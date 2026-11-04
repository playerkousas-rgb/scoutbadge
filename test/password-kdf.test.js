'use strict';

/*
 * 密碼 KDF 成本與「後端服務連線逾時」回歸測試（GS 6.4.0）
 *
 * 背景（2026-11-04，旅團 1187 事故）：
 *   GS 6.2.0／6.3.0 把密碼雜湊改成 PBKDF2-HMAC-SHA256 120,000 次迭代。Apps Script
 *   每次 Utilities.computeHmacSha256Signature() 都要過 JS↔Java 邊界，120,000 次要
 *   20–40 秒；Vercel proxy 對上游只等 25 秒（舊版），所以**所有密碼登入**都回
 *   「後端服務連線逾時，請稍後再試」。中央 sheep 登入免密碼核對（用短效票），
 *   所以出現「超管入得、一般帳號入唔到」，同 API Key 完全無關。
 *
 * 本測試鎖住四件事：
 *   1. 新寫入的雜湊迭代次數必須落在「Apps Script 一次請求做得完」的預算內。
 *   2. 舊格式（pbkdf2$120000$ 及 64-hex SHA-256）仍然驗證得到，唔會鎖死用戶。
 *   3. 舊雜湊帳號成功登入後會自動改寫成本版格式（只做一次慢登入）。
 *   4. 一次成功登入只做一個 KDF（唔會因為「是否預設密碼」再做第二次）。
 *   5. Sheet 選單救援工具可以把舊雜湊帳號即時改寫，唔需要登入 App。
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gasvm');

const ROOT = path.join(__dirname, '..');
const CODE_GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const PROXY_SRC = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const API_KEY = 'sc_kdf_regression_key';

const KDF_ITERATIONS = Number((CODE_GS_SRC.match(/const PBKDF2_ITERATIONS = (\d+);/) || [])[1]);
const LEGACY_KDF_ITERATIONS = 120000;

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  [PASS] ${label}`);
}

function sha256HexNode(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function legacyPbkdf2Hash(pw, saltHex, iter) {
  const dk = crypto.pbkdf2Sync(Buffer.from(String(pw), 'utf8'), Buffer.from(saltHex, 'hex'), iter, 32, 'sha256').toString('hex');
  return `pbkdf2$${iter}$${saltHex}$${dk}`;
}

function getUserRow(gas, scoutId) {
  const rows = gas.sheets.get('Users')._rows;
  const headers = rows[0].map((h) => String(h).trim());
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(scoutId)) {
      const obj = { _rowNumber: i + 1 };
      headers.forEach((h, idx) => { obj[h] = rows[i][idx]; });
      return obj;
    }
  }
  return null;
}

function countHmac(gas) {
  const counter = { calls: 0 };
  const orig = gas.sandbox.Utilities.computeHmacSha256Signature;
  gas.sandbox.Utilities.computeHmacSha256Signature = function (v, k) {
    counter.calls += 1;
    return orig(v, k);
  };
  return counter;
}

console.log('=== Password KDF Budget / Timeout Regression (GS 6.4.0, 旅團 1187) ===\n');

// ---------------------------------------------------------------------------
// 1. 迭代次數預算
// ---------------------------------------------------------------------------
console.log('1. 迭代次數必須在 Apps Script 單次請求預算內');
{
  assert.ok(KDF_ITERATIONS > 0, 'Code.gs 必須宣告 PBKDF2_ITERATIONS');
  assert.ok(
    KDF_ITERATIONS <= 20000,
    `PBKDF2_ITERATIONS=${KDF_ITERATIONS} 太大：Apps Script 每次 HMAC 約 0.1–0.3ms，` +
    '超過 20,000 次就會逼近 Vercel proxy 的上游逾時（會再出現「後端服務連線逾時」）'
  );
  assert.ok(KDF_ITERATIONS >= 5000, '迭代次數亦不可低到失去慢雜湊的意義');
  const min = Number((CODE_GS_SRC.match(/const PBKDF2_MIN_ITERATIONS = (\d+);/) || [])[1]);
  const max = Number((CODE_GS_SRC.match(/const PBKDF2_MAX_ITERATIONS = (\d+);/) || [])[1]);
  assert.ok(min > 0 && min <= KDF_ITERATIONS, 'PBKDF2_MIN_ITERATIONS 必須 ≤ 本版迭代次數，否則新雜湊驗證不到自己');
  assert.ok(max >= LEGACY_KDF_ITERATIONS, 'PBKDF2_MAX_ITERATIONS 必須 ≥ 120,000，否則舊雜湊驗證不到');
  ok(`本版 ${KDF_ITERATIONS} 次；驗證接受 ${min}–${max} 次（同時覆蓋舊 120,000 次）`);
}

// ---------------------------------------------------------------------------
// 2. 舊雜湊仍然驗證得到（唔會鎖死既有帳號）
// ---------------------------------------------------------------------------
console.log('\n2. 舊格式雜湊仍然驗證得到');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const oldHash = legacyPbkdf2Hash('OldPass#1187', salt, LEGACY_KDF_ITERATIONS);
  assert.strictEqual(gas.sandbox.verifyPassword('OldPass#1187', oldHash), true, '舊 pbkdf2$120000$ 必須仍然驗證成功');
  assert.strictEqual(gas.sandbox.verifyPassword('Wrong', oldHash), false);

  const legacyHex = sha256HexNode('VeryOldPass');
  assert.strictEqual(gas.sandbox.verifyPassword('VeryOldPass', legacyHex), true, '舊 64-hex SHA-256 必須仍然驗證成功');

  // 荒謬的迭代次數（可能被改大拖死後端）一律拒絕
  assert.strictEqual(gas.sandbox.verifyPassword('x', `pbkdf2$9000000$${salt}$${'0'.repeat(64)}`), false);
  assert.strictEqual(gas.sandbox.verifyPassword('x', `pbkdf2$1$${salt}$${'0'.repeat(64)}`), false);
  ok('舊 pbkdf2$120000$、舊 64-hex 照樣驗證；超出範圍的迭代次數被拒絕');
}

// ---------------------------------------------------------------------------
// 3. 舊雜湊帳號登入一次就自動改寫（之後唔再慢）
// ---------------------------------------------------------------------------
console.log('\n3. 舊雜湊帳號登入成功後自動改寫為本版雜湊');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  const salt = 'ffeeddccbbaa99887766554433221100';
  const oldHash = legacyPbkdf2Hash('MigratingPass#1', salt, LEGACY_KDF_ITERATIONS);
  assert.strictEqual(gas.post({
    action: 'upsertUser', apikey: API_KEY,
    user: { scoutId: '1234500001', name: '舊雜湊成員', role: 'member', password_hash: oldHash }
  }).success, true);
  assert.strictEqual(getUserRow(gas, '1234500001').password_hash, oldHash);

  const login = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500001', password: 'MigratingPass#1' });
  assert.strictEqual(login.success, true, '舊 120,000 次雜湊的帳號必須登入得到');
  const after = getUserRow(gas, '1234500001').password_hash;
  assert.strictEqual(
    Number(gas.sandbox.storedHashIterations_(after)),
    KDF_ITERATIONS,
    '登入成功後必須改寫成本版迭代次數（只慢一次）'
  );
  assert.notStrictEqual(after, oldHash, '必須實際寫入新雜湊（另有新隨機鹽）');
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500001', password: 'MigratingPass#1' }).success, true);

  // 已經是本版格式就不要每次登入都重寫
  const stable = getUserRow(gas, '1234500001').password_hash;
  gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500001', password: 'MigratingPass#1' });
  assert.strictEqual(getUserRow(gas, '1234500001').password_hash, stable, '本版格式不應每次登入重寫');
  ok('舊雜湊 → 登入一次 → 改寫為本版格式；本版格式不再重寫');
}

// ---------------------------------------------------------------------------
// 4. 一次成功登入只做一個 KDF（唔可以有第二次「預設密碼」核對）
// ---------------------------------------------------------------------------
console.log('\n4. 一次登入只做一個 KDF');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();
  gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234500002', name: '正常成員', email: 'kdf2@troop.org', role: 'member', password: 'MemberPass#2'
  });
  // 先登入一次（建立 session 之外的狀態），並確認 dummy 快取已熱
  gas.post({ action: 'login', apikey: API_KEY, login_id: '9999999998', password: 'x' });

  const counter = countHmac(gas);
  const r = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500002', password: 'MemberPass#2' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(
    counter.calls,
    KDF_ITERATIONS,
    `成功登入只應做 ${KDF_ITERATIONS} 次 HMAC（實際 ${counter.calls}）：` +
    '多一次就代表又做了「是否預設密碼」的額外 PBKDF2，登入時間會翻倍'
  );
  ok(`成功登入 = ${counter.calls} 次 HMAC（單一 KDF，等於一次 PBKDF2）`);

  // 失敗／不存在的帳號亦只做一個 dummy KDF
  const counter2 = countHmac(gas);
  gas.post({ action: 'login', apikey: API_KEY, login_id: '1234599999', password: 'x' });
  assert.strictEqual(counter2.calls, KDF_ITERATIONS, '不存在帳號亦只做一次 dummy KDF');
  ok('不存在帳號／錯密碼 = 一次 dummy KDF');
}

// ---------------------------------------------------------------------------
// 5. Sheet 選單救援重設（唔需要登入 App）
// ---------------------------------------------------------------------------
console.log('\n5. Sheet 選單救援重設舊雜湊帳號');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  const salt = '0123456789abcdef0123456789abcdef';
  const oldHash = legacyPbkdf2Hash('StuckPass#1187', salt, LEGACY_KDF_ITERATIONS);
  gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234500003', name: '預設帳號', email: 'first@troop1187.org', role: 'member', password: 'StuckPass#1187'
  });
  // 模擬 GS 6.3.0 遺留的 120,000 次雜湊 + 錯密鎖定
  gas.post({ action: 'setPw', apikey: API_KEY, scoutId: '1234500003', password_hash: oldHash });
  for (let i = 0; i < 5; i += 1) {
    gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500003', password: 'wrong' });
  }
  const locked = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500003', password: 'StuckPass#1187' });
  assert.strictEqual(locked.success, false, '先確認帳號真的被鎖');

  // 用電郵亦可（大小寫／前後空白不敏感）
  const r = gas.sandbox.forceResetUserPasswordFromSheet('  First@Troop1187.org ', 'NewTemp#1187');
  assert.strictEqual(r.success, true, `救援重設應成功：${r.error || ''}`);
  const row = getUserRow(gas, '1234500003');
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(row.password_hash)), KDF_ITERATIONS, '救援重設必須寫入本版雜湊');
  assert.strictEqual(row.force_change_password, true, '救援重設後必須強制改密');
  assert.strictEqual(gas.sandbox.verifyPassword('NewTemp#1187', row.password_hash), true);

  const relogin = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234500003', password: 'NewTemp#1187' });
  assert.strictEqual(relogin.success, true, '救援重設後必須即時登入得到（錯密鎖定亦已清除）');
  assert.strictEqual(relogin.force_change_password, true);

  assert.strictEqual(gas.sandbox.forceResetUserPasswordFromSheet('nobody-here', 'SomePass#1').success, false, '找不到帳號要明確失敗');
  assert.strictEqual(gas.sandbox.forceResetUserPasswordFromSheet('1234500003', 'ab').success, false, '太短的新密碼要拒絕');
  assert.strictEqual(gas.sandbox.forceResetUserPasswordFromSheet('sheep', 'SomePass#1').success, false, '中央保留帳號不可在 Sheet 重設');
  ok('救援重設：寫入本版雜湊、解除鎖定、強制改密、拒絕未知帳號／短密碼／保留帳號');
}

// ---------------------------------------------------------------------------
// 6. Proxy／前端逾時預算：舊雜湊第一次登入仍有機會完成
// ---------------------------------------------------------------------------
console.log('\n6. Proxy 對密碼類 action 的逾時預算');
{
  const upstream = Number((PROXY_SRC.match(/const UPSTREAM_TIMEOUT_MS = ([\d_]+);/) || [])[1].replace(/_/g, ''));
  const password = Number((PROXY_SRC.match(/const PASSWORD_TIMEOUT_MS = ([\d_]+);/) || [])[1].replace(/_/g, ''));
  assert.ok(upstream > 0 && password > 0, 'proxy 必須宣告兩個逾時常數');
  assert.ok(password > 25000, `密碼類 action 的逾時必須大於 25 秒（實際 ${password}），否則舊 120,000 次雜湊第一次登入必定 504`);
  assert.ok(password >= 40000, '舊雜湊最壞情況要 40 秒，逾時應留到 45 秒左右');
  assert.ok(password < 60000, '不可超過 Vercel function maxDuration（60 秒）');
  assert.match(PROXY_SRC, /PASSWORD_ACTIONS\.has\(action\)/, '必須按 action 選擇逾時');
  assert.match(PROXY_SRC, /'login'/, 'PASSWORD_ACTIONS 必須包含 login');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const maxDuration = vercel.functions['api/proxy.js'].maxDuration;
  assert.ok(password < maxDuration * 1000, 'proxy 逾時必須留在 maxDuration 之內');
  // 前端要等得比 proxy 久，否則用戶在後端完成前就被前端 abort
  assert.match(
    INDEX_SRC,
    /apiRequest\('login', \{ login_id: lid, password: pw \}, \{ troopId: currentTroopId, timeout: 50000 \}\)/,
    '登入請求必須傳入比 proxy 更長的 timeout（50 秒）'
  );
  ok(`proxy：一般 ${upstream / 1000}s／密碼類 ${password / 1000}s；前端登入等 50s；maxDuration ${maxDuration}s`);
}

// ---------------------------------------------------------------------------
// 7. 前線可見性：未更新的旅團要自己見到「登入會逾時」，唔使等投訴
// ---------------------------------------------------------------------------
console.log('\n7. 前端按後端版本標示「此版本登入會逾時」；proxy 記錄慢登入');
{
  const compareSrc = (INDEX_SRC.match(/function compareVersions\([\s\S]*?\n\}/) || [''])[0];
  const warnSrc = (INDEX_SRC.match(/function gsSlowLoginWarning\([\s\S]*?\n\}/) || [''])[0];
  assert.ok(compareSrc && warnSrc, 'index.html 必須提供 compareVersions 及 gsSlowLoginWarning');
  assert.match(INDEX_SRC, /const GS_SLOW_LOGIN_FROM = '6\.2\.0';/, '受影響版本起點必須是 6.2.0（PBKDF2 120,000 首次引入）');
  assert.match(INDEX_SRC, /const GS_SLOW_LOGIN_FIXED = '6\.4\.0';/, '修好版本必須是 6.4.0');
  assert.strictEqual(
    (INDEX_SRC.match(/const slowWarn = gsSlowLoginWarning\(st, inEn\);/g) || []).length,
    2,
    '首頁／登入頁及主畫面兩處 notice 都要顯示'
  );

  // 直接執行抽出的前端函式，確認只有 6.2.x／6.3.x 會標紅
  const constSrc = (INDEX_SRC.match(/const GS_SLOW_LOGIN_FROM = '[^']+';\nconst GS_SLOW_LOGIN_FIXED = '[^']+';/) || [''])[0];
  assert.ok(constSrc, '必須抽出兩個版本界線常數');
  const build = new Function('GS_LATEST', constSrc + '\n' + compareSrc + '\n' + warnSrc + '\nreturn gsSlowLoginWarning;');
  const warn = build({ gsVersion: '6.4.0' });
  const zh = () => false;
  const en = () => true;
  assert.match(warn({ gsVersion: '6.2.0' }, zh), /後端服務連線逾時/, '6.2.0 必須標示登入逾時');
  assert.match(warn({ gsVersion: '6.3.0' }, zh), /後端服務連線逾時/, '6.3.0 必須標示登入逾時');
  assert.match(warn({ gsVersion: '6.3.0' }, en), /timed out/i, '英文版亦要有同樣提示');
  assert.strictEqual(warn({ gsVersion: '6.1.0' }, zh), '', '6.1.0（單次 SHA-256）不應被標示');
  assert.strictEqual(warn({ gsVersion: '6.4.0' }, zh), '', '已修正版本不應被標示');
  assert.strictEqual(warn({}, zh), '', '未回報版本時不應亂標示');
  ok('登入頁／首頁／主畫面只對 GS 6.2.x／6.3.x 顯示「此版本登入會逾時」');

  assert.match(PROXY_SRC, /const SLOW_LOGIN_MS = 8_000;/, 'proxy 必須有慢登入門檻');
  assert.match(PROXY_SRC, /\[proxy\] slow_password_kdf troop=/, 'proxy 必須輸出可供 grep 的 slow_password_kdf 記錄');
  assert.match(PROXY_SRC, /duration=\$\{duration\}ms/, '一般 logResult 亦要記錄 duration（分鐘級排查靠它）');
  ok('proxy 對超過 8 秒的登入／改密／重設輸出 slow_password_kdf（可按 troop grep 出未更新的旅團）');
}

console.log(`\n=== Password KDF 回歸測試全部通過（共 ${passed} 項） ===`);
