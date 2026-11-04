'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeGas } = require('./gasvm');

const API_KEY = 'sc_auth_hardening_key_2026';

// GS 6.4.0：120,000 → 10,000（Apps Script 每次 HMAC 都要過 JS↔Java 邊界，120,000 次要
// 20–40 秒，會撞 Vercel proxy 25 秒上游上限）。測試一律由原始碼讀出，避免再硬編碼。
const CODE_GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const KDF_ITERATIONS = Number((CODE_GS_SRC.match(/const PBKDF2_ITERATIONS = (\d+);/) || [])[1]);
const LEGACY_KDF_ITERATIONS = 120000;
assert.ok(KDF_ITERATIONS > 0, 'Code.gs 必須宣告 PBKDF2_ITERATIONS');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  [PASS] ${label}`);
}

function sha256HexNode(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function pbkdf2HexNode(pw, saltHex, iter) {
  return crypto.pbkdf2Sync(Buffer.from(String(pw), 'utf8'), Buffer.from(saltHex, 'hex'), iter, 32, 'sha256').toString('hex');
}

function getUserRow(gas, scoutId) {
  const sh = gas.sheets.get('Users');
  const rows = sh._rows;
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

function signUpstreamBody(body, apiKey) {
  const ts = Date.now();
  const nonce = 'nonce_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const copy = {};
  Object.keys(body).sort().forEach((k) => {
    if (k !== 'sig' && k !== 'sig_ts' && k !== 'sig_nonce') copy[k] = body[k];
  });
  const bodyHash = sha256HexNode(JSON.stringify(copy));
  const msg = [String(body.action || ''), String(ts), nonce, bodyHash].join('\n');
  const sig = crypto.createHmac('sha256', apiKey).update(msg, 'utf8').digest('hex');
  return { ...body, sig_ts: ts, sig_nonce: nonce, sig };
}

console.log('=== Auth Hardening Test Suite (A3 / A5 / A17 / Role Reset Matrix) ===\n');

// ---------------------------------------------------------------------------
// 1. A3 PBKDF2-HMAC-SHA256 Vectors, Per-User Random Salt & Legacy Auto-Upgrade
// ---------------------------------------------------------------------------
console.log('1. A3 PBKDF2-HMAC-SHA256 密碼雜湊、全寫入入口與舊版 64-hex 平滑升級');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  // Cross-verify against Node crypto.pbkdf2Sync across ASCII, Cantonese UTF-8, and % symbols
  for (const samplePw of ['Scout2026!', '香港童軍總領袖獎章🔥', '100%Safe$Pass#']) {
    const h1 = gas.sandbox.hashPassword(samplePw);
    const h2 = gas.sandbox.hashPassword(samplePw);
    assert.notStrictEqual(h1, h2, '相同密碼必須產生不同 16-byte 隨機鹽');
    const m = h1.match(/^pbkdf2\$(\d+)\ encompassing?|^pbkdf2\$(\d+)\$([0-9a-f]{32})\$([0-9a-f]{64})$/);
    assert.ok(m, `雜湊格式不符 pbkdf2$<iter>$<salt>$<dk>: ${h1}`);
    assert.strictEqual(Number(m[2]), KDF_ITERATIONS, `迭代次數必須為 ${KDF_ITERATIONS}`);
    assert.strictEqual(m[4], pbkdf2HexNode(samplePw, m[3], KDF_ITERATIONS), 'PBKDF2 衍生金鑰必須與標準 Node crypto.pbkdf2Sync 完全一致');
    assert.strictEqual(gas.sandbox.verifyPassword(samplePw, h1), true);
    assert.strictEqual(gas.sandbox.verifyPassword(samplePw + 'x', h1), false);
  }
  ok(`Code.gs PBKDF2-HMAC-SHA256（${KDF_ITERATIONS} iter + 16B salt）與 Node crypto 標準向量完全一致（含中文／符號）`);

  // Verify assets/batch-onboard/Code.gs hashPassword also produces exact PBKDF2-HMAC-SHA256
  const batchCtx = {
    Utilities: gas.sandbox.Utilities,
    SpreadsheetApp: gas.sandbox.SpreadsheetApp,
    UrlFetchApp: gas.sandbox.UrlFetchApp,
    Date, Math, String, Number, Boolean, Array, Object, JSON, parseInt
  };
  vm.createContext(batchCtx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'assets', 'batch-onboard', 'Code.gs'), 'utf8'),
    batchCtx,
    { filename: 'assets/batch-onboard/Code.gs' }
  );
  const bh = batchCtx.hashPassword('BatchPass#82');
  const bm = bh.match(/^pbkdf2\$(\d+)\$([0-9a-f]{32})\$([0-9a-f]{64})$/);
  assert.ok(bm, `batch-onboard 雜湊格式必須為 pbkdf2$<iter>$: ${bh}`);
  assert.strictEqual(Number(bm[1]), KDF_ITERATIONS, 'batch-onboard 的迭代次數必須同主 Code.gs 一致');
  assert.strictEqual(bm[3], pbkdf2HexNode('BatchPass#82', bm[2], KDF_ITERATIONS));
  assert.strictEqual(gas.sandbox.verifyPassword('BatchPass#82', bh), true);
  ok(`assets/batch-onboard/Code.gs 寫入主表同樣使用 PBKDF2-HMAC-SHA256（${KDF_ITERATIONS} iter，與主 Code.gs 一致）`);

  // Default admin seeded by initializeSheets uses PBKDF2
  const adminRow = getUserRow(gas, '1111111111');
  assert.match(adminRow.password_hash, new RegExp(`^pbkdf2\\$${KDF_ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`));

  // Create leader & get token to test all password-setting paths
  assert.strictEqual(gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234560010', name: '團長甲', email: 'gsl@troop.org', role: 'group_leader', password: 'GslInit!1'
  }).success, true);
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(getUserRow(gas, '1234560010').password_hash)), KDF_ITERATIONS);

  const gslLogin = gas.post({ action: 'login', apikey: API_KEY, login_id: 'gsl@troop.org', password: 'GslInit!1' });
  assert.strictEqual(gslLogin.success, true);

  // Bulk onboarding writes PBKDF2
  assert.strictEqual(gas.post({
    action: 'bulkAddUsers', apikey: API_KEY, token: gslLogin.token,
    users: [{ scoutId: '1234560011', name: '批量成員', role: 'member', password: 'Bulk!123' }]
  }).created, 1);
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(getUserRow(gas, '1234560011').password_hash)), KDF_ITERATIONS);

  // Application + approval writes PBKDF2
  assert.strictEqual(gas.post({
    action: 'apply', apikey: API_KEY,
    scoutId: '1234560012', name: '申請成員', email: 'app12@troop.org', requested_role: 'member', branch: '紅隊'
  }).success, true);
  const apps = gas.post({ action: 'getApplications', apikey: API_KEY, token: gslLogin.token });
  const appId = apps.applications.find((a) => a.scoutId === '1234560012').app_id;
  assert.strictEqual(gas.post({
    action: 'reviewApplication', apikey: API_KEY, token: gslLogin.token,
    app_id: appId, decision: 'approved', final_role: 'member', temp_password: 'Approve!9'
  }).success, true);
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(getUserRow(gas, '1234560012').password_hash)), KDF_ITERATIONS);

  // setPw plaintext writes PBKDF2; setPw with legacy 64-hex preserves hash for migration; Login auto-upgrades legacy 64-hex!
  const legacyPw = 'LegacyScout2024';
  const legacyHex = sha256HexNode(legacyPw);
  assert.strictEqual(gas.post({
    action: 'setPw', apikey: API_KEY, scoutId: '1234560011', password_hash: legacyHex
  }).success, true);
  assert.strictEqual(getUserRow(gas, '1234560011').password_hash, legacyHex);

  // Wrong password on legacy hash must NOT upgrade or alter hash
  const badLegacy = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560011', password: 'WrongPassword' });
  assert.strictEqual(badLegacy.success, false);
  assert.strictEqual(getUserRow(gas, '1234560011').password_hash, legacyHex, '密碼錯誤時不可改動舊 hash');

  // Correct password on legacy hash logs in AND transparently upgrades to PBKDF2 v2!
  const okLegacy = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560011', password: legacyPw });
  assert.strictEqual(okLegacy.success, true);
  const upgradedHash = getUserRow(gas, '1234560011').password_hash;
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(upgradedHash)), KDF_ITERATIONS, '舊 64-hex 帳號成功登入後須自動升級為本版 PBKDF2');
  assert.match(upgradedHash, /^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  // Second login with same password still works against upgraded PBKDF2 hash
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560011', password: legacyPw }).success, true);
  ok('所有設密入口均寫 PBKDF2；舊版 64-hex 登入成功自動平滑升級為 PBKDF2 且原密碼不變');

  // upsertUser accepts both v2 PBKDF2 and legacy 64-hex, rejects invalid hash
  const v2Hash = gas.sandbox.hashPasswordV2('ImportV2Pass');
  assert.strictEqual(gas.post({
    action: 'upsertUser', apikey: API_KEY,
    user: { scoutId: '1234560013', name: '匯入V2', role: 'member', password_hash: v2Hash }
  }).success, true);
  assert.strictEqual(gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560013', password: 'ImportV2Pass' }).success, true);

  assert.strictEqual(gas.post({
    action: 'upsertUser', apikey: API_KEY,
    user: { scoutId: '1234560014', name: '壞雜湊', role: 'member', password_hash: 'not-a-valid-hash' }
  }).success, false);
  ok('upsertUser 同時相容 PBKDF2 新格式與舊 64-hex 格式，並拒絕無效 hash');
}

// ---------------------------------------------------------------------------
// 2. A5 Login Lockout (5 fails -> 15 min) & Session Invalidation on changePassword
// ---------------------------------------------------------------------------
console.log('\n2. A5 連續 5 次錯密鎖定 15 分鐘與自行改密踢走其他舊 session');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();
  gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234560021', name: '測試鎖定成員', email: 'lock21@troop.org', role: 'member', password: 'Correct#21'
  });

  // 4 failures -> generic error, not locked yet
  for (let i = 1; i <= 4; i++) {
    const r = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560021', password: 'Wrong#' + i });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.error, '帳號或密碼錯誤');
  }
  // 5th failure -> triggers 15-minute lock + audit log 'login_locked'
  const r5 = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560021', password: 'Wrong#5' });
  assert.strictEqual(r5.success, false);
  assert.match(r5.error, /15 分鐘/);
  const lockProp = JSON.parse(gas.props.get('LOGIN_FAIL:1234560021'));
  assert.strictEqual(lockProp.count, 5);
  assert.ok(lockProp.lockedUntil > Date.now());

  const auditRows = gas.sheets.get('操作紀錄')._rows;
  assert.ok(auditRows.some((row) => row[2] === 'login_locked' && row[3] === '1234560021'), '必須寫入 login_locked 審計紀錄');

  // Even CORRECT password during lock window is rejected!
  const duringLock = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560021', password: 'Correct#21' });
  assert.strictEqual(duringLock.success, false);
  assert.match(duringLock.error, /分鐘後再試/);

  // Simulate 15 minutes elapsed -> correct password succeeds and clears LOGIN_FAIL
  gas.props.set('LOGIN_FAIL:1234560021', JSON.stringify({ count: 5, lockedUntil: Date.now() - 1000 }));
  const afterUnlock = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560021', password: 'Correct#21' });
  assert.strictEqual(afterUnlock.success, true);
  assert.strictEqual(gas.props.has('LOGIN_FAIL:1234560021'), false, '成功登入後須清除 LOGIN_FAIL 紀錄');
  ok('連續 5 次錯密鎖定 15 分鐘、鎖定期內連正確密碼亦拒、寫入 login_locked 審計、到期後登入自動清零');

  // Multi-session invalidation on changePassword: keep current token, kick all other sessions
  gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234560022', name: '多裝置領袖', email: 'multi@troop.org', role: 'branch_leader', password: 'OldLeader#1'
  });
  const devA = gas.post({ action: 'login', apikey: API_KEY, login_id: 'multi@troop.org', password: 'OldLeader#1' });
  const devB = gas.post({ action: 'login', apikey: API_KEY, login_id: 'multi@troop.org', password: 'OldLeader#1' });
  assert.ok(devA.token && devB.token && devA.token !== devB.token);

  const chg = gas.post({
    action: 'changePassword', apikey: API_KEY, token: devA.token,
    old_password: 'OldLeader#1', new_password: 'NewLeader#2'
  });
  assert.strictEqual(chg.success, true);

  // Device A token stays valid; Device B token is kicked!
  assert.strictEqual(gas.post({ action: 'getAllUsers', apikey: API_KEY, token: devA.token }).success, true, '改密當下使用的 token 須保留有效');
  const devBCheck = gas.post({ action: 'getAllUsers', apikey: API_KEY, token: devB.token });
  assert.strictEqual(devBCheck.success, false, '其他裝置舊 session 必須即時失效');
  ok('用戶更改密碼後保留當前 session 並即時踢走同一帳號其他舊 session');
}

// ---------------------------------------------------------------------------
// 3. A17 Anti-Enumeration on Public Login vs Normal Existence on Leader Backend
// ---------------------------------------------------------------------------
console.log('\n3. A17 公開登入反枚舉（統一訊息＋dummy KDF）與領袖後台正常查詢');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();
  gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234560031', name: '存在成員', email: 'exist31@troop.org', role: 'branch_leader', password: 'RealPass#31'
  });

  // Instrument HMAC call count to prove dummy KDF runs on non-existent accounts
  let hmacCalls = 0;
  const origHmac = gas.sandbox.Utilities.computeHmacSha256Signature;
  gas.sandbox.Utilities.computeHmacSha256Signature = function (v, k) {
    hmacCalls += 1;
    return origHmac(v, k);
  };

  // Warm up cached dummy hash first so per-request count reflects login verification itself
  gas.post({ action: 'login', apikey: API_KEY, login_id: '9999999999', password: 'AnyPassword' });

  hmacCalls = 0;
  const rMissingScoutId = gas.post({ action: 'login', apikey: API_KEY, login_id: '8888888888', password: 'GuessPassword' });
  const missingScoutIdHmacs = hmacCalls;

  hmacCalls = 0;
  const rMissingEmail = gas.post({ action: 'login', apikey: API_KEY, login_id: 'nobody@troop.org', password: 'GuessPassword' });
  const missingEmailHmacs = hmacCalls;

  hmacCalls = 0;
  const rWrongPw = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560031', password: 'GuessPassword' });
  const wrongPwHmacs = hmacCalls;

  hmacCalls = 0;
  const rCentralId = gas.post({ action: 'login', apikey: API_KEY, login_id: 'sheep', password: 'GuessPassword' });
  const centralIdHmacs = hmacCalls;

  assert.deepStrictEqual(rMissingScoutId, { success: false, error: '帳號或密碼錯誤' });
  assert.deepStrictEqual(rMissingEmail, { success: false, error: '帳號或密碼錯誤' });
  assert.deepStrictEqual(rWrongPw, { success: false, error: '帳號或密碼錯誤' });
  assert.deepStrictEqual(rCentralId, { success: false, error: '帳號或密碼錯誤' });
  // 每次登入最多一個 PBKDF2（dummy 雜湊已快取）：等於 KDF_ITERATIONS 次 HMAC。
  assert.strictEqual(missingScoutIdHmacs, KDF_ITERATIONS, '帳號不存在亦必須執行完整一次 dummy KDF');
  assert.strictEqual(missingEmailHmacs, KDF_ITERATIONS);
  assert.strictEqual(wrongPwHmacs, KDF_ITERATIONS);
  assert.strictEqual(centralIdHmacs, KDF_ITERATIONS);
  ok(`公開 login 對不存在 SCOUT ID／不存在電郵／保留帳號／錯密碼回傳完全一致訊息並均執行一次（${KDF_ITERATIONS} 次）KDF`);

  // Leader backend queries MUST still accurately show whether members/emails exist
  const leaderSession = gas.post({ action: 'login', apikey: API_KEY, login_id: 'exist31@troop.org', password: 'RealPass#31' });
  const allUsers = gas.post({ action: 'getAllUsers', apikey: API_KEY, token: leaderSession.token });
  assert.strictEqual(allUsers.success, true);
  assert.ok(allUsers.users.some((u) => u.scoutId === '1234560031' && u.email === 'exist31@troop.org'));
  assert.strictEqual(allUsers.users.some((u) => u.scoutId === '8888888888'), false);
  const dupCheck = gas.post({
    action: 'addUser', apikey: API_KEY, token: leaderSession.token,
    scoutId: '1234560099', name: '撞電郵', email: 'exist31@troop.org', role: 'member', password: '1234'
  });
  assert.strictEqual(dupCheck.success, false);
  assert.match(dupCheck.error, /電郵|Email/i, '領袖後台新增用戶仍須明確提示電郵已存在');
  ok('反枚舉只套用公開入口；領袖後台名冊與唯一性檢查仍正常顯示存在與否');
}

// ---------------------------------------------------------------------------
// 4 & 5. Reset Password Role Hierarchy Matrix (Token + Upstream sig) & Post-Reset Cleanup
// ---------------------------------------------------------------------------
console.log('\n4 & 5. 重設密碼職級矩陣（含上游 sig 防冒充）與重設後三項強制善後');
{
  const gas = makeGas({ apiKey: API_KEY });
  gas.sandbox.initializeSheets();

  const superToken = gas.sandbox.createToken('sheep');

  // Verify non-super_admin cannot create an admin account either!
  assert.strictEqual(gas.post({
    action: 'addUser', apikey: API_KEY,
    scoutId: '1234560101', name: '管理員A', email: 'adminA@troop.org', role: 'admin', password: 'AdminA#101'
  }).success, false, '非 SUPER_ADMIN 不可建立 ADMIN 帳號');

  // Seed a full hierarchy of accounts using super_admin session
  const accounts = [
    { scoutId: '1234560101', name: '管理員A', email: 'adminA@troop.org', role: 'admin', pw: 'AdminA#101' },
    { scoutId: '1234560102', name: '管理員B', email: 'adminB@troop.org', role: 'admin', pw: 'AdminB#102' },
    { scoutId: '1234560103', name: '團長A', email: 'gslA@troop.org', role: 'group_leader', pw: 'GslA#103' },
    { scoutId: '1234560104', name: '支部領袖A', email: 'blA@troop.org', role: 'branch_leader', pw: 'BlA#104' },
    { scoutId: '1234560105', name: '支部領袖B', email: 'blB@troop.org', role: 'branch_leader', pw: 'BlB#105' },
    { scoutId: '1234560106', name: '團員A', email: 'memA@troop.org', role: 'member', pw: 'MemA#106' },
    { scoutId: '1234560107', name: '團員B', email: 'memB@troop.org', role: 'member', pw: 'MemB#107' }
  ];
  for (const a of accounts) {
    assert.strictEqual(gas.post({
      action: 'addUser', apikey: API_KEY, token: superToken,
      scoutId: a.scoutId, name: a.name, email: a.email, role: a.role, password: a.pw
    }).success, true);
    // Clear initial force_change_password so we can verify resetPassword flips it back to true!
    const row = getUserRow(gas, a.scoutId);
    gas.sheets.get('Users').getRange(row._rowNumber, 16).setValue(false);
  }

  const tok = {};
  for (const a of accounts) {
    const l = gas.post({ action: 'login', apikey: API_KEY, login_id: a.scoutId, password: a.pw });
    assert.strictEqual(l.success, true);
    tok[a.scoutId] = l.token;
  }

  function assertRejectedUnchanged(callerToken, targetScoutId, label) {
    const beforeHash = getUserRow(gas, targetScoutId).password_hash;
    const res = gas.post({
      action: 'resetPassword', apikey: API_KEY, token: callerToken,
      targetScoutId: targetScoutId, new_password: 'Hacked!99'
    });
    assert.strictEqual(res.success, false, `應拒絕：${label} (${JSON.stringify(res)})`);
    assert.strictEqual(getUserRow(gas, targetScoutId).password_hash, beforeHash, `被拒時目標 password_hash 絕不可變動：${label}`);
  }

  // Forbidden resets across every role level
  assertRejectedUnchanged(tok['1234560106'], '1234560107', 'member 重設另一 member');
  assertRejectedUnchanged(tok['1234560106'], '1234560104', 'member 重設 branch_leader');
  assertRejectedUnchanged(tok['1234560104'], '1234560105', 'branch_leader 重設同級 branch_leader');
  assertRejectedUnchanged(tok['1234560104'], '1234560103', 'branch_leader 重設更高職級 group_leader');
  assertRejectedUnchanged(tok['1234560104'], '1234560101', 'branch_leader 重設更高職級 admin');
  assertRejectedUnchanged(tok['1234560103'], '1234560103', 'group_leader 重設自己');
  assertRejectedUnchanged(tok['1234560103'], '1234560101', 'group_leader 重設更高職級 admin');
  assertRejectedUnchanged(tok['1234560101'], '1234560102', 'ADMIN 重設另一位同級 ADMIN');
  assertRejectedUnchanged(tok['1234560101'], '1111111111', 'ADMIN 重設預設管理員 ADMIN');
  assertRejectedUnchanged(tok['1234560101'], '1234560101', 'ADMIN 重設自己');
  const superAttempt = gas.post({
    action: 'resetPassword', apikey: API_KEY, token: tok['1234560101'],
    targetScoutId: 'sheep', new_password: 'Hacked!99'
  });
  assert.strictEqual(superAttempt.success, false, '任何人不可重設保留帳號 sheep');
  ok('職級矩陣阻擋全部越權／同級重設（ADMIN 不可改 ADMIN、同級不可互改、member 全拒），且目標 hash 原封不動');

  // Handler-level enforcement & upstream sig entrypoint check:
  // (a) Calling handleResetPassword with a raw string managerScoutId ('1111111111') must be rejected
  const rawCallRes = JSON.parse(gas.sandbox.handleResetPassword('1234560106', '1111111111', 'Bypass!1').getContent());
  assert.strictEqual(rawCallRes.success, false, 'handleResetPassword 必須拒絕未驗明 role 的純字串 managerScoutId');

  // (b) Upstream sig with on_behalf='1111111111' (local admin SCOUT ID!) + on_behalf_role='branch_leader' trying to reset group_leader -> REJECTED!
  const beforeGslHash = getUserRow(gas, '1234560103').password_hash;
  const sigSpoof = gas.post(signUpstreamBody({
    action: 'resetPassword',
    targetScoutId: '1234560103',
    new_password: 'SigSpoof!1',
    on_behalf: '1111111111',
    on_behalf_role: 'branch_leader'
  }, API_KEY));
  assert.strictEqual(sigSpoof.success, false, '上游 sig 自報較低角色時絕不可借本地同 SCOUT ID 管理員提權');
  assert.strictEqual(getUserRow(gas, '1234560103').password_hash, beforeGslHash);

  // (c) Upstream sig with default/admin role trying to reset another admin -> REJECTED!
  const beforeAdminBHash = getUserRow(gas, '1234560102').password_hash;
  const sigAdminPeer = gas.post(signUpstreamBody({
    action: 'resetPassword',
    targetScoutId: '1234560102',
    new_password: 'SigPeer!1',
    on_behalf: 'upstream_admin',
    on_behalf_role: 'admin'
  }, API_KEY));
  assert.strictEqual(sigAdminPeer.success, false, '上游 admin 同樣不可重設下游 admin');
  assert.strictEqual(getUserRow(gas, '1234560102').password_hash, beforeAdminBHash);
  ok('handler 內部與上游 sig 入口均強制驗證操作者職級（杜絕字串反查或上游同級越權）');

  // Allowed resets + verify ALL THREE post-reset side effects:
  //   (1) Clear LOGIN_FAIL:<target>
  //   (2) Destroy all target tokens while preserving manager's token
  //   (3) Set force_change_password = true
  // First lock target '1234560106' with 5 failed logins AND open a 2nd session before lock
  const extraMemLogin = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560106', password: 'MemA#106' });
  assert.strictEqual(extraMemLogin.success, true);
  for (let i = 0; i < 5; i++) {
    gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560106', password: 'bad' + i });
  }
  assert.strictEqual(gas.props.has('LOGIN_FAIL:1234560106'), true, '重設前成員已被鎖定');
  assert.strictEqual(Boolean(getUserRow(gas, '1234560106').force_change_password), false);

  // branch_leader resets member '1234560106'
  const blResetMem = gas.post({
    action: 'resetPassword', apikey: API_KEY, token: tok['1234560104'],
    targetScoutId: '1234560106', new_password: 'TempMem#88'
  });
  assert.strictEqual(blResetMem.success, true);

  // Verify 3 post-reset invariants:
  assert.strictEqual(gas.props.has('LOGIN_FAIL:1234560106'), false, '(1) 必須清除 LOGIN_FAIL 鎖定');
  assert.strictEqual(
    gas.post({ action: 'getServiceRecords', apikey: API_KEY, token: tok['1234560106'] }).success,
    false,
    '(2a) 目標舊 token #1 必須失效'
  );
  assert.strictEqual(
    gas.post({ action: 'getServiceRecords', apikey: API_KEY, token: extraMemLogin.token }).success,
    false,
    '(2b) 目標舊 token #2 必須失效'
  );
  assert.strictEqual(
    gas.post({ action: 'getAllUsers', apikey: API_KEY, token: tok['1234560104'] }).success,
    true,
    '(2c) 操作者領袖自己的 session 絕不可受影響'
  );
  const memRowAfter = getUserRow(gas, '1234560106');
  assert.strictEqual(memRowAfter.force_change_password, true, '(3) 必須設 force_change_password = true');
  assert.strictEqual(Number(gas.sandbox.storedHashIterations_(memRowAfter.password_hash)), KDF_ITERATIONS);
  const memRelogin = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560106', password: 'TempMem#88' });
  assert.strictEqual(memRelogin.success, true);
  assert.strictEqual(memRelogin.force_change_password, true);

  // Verify group_leader -> branch_leader, admin -> group_leader, and SUPER_ADMIN -> ADMIN (both normal admin and default 1111111111)
  assert.strictEqual(gas.post({
    action: 'resetPassword', apikey: API_KEY, token: tok['1234560103'],
    targetScoutId: '1234560104', new_password: 'TempBl#88'
  }).success, true);
  assert.strictEqual(gas.post({
    action: 'resetPassword', apikey: API_KEY, token: tok['1234560101'],
    targetScoutId: '1234560103', new_password: 'TempGsl#88'
  }).success, true);
  assert.strictEqual(gas.post({
    action: 'resetPassword', apikey: API_KEY, token: superToken,
    targetScoutId: '1234560102', new_password: 'SuperSetAdmin#1'
  }).success, true);
  assert.strictEqual(gas.post({
    action: 'resetPassword', apikey: API_KEY, token: superToken,
    targetScoutId: '1111111111', new_password: 'SuperResetDefault#1'
  }).success, true);
  assert.strictEqual(getUserRow(gas, '1111111111').force_change_password, true);
  ok('合法上級重設（含 SUPER_ADMIN 重設 ADMIN／預設管理員）全部通過，並完整執行解鎖＋踢舊 session＋強制改密');
}

console.log(`\n=== Auth Hardening 測試全部通過（共 ${passed} 項） ===`);
