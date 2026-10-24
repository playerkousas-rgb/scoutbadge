'use strict';

/*
 * 「系統介紹」分頁及部署教學入口回歸測試（同步 CUBS 已合併的修正）
 *
 * 驗收重點：
 *   1. 首頁有獨立「系統介紹」分頁，並在「新旅團部署」有入口；交叉連結要正確切換選中分頁。
 *   2. 沿用通用「支部進度追蹤系統」介紹圖（assets/，會部署），支援放大、下載、手機顯示。
 *   3. 中英鍵完整，說明涵蓋資料流向、Google 授權、「任何人」入口≠Sheet 公開、
 *      帳號密碼登入及安全邊界；不披露任何隱藏／保留帳號資訊。
 *   4. 本地預覽伺服器以 image/webp 提供圖檔。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const IMAGE_REL = 'assets/system-introduction-zh-hant.webp';

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

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `缺少 #${id} 分頁`);
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, `#${id} 分頁未閉合`);
  return html.slice(start, end + '</section>'.length);
}

function i18nObject() {
  const start = html.indexOf('const I18N={');
  const end = html.indexOf('let currentLang=');
  assert.ok(start >= 0 && end > start, '找不到 I18N 字典');
  const fn = new Function(html.slice(start, end) + '; return I18N;');
  return fn();
}

/** 由 index.html 取出 showWelcomeTab 原始碼（連同大括號平衡），在假 DOM 內執行。 */
function extractShowWelcomeTab() {
  const start = html.indexOf('function showWelcomeTab(');
  assert.ok(start >= 0, '缺少 showWelcomeTab()');
  let depth = 0, i = html.indexOf('{', start);
  const open = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, 'showWelcomeTab() 大括號不平衡');
  assert.ok(open > start);
  return html.slice(start, i + 1);
}

function fakeDom(names) {
  const classes = (owner) => {
    const set = new Set(owner.active ? ['active'] : []);
    return {
      add: (value) => set.add(value),
      remove: (value) => set.delete(value),
      contains: (value) => set.has(value)
    };
  };
  const sections = names.map((name) => ({ id: `welcome-${name}`, classList: null }));
  const buttons = names.map((name) => ({ tab: name, classList: null }));
  sections.forEach((s) => { s.classList = classes({}); });
  buttons.forEach((b) => { b.classList = classes({}); });
  const document = {
    getElementById: (id) => sections.find((s) => s.id === id) || null,
    querySelectorAll: (selector) => {
      if (selector === '.welcome-section') return sections;
      if (selector === '.welcome-nav button') return buttons;
      throw new Error('unexpected selector ' + selector);
    },
    querySelector: (selector) => {
      const m = /^\.welcome-nav button\[data-tab="([^"]+)"\]$/.exec(selector);
      if (!m) throw new Error('unexpected selector ' + selector);
      return buttons.find((b) => b.tab === m[1]) || null;
    }
  };
  return { document, sections, buttons };
}

console.log('\n【1】分頁、入口及圖片');

test('首頁有「系統介紹」分頁按鈕，位置在「進入系統」與「新旅團部署」之間', () => {
  assert.match(html, /<button data-tab="intro" onclick="showWelcomeTab\('intro', this\)" data-i18n="tab_intro">🌿 系統介紹<\/button>/);
  const order = ['data-tab="enter"', 'data-tab="intro"', 'data-tab="setup"'].map((needle) => html.indexOf(needle));
  assert.ok(order.every((index) => index > 0), '三個分頁按鈕都要存在');
  assert.ok(order[0] < order[1] && order[1] < order[2], '分頁次序應為：進入系統 → 系統介紹 → 新旅團部署');
});

test('「系統介紹」及「新旅團部署」有雙向入口，且交叉連結會切換分頁', () => {
  const intro = section('welcome-intro');
  assert.match(intro, /onclick="showWelcomeTab\('setup'\)"/, '介紹頁要有前往部署的入口');
  const setupStart = html.indexOf('<div id="welcome-setup"');
  const setupEnd = html.indexOf('<div id="welcome-guide"');
  const setup = html.slice(setupStart, setupEnd);
  assert.match(setup, /class="setup-intro-link"[\s\S]*?onclick="showWelcomeTab\('intro'\)"/, '部署頁要有返回介紹的入口');

  const { document, sections, buttons } = fakeDom(['enter', 'intro', 'setup', 'guide']);
  const showWelcomeTab = new Function('document', extractShowWelcomeTab() + '; return showWelcomeTab;')(document);

  showWelcomeTab('intro');                       // 交叉連結：不傳 nav 按鈕
  assert.deepStrictEqual(sections.map((s) => s.classList.contains('active')), [false, true, false, false], '只顯示介紹分頁');
  assert.deepStrictEqual(buttons.map((b) => b.classList.contains('active')), [false, true, false, false], '介紹分頁按鈕要亮起');
  showWelcomeTab('setup');
  assert.deepStrictEqual(sections.map((s) => s.classList.contains('active')), [false, false, true, false]);
  assert.deepStrictEqual(buttons.map((b) => b.classList.contains('active')), [false, false, true, false]);
  showWelcomeTab('intro', buttons[1]);
  assert.deepStrictEqual(buttons.map((b) => b.classList.contains('active')), [false, true, false, false]);
});

test('介紹圖放在會部署的 assets/（不是 docs/），支援放大、下載及手機顯示', () => {
  const intro = section('welcome-intro');
  assert.ok(intro.includes(`src="${IMAGE_REL}"`), '介紹頁要引用 assets 圖檔');
  assert.ok(!/src="docs\//.test(intro), '不可引用可能被部署忽略的 docs/ 圖檔');
  assert.match(intro, /<a href="assets\/system-introduction-zh-hant\.webp" target="_blank" rel="noopener noreferrer">/, '點圖可放大');
  assert.match(intro, /download="system-introduction-zh-hant\.webp"/, '可下載介紹圖');
  assert.match(intro, /<img[^>]*width="768" height="1376"[^>]*loading="lazy"[^>]*decoding="async"/, '要有尺寸及 lazy 載入（手機友善）');
  assert.match(intro, /lang="zh-Hant"/, '圖片語言要標示繁中');
  assert.match(intro, /data-i18n="intro_image_caption"/, '圖旁要標示圖片語言');
  assert.match(html, /@media\(max-width:740px\)\{\.system-intro-grid\{grid-template-columns:minmax\(0,1fr\)\}/, '要有手機單欄版面');

  const ignore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')
    .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const ignored = ignore.filter((rule) => rule === 'assets' || rule === 'assets/' || rule === '*.webp' ||
    rule.replace(/^\//, '') === IMAGE_REL);
  assert.deepStrictEqual(ignored, [], '圖檔不可被 .vercelignore 排除');
});

test('圖檔真實存在且為 768×1376 WebP', () => {
  const bytes = fs.readFileSync(path.join(ROOT, IMAGE_REL));
  assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(bytes.toString('ascii', 8, 12), 'WEBP');
  const bits = bytes.readUInt32LE(21);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  assert.deepStrictEqual([width, height], [768, 1376], '實際圖檔尺寸要與 HTML 宣告一致，避免版面跳動');
});

test('本地預覽伺服器以 image/webp 提供圖檔', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /'\.webp': 'image\/webp'/, 'dev server 要設定 WebP MIME');
});

test('介紹圖及 Code.gs 下載都不會被部署忽略', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  assert.match(ignore, /apps-script\/\*\s*\n\s*!apps-script\/Code\.gs/, 'Code.gs 必須保留可下載（.vercelignore 要有反向例外）');
  const build = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');
  assert.match(build, /const STATIC_FILES = \['index\.html', 'apps-script\/Code\.gs'\];/);
  assert.match(build, /const STATIC_DIRS = \['assets', 'data', 'docs'\];/, 'assets/ 會整個目錄發布，新圖檔自動上線');
});

console.log('\n【2】中英說明及安全邊界');

test('介紹分頁的每個中英鍵都存在且內容一致（雙語齊全）', () => {
  const i18n = i18nObject();
  const keys = new Set();
  for (const m of section('welcome-intro').matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of section('welcome-intro').matchAll(/data-i18n-alt="([^"]+)"/g)) keys.add(m[1]);
  keys.add('tab_intro');
  keys.add('setup_intro_p');
  keys.add('setup_intro_btn');
  assert.ok(keys.size >= 15, '應覆蓋標題、三項說明、注意事項、圖說及按鈕');
  for (const key of keys) {
    assert.strictEqual(typeof i18n.zh[key], 'string', `缺少中文鍵 ${key}`);
    assert.strictEqual(typeof i18n.en[key], 'string', `缺少英文鍵 ${key}`);
    assert.ok(i18n.zh[key].trim() && i18n.en[key].trim(), `${key} 不可為空`);
  }
});

test('說明涵蓋資料流向、Google 授權、「任何人」入口、帳號密碼登入', () => {
  const i18n = i18nObject();
  assert.match(i18n.zh.intro_data, /Apps Script/);
  assert.match(i18n.en.intro_data, /Apps Script/);
  assert.match(i18n.zh.intro_auth_p, /權限確實較廣/);
  assert.match(i18n.en.intro_auth_p, /permissions are broad/);
  assert.match(i18n.zh.intro_sheet_p, /不是試算表的分享設定/);
  assert.match(i18n.en.intro_sheet_p, /not sharing of the spreadsheet file/);
  assert.match(i18n.zh.intro_login_p, /每次均核實帳號及密碼/);
  assert.match(i18n.en.intro_login_p, /Each password sign-in checks the account and password/);
  assert.match(i18n.zh.intro_login_p, /API Key 是系統連接用的鑰匙，不是個人登入密碼/);
  assert.match(i18n.en.intro_login_p, /not a personal login password/);
  assert.match(i18n.zh.intro_h2, /支部進度追蹤系統/);
  assert.match(i18n.en.intro_h2, /Section Progress Tracking System/);
});

test('保留安全邊界：私人 Sheet ≠ 所有資料 API 自動安全，非獨立安全認證', () => {
  const i18n = i18nObject();
  assert.match(i18n.zh.intro_caution, /仍待補強/);
  assert.match(i18n.zh.intro_caution, /並非獨立安全認證/);
  assert.match(i18n.en.intro_caution, /still need strengthening/);
  assert.match(i18n.en.intro_caution, /not an independent security certification/);
  assert.match(i18n.zh.intro_caution, /私人 Sheet 不等於所有資料 API 自動安全/);
});

test('公開介紹不含任何隱藏／保留帳號資訊', () => {
  const intro = section('welcome-intro');
  const zhStart = html.indexOf('  tab_intro:');
  const introKeyBlock = html.slice(zhStart, html.indexOf('  setup_h2:', zhStart));
  for (const needle of ['sheep', 'SUPER_KEY', 'SUPER_ADMIN', '系統管理員', '中央管理', '超管', '後門', '隱藏管理鍵', 'S1']) {
    assert.ok(!intro.includes(needle), `介紹分頁不可出現 ${needle}`);
    assert.ok(!introKeyBlock.includes(needle), `介紹文案不可出現 ${needle}`);
  }
  assert.doesNotMatch(intro, /password|密碼是|changeme/i, '介紹頁不可展示任何預設密碼');
});

console.log('\n【3】部署教學文案：URL 由 Google 部署視窗提供、編號在 ADMIN FORM 填');

test('部署步驟只交 API Key，並指示在 Google 部署視窗取得 URL', () => {
  const i18n = i18nObject();
  for (const text of [i18n.zh.s2p, i18n.en.s2p]) {
    assert.match(text, /管理部署|Manage deployments/, '要指明部署網址來自 Google 部署視窗');
    assert.match(text, /只提供 API Key|only the API Key/, 'GS 彈窗及選單只提供 API Key');
    assert.match(text, /毋須在 Sheet|No troop ID needs to be configured/, '不要求先在 GS 設定旅團編號');
  }
  assert.match(i18n.zh.s3p, /ADMIN FORM/);
  assert.match(i18n.en.s3p, /ADMIN FORM/);
  assert.match(i18n.zh.setup_submit_card, /ADMIN FORM/);
  assert.match(i18n.en.setup_submit_card, /ADMIN FORM/);
  assert.match(i18n.zh.setup_submit_card, /毋須預先在 GS 設定旅團編號/);
  assert.match(i18n.en.setup_submit_card, /no troop ID needs to be configured in GS first/);
});

test('初次登入提示（童軍自己的預設管理員）保留', () => {
  const i18n = i18nObject();
  assert.match(i18n.zh.s_fl_p, /1111111111/);
  assert.match(i18n.zh.s_fl_p, /強制改密碼/);
  assert.match(i18n.en.s_fl_p, /1111111111/);
});

test('alt 文字會跟語言切換（applyStaticI18n 支援 data-i18n-alt）', () => {
  assert.match(html, /querySelectorAll\('\[data-i18n-alt\]'\)\.forEach\(el=>\{ el\.alt=t\(el\.getAttribute\('data-i18n-alt'\)\); \}\);/);
});

console.log(`\nsystem-intro: ${passed} 項通過${process.exitCode ? '（有失敗）' : ''}`);
