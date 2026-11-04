'use strict';

/*
 * YMIS → SCOUT ID 改名相容測試（GS 6.5.0）
 *
 * 背景：YMIS 是童軍總會的青少年會員資料系統；當中那 10 位數字是童軍成員編號 SCOUT ID。
 * 系統自此一律叫 SCOUT ID，並跟 ROVERBOOK／ROVERBADGE 用同一個 JSON 欄位名 scoutId。
 *
 * 但既有旅團的 Sheet 表頭仍然係 ymis／YMIS，舊上游（旅系統）、舊匯出檔、舊 BADGE 亦仍然
 * 會送／讀 ymis。所以本測試守住四件事：
 *   1. 新安裝：Users 等資料表用 scout_id；API 用 scoutId。
 *   2. 舊輸入：ymis、target_ymis 仍然接受（等同 scoutId）。
 *   3. 舊輸出：回應同時附 ymis 鏡像（舊系統照樣讀得懂）。
 *   4. 舊 Sheet：表頭仍然係 ymis／YMIS 的既有旅團，寫入、讀取、匯入、匯出全部照常運作。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gasvm');

const ROOT = path.join(__dirname, '..');
const CODE_GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const BATCH_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'batch-onboard', 'Code.gs'), 'utf8');
const API_KEY = 'sc_scout_id_compat_key';

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  [PASS] ${label}`);
}

function getUserRow(gas, scoutId) {
  const rows = gas.sheets.get('Users')._rows;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(scoutId)) return { row: rows[i], rowNumber: i + 1 };
  }
  return null;
}

console.log('=== YMIS → SCOUT ID 改名相容測試 ===\n');

// ---------------------------------------------------------------------------
// 1. 新安裝：表頭 scout_id、API 欄位 scoutId
// ---------------------------------------------------------------------------
console.log('1. 新安裝用 scout_id／scoutId');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  assert.strictEqual(gas.sheets.get('Users')._rows[0][0], 'scout_id', '新 Users 表頭必須係 scout_id');
  assert.strictEqual(gas.sheets.get('Tokens')._rows[0][1], 'scout_id');
  assert.strictEqual(gas.sheets.get('Applications')._rows[0][1], 'scout_id');
  assert.strictEqual(gas.sheets.get('待批完成')._rows[0][1], 'scout_id');
  assert.strictEqual(gas.sheets.get('活動履歷')._rows[0][2], 'scout_id');
  assert.strictEqual(gas.sheets.get('密碼重設')._rows[0][1], 'scout_id');
  // 人手閱讀的工作表用大寫標籤
  assert.strictEqual(gas.sheets.get('進度追蹤')._rows[0][0], 'SCOUT ID');

  const add = gas.post({ action: 'addUser', apikey: API_KEY, scoutId: '1234560001', name: '陳大文', email: 'a@x.org', role: 'member', password: 'Pass#1234' });
  assert.strictEqual(add.success, true);
  assert.strictEqual(add.scoutId, '1234560001', '回應用 scoutId');
  assert.strictEqual(getUserRow(gas, '1234560001').row[0], '1234560001', 'ID 寫入第一欄');

  const login = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560001', password: 'Pass#1234' });
  assert.strictEqual(login.success, true);
  assert.strictEqual(login.user.scoutId, '1234560001');
  assert.strictEqual(login.user.ymis, '1234560001', '回應必須同時有舊欄位 ymis 鏡像');
  ok('新安裝：scout_id 表頭、scoutId API 欄位、回應附 ymis 鏡像');
}

// ---------------------------------------------------------------------------
// 2. 舊輸入：ymis／target_ymis 仍然接受
// ---------------------------------------------------------------------------
console.log('\n2. 舊欄位輸入（ymis／target_ymis）仍然接受');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  // addUser 用舊 ymis
  const add = gas.post({ action: 'addUser', apikey: API_KEY, ymis: '1234560002', name: '舊欄位成員', email: 'b@x.org', role: 'member', password: 'OldKey#22' });
  assert.strictEqual(add.success, true, 'addUser 必須接受舊 ymis');
  assert.strictEqual(getUserRow(gas, '1234560002').row[0], '1234560002');

  // apply 用舊 ymis
  const apply = gas.post({ action: 'apply', apikey: API_KEY, ymis: '1234560003', name: '申請者', email: 'c@x.org', requested_role: 'member', branch: 'b4' });
  assert.strictEqual(apply.success, true, 'apply 必須接受舊 ymis');

  // 領袖登入後用舊 target_ymis 重設密碼
  const leaderLogin = gas.post({ action: 'login', apikey: API_KEY, login_id: '1111111111', password: 'changeme' });
  assert.strictEqual(leaderLogin.success, true);
  const token = leaderLogin.token;
  const reset = gas.post({ action: 'resetPassword', apikey: API_KEY, token, target_ymis: '1234560002', new_password: 'NewPass#22' });
  assert.strictEqual(reset.success, true, 'resetPassword 必須接受舊 target_ymis');
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560002', password: 'NewPass#22' }).success, true);

  // setPw／setStatus／upsertUser 用舊 ymis
  assert.strictEqual(gas.post({ action: 'setStatus', apikey: API_KEY, token, ymis: '1234560002', status: 'inactive' }).success, true, 'setStatus 必須接受舊 ymis');
  assert.strictEqual(gas.post({ action: 'setStatus', apikey: API_KEY, token, targetScoutId: '1234560002', status: 'active' }).success, true);
  const imp = gas.post({
    action: 'upsertUser', apikey: API_KEY,
    user: { ymis: '1234560004', name: '舊匯入', role: 'member', password_hash: gas.sandbox.hashPassword('ImpPass#44') }
  });
  assert.strictEqual(imp.success, true, 'upsertUser 必須接受舊 user.ymis');
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560004', password: 'ImpPass#44' }).success, true);
  // 批量開戶每筆用舊 ymis 亦要收
  const bulk = gas.post({ action: 'bulkAddUsers', apikey: API_KEY, token, users: [{ ymis: '1234560005', name: '批量舊欄', role: 'member', password: 'Bulk#55' }] });
  assert.strictEqual(bulk.success, true);
  assert.strictEqual(bulk.results[0].scoutId, '1234560005', '批量開戶每筆亦要接受舊 ymis');
  assert.strictEqual(bulk.results[0].ymis, '1234560005', '批量結果附 ymis 鏡像');
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560005', password: 'Bulk#55' }).success, true);
  // 舊版匯出 JSON（ymis 鍵）要可以直接倒返入嚟
  const oldExport = { users: [{ ymis: '1234560006', name: '舊匯出檔', role: 'member', password_hash: gas.sandbox.hashPassword('OldFile#66') }] };
  const impRes = gas.sandbox.importUsersFromText(JSON.stringify(oldExport), 'compat-test');
  assert.strictEqual(impRes.failed, 0, '舊匯出檔（ymis 鍵）必須匯入成功');
  assert.strictEqual(impRes.results[0].scoutId, '1234560006');
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560006', password: 'OldFile#66' }).success, true);
  ok('addUser／apply／resetPassword／setStatus／upsertUser／bulkAddUsers／importUsersFromText 全部接受舊 ymis、target_ymis');
}

// ---------------------------------------------------------------------------
// 3. 舊輸出：清單、匯出、旅系統結果都附 ymis 鏡像
// ---------------------------------------------------------------------------
console.log('\n3. 回應同時提供 scoutId 及 ymis');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();
  gas.post({ action: 'addUser', apikey: API_KEY, scoutId: '1234560010', name: '鏡像測試', email: 'm@x.org', role: 'member', password: 'Mirror#10' });
  const token = gas.post({ action: 'login', apikey: API_KEY, login_id: '1111111111', password: 'changeme' }).token;

  const members = gas.post({ action: 'getMembers', apikey: API_KEY, token });
  const m = members.members.find((x) => x.scoutId === '1234560010');
  assert.ok(m && m.ymis === '1234560010', 'getMembers 每筆都要有 ymis 鏡像');

  // 旅系統上游以 API Key 拉名冊（getRegistrySafe）亦要有鏡像
  const reg = gas.post({ action: 'getRegistrySafe', apikey: API_KEY });
  const r0 = reg.members.find((x) => x.scoutId === '1234560010');
  assert.ok(r0 && r0.ymis === '1234560010', 'getRegistrySafe 每筆都要有 ymis 鏡像');

  const all = gas.post({ action: 'getAllUsers', apikey: API_KEY, token });
  const u = all.users.find((x) => x.scoutId === '1234560010');
  assert.ok(u && u.ymis === '1234560010', 'getAllUsers 每筆都要有 ymis 鏡像');

  const exp = gas.post({ action: 'exportUsers', apikey: API_KEY, token });
  const e = exp.users.find((x) => x.scoutId === '1234560010');
  assert.ok(e && e.ymis === '1234560010', 'exportUsers 每筆都要有 ymis 鏡像（舊系統匯入得）');
  ok('getMembers／getAllUsers／exportUsers 同時提供 scoutId 及 ymis');
}

// ---------------------------------------------------------------------------
// 4. 既有旅團（舊表頭 ymis／YMIS）一切照常
// ---------------------------------------------------------------------------
console.log('\n4. 舊 Sheet 表頭（ymis／YMIS）照常讀寫');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();
  // 模擬 6.4.0 或之前的既有旅團：Users 第一欄叫 ymis
  gas.sheets.get('Users')._rows[0][0] = 'ymis';
  gas.sheets.get('密碼重設')._rows[0][1] = 'ymis';

  const add = gas.post({ action: 'addUser', apikey: API_KEY, scoutId: '1234560020', name: '舊表頭成員', email: 'old@x.org', role: 'member', password: 'OldHead#20' });
  assert.strictEqual(add.success, true);
  assert.strictEqual(getUserRow(gas, '1234560020').row[0], '1234560020', '舊表頭下 ID 一樣要寫入第一欄');

  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560020', password: 'OldHead#20' }).success, true);

  const token = gas.post({ action: 'login', apikey: API_KEY, login_id: '1111111111', password: 'changeme' }).token;
  const exp = gas.post({ action: 'exportUsers', apikey: API_KEY, token });
  assert.ok(exp.users.some((x) => x.scoutId === '1234560020'), '舊表頭下匯出仍然搵到成員');

  // 旅系統讀取（以表頭文字定位欄位）亦要認得舊 ymis
  const rec = gas.sandbox.linkReadUserRow('1234560020');
  assert.ok(rec, 'linkReadUserRow 必須認得舊 ymis 表頭');
  assert.strictEqual(String(rec.data[rec.map.scoutId]), '1234560020');

  // 密碼重設表：舊表頭唔應該被加一個 scout_id 空欄
  const resetHeaders = gas.sheets.get('密碼重設')._rows[0].map((h) => String(h).trim());
  assert.strictEqual(resetHeaders.filter((h) => /^(ymis|scout_id|scoutId)$/i.test(h)).length, 1, '密碼重設表唔可以出現兩個 ID 欄');
  ok('舊表頭：寫入、登入、匯出、旅系統讀取、密碼重設表全部照常');
}

// ---------------------------------------------------------------------------
// 5. CSV 範本與解析
// ---------------------------------------------------------------------------
console.log('\n5. CSV 範本用 scout_id，並同時接受舊 ymis 表頭');
{
  const csv = fs.readFileSync(path.join(ROOT, 'data', 'members_template.csv'), 'utf8').split('\n')[0];
  assert.strictEqual(csv.trim().split(',')[0], 'scout_id', 'data/members_template.csv 首欄必須係 scout_id');
  assert.match(INDEX_SRC, /const csv='scout_id,name,email,squad/, '前端下載的範本首欄必須係 scout_id');
  assert.match(INDEX_SRC, /normCsvHeader/, '前端必須有 CSV 表頭相容處理');
  assert.match(INDEX_SRC, /k==='scoutid'\|\|k==='ymis'/, 'CSV 表頭 ymis／scout_id／scoutId 都要認');

  // 實際執行前端 parseMemberCSV（抽出函式在 vm 內跑）
  const fnSrc = (INDEX_SRC.match(/function parseMemberCSV\(text\)\{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(fnSrc, 'index.html 必須有 parseMemberCSV');
  const parse = new Function(fnSrc + '\nreturn parseMemberCSV;')();
  const modern = parse('scout_id,name,email,role\n1234560030,新範本,a@x.org,member');
  const legacy = parse('ymis,name,email,role\n1234560031,舊範本,b@x.org,member');
  const human = parse('SCOUT ID,姓名,電郵,角色\n1234560032,人手表,c@x.org,member');
  assert.strictEqual(modern[0].scoutId, '1234560030');
  assert.strictEqual(legacy[0].scoutId, '1234560031', '舊 ymis 表頭 CSV 必須讀得入');
  assert.strictEqual(human[0].scoutId, '1234560032', '人手打的 SCOUT ID 表頭亦要讀得入');
  ok('CSV：新範本 scout_id、舊 ymis、人手 SCOUT ID 表頭全部讀得入');
}

// ---------------------------------------------------------------------------
// 6. 批量開戶（batch-onboard）亦同步
// ---------------------------------------------------------------------------
console.log('\n6. 批量開戶腳本同步');
{
  assert.match(BATCH_SRC, /var USERS_HEADER = \['scout_id','name'/, '批量開戶新表用 scout_id');
  assert.match(BATCH_SRC, /function isScoutIdHeader_/, '批量開戶要認得舊 ymis 表頭');
  assert.match(BATCH_SRC, /var scoutIdCol = scoutIdColumnIndex_\(headers\);/, '批量開戶以相容方式定位 ID 欄');
  ok('批量開戶：新表 scout_id、舊表 ymis 均寫得入');
}

// ---------------------------------------------------------------------------
// 7. 程式碼不再用 YMIS 做識別名（只保留相容層）
// ---------------------------------------------------------------------------
console.log('\n7. 程式碼命名清理');
{
  assert.doesNotMatch(CODE_GS_SRC, /normalizeYmis|findUsersAccountByYmis|findRosterAccountByYmis|function getUserByYmis/, '舊識別名必須清除');
  assert.doesNotMatch(INDEX_SRC, /window\.YmisParse|ymis-parse/, '舊檔案／全域名必須清除');
  assert.match(CODE_GS_SRC, /function aliasLegacyScoutId_/, '必須有輸入相容層');
  assert.match(CODE_GS_SRC, /function withLegacyScoutId_/, '必須有輸出鏡像');
  assert.match(CODE_GS_SRC, /function scoutIdColumnIndex_/, '必須有表頭相容');
  // 剩下的 ymis 只可以在相容層／舊鍵讀取出現，唔可以散落業務邏輯
  const leftovers = CODE_GS_SRC.split('\n').filter((l) => /\bymis\b|\bYMIS\b/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  const allowed = /(aliasLegacyScoutId_|withLegacyScoutId_|isScoutIdHeader_|target_ymis|'ymis'|\.ymis|\bYMIS\b)/;
  const stray = leftovers.filter((l) => !allowed.test(l));
  assert.deepStrictEqual(stray, [], '不應再有散落的 ymis 業務邏輯：\n' + stray.join('\n'));
  ok('Code.gs 只剩相容層讀寫 ymis，其餘全部叫 scoutId');
}

console.log(`\n=== YMIS → SCOUT ID 改名相容測試全部通過（共 ${passed} 項） ===`);
