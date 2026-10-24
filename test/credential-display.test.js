'use strict';

/*
 * 接入資料顯示回歸測試（同步 CUBS 已合併的修正）
 *
 * 驗收重點：
 *   1. 旅系統選單、initializeSheets、showApiKey／showVercelEnv／vercelEnvLines 只提供 API Key；
 *      Google 回報的網址（三個不同值）及舊 WEBAPP_URL 快取一律不外洩。
 *   2. 不要求旅團先設定編號、不新增貼部署 URL 到 GS 的流程，亦不改寫既有屬性。
 *   3. 新裝無旅團編號可生成 API Key；重跑初始化不換 Key、不改資料。
 *   4. 初始化回傳物件不再帶出推算的 scriptUrl／backend。
 *   5. 不影響內部登入／驗票協議（仍保留 SUPER_VERIFY_URL 等設定）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gasvm');

const ROOT = path.join(__dirname, '..');
const KEY = 'sc_display_test_0123456789abcdef';

// 三個不同的「Google 可能回報」網址：部署視窗以外的值都不可顯示。
const FALSE_URLS = [
  'https://script.google.com/macros/s/WRONG_INITIALIZER_NODE/exec',
  'https://script.google.com/a/example.org/macros/s/WRONG_MENU_NODE/exec',
  'https://script.google.com/macros/s/WRONG_CACHED_NODE/exec'
];

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}\n     ${e && e.message}`);
    process.exitCode = 1;
  }
}

function setup({ apiKey = KEY } = {}) {
  const backend = makeGas({ apiKey });
  const alerts = [];
  const prompts = [];
  const logs = [];
  const items = [];
  const calls = { getUrl: 0, fetch: 0 };

  backend.sandbox.ScriptApp.getService = () => ({
    getUrl() {
      const value = FALSE_URLS[calls.getUrl % FALSE_URLS.length];
      calls.getUrl++;
      return value;
    }
  });
  backend.sandbox.UrlFetchApp = {
    fetch() { calls.fetch++; throw new Error('接入資料顯示不可探測任何網址'); }
  };
  backend.sandbox.Logger.log = (message) => logs.push(String(message));

  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    alert(title, message) {
      // Apps Script 的 ui.alert 可以用單一參數（= 訊息）或 (標題, 訊息)。
      const text = message === undefined ? String(title || '') : String(message || '');
      alerts.push({ title: message === undefined ? '' : String(title || ''), message: text });
      return 'OK';
    },
    prompt(title, message) {
      prompts.push({ title: String(title || ''), message: String(message || '') });
      return { getSelectedButton: () => 'CANCEL', getResponseText: () => '' };
    },
    createMenu(title) {
      const menu = {
        addItem(label, handler) { items.push({ title, label, handler }); return menu; },
        addSeparator() { return menu; },
        addSubMenu() { return menu; },
        addToUi() { return menu; }
      };
      return menu;
    }
  };
  backend.sandbox.SpreadsheetApp.getUi = () => ui;
  return { backend, alerts, prompts, logs, items, calls };
}

function assertNoDeploymentUrl(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const url of FALSE_URLS) {
    assert.ok(!text.includes(url), `${label || '接入資料'} 不得顯示 ${url}`);
  }
  assert.doesNotMatch(text, /https?:\/\//, `${label || '接入資料'} 不得包含任何網址`);
  assert.doesNotMatch(text, /_BACKEND\s*=|已核實|部署 ID 長度|56 字元|74 字元/, `${label || '接入資料'} 不得暗示自動核實`);
}

console.log('\n【1】initializeSheets：只顯示 API Key，不回傳推算網址');

test('初始化彈窗及回傳物件只有 API Key，完全沒有網址', () => {
  const { backend, alerts, logs, calls } = setup();
  const result = backend.sandbox.initializeSheets();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.apiKey, KEY);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'scriptUrl'), false, '不可回傳推算的 scriptUrl');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'backend'), false, '不可回傳 backend');

  assert.ok(alerts.length > 0, '要驗真正的初始化彈窗，而不是只驗 helper');
  const popup = alerts.map((a) => a.message).join('\n');
  assert.match(popup, /初始化完成/);
  assert.ok(popup.includes(KEY), '領袖要即時看到 API Key');
  assert.match(popup, /ADMIN FORM/, '要指示用戶在 ADMIN FORM 填編號／名稱／URL／API Key');
  assert.match(popup, /部署 → 管理部署/, '要指明部署網址由 Google 部署視窗提供');
  assertNoDeploymentUrl(popup, '初始化彈窗');
  assertNoDeploymentUrl(result, '初始化回傳物件');
  assertNoDeploymentUrl(logs, 'Logger');
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 }, '初始化不可查詢或探測任何網址');
});

test('初始化不再提示輸入旅團編號，亦不寫入旅團編號／名稱屬性', () => {
  const { backend, prompts, alerts } = setup({ apiKey: null });
  const result = backend.sandbox.initializeSheets();
  assert.strictEqual(prompts.length, 0, '初始化不可彈出任何 prompt（編號／名稱／URL）');
  assert.match(result.apiKey, /^sc_[0-9a-f]{24}$/, '沒有旅團編號亦要生成 API Key');
  assert.strictEqual(backend.props.get('TROOP_ID') || null, null, '不可自行推算或寫入旅團編號');
  assert.strictEqual(backend.props.get('TROOP_NAME') || null, null);
  const text = alerts.map((a) => a.message).join('\n');
  assert.ok(text.includes('API Key = ' + result.apiKey));
  assert.doesNotMatch(text, /TROOP_<|（未設定）|TROOP_.*_APIKEY|請輸入旅團編號/);
});

test('重跑初始化：API Key、既有資料及舊屬性原樣保留', () => {
  const { backend, alerts } = setup();
  backend.props.set('WEBAPP_URL', FALSE_URLS[2]);
  backend.props.set('TROOP_ID', '0082');
  backend.props.set('TROOP_NAME', '第 82 旅');
  const first = backend.sandbox.initializeSheets();

  backend.sheets.get('成員名單').appendRow(['1234567890', '陳大文', '2025-01-01', '童軍', '', '紅隊']);
  backend.sheets.get('進度追蹤').appendRow(['1234567890', 'L1-01', '2025-01-01', '2025-01-02', '舊領袖', '保留備註']);
  backend.sheets.get('其他獎章').appendRow(['1234567890', 'ACT-07', '游泳章', '2024-01-01', 'CERT-OLD', '舊備註', '2024-01-02']);
  const snapshot = JSON.stringify(
    ['Users', '成員名單', '進度追蹤', '其他獎章', '活動履歷', '待批履歷', '操作紀錄', 'SystemConfig']
      .map((name) => [name, backend.sheets.get(name)._rows])
  );

  const second = backend.sandbox.initializeSheets();
  assert.strictEqual(second.apiKey, first.apiKey, '重跑不得更換既有 API Key');
  assert.strictEqual(backend.props.get('API_KEY'), first.apiKey);
  assert.strictEqual(
    JSON.stringify(
      ['Users', '成員名單', '進度追蹤', '其他獎章', '活動履歷', '待批履歷', '操作紀錄', 'SystemConfig']
        .map((name) => [name, backend.sheets.get(name)._rows])
    ),
    snapshot,
    '初始化只可增補，不得改寫既有資料'
  );
  assert.strictEqual(backend.props.get('WEBAPP_URL'), FALSE_URLS[2], '舊 URL 屬性原樣保留，只是不再顯示');
  assert.strictEqual(backend.props.get('TROOP_ID'), '0082');
  assert.strictEqual(backend.props.get('TROOP_NAME'), '第 82 旅');
  assertNoDeploymentUrl(alerts.map((a) => a.message).join('\n'));
});

console.log('\n【2】所有接入顯示入口：一致只顯示 API Key');

test('vercelEnvLines／showVercelEnv／showApiKey／menuShowLinkCredentials 只顯示 Key', () => {
  const { backend, alerts, prompts, logs, calls } = setup();

  assert.deepStrictEqual(Array.from(backend.sandbox.vercelEnvLines()), ['API Key = ' + KEY]);
  const shown = backend.sandbox.showVercelEnv();
  assert.deepStrictEqual(Array.from(shown), ['API Key = ' + KEY], 'showVercelEnv 保留原有回傳契約');

  assert.strictEqual(backend.sandbox.showApiKey(), KEY, 'showApiKey 保留原有 API Key 回傳契約');

  const menu = backend.sandbox.menuShowLinkCredentials();
  assert.ok(menu.includes(KEY), '選單要顯示 API Key');
  assert.match(menu, /Google「部署 → 管理部署」/, '選單要說明部署網址由 Google 部署視窗提供');
  assert.match(menu, /ADMIN FORM/);
  assert.doesNotMatch(menu, /BACKEND（部署後抄此 URL）|隱藏管理鍵|顯示 BACKEND/);

  for (const [label, value] of [['vercelEnvLines', shown], ['showApiKey 彈窗', alerts], ['選單', menu], ['Logger', logs]]) {
    assertNoDeploymentUrl(value, label);
  }
  assert.strictEqual(prompts.length, 0, '不可要求領袖貼上或設定部署 URL');
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 });
});

test('Google 網址查詢失敗或無 UI 時，顯示仍然正常', () => {
  const { backend, alerts, calls } = setup();
  backend.sandbox.ScriptApp.getService = () => { calls.getUrl++; throw new Error('No service context'); };
  assert.doesNotThrow(() => backend.sandbox.initializeSheets());
  assert.strictEqual(backend.sandbox.showApiKey(), KEY);
  assert.doesNotThrow(() => backend.sandbox.showVercelEnv());
  assert.doesNotThrow(() => backend.sandbox.menuShowLinkCredentials());
  assertNoDeploymentUrl(alerts);
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 });
});

test('舊／可疑 URL 屬性不會成為顯示的部署資料，亦沒有自動驗證入口', () => {
  const { backend, alerts, prompts, calls } = setup();
  backend.props.set('BACKEND_EXEC_URL', FALSE_URLS[0]);
  backend.props.set('WEBAPP_URL_VERIFIED', 'true');
  backend.sandbox.initializeSheets();
  backend.sandbox.showApiKey();
  backend.sandbox.showVercelEnv();
  backend.sandbox.menuShowLinkCredentials();
  assertNoDeploymentUrl(alerts);
  assert.strictEqual(typeof backend.sandbox.getScriptUrl, 'undefined', '不可有自動取得網址的函式');
  assert.strictEqual(prompts.length, 0);
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 });
  assert.strictEqual(backend.props.get('WEBAPP_URL_VERIFIED'), 'true', '不要為 UI 修正刪除既有屬性');
});

test('舊選單仍可開啟：驗證 BACKEND 只回說明，不推算／不探測網址', () => {
  const { backend, alerts, logs, calls } = setup();
  const result = backend.sandbox.verifyBackendUrl(FALSE_URLS[0]);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, 'AUTO_BACKEND_URL_DISABLED');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'url'), false);
  const text = backend.sandbox.menuVerifyBackendUrl();
  assert.match(text, /不顯示自動取得或推算/);
  for (const value of [result, text, alerts, logs]) assertNoDeploymentUrl(value);
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 });
});

console.log('\n【3】旅系統選單：API KEY 項目、無設定編號／驗證網址項目');

test('選單保留 menuShowLinkCredentials 但標籤只講 API KEY', () => {
  const { backend, items, calls } = setup();
  backend.sandbox.onOpen();
  const credentials = items.find((item) => item.handler === 'menuShowLinkCredentials');
  assert.ok(credentials, '保留原有 handler，舊選單綁定不會失效');
  assert.strictEqual(credentials.label, '🔑 顯示 API KEY（交 ADMIN）');
  assert.ok(!items.some((item) => /顯示 BACKEND|驗證 BACKEND|設定 BACKEND/.test(item.label)));
  assert.ok(!items.some((item) => /SetBackend|VerifyBackend/.test(item.handler)));
  assert.ok(!items.some((item) => /設定旅團編號/.test(item.label)), '旅團編號屬 ADMIN FORM，不新增 GS 設定選單');
  assert.deepStrictEqual(calls, { getUrl: 0, fetch: 0 });
});

console.log('\n【4】協議不變、內部設定未動');

test('中央登入／驗票協議及 API Key 屬性保持不變', () => {
  const gas = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  assert.match(gas, /const SUPER_VERIFY_URL = 'https:\/\/scoutbadge\.vercel\.app\/api\/verify-super-ticket';/);
  assert.match(gas, /const SUPER_TOKEN_PREFIX = 'sbs-super-v1-';/);
  assert.match(gas, /function verifyCentralTicket\s*\(/);
  assert.doesNotMatch(gas, /function (?:setBackendUrl|menuSetBackendUrl|rememberWebAppUrlFromRequest)\s*\(/);
  assert.doesNotMatch(gas, /ScriptApp\.getService\(\)\.getUrl\(\)\s*\)?\s*[;,]?\s*$/m, '接入顯示及初始化不得再讀自動網址');
});

console.log('\n【5】前端指南：只交 API Key、編號在 ADMIN FORM 填');

test('index.html 中英文案已同步，不再承諾自動核實網址', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /GS 彈窗及選單只提供 API Key/);
  assert.match(html, /dialogs and menus provide only the API Key/);
  assert.match(html, /旅團編號直接在 ADMIN FORM 填寫/);
  assert.match(html, /Enter the troop ID directly in the ADMIN FORM/);
  assert.match(html, /部署網址由 Google「部署 → 管理部署」視窗提供/);
  assert.doesNotMatch(html, /顯示 BACKEND／APIKEY（交 ADMIN）/);
  assert.doesNotMatch(html, /GS 會自動記低正確網址|script then remembers the correct URL|only submit when it says “✅ verified”/);
});

console.log(`\ncredential-display: ${passed} 項通過${process.exitCode ? '（有失敗）' : ''}`);
