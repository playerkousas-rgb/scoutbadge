'use strict';

/*
 * YMIS 獎章匯出（試行版，童軍支部）測試
 *
 * 守住：
 *   1. 四欄欄名、支部固定值、五款獎章字串與 YMIS 範本／使用者提供的字串逐字一致
 *   2. SCOUT ID／日期／獎章／重複行驗證
 *   3. 工作表只有表頭＋領袖指定的紀錄，全部以文字寫入（保留前導零）
 *   4. index.html 接線：領袖專用入口、試行提示、不由考核完成度推斷、不呼叫後端
 *
 * 界線：只驗證本地產生的資料；未（亦無法）驗證 YMIS 伺服器是否接受檔案。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const api = require('../assets/ymis-export.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const BADGES = ['Membership Badge', 'Scout Pathfinder Award', 'Scout Standard Award', 'Scout Advanced Award', "Chief Scout's Award"];
const base = { scoutId: '0123456789', badge: 'Membership Badge', date: '2026-11-14' };

test('exact YMIS headers, Scout section and the five supported award names', () => {
  assert.deepEqual(api.headers, ['Scout ID', 'Badge-Section', 'Badge-Badge', 'Badge-award date (YYYYMMDD)']);
  assert.equal(api.section, 'Scout');
  assert.deepEqual(api.badges.map((b) => b[1]), BADGES);
  assert.deepEqual(api.badges.map((b) => b[0]), ['會員章', '童軍探索獎章', '童軍標準獎章', '童軍高級獎章', '總領袖獎章']);
  for (const badge of BADGES) {
    assert.deepEqual(api.buildRows([{ scoutId: '0123456789', badge, date: '2024-02-29' }]), [['0123456789', 'Scout', badge, '20240229']]);
  }
});

test('mapping is frozen and matches the Chinese award names in data/items.json', () => {
  assert.ok(Object.isFrozen(api.headers) && Object.isFrozen(api.badges) && api.badges.every(Object.isFrozen));
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'items.json'), 'utf8'));
  assert.deepEqual(api.badges.map((b) => b[0]), items.badges.map((b) => b.name), '介面中文名要與 L1–L5 正名一致');
});

test('rejects missing/invalid IDs, dates, unsupported badges and duplicates', () => {
  const bad = [
    { scoutId: '' }, { scoutId: '123' }, { scoutId: '12345678901' }, { scoutId: '12345abcde' },
    { badge: '' }, { badge: 'Voyager Award' }, { badge: 'Cub Scout Award' }, { badge: 'chief scout\'s award' },
    { date: '' }, { date: '2026-02-29' }, { date: '2026-04-31' }, { date: '20261114' }, { date: '14/11/2026' }
  ];
  for (const delta of bad) assert.throws(() => api.buildRows([{ ...base, ...delta }]), undefined, JSON.stringify(delta));
  assert.throws(() => api.buildRows([]));
  assert.throws(() => api.buildRows(null));
  assert.throws(() => api.buildRows([base, base]), /Duplicate/);
  assert.equal(api.buildRows([base, { ...base, badge: 'Scout Pathfinder Award' }]).length, 2);
  assert.equal(api.buildRows([base, { ...base, scoutId: '0123456780' }]).length, 2);
});

test('accepts the legacy `ymis` field and keeps IDs as text with leading zeroes', () => {
  assert.deepEqual(api.buildRows([{ ymis: '0000000042', badge: 'Membership Badge', date: '2026-01-05' }]), [['0000000042', 'Scout', 'Membership Badge', '20260105']]);
  assert.deepEqual(api.buildRows([{ scoutId: ' 0123456789 ', badge: 'Membership Badge', date: '2026-01-05' }])[0][0], '0123456789');
  // 數字型別（Sheet 丟失前導零）不可被當成有效編號
  assert.throws(() => api.buildRows([{ ...base, scoutId: 123456789 }]));
});

test('workbook has only the header row and the declared records, all as strings', () => {
  let table; let sheet;
  const fake = { utils: {
    aoa_to_sheet(a) { table = a; sheet = {}; return sheet; },
    book_new() { return {}; },
    book_append_sheet(w, s, n) { w.sheet = s; w.name = n; }
  } };
  const rows = api.buildRows([base, { ...base, scoutId: '1234560001', date: '2025-12-31' }]);
  const wb = api.workbook(fake, rows);
  assert.equal(wb.name, 'Sheet1');
  assert.equal(wb.sheet, sheet);
  assert.deepEqual(table, [
    ['Scout ID', 'Badge-Section', 'Badge-Badge', 'Badge-award date (YYYYMMDD)'],
    ['0123456789', 'Scout', 'Membership Badge', '20261114'],
    ['1234560001', 'Scout', 'Membership Badge', '20251231']
  ]);
  assert.ok(table.flat().every((cell) => typeof cell === 'string'), '所有儲存格都要係文字');
  assert.equal(api.headers.length, 4, 'workbook() 不可改動原本的表頭陣列');
});

test('index.html wires the export as a leader-only, explicit, beta feature', () => {
  assert.ok(html.includes('<script src="assets/ymis-export.js"></script>'), '要載入 assets/ymis-export.js');
  const start = html.indexOf('/* ---------- YMIS 獎章匯出');
  const end = html.indexOf('function showOverviewSubTab(');
  assert.ok(start >= 0 && end > start, '找不到 YMIS 匯出程式段');
  const code = html.slice(start, end);

  // 領袖專用：入口及兩個函式都要檢查角色
  assert.match(html, /canUserTickRole\(currentUser\.role\)\)\?`<div class="info-section"[^`]*onclick="openYmisExport\(\)"/, '入口只向領袖顯示');
  assert.match(code, /function openYmisExport\(\)\{\s*if\(!currentUser\|\|!canUserTickRole\(currentUser\.role\)\)/);
  assert.match(code, /async function downloadYmisAwards\(\)\{\s*if\(!currentUser\|\|!canUserTickRole\(currentUser\.role\)\)/);

  // 不由考核完成度推斷、不寫回進度、不呼叫後端
  for (const forbidden of ['progressFlat', 'progressRich', 'pendingChanges', 'apiRequest', 'otherBadgesMap', 'todayISO()']) {
    assert.ok(!code.includes(forbidden), `YMIS 匯出不可使用 ${forbidden}`);
  }
  assert.ok(!/id="ymisExportDate_[^"]*"[^>]*\svalue=/.test(code), '獲獎日期不可有預設值');
  assert.ok(code.includes('ymisExportConfirm') && code.includes("t('ymis_need_confirm')"), '下載前必須勾選確認');

  // 外部 SheetJS 以 SRI 固定版本
  assert.ok(code.includes('xlsx/0.18.5/xlsx.full.min.js') && /SHEETJS_SRI='sha512-[A-Za-z0-9+/=]+'/.test(code) && code.includes("s.setAttribute('integrity',SHEETJS_SRI)") && code.includes("s.setAttribute('crossorigin','anonymous')"));
});

test('beta warning and upload path are present in both languages', () => {
  const start = html.indexOf('const I18N={');
  const end = html.indexOf('let currentLang=');
  assert.ok(start >= 0 && end > start, '找不到 I18N 字典');
  const I18N = new Function(html.slice(start, end) + '; return I18N;')();
  const keys = Object.keys(I18N.zh).filter((k) => k.startsWith('ymis_'));
  assert.ok(keys.length >= 15);
  for (const k of keys) assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], `英文缺少 ${k}`);

  assert.ok(I18N.zh.ymis_btn.includes('匯出 YMIS 獎章（試行）'));
  assert.match(I18N.zh.ymis_beta, /試行版/);
  assert.match(I18N.zh.ymis_beta, /尚未以真實資料在 YMIS 實測/);
  assert.match(I18N.zh.ymis_beta, /匯出不代表已匯入/);
  assert.match(I18N.en.ymis_beta, /Beta/);
  assert.match(I18N.en.ymis_beta, /not yet tested in YMIS/);
  assert.match(I18N.en.ymis_beta, /does NOT mean imported/);
  assert.match(I18N.zh.ymis_explicit, /完成考核不等於已頒章/);
  assert.match(I18N.zh.ymis_upload_hint, /成員註冊 → 資料檔案上傳 → 新增支部獎章紀錄/);
  assert.match(I18N.zh.ymis_upload_hint, /不會偵測跨次重複上傳/);
  assert.match(I18N.zh.ymis_done, /尚未確認已匯入 YMIS/);
  assert.match(I18N.en.ymis_done, /NOT confirmed/);
});

test('documentation keeps the beta boundary', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'YMIS_BADGE_EXPORT.md'), 'utf8');
  for (const s of ['試行', '尚無真實資料在 YMIS 驗證', '匯出不等於匯入成功', '新增支部獎章紀錄', ...api.headers, ...BADGES]) {
    assert.ok(doc.includes(s), `docs/YMIS_BADGE_EXPORT.md 缺少：${s}`);
  }
});
