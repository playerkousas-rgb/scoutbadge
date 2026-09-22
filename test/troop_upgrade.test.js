'use strict';

/*
 * 進度追蹤旅系統升級版 回歸測試
 * 參考：BUILD.md 及 進度追蹤旅系統升級版.md
 *
 * 驗證點：
 * 1. 單用進度時無「關入口」掣，唔會誤閂（前端靜態檢查）
 * 2. 預設 ALLOW_LOCAL_LOGIN=true，單用時唔會誤閂
 * 3. setDownstreamAccess 只接受上游 sig 驗證，apikey 或無 sig 均回 403
 * 4. 團掛進度後（ALLOW_LOCAL_LOGIN=false），進度本地登入回 403，開戶申請回 403
 * 5. 閂口後，上層 sig（成員／領袖）照常放行；SUPER 災難恢復照常放行
 * 6. 領袖／旅長經 sig 入，下游唔使有 row（BUILD.md §2 開戶錨點）
 * 7. exportAll 預設剝密碼；include_hash=true 吐出 password_hash 及 sha256
 * 8. upsertUser 直插 hash，舊密碼照用（唔經 1234+mustChangePw），transferId 冪等 + 撞號阻擋
 * 9. setPw、setStatus、verifyPw 伺服器端同步功能正常
 * 10. setDownstreamAccess({allowLocal: true}) 可重新開通本地登入
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeGas } = require('./gasvm');

const KEY = 'TEST_API_KEY_TROOP_UPGRADE';
const CHILD_ID = '0082S';

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function signSig({ sub, role = 'member', children_ids = [], targetYmis = '', exp = null, key = KEY, childId = CHILD_ID }) {
  const nowS = Math.floor(Date.now() / 1000);
  const expiry = exp !== null ? exp : (nowS + 600);
  const scopeObj = { role };
  if (children_ids && children_ids.length) scopeObj.children_ids = children_ids;
  if (targetYmis) scopeObj.targetYmis = targetYmis;
  const scope = JSON.stringify(scopeObj);
  const msg = `${childId}|${sub}|${scope}|${expiry}`;
  const sig = hmac(key, msg);
  return { childId, sub, scope, exp: expiry, sig };
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

async function run() {
  console.log('=== 進度追蹤旅系統升級版 回歸測試 ===\n');

  // ========================================================
  // 1. 前端靜態檢查：進度前端唔使加「關入口」掣（避免誤閂）
  // ========================================================
  console.log('1. 進度前端檢查：無「關入口」掣');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(!indexHtml.includes('setDownstreamAccess'), '進度前端不應直接呼叫 setDownstreamAccess');
  assert(!indexHtml.includes('關閉進度直接登入'), '進度前端不應有「關閉進度直接登入」掣');
  assert(!indexHtml.includes('關閉團直接登入'), '進度前端不應有「關閉團直接登入」掣');
  assert(indexHtml.includes('exportMembersJson'), '進度前端應有 exportMembersJson 匯出功能');
  console.log('  [PASS] 進度前端無「關閉入口」掣，單用時唔會誤閂');

  // 初始化真 Apps Script Code.gs
  const gas = makeGas({ apiKey: KEY, execUrl: 'https://script.google.com/macros/s/TEST/exec' });
  gas.sandbox.initializeSheets();
  gas.props.set('PORTAL_GLOBAL_ID', CHILD_ID);

  // 建立一筆測試成員與領袖
  gas.post({
    action: 'addUser',
    apikey: KEY,
    ymis: '1234560001',
    name: '陳大文',
    email: 'chan@example.org',
    role: 'member',
    password: 'OldPassword123'
  });

  gas.post({
    action: 'addUser',
    apikey: KEY,
    ymis: '1234560002',
    name: '林領袖',
    email: 'leader@example.org',
    role: 'branch_leader',
    password: 'LeaderPassword456'
  });

  // ========================================================
  // 2. 預設新部署 ALLOW_LOCAL_LOGIN=true
  // ========================================================
  console.log('\n2. 預設新部署 ALLOW_LOCAL_LOGIN=true');
  const defaultAccess = gas.post({ action: 'getDownstreamAccess', apikey: KEY });
  assert.strictEqual(defaultAccess.success, true);
  assert.strictEqual(defaultAccess.allowLocal, true, '新部署預設 allowLocal 應為 true');

  // 本地登入成功
  const normalLogin = gas.post({ action: 'login', login_id: '1234560001', password: 'OldPassword123', apikey: KEY });
  assert.strictEqual(normalLogin.success, true, '預設狀態本地登入應成功');
  console.log('  [PASS] 預設新部署 ALLOW_LOCAL_LOGIN=true，本地登入正常放行');

  // ========================================================
  // 3. setDownstreamAccess：只接受上游 sig 驗證先可寫旗
  // ========================================================
  console.log('\n3. setDownstreamAccess 安全權限檢查');
  // 3a. 無 sig（只有 apikey）→ 403
  const noSigSet = gas.post({ action: 'setDownstreamAccess', apikey: KEY, allowLocal: false });
  assert.strictEqual(noSigSet.success, false);
  assert.strictEqual(noSigSet.code, 403, '無 sig 只帶 apikey 應回 403');
  assert(noSigSet.error.includes('簽名驗證'), '應提示只接受上游簽名驗證');

  // 3b. 偽造 / 篡改 sig → 403
  const badSig = signSig({ sub: 'troop_admin@example.org', role: 'admin', key: 'WRONG_KEY' });
  const badSigSet = gas.post({ action: 'setDownstreamAccess', ...badSig, allowLocal: false });
  assert.strictEqual(badSigSet.success, false);
  assert.strictEqual(badSigSet.code, 403);

  // 3c. 正確上游 sig（由上游支部／旅管理層用此 leaf 之 apikey 簽署）→ 200
  const validSig = signSig({ sub: 'troop_admin@example.org', role: 'admin' });
  const closeRes = gas.post({ action: 'setDownstreamAccess', ...validSig, allowLocal: false });
  assert.strictEqual(closeRes.success, true, JSON.stringify(closeRes));
  assert.strictEqual(closeRes.allowLocal, false);

  const checkClosed = gas.post({ action: 'getDownstreamAccess', apikey: KEY });
  assert.strictEqual(checkClosed.allowLocal, false, '旗值應已寫入為 false');
  console.log('  [PASS] setDownstreamAccess 拒絕純 apikey／偽造 sig，只接受有效上游 sig 寫旗');

  // ========================================================
  // 4. 閂口後：本地入口回 403（登入／開戶都攔）
  // ========================================================
  console.log('\n4. 閂口後本地入口攔截（回 403）');
  // 4a. 成員本地密碼登入 → 403
  const blockedLogin = gas.post({ action: 'login', login_id: '1234560001', password: 'OldPassword123', apikey: KEY });
  assert.strictEqual(blockedLogin.success, false);
  assert.strictEqual(blockedLogin.code, 403, '閂口後本地密碼登入應回 403');
  assert(blockedLogin.error.includes('關閉直接登入'), '錯誤訊息應清楚說明已關閉直接登入');

  // 4b. 領袖本地密碼登入 → 403
  const blockedLeaderLogin = gas.post({ action: 'login', login_id: 'leader@example.org', password: 'LeaderPassword456', apikey: KEY });
  assert.strictEqual(blockedLeaderLogin.success, false);
  assert.strictEqual(blockedLeaderLogin.code, 403, '閂口後領袖本地密碼登入應回 403');

  // 4c. 本地註冊開戶申請 → 403
  const blockedApply = gas.post({
    action: 'apply',
    apikey: KEY,
    ymis: '1234560099',
    name: '新團員',
    email: 'new@example.org',
    requested_role: 'member'
  });
  assert.strictEqual(blockedApply.success, false);
  assert.strictEqual(blockedApply.code, 403, '閂口後本地開戶申請應回 403');
  assert(blockedApply.error.includes('關閉直接開戶申請'), '錯誤訊息應清楚說明已關閉開戶申請');
  console.log('  [PASS] 閂口後本地密碼登入及開戶申請均被攔截回 403');

  // ========================================================
  // 5. 閂口後：上層 sig 與 SUPER 災難恢復放行
  // ========================================================
  console.log('\n5. 閂口後上層 sig 與 SUPER 放行');
  // 5a. 成員上層 sig portalLogin → 成功
  const memberSig = signSig({ sub: '1234560001', role: 'member' });
  const pLogin = gas.post({ action: 'portalLogin', ...memberSig });
  assert.strictEqual(pLogin.success, true, '上層 sig portalLogin 應放行');
  assert.strictEqual(pLogin.user.ymis, '1234560001');

  // 5b. SUPER 災難恢復登入（isSuperAdmin）→ 放行
  const superLogin = gas.post({ action: 'superLogin', login_id: 'sheep', isSuperAdmin: true, apikey: KEY });
  assert.strictEqual(superLogin.success, true, 'SUPER 災難恢復應放行');
  assert.strictEqual(superLogin.user.role, 'super_admin');
  console.log('  [PASS] 上層 sig 與 SUPER 災難恢復在閂口後均正常放行');

  // ========================================================
  // 6. 領袖／旅長經 sig 入，下游唔使有 row（BUILD.md §2 開戶錨點）
  // ========================================================
  console.log('\n6. 上游領袖經 sig 入，下游無 row 亦可放行並具備領袖權限');
  const upstreamLeaderEmail = 'external_gsl@troop0082.org';
  // 確定 Users 表無此人
  assert.strictEqual(gas.sandbox.getUserByEmail(upstreamLeaderEmail), null, '下游名冊應無此上游領袖');

  const gslSig = signSig({ sub: upstreamLeaderEmail, role: 'group_leader' });
  const gslLogin = gas.post({ action: 'portalLogin', ...gslSig });
  assert.strictEqual(gslLogin.success, true, '上游領袖 sig portalLogin 應成功: ' + JSON.stringify(gslLogin));
  assert.strictEqual(gslLogin.user.email, upstreamLeaderEmail);
  assert.strictEqual(gslLogin.user.can_tick, true);

  // 以獲發的 token 進行領袖操作（getAllUsers）
  const gslUsers = gas.post({ action: 'getAllUsers', token: gslLogin.token, apikey: KEY });
  assert.strictEqual(gslUsers.success, true, '上游領袖應具備領袖操作權限: ' + JSON.stringify(gslUsers));
  console.log('  [PASS] 上游領袖經 sig 入下游無 row 亦能成功登入並獲得領袖權限');

  // ========================================================
  // 7. exportAll：備份與 JSON 吐出（含 hash）
  // ========================================================
  console.log('\n7. exportAll JSON 吐出（預設剝密碼 vs 含 hash）');
  // 7a. 預設（無 include_hash 或 false）：剝除密碼欄
  const expNoHash = gas.post({ action: 'exportAll', apikey: KEY });
  assert.strictEqual(expNoHash.success, true);
  assert.strictEqual(expNoHash.meta.include_hash, false);
  assert(expNoHash.meta.sha256 && expNoHash.meta.sha256.length === 64, '應有 sha256 校驗碼');
  const u1NoHash = expNoHash.data.users.find((u) => u.ymis === '1234560001');
  assert(u1NoHash, '應包含成員');
  assert.strictEqual(u1NoHash.password_hash, undefined, '預設 exportAll 不應包含 password_hash');

  // 7b. include_hash = true：吐出含 hash+salt
  const expWithHash = gas.post({ action: 'exportAll', apikey: KEY, include_hash: true });
  assert.strictEqual(expWithHash.success, true);
  assert.strictEqual(expWithHash.meta.include_hash, true);
  const u1WithHash = expWithHash.data.users.find((u) => u.ymis === '1234560001');
  assert(u1WithHash, '應包含成員');
  assert(typeof u1WithHash.password_hash === 'string' && u1WithHash.password_hash.length === 64, '應包含完整 password_hash');
  console.log('  [PASS] exportAll 支援剝密碼備份與含 hash 吐出，meta 含 sha256 校驗碼');

  // ========================================================
  // 8. upsertUser：直插 hash、transferId 冪等、撞號阻擋
  // ========================================================
  console.log('\n8. upsertUser 直插 hash 與批量開戶');
  const customPass = 'ScoutSecret!2026';
  const customHash = sha256Hex(customPass);

  // 8a. 直插 hash 新增成員
  const upRes1 = gas.post({
    action: 'upsertUser',
    apikey: KEY,
    transferId: 'trans-001',
    user: {
      ymis: '1234560088',
      name: '何新民',
      email: 'ho@example.org',
      role: 'member',
      password_hash: customHash,
      squad: '老鷹隊',
      squad_role: 'member',
      can_tick: false
    }
  });
  assert.strictEqual(upRes1.success, true);
  assert.strictEqual(upRes1.action, 'created');

  // 8b. 重複 transferId 冪等檢查
  const upResDup = gas.post({
    action: 'upsertUser',
    apikey: KEY,
    transferId: 'trans-001',
    user: { ymis: '1234560088', name: '何新民' }
  });
  assert.strictEqual(upResDup.success, true);
  assert.strictEqual(upResDup.idempotent, true, '重複 transferId 應直接跳過 (idempotent)');

  // 8c. 撞號阻擋：相同 Email 不能用於另一個不同 YMIS
  const collisionRes = gas.post({
    action: 'upsertUser',
    apikey: KEY,
    user: {
      ymis: '1234560099',
      name: '撞電郵者',
      email: 'ho@example.org', // 與 1234560088 重複
      role: 'member'
    }
  });
  assert.strictEqual(collisionRes.success, false);
  assert.strictEqual(collisionRes.code, 409, '重複電郵開新 YMIS 應回 409');
  console.log('  [PASS] upsertUser 成功直插 hash，transferId 冪等及撞號阻擋均生效');

  // ========================================================
  // 9. setPw、verifyPw、setStatus 伺服器端同步鏈
  // ========================================================
  console.log('\n9. setPw、verifyPw、setStatus 測試');
  // 9a. verifyPw 核對剛直插之密碼
  const v1 = gas.post({ action: 'verifyPw', apikey: KEY, ymis: '1234560088', password_hash: customHash });
  assert.strictEqual(v1.success, true);
  assert.strictEqual(v1.match, true, 'verifyPw 雜湊一致應回 match: true');

  const vWrong = gas.post({ action: 'verifyPw', apikey: KEY, ymis: '1234560088', password_hash: sha256Hex('WrongPass') });
  assert.strictEqual(vWrong.success, true);
  assert.strictEqual(vWrong.match, false, 'verifyPw 雜湊不符應回 match: false');

  // 9b. setPw 更新密碼
  const newSecret = 'UpdatedPass!7788';
  const newHash = sha256Hex(newSecret);
  const setPwRes = gas.post({ action: 'setPw', apikey: KEY, ymis: '1234560088', password_hash: newHash });
  assert.strictEqual(setPwRes.success, true);

  // 核對更新後密碼
  const v2 = gas.post({ action: 'verifyPw', apikey: KEY, ymis: '1234560088', password_hash: newHash });
  assert.strictEqual(v2.match, true, 'setPw 之後 verifyPw 應匹配新雜湊');

  // 9c. setStatus
  const setStatRes = gas.post({ action: 'setStatus', apikey: KEY, ymis: '1234560088', status: 'transferred_out' });
  assert.strictEqual(setStatRes.success, true);
  // 驗證 transferred_out 狀態下無法登入（因為已移出）
  assert.strictEqual(gas.sandbox.getUser('1234560088'), null);
  // 恢復為 active
  gas.post({ action: 'setStatus', apikey: KEY, ymis: '1234560088', status: 'active' });
  assert.notStrictEqual(gas.sandbox.getUser('1234560088'), null);
  console.log('  [PASS] setPw、verifyPw 及 setStatus 運作正常');

  // ========================================================
  // 10. 重新開放本地入口
  // ========================================================
  console.log('\n10. 重新開放本地入口並驗證直插密碼');
  const reopenSig = signSig({ sub: 'troop_admin@example.org', role: 'admin' });
  const reopenRes = gas.post({ action: 'setDownstreamAccess', ...reopenSig, allowLocal: true });
  assert.strictEqual(reopenRes.success, true);
  assert.strictEqual(reopenRes.allowLocal, true);

  // 1234560088 使用 setPw 更新的密碼直接本地登入（唔經 1234+mustChangePw）
  const directLogin = gas.post({ action: 'login', login_id: '1234560088', password: newSecret, apikey: KEY });
  assert.strictEqual(directLogin.success, true, '開口後直插密碼應能正常登入: ' + JSON.stringify(directLogin));
  assert.strictEqual(directLogin.user.ymis, '1234560088');
  assert.strictEqual(directLogin.user.force_change_password, false, '直插密碼不應被強制要求改密碼');
  console.log('  [PASS] 重新開放後，匯入／直插密碼之帳戶可直接登入，密碼照用毋須 1234');

  console.log('\n=== 全部 10 項升級版功能測試通過 ===');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
