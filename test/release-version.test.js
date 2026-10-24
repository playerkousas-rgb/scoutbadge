'use strict';

/*
 * 最新版本公告、GS 初始化核對及資料保全測試
 *
 * 覆蓋：
 *   1. 前端 GS_LATEST 與 Code.gs GS_VERSION 一致
 *   2. ecStatus 回報 gsVersion 和 initializedGsVersion
 *   3. load 回報 gsVersion 和 initializedGsVersion
 *   4. initializeSheets() 成功後才寫入初始化標記
 *   5. 初始化前後用戶資料保持原值（帳號、舊 ID 紀錄、徽章、活動履歷、Token、操作紀錄、設定）
 *   6. 重複初始化安全且不更換 API Key
 *   7. 資料保全：初始化不刪除殘留 super_admin 列或 Tokens
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeGas } = require('./gasvm');

function snapshotRows(backend, names) {
  return Object.fromEntries(names.map(name => [name, JSON.parse(JSON.stringify(backend.sheets.get(name)._rows))]));
}

// ---- 1. 前端 GS_LATEST 與 Code.gs GS_VERSION 一致 ----
(function testFrontendMatchesCodeGs() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const gas = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const release = html.match(/const GS_LATEST=Object\.freeze\(\{updated:'([^']+)',gsVersion:'([^']+)',initializeRequired:(true|false)\}\)/);
  assert.ok(release, 'frontend exposes one latest-release declaration');
  const gs = gas.match(/const GS_VERSION = '([^']+)'/);
  assert.ok(gs, 'Apps Script exposes its latest GS version');
  assert.equal(release[1], '2026-10-24');
  assert.equal(release[2], gs[1], 'frontend required GS and backend reported GS must match');
  assert.equal(release[3], 'true', 'this release explicitly requires initializeSheets()');
  assert.match(gas, /setProperty\(GS_INIT_PROP,\s*GS_VERSION\)/);
  assert.doesNotMatch(gas, /GS_VERSION_HISTORY|SEQUENTIAL_PATCH/);
  console.log('[PASS] 前端 GS_LATEST 與 Code.gs GS_VERSION 一致');
})();

// ---- 2-7. GS 版本核對、初始化安全及資料保全 ----
(function testVersionAndDataPreservation() {
  const backend = makeGas({ apiKey: 'TESTKEY123', execUrl: 'http://127.0.0.1:0/exec' });

  // 先執行一次 initializeSheets 建立所有工作表
  backend.sandbox.initializeSheets();
  const sheets = backend.sheets;

  // 種入用戶資料（模擬既有旅團）
  sheets.get('Users').appendRow(['1234567890','陳大文','parent@example.org','member','existing-hash','b4',false,'leader','2026-01-01','2026-01-01','2026-01-02','active','','紅隊','member',false]);
  sheets.get('成員名單').appendRow(['1234567890','陳大文','2025-01-01','童軍','','紅隊']);
  sheets.get('進度追蹤').appendRow(['1234567890','L1-01','2025-01-01','2025-01-02','舊領袖','舊版備註']);
  sheets.get('其他獎章').appendRow(['1234567890','ACT-07','游泳章','2024-01-01','CERT-OLD','舊徽章備註','2024-01-02']);
  sheets.get('活動履歷').appendRow(['LOG_OLD','service','1234567890','陳大文','2024-01-01','舊服務','義工','2','CERT','舊內容','舊領袖','2024-01-02','']);
  sheets.get('Tokens').appendRow(['token-user','1234567890','2026-01-01','2099-01-01']);
  sheets.get('操作紀錄').appendRow(['2026-01-01','領袖','update','1234567890','原有操作紀錄']);
  // 種入既有旅團設定（模擬已有 allow_member_requests 設定）
  sheets.get('SystemConfig').appendRow(['allow_member_requests','true','keep-time','keep-actor']);

  // 種入殘留 super_admin 列（測試資料保全：不刪除）
  sheets.get('Users').appendRow(['sheep','系統管理員','','super_admin','old-hash','',true,'','','','active','*','','','',false]);

  const preservedSheetNames = ['Users','成員名單','進度追蹤','其他獎章','活動履歷','Tokens','操作紀錄'];
  const originalRows = snapshotRows(backend, preservedSheetNames);
  const originalConfig = sheets.get('SystemConfig')._rows.find(r => r[0] === 'allow_member_requests');
  assert.ok(originalConfig, 'seeded allow_member_requests config exists');

  // 清除初始化標記（模擬新貼 Code.gs 但未跑 initializeSheets）
  backend.props.delete('INITIALIZED_GS_VERSION');

  // ---- ecStatus：未初始化 ----
  const before = backend.get({ action: 'ecStatus' });
  assert.equal(before.success, true);
  assert.equal(before.gsVersion, '6.1.0');
  assert.equal(before.initializedGsVersion, '', 'new Code.gs alone must not count as initialized');
  assert.equal(before.initRequired, true);
  console.log('[PASS] ecStatus 回報 gsVersion 和 initializedGsVersion（未初始化）');

  // ---- initializeSheets()：成功後才寫入標記 ----
  const apiKey = backend.props.get('API_KEY');
  const initialized = backend.sandbox.initializeSheets();
  assert.equal(initialized.success, true);
  assert.equal(initialized.gsVersion, before.gsVersion);
  assert.equal(initialized.initializedGsVersion, before.gsVersion);

  // API Key 不變
  assert.equal(backend.props.get('API_KEY'), apiKey, 'running the required initialization must not rotate the existing API key');
  console.log('[PASS] initializeSheets() 成功後寫入初始化標記，API Key 不變');

  // ---- 資料保全：初始化前後用戶資料保持原值 ----
  assert.deepEqual(snapshotRows(backend, preservedSheetNames), originalRows, 'initialization must not modify existing user records, including old IDs');
  const configAfter = sheets.get('SystemConfig')._rows.find(r => r[0] === 'allow_member_requests');
  assert.deepEqual(configAfter, originalConfig, 'an existing troop setting must not be overwritten by a default');
  console.log('[PASS] 初始化前後用戶資料保持原值（帳號、舊 ID、徽章、活動履歷、Token、操作紀錄、設定）');

  // ---- 殘留 super_admin 列保留不刪 ----
  const usersAfter = sheets.get('Users')._rows;
  const sheepRow = usersAfter.find(r => String(r[0]).toLowerCase() === 'sheep');
  assert.ok(sheepRow, 'legacy super_admin row is preserved (data preservation)');
  console.log('[PASS] 殘留 super_admin 列保留不刪（資料保全）');

  // ---- ecStatus：已初始化 ----
  const after = backend.get({ action: 'ecStatus' });
  assert.equal(after.success, true);
  assert.equal(after.gsVersion, before.gsVersion);
  assert.equal(after.initializedGsVersion, before.gsVersion);
  assert.equal(after.initRequired, true);
  console.log('[PASS] ecStatus 回報已初始化版本');

  // ---- load 回報 gsVersion 和 initializedGsVersion ----
  const load = backend.get({ action: 'load', apikey: 'TESTKEY123' });
  assert.equal(load.success, true);
  assert.equal(load.gsVersion, before.gsVersion);
  assert.equal(load.initializedGsVersion, before.gsVersion);
  assert.equal(load.initRequired, true);
  console.log('[PASS] load 回報 gsVersion 和 initializedGsVersion');

  // ---- 重複初始化安全 ----
  backend.sandbox.initializeSheets();
  assert.equal(backend.props.get('API_KEY'), apiKey, 're-running initialization remains safe and idempotent');
  assert.deepEqual(snapshotRows(backend, preservedSheetNames), originalRows, 're-running initialization must also preserve every existing user value');
  const configAfter2 = sheets.get('SystemConfig')._rows.find(r => r[0] === 'allow_member_requests');
  assert.deepEqual(configAfter2, originalConfig);
  console.log('[PASS] 重複初始化安全且不更換 API Key');

  // ---- 前端三狀態判斷 ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const fnMatch = html.match(/function gsReleaseStatusOf\(info, latest\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'gsReleaseStatusOf function exists in frontend');

  // 提取 GS_LATEST、compareVersions、gsReleaseStatusOf
  const latestMatch = html.match(/const GS_LATEST=Object\.freeze\(\{[^}]+\}\)/);
  const cvMatch = html.match(/function compareVersions\(a, b\) \{[\s\S]*?\n\}/);
  assert.ok(latestMatch, 'GS_LATEST exists in frontend');
  assert.ok(cvMatch, 'compareVersions exists in frontend');

  const fnSrc = latestMatch[0] + '\n' + cvMatch[0] + '\n' + fnMatch[0];
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + '\nthis.gsReleaseStatusOf = gsReleaseStatusOf;', sandbox);

  // GS 未更新
  const outdated = sandbox.gsReleaseStatusOf({ gsVersion: '5.0.0', initializedGsVersion: '5.0.0' });
  assert.equal(outdated.code, 'outdated');
  console.log('[PASS] 前端分辨「GS 未更新」');

  // GS 已更新但未初始化
  const needsInit = sandbox.gsReleaseStatusOf({ gsVersion: '6.1.0', initializedGsVersion: '' });
  assert.equal(needsInit.code, 'needs_init');
  console.log('[PASS] 前端分辨「GS 已更新但未初始化」');

  // 全部完成
  const ok = sandbox.gsReleaseStatusOf({ gsVersion: '6.1.0', initializedGsVersion: '6.1.0' });
  assert.equal(ok.code, 'ok');
  console.log('[PASS] 前端分辨「全部完成」（顯示綠色「已核對」）');
})();

console.log('\n=== 最新版本公告、GS 初始化核對及資料保全測試：全部通過 ===');
