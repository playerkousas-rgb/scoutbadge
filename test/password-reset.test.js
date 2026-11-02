'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { makeGas } = require('./gasvm');

const API_KEY = 'sc_pwd_reset_test_key_2026';
const NEUTRAL_MSG = '若此帳號已登記電郵，重設碼已發送到登記電郵（15 分鐘內有效）';

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  [PASS] ${label}`);
}

function sha256HexNode(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function extractResetCodeFromMail(mail) {
  const m = String(mail.body || '').match(/Reset code[：:]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
  assert.ok(m, `信件內容應含 XXXX-XXXX 重設碼: ${mail.body}`);
  return m[1]; // returns e.g. "ABCD-1234"
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end(raw) { try { this.body = JSON.parse(raw); } catch (_) { this.body = raw; } }
  };
}

async function main() {
  console.log('=== Password Reset & Proxy / UX / i18n Test Suite ===\n');

  // -------------------------------------------------------------------------
  // 1. Backward Compatibility (auto-create 密碼重設 without initializeSheets) & Additive initializeSheets
  // -------------------------------------------------------------------------
  console.log('1. 密碼重設工作表：未跑 initializeSheets() 自動補建 ＋ 重跑 initializeSheets() 冪等保全');
  {
    const gas = makeGas({ apiKey: API_KEY });
    gas.sandbox.initializeSheets();
    assert.ok(gas.sheets.has('密碼重設'), 'initializeSheets() 必須建立 密碼重設 工作表');

    // Seed a leader and a member without email, then DELETE 密碼重設 to simulate an old un-initialized troop sheet
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560201', name: '林領袖', email: 'lam.leader@troop.org', role: 'branch_leader', password: 'InitPass#201'
    });
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560202', name: '無電郵團員', email: '', role: 'member', password: 'MemPass#202'
    });
    gas.sheets.delete('密碼重設');
    assert.strictEqual(gas.sheets.has('密碼重設'), false);

    // First forgot-password call auto-creates 密碼重設 without requiring initializeSheets()!
    const req1 = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'lam.leader@troop.org' });
    assert.deepStrictEqual(req1, { success: true, message: NEUTRAL_MSG });
    assert.strictEqual(gas.sheets.has('密碼重設'), true, '舊 Sheet 未跑 initializeSheets() 時首次呼叫必須自動補建 密碼重設 表');
    assert.deepStrictEqual(
      Array.from(gas.sheets.get('密碼重設')._rows[0]),
      ['reset_id', 'ymis', 'email', 'code_hash', 'created_ms', 'expires_ms', 'attempts', 'status', 'used_at']
    );
    assert.strictEqual(gas.sentMails.length, 1);

    // Re-running initializeSheets() preserves existing rows in 密碼重設 and Users and keeps API_KEY unchanged
    const rowsBeforeInit = gas.sheets.get('密碼重設')._rows.length;
    gas.sandbox.initializeSheets();
    assert.strictEqual(gas.sheets.get('密碼重設')._rows.length, rowsBeforeInit, 'initializeSheets() 不可清空既有密碼重設列');
    assert.strictEqual(gas.props.get('API_KEY'), API_KEY, 'initializeSheets() 不可更換既有 API Key');
    ok('未初始化舊 Sheet 自動補建 密碼重設 表，且重跑 initializeSheets() 完全冪等無損');
  }

  // -------------------------------------------------------------------------
  // 2. Full Leader Self-Service Email Reset Lifecycle & Zero Plaintext Leak
  // -------------------------------------------------------------------------
  console.log('\n2. 領袖電郵重設全流程（不分大小寫／含空白連字號／只存雜湊／踢舊 session／解鎖）');
  {
    const gas = makeGas({ apiKey: API_KEY });
    gas.sandbox.initializeSheets();
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560210', name: '陳團長', email: 'Chan.GSL@Troop.org', role: 'group_leader', password: 'OldGslPassword!1'
    });

    // Open two active sessions for this leader, then lock the account with 5 wrong logins
    const s1 = gas.post({ action: 'login', apikey: API_KEY, login_id: 'chan.gsl@troop.org', password: 'OldGslPassword!1' });
    const s2 = gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560210', password: 'OldGslPassword!1' });
    assert.ok(s1.token && s2.token);
    for (let i = 0; i < 5; i++) {
      gas.post({ action: 'login', apikey: API_KEY, login_id: '1234560210', password: 'wrong' + i });
    }
    assert.strictEqual(gas.props.has('LOGIN_FAIL:1234560210'), true);

    // Request reset using YMIS (and pass forged token/role/on_behalf to verify handler ignores them)
    const reqRes = gas.post({
      action: 'requestPasswordReset', apikey: API_KEY,
      login_id: '1234560210', token: 'forged-token', role: 'super_admin', on_behalf: '1111111111'
    });
    assert.deepStrictEqual(reqRes, { success: true, message: NEUTRAL_MSG });
    assert.strictEqual(gas.sentMails.length, 1);
    assert.strictEqual(gas.sentMails[0].to, 'chan.gsl@troop.org');

    const formattedCode = extractResetCodeFromMail(gas.sentMails[0]); // e.g. "ABCD-1234"
    const rawCode = formattedCode.replace(/-/g, '');
    assert.strictEqual(rawCode.length, 8);

    // Verify plaintext code NEVER appears in HTTP response, Sheet cells, ScriptProperties, or Audit Log
    const sheetDump = JSON.stringify(gas.sheets.get('密碼重設')._rows);
    const auditDump = JSON.stringify(gas.sheets.get('操作紀錄')._rows);
    const propsDump = JSON.stringify([...gas.props.entries()]);
    assert.strictEqual(JSON.stringify(reqRes).includes(rawCode), false, '回應不得含明文重設碼');
    assert.strictEqual(sheetDump.includes(rawCode), false, '密碼重設表不得存明文重設碼');
    assert.strictEqual(auditDump.includes(rawCode), false, '操作紀錄不得記明文重設碼');
    assert.strictEqual(propsDump.includes(rawCode), false, 'ScriptProperties 不得存明文重設碼');
    assert.strictEqual(gas.sheets.get('密碼重設')._rows[1][3], sha256HexNode(rawCode), 'code_hash 欄必須為 SHA-256 hex');

    // Confirm with lowercase + spaces + hyphen paste format (" abcd - 1234 ")
    const pastedMessyCode = '  ' + formattedCode.slice(0, 4).toLowerCase() + ' - ' + formattedCode.slice(5).toLowerCase() + '  ';
    const newSecretPw = 'BrandNewLeader!2026';
    const confRes = gas.post({
      action: 'confirmPasswordReset', apikey: API_KEY,
      login_id: 'CHAN.GSL@TROOP.ORG', code: pastedMessyCode, new_password: newSecretPw,
      token: 'forged-token', role: 'super_admin'
    });
    assert.strictEqual(confRes.success, true, JSON.stringify(confRes));

    // Verify plaintext new password NEVER appears in Sheet / Audit / Response
    const allSheetsDump = JSON.stringify([...gas.sheets.values()].map((s) => s._rows));
    assert.strictEqual(allSheetsDump.includes(newSecretPw), false, '任何工作表均不得出現明文新密碼');
    assert.strictEqual(JSON.stringify(confRes).includes(newSecretPw), false);

    // Verify old sessions s1 & s2 are both destroyed, lockout is cleared, and single-use code cannot be reused
    assert.strictEqual(gas.props.has('LOGIN_FAIL:1234560210'), false, '重設成功須清除 LOGIN_FAIL');
    assert.strictEqual(gas.post({ action: 'getAllUsers', apikey: API_KEY, token: s1.token }).success, false, '舊 session #1 必須失效');
    assert.strictEqual(gas.post({ action: 'getAllUsers', apikey: API_KEY, token: s2.token }).success, false, '舊 session #2 必須失效');

    const reuseRes = gas.post({
      action: 'confirmPasswordReset', apikey: API_KEY,
      login_id: 'chan.gsl@troop.org', code: rawCode, new_password: 'AnotherPassword!2'
    });
    assert.strictEqual(reuseRes.success, false, '重設碼必須單次使用，重用即拒');

    const freshLogin = gas.post({ action: 'login', apikey: API_KEY, login_id: 'chan.gsl@troop.org', password: newSecretPw });
    assert.strictEqual(freshLogin.success, true);
    assert.strictEqual(freshLogin.force_change_password, false, '本人剛設好新密碼，登入不應再重複強制改密');
    ok('8 位重設碼支援小寫／空白／連字號貼上、只存 SHA-256 雜湊、單次使用、即時踢走全部舊 session 並解鎖');
  }

  // -------------------------------------------------------------------------
  // 3. Superseding, 15-Minute Expiry, 5-Attempt Lock, Rate Limit & 24h Pruning
  // -------------------------------------------------------------------------
  console.log('\n3. 舊碼作廢、15 分鐘過期、5 次輸錯作廢、限速（3 次／30 分鐘）與 24 小時清理');
  {
    const gas = makeGas({ apiKey: API_KEY });
    gas.sandbox.initializeSheets();
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560220', name: '李領袖', email: 'lee@troop.org', role: 'branch_leader', password: 'LeeOldPass#1'
    });
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560221', name: '張領袖', email: 'cheung@troop.org', role: 'branch_leader', password: 'CheungOld#1'
    });

    // Seed a >24h stale row to verify automatic pruning
    const staleMs = Date.now() - 26 * 60 * 60 * 1000;
    gas.sheets.get('密碼重設').appendRow(['PWR_STALE', '1234560220', 'lee@troop.org', '', staleMs, staleMs + 900000, 0, 'expired', '']);

    // Request #1 & Request #2 for lee@troop.org -> #1 must be superseded!
    gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'lee@troop.org' });
    const code1 = extractResetCodeFromMail(gas.sentMails[0]).replace(/-/g, '');
    assert.strictEqual(
      gas.sheets.get('密碼重設')._rows.some((r) => r[0] === 'PWR_STALE'),
      false,
      '超過 24 小時的舊列必須自動清理'
    );

    gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'lee@troop.org' });
    const code2 = extractResetCodeFromMail(gas.sentMails[1]).replace(/-/g, '');

    // Old code1 must fail
    assert.strictEqual(gas.post({
      action: 'confirmPasswordReset', apikey: API_KEY,
      login_id: 'lee@troop.org', code: code1, new_password: 'TryOldCode#1'
    }).success, false, '新重設碼發出後舊碼必須即時作廢');

    // Request #3 succeeds (3rd within 30 mins); Request #4 is rate-limited without sending a 4th email!
    const req3 = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'lee@troop.org' });
    assert.strictEqual(req3.success, true);
    assert.strictEqual(gas.sentMails.length, 3);
    const code3 = extractResetCodeFromMail(gas.sentMails[2]).replace(/-/g, '');

    const req4 = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'lee@troop.org' });
    assert.strictEqual(req4.success, false, '30 分鐘內第 4 次申請必須觸發限速');
    assert.match(req4.error, /頻密/);
    assert.strictEqual(gas.sentMails.length, 3, '觸發限速時不得再寄出第 4 封信');
    assert.strictEqual(code2 !== code3 || code3.length === 8, true);

    // 5 wrong attempts on code3 -> locks code3 so even the real code3 on attempt #6 fails!
    for (let i = 1; i <= 5; i++) {
      const bad = gas.post({
        action: 'confirmPasswordReset', apikey: API_KEY,
        login_id: 'lee@troop.org', code: 'ZZZZZZZ' + i, new_password: 'ValidNewPass#1'
      });
      assert.strictEqual(bad.success, false);
    }
    const sixthWithRealCode = gas.post({
      action: 'confirmPasswordReset', apikey: API_KEY,
      login_id: 'lee@troop.org', code: code3, new_password: 'ValidNewPass#1'
    });
    assert.strictEqual(sixthWithRealCode.success, false, '連續輸錯 5 次後即使第 6 次輸入正確重設碼亦必須拒絕');

    // Test 15-minute expiry on cheung@troop.org
    gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'cheung@troop.org' });
    const cheungCode = extractResetCodeFromMail(gas.sentMails[3]).replace(/-/g, '');
    const pwrSheet = gas.sheets.get('密碼重設');
    const cheungRowIdx = pwrSheet._rows.findIndex((r) => r[2] === 'cheung@troop.org' && r[7] === 'pending');
    assert.ok(cheungRowIdx > 0);
    pwrSheet.getRange(cheungRowIdx + 1, 6).setValue(Date.now() - 1000); // expire expires_ms
    const expiredRes = gas.post({
      action: 'confirmPasswordReset', apikey: API_KEY,
      login_id: 'cheung@troop.org', code: cheungCode, new_password: 'CheungNew#2'
    });
    assert.strictEqual(expiredRes.success, false, '超過 15 分鐘的重設碼必須失效');
    assert.strictEqual(pwrSheet._rows[cheungRowIdx][7], 'expired');
    ok('舊碼覆蓋作廢、15 分鐘過期、5 次輸錯鎖死、3 次／30 分鐘限速與 24 小時清理全部通過');
  }

  // -------------------------------------------------------------------------
  // 4. Anti-Enumeration: Missing Account, No-Email Member, Default Admin (admin@example.com), MailApp Failure & testPasswordResetMail
  // -------------------------------------------------------------------------
  console.log('\n4. 反枚舉與第 3 條路徑保護（無帳號／無電郵成員／預設管理員 1111111111／MailApp 失敗均回同一中性訊息）');
  {
    const gas = makeGas({ apiKey: API_KEY });
    gas.sandbox.initializeSheets();
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560230', name: '真領袖', email: 'real.leader@troop.org', role: 'branch_leader', password: 'Leader#230'
    });
    gas.post({
      action: 'addUser', apikey: API_KEY,
      ymis: '1234560231', name: '無電郵團員', email: '', role: 'member', password: 'Member#231'
    });

    const rUnknownEmail = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'ghost@troop.org' });
    const rUnknownYmis = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: '9876543210' });
    const rNoEmailMem = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: '1234560231' });
    const rDefaultAdminYmis = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: '1111111111' });
    const rDefaultAdminEmail = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'admin@example.com' });
    const rCentral = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'sheep' });
    assert.strictEqual(gas.sentMails.length, 0, '無合資格電郵帳號時絕不可寄出任何電郵（含預設管理員 admin@example.com）');

    // Now simulate MailApp failure (e.g. MailApp permission not yet authorized) on a real leader
    gas.mailState.failWith = 'Exception: You do not have permission to call MailApp.sendEmail';
    const rMailFail = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'real.leader@troop.org' });
    assert.strictEqual(gas.sentMails.length, 0);
    assert.ok(gas.props.get('PWD_RESET_MAIL_ERROR'), '內部應記錄 PWD_RESET_MAIL_ERROR 供診斷');

    // Now restore MailApp and send a real one — compare ALL responses byte-for-byte!
    gas.mailState.failWith = '';
    const rRealOk = gas.post({ action: 'requestPasswordReset', apikey: API_KEY, login_id: 'real.leader@troop.org' });
    assert.strictEqual(gas.sentMails.length, 1);

    for (const r of [rUnknownEmail, rUnknownYmis, rNoEmailMem, rDefaultAdminYmis, rDefaultAdminEmail, rCentral, rMailFail]) {
      assert.deepStrictEqual(r, rRealOk, '所有公開 requestPasswordReset 回應結構與文字必須完全一致（零枚舉訊號）');
    }

    // testPasswordResetMail() sends test mail to active editor user and clears PWD_RESET_MAIL_ERROR
    const testMsg = gas.sandbox.testPasswordResetMail();
    assert.match(testMsg, /owner@troop\.org/);
    assert.strictEqual(gas.sentMails.length, 2);
    assert.strictEqual(gas.props.has('PWD_RESET_MAIL_ERROR'), false, 'testPasswordResetMail 成功後應清除錯誤旗標');
    ok('不存在帳號、無電郵成員、預設管理員（admin@example.com）及 MailApp 失敗均回完全一致中性訊息；testPasswordResetMail 正常運作');
  }

  // -------------------------------------------------------------------------
  // 5. Proxy Action Allowlist & Identity Stripping on Public Reset Endpoints
  // -------------------------------------------------------------------------
  console.log('\n5. api/proxy.js 動作白名單與公開重設欄位剝除測試');
  {
    const gas = makeGas({ apiKey: API_KEY });
    gas.sandbox.initializeSheets();
    const capturedBodies = [];

    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(raw || '{}');
        capturedBodies.push(parsed);
        const out = gas.post(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const origEnv = { ...process.env };
    // Use trusted Google Apps Script URL shape and intercept global.fetch to forward to our local test server
    process.env.TROOP_0082_NAME = '第 82 旅';
    process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TEST_DEPLOY_0082/exec';
    process.env.TROOP_0082_APIKEY = API_KEY;
    process.env.SUPER_KEY = '9082';

    const origFetch = global.fetch;
    global.fetch = async (targetUrl, opts) => {
      return origFetch(`http://127.0.0.1:${port}/exec`, opts);
    };

    try {
      delete require.cache[require.resolve('../api/proxy')];
      const proxyHandler = require('../api/proxy');
      assert.ok(proxyHandler.PUBLIC_ACTIONS.has('requestPasswordReset'));
      assert.ok(proxyHandler.PUBLIC_ACTIONS.has('confirmPasswordReset'));

      // Unknown action -> 400 without calling upstream
      const resUnknown = mockRes();
      await proxyHandler({ method: 'POST', body: { troopId: '0082', action: 'arbitraryUnknownAction' }, headers: {} }, resUnknown);
      assert.strictEqual(resUnknown.statusCode, 400);
      assert.strictEqual(capturedBodies.length, 0, '未知 action 必須在 proxy 直接攔截（400），不得轉發後端');

      // Direct superLogin -> 403
      const resSuper = mockRes();
      await proxyHandler({ method: 'POST', body: { troopId: '0082', action: 'superLogin' }, headers: {} }, resSuper);
      assert.strictEqual(resSuper.statusCode, 403);

      // requestPasswordReset with stale/invalid sbs1. token + forged role/on_behalf/sig -> stripped cleanly and succeeds 200!
      const resReset = mockRes();
      await proxyHandler({
        method: 'POST',
        headers: {},
        body: {
          troopId: '0082',
          action: 'requestPasswordReset',
          login_id: 'someone@troop.org',
          token: 'sbs1.invalid.corrupted.session',
          role: 'super_admin',
          on_behalf: '1111111111',
          on_behalf_role: 'super_admin',
          sig: 'deadbeef',
          sig_ts: 12345,
          sig_nonce: 'badnonce1234'
        }
      }, resReset);
      assert.strictEqual(resReset.statusCode, 200);
      assert.strictEqual(resReset.body.success, true);
      assert.strictEqual(capturedBodies.length, 1);
      const forwarded = capturedBodies[0];
      for (const strippedKey of ['token', 'role', 'on_behalf', 'on_behalf_role', 'sig', 'sig_ts', 'sig_nonce']) {
        assert.strictEqual(forwarded[strippedKey], undefined, `proxy 轉發公開重設時必須剝除 ${strippedKey}`);
      }
      assert.strictEqual(forwarded.apikey, API_KEY, 'proxy 仍正常注入伺服器端 API Key');
    } finally {
      global.fetch = origFetch;
      process.env = origEnv;
      await new Promise((resolve) => server.close(resolve));
    }
    ok('proxy 白名單攔截未知 action（400）、阻擋 superLogin（403），並剝除公開重設入口所有 token／身分／sig 欄位');
  }

  // -------------------------------------------------------------------------
  // 6. Frontend UX Structure, Paste Sanitizer, Client Role Gate & Bilingual i18n Sync
  // -------------------------------------------------------------------------
  console.log('\n6. 前端忘記密碼 UX、貼上自動去空白、客戶端重設按鈕職級門檻與中英雙語同步檢查');
  {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const tsv = fs.readFileSync(path.join(root, 'i18n_dict.tsv'), 'utf8');

    // Prominent button on login page + two-step single-action screens + troubleshooting details
    assert.ok(html.includes('id="btnForgotPwProminent"'), '登入頁密碼欄旁須有顯眼「忘記密碼？」按鈕');
    assert.ok(html.includes('id="fpStep1"') && html.includes('id="fpStep2"'), '忘記密碼須為兩步單欄結構');
    assert.ok(html.includes('class="fp-troubleshoot"'), '須包含「收唔到信？」摺疊排查指引');
    assert.ok(html.includes('canManageClientRole(currentUser.role,u.role)'), '用戶管理列表須按職級門檻決定是否渲染重設密碼按鈕');

    // Extract and execute sanitizeFpCodeInput & canManageClientRole directly
    const sanMatch = html.match(/function sanitizeFpCodeInput\(el\)\{[\s\S]*?\n\}/);
    const roleMatch = html.match(/const CLIENT_ROLE_LEVEL=\{[^\n]+\};\nfunction canManageClientRole\(mgrRole,targetRole\)\{[\s\S]*?\n\}/);
    assert.ok(sanMatch && roleMatch, 'sanitizeFpCodeInput 及 canManageClientRole 函式必須存在');

    const sanitizeFn = new Function(sanMatch[0] + '; return sanitizeFpCodeInput;')();
    const fakeInput = { value: '  ab3d - 9k2m extra  ' };
    assert.strictEqual(sanitizeFn(fakeInput), 'AB3D9K2M');
    assert.strictEqual(fakeInput.value, 'AB3D9K2M', '貼上含空格／連字號／小寫的重設碼須自動轉為 8 位大寫');

    const canManageFn = new Function(roleMatch[0] + '; return canManageClientRole;')();
    assert.strictEqual(canManageFn('super_admin', 'admin'), true);
    assert.strictEqual(canManageFn('admin', 'admin'), false);
    assert.strictEqual(canManageFn('admin', 'group_leader'), true);
    assert.strictEqual(canManageFn('group_leader', 'admin'), false);
    assert.strictEqual(canManageFn('group_leader', 'group_leader'), false);
    assert.strictEqual(canManageFn('group_leader', 'branch_leader'), true);
    assert.strictEqual(canManageFn('branch_leader', 'branch_leader'), false);
    assert.strictEqual(canManageFn('branch_leader', 'member'), true);
    assert.strictEqual(canManageFn('member', 'member'), false);
    assert.strictEqual(canManageFn('super_admin', 'super_admin'), false);

    // Verify all new forgot-password keys exist in BOTH I18N.zh and I18N.en AND i18n_dict.tsv has synced rows
    const i18nStart = html.indexOf('const I18N={');
    const i18nEnd = html.indexOf('let currentLang=');
    const I18N = new Function(html.slice(i18nStart, i18nEnd) + '; return I18N;')();
    const requiredKeys = [
      'login_forgot', 'login_forgot_prominent', 'fp_title', 'fp_contact', 'fp_body',
      'fp_id_label', 'fp_id_ph', 'fp_id_hint', 'fp_send_btn', 'fp_sending', 'fp_have_code',
      'fp_neutral_sent', 'fp_code_label', 'fp_code_ph', 'fp_code_hint',
      'fp_newpw_label', 'fp_newpw_ph', 'fp_confirmpw_label', 'fp_confirmpw_ph',
      'fp_pw_rules', 'fp_confirm_btn', 'fp_confirming', 'fp_no_mail_title', 'fp_no_mail_html',
      'fp_back_step1', 'fp_err_empty_id', 'fp_err_bad_email', 'fp_err_bad_code',
      'fp_err_pw_len', 'fp_err_pw_mismatch', 'fp_err_rate', 'fp_err_code_invalid', 'fp_reset_done_login'
    ];
    for (const k of requiredKeys) {
      assert.ok(typeof I18N.zh[k] === 'string' && I18N.zh[k].length > 0, `I18N.zh 缺少 ${k}`);
      assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length > 0, `I18N.en 缺少 ${k}`);
      if (k !== 'fp_code_ph') {
        assert.notStrictEqual(I18N.zh[k], I18N.en[k], `I18N 中英文不可未翻譯照抄: ${k}`);
      }
    }
    for (const tsvPair of [
      '🔑 忘記密碼？\t🔑 Forgot password?',
      '📨 發送 8 位重設碼\t📨 Send 8-character reset code',
      '✅ 確認重設密碼\t✅ Confirm password reset',
      '📬 收唔到信？點此查看排查方法\t📬 Didn’t get the email? Troubleshooting steps'
    ]) {
      assert.ok(tsv.includes(tsvPair), `i18n_dict.tsv 必須同步包含：${tsvPair}`);
    }
    ok('前端顯眼入口、兩步單動作介面、貼上消毒、職級門檻與 I18N／TSV 雙語同步全部通過');
  }

  console.log(`\n=== Password Reset & Proxy / UX / i18n 測試全部通過（共 ${passed} 項） ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
