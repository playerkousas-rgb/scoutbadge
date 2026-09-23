'use strict';

// Real Code.gs HTTP regression: Vercel -> GAS only, no outbound GAS requests.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { makeGas } = require('./gasvm');
const { backendHash, isCentralLoginCandidate, centralSubject, createSuperTicket } = require('../lib/super-auth');

const GAS_PORT = 39531;
const OLD_PORT = 39532;
const LEGACY_PORT = 39534;
const DEV_PORT = 39533;
const KEY = 'KEY_A';
const EXEC_URL = `http://127.0.0.1:${GAS_PORT}/exec`;
// Deliberate mismatch: same Apps Script, registered with a trailing slash.
const MISMATCH_URL = `${EXEC_URL}/`;
const OLD_URL = `http://127.0.0.1:${OLD_PORT}/exec`;
const LEGACY_URL = `http://127.0.0.1:${LEGACY_PORT}/exec`;
const BASE = `http://127.0.0.1:${DEV_PORT}`;
const SUPER_PASSWORD = '0728';

let passed = 0;
const ok = (label) => { console.log(`  [PASS] ${label}`); passed += 1; };

function gasHttpServer(gas) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const params = {};
          new URL(req.url, 'http://127.0.0.1').searchParams.forEach((v, k) => { params[k] = v; });
          const out = req.method === 'GET'
            ? gas.sandbox.doGet({ parameter: params })
            : gas.sandbox.doPost({ postData: { contents: raw }, parameter: params });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(out.getContent());
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'gasvm: ' + (e && e.stack || e) }));
        }
      });
    });
    server.listen(GAS_PORT, '127.0.0.1', () => resolve(server));
  });
}

// A backend that knows the central contract (it reports 409) but was never
// re-deployed with bootstrap support: configuring still demands a leader.
function legacyBackendServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (body.action === 'superLogin') {
          res.end(JSON.stringify({ success: false, code: 409, reason: 'central_verifier_not_configured', error: '中央登入尚未設定' }));
          return;
        }
        res.end(JSON.stringify({ success: false, error: '需領袖權限' }));
      });
    });
    server.listen(LEGACY_PORT, '127.0.0.1', () => resolve(server));
  });
}

// A troop backend that was never upgraded: it has no central-login action.
function oldBackendServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Unknown action: ' + body.action }));
      });
    });
    server.listen(OLD_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function proxy(body, extraHeaders) {
  const res = await fetch(`${BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, data };
}

async function gasDirect(body) {
  const res = await fetch(EXEC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function verifier(body) {
  const res = await fetch(`${BASE}/api/verify-super-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

function seed(gas) {
  const users = gas.sheets.get('Users');
  const hash = gas.sandbox.hashPassword;
  users.appendRow(['1234567890', '陳大文', 'leader@example.org', 'group_leader', hash('PassA!234567'), '', true, 'test', '2026-01-01', '2026-01-01', '', 'active', '', 'A隊', 'member', false]);
  users.appendRow(['1234560001', '成員甲', 'member@example.org', 'member', hash('MemberA!234'), '', false, 'test', '2026-01-01', '2026-01-01', '', 'active', '', 'A隊', 'member', false]);
  gas.sheets.get('成員名單').appendRow(['1234567890', '陳大文', '2026-01-01', '', '', 'A隊']);
  gas.sheets.get('成員名單').appendRow(['1234560001', '成員甲', '2026-01-01', '', '', 'A隊']);
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fetch(`${BASE}/api/troops`); return; }
    catch (_) {
      if (Date.now() > deadline) throw new Error('dev server did not start');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

async function run() {
  const gas = makeGas({ apiKey: KEY, execUrl: EXEC_URL });
  // 「回打」係真嘅：gasvm 嘅 UrlFetchApp 會行一次真 HTTP。測試只加上計數，唔會攔。
  const callbacks = [];
  const realFetch = gas.sandbox.UrlFetchApp.fetch;
  gas.sandbox.UrlFetchApp = {
    fetch: (url, options) => { callbacks.push(String(url)); return realFetch(url, options); }
  };
  gas.sandbox.initializeSheets();
  seed(gas);
  const gasServer = await gasHttpServer(gas);
  const oldServer = await oldBackendServer();
  const legacyServer = await legacyBackendServer();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      SCOUTBADGE_PROXY_TEST: '1',
      PORT: String(DEV_PORT),
      TROOP_0082_NAME: '第 82 旅（中央登入）',
      TROOP_0082_BACKEND: EXEC_URL,
      TROOP_0082_APIKEY: KEY,
      // Same script, registered with a trailing slash: hash must not match.
      TROOP_0099_NAME: '第 99 旅（後端不一致）',
      TROOP_0099_BACKEND: MISMATCH_URL,
      TROOP_0099_APIKEY: KEY,
      // Backend that predates the central-login contract.
      TROOP_0077_NAME: '第 77 旅（舊版後端）',
      TROOP_0077_BACKEND: OLD_URL,
      TROOP_0077_APIKEY: KEY,
      // Backend that reports 409 but cannot self-bootstrap (never re-deployed).
      TROOP_0066_NAME: '第 66 旅（未部署新版本）',
      TROOP_0066_BACKEND: LEGACY_URL,
      TROOP_0066_APIKEY: KEY,
      // Pasted values often carry whitespace; login must still work.
      SUPER_KEY: `  ${SUPER_PASSWORD}  `
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();

  try {
    // ---- 1. 中央帳號識別（含舊別名）----
    assert.strictEqual(isCentralLoginCandidate('sheep'), true);
    assert.strictEqual(isCentralLoginCandidate('1234560001'), false, 'YMIS 行本團登入');
    assert.strictEqual(isCentralLoginCandidate('leader@example.org'), false, 'email 行本團登入');
    assert.strictEqual(centralSubject('sheep@scoutbadge.local'), 'sheep', '舊別名要摺返去中央帳號');
    assert.strictEqual(centralSubject('  SHEEP  '), 'SHEEP');
    ok('中央帳號識別：sheep／大小寫／空白／舊別名 sheep@scoutbadge.local');

    // ---- 1b. 只讀診斷（喺 Apps Script 編輯器 Run diagnoseCentralLogin 用）----
    const diagBefore = gas.sandbox.diagnoseCentralLogin();
    assert.strictEqual(diagBefore.mode, 'callback', JSON.stringify(diagBefore));
    assert.strictEqual(diagBefore.verifyUrlIsConstant, true, '線上一定用常數端點');
    assert(/\/api\/verify-super-ticket$/.test(diagBefore.verifyUrlTail), diagBefore.verifyUrlTail);
    assert.strictEqual(diagBefore.backendHashTail.length, 8);
    assert(typeof diagBefore.hint === 'string' && diagBefore.hint.indexOf('回打') >= 0);
    ok('診斷：回打模式、常數端點、後端 hash 尾段（只讀，唔發請求）');

    // ---- 2. 舊版單向授權已停用（fail closed）----
    // 以前：Vercel 驗 SUPER_KEY → 只要本團 API_KEY 正確就發中央 session。
    // 現在：冇 Vercel 封嘅短效票，一律唔發，而且唔會偷偷回退。
    // 真部署嘅端點係 Code.gs 常數；本地測試用 loopback 覆寫（第 3 節會經管理介面再做一次）。
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', `${BASE}/api/verify-super-ticket`);
    const oneWay = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', isSuperAdmin: true });
    assert.strictEqual(oneWay.success, false, JSON.stringify(oneWay));
    assert.strictEqual(oneWay.code, 401);
    assert(!oneWay.token);
    assert.strictEqual(callbacks.length, 0, '冇票＝唔會回打');
    const noTicket = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep' });
    assert.strictEqual(noTicket.success, false);
    assert.strictEqual(noTicket.code, 401);
    assert.strictEqual(callbacks.length, 0);
    const wrongUser = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: '1234567890', super_ticket: 'sbt1.a.b.c' });
    assert.strictEqual(wrongUser.success, false, '中央票只可以用喺中央身份');
    assert.strictEqual(callbacks.length, 0, '唔係中央身份：連回打都唔會做');
    const noKey = await gasDirect({ action: 'superLogin', login_id: 'sheep', super_ticket: 'sbt1.a.b.c' });
    assert.strictEqual(noKey.success, false);
    assert.strictEqual(noKey.code, 403, '冇 API Key 連 requireAuth 都過唔到');
    assert.strictEqual(callbacks.length, 0);
    // 一張假票會被送去驗票端點，端點話唔 valid → 一樣 401（冇 fallback）。
    const junkTicket = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: 'not-a-real-ticket' });
    assert.strictEqual(junkTicket.success, false);
    assert.strictEqual(junkTicket.code, 401);
    assert.strictEqual(callbacks.length, 1, '假票要真係問過端點先算 fail closed');
    assert.strictEqual((await gasDirect({ action: 'login', apikey: KEY, login_id: 'sheep', password: 'anything', isSuperAdmin: true })).success, false);
    ok('單向授權已停用：無票／爛票／錯身份一律 401，只有真票先過');

    // ---- 3. 舊管理介面（相容）：線上端點固定，只准 loopback 覆寫 ----
    const leader = await proxy({ troopId: '0082', action: 'login', login_id: '1234567890', password: 'PassA!234567' });
    assert.strictEqual(leader.data.success, true, JSON.stringify(leader.data));
    const member = await proxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'MemberA!234' });
    assert.strictEqual(member.data.success, true, JSON.stringify(member.data));
    const memberCfg = await proxy({ troopId: '0082', action: 'configureTrustedTicketVerifier', verifyUrl: `${BASE}/api/verify-super-ticket`, token: member.data.token });
    assert.strictEqual(memberCfg.data.success, false, '成員唔可以設定驗票端點');
    const httpsCfg = await proxy({ troopId: '0082', action: 'configureTrustedTicketVerifier', verifyUrl: 'https://evil.example.com/api/verify-super-ticket', token: leader.data.token });
    assert.strictEqual(httpsCfg.data.success, false, JSON.stringify(httpsCfg.data));
    assert(String(httpsCfg.data.error).indexOf('常數') >= 0, '要講明線上端點係常數：' + httpsCfg.data.error);
    const loopCfg = await proxy({ troopId: '0082', action: 'configureTrustedTicketVerifier', verifyUrl: `${BASE}/api/verify-super-ticket`, token: leader.data.token });
    assert.strictEqual(loopCfg.data.success, true, JSON.stringify(loopCfg.data));
    assert.strictEqual(loopCfg.data.loopback_override, true);
    assert.strictEqual(loopCfg.data.verify_url_in_use, `${BASE}/api/verify-super-ticket`);
    ok('驗票端點：https 覆寫被拒（線上係 Code.gs 常數），只有 loopback 可以做本地覆寫');

    // ---- 4. 真票 + 真回打：Node 封嘅票，真 Code.gs 打返 dev server 驗 ----
    process.env.SUPER_KEY = `  ${SUPER_PASSWORD}  `;
    const mint = (over) => createSuperTicket(Object.assign({
      troopId: '0082', backend: EXEC_URL, apikey: KEY, loginId: 'sheep'
    }, over || {}));
    const ticket = mint();
    assert(String(ticket).startsWith('sbt1.'), '票要有 sbt1 封套前綴');
    const beforeFirst = callbacks.length;
    const first = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: ticket });
    assert.strictEqual(first.success, true, JSON.stringify(first));
    assert.strictEqual(first.user.role, 'super_admin');
    assert.strictEqual(first.central, 'callback');
    assert.strictEqual(callbacks.length, beforeFirst + 1, '一次登入＝一次回打');
    assert.strictEqual(callbacks[beforeFirst], `${BASE}/api/verify-super-ticket`, '回打一定係本部署嘅驗票端點');
    const replay = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: ticket });
    assert.strictEqual(replay.success, false, '同一張票唔可以換第二次 token');
    assert.strictEqual(replay.code, 401);
    ok('回打驗票：真票換到 token（超管身份），同一張票第二次即 401（單次使用）');

    // 換旅團後端／換 KEY／換身份封嘅票，一律唔得。
    const wrongBackend = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: mint({ backend: MISMATCH_URL }) });
    assert.strictEqual(wrongBackend.success, false, '後端 hash 唔一致嘅票要拒');
    const wrongKey = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: mint({ apikey: 'OTHER-KEY' }) });
    assert.strictEqual(wrongKey.success, false, '唔係本團 KEY 封嘅票要拒');
    const wrongSubject = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: mint({ loginId: 'someone-else' }) });
    assert.strictEqual(wrongSubject.success, false, '身份唔夾嘅票要拒');
    const tampered = String(ticket).split('.');
    tampered[2] = tampered[2].slice(0, -2) + (tampered[2].endsWith('AA') ? 'BB' : 'AA');
    const tamperedRes = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', super_ticket: tampered.join('.') });
    assert.strictEqual(tamperedRes.success, false, '改過嘅票（GCM tag）要拒');
    ok('票綁死旅團後端、本團 KEY 同身份；改一個 byte 都驗唔過');

    // ---- 5. 中央登入全循環（proxy 封票 → 真 GAS 回打 → sealed session）----
    for (const id of ['sheep', 'Sheep', '  sheep  ', 'sheep@scoutbadge.local']) {
      const r = await proxy({ troopId: '0082', action: 'login', login_id: id, password: SUPER_PASSWORD });
      assert.strictEqual(r.status, 200, `${id}: ${JSON.stringify(r.data)}`);
      assert.strictEqual(r.data.success, true, `${id}: ${JSON.stringify(r.data)}`);
      assert.strictEqual(r.data.user.role, 'super_admin');
      assert(String(r.data.token).startsWith('sbs1.'), '瀏覽器只拿到 sealed session');
      assert(String(r.data.token).indexOf('gas_') < 0, 'GAS token 唔可以原樣交去瀏覽器');
    }
    // SUPER_KEY 前後有空白、輸入又打字時多咗空白，都要照入
    const padded = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: ` ${SUPER_PASSWORD}\n` });
    assert.strictEqual(padded.data.success, true, JSON.stringify(padded.data));
    // 密碼唔會落去後端：封票之後 GAS 只見到票。
    assert(callbacks.length >= beforeFirst + 1 + 5, '每次中央登入都要回打一次');
    ok('中央登入全循環：sheep／大小寫／空白／舊別名／SUPER_KEY 前後空白全部入到，票由 proxy 封');

    // ---- 6. 驗票端點自我檢查（probe）：只回 booleans，唔回後端網址／Key ----
    const probeOk = await verifier({ ticket: 'test', apikey: KEY, backendHash: backendHash(EXEC_URL) });
    assert.strictEqual(probeOk.status, 200);
    assert.strictEqual(probeOk.data.probe, true);
    assert.strictEqual(probeOk.data.troop_known, true);
    assert.strictEqual(probeOk.data.key_ok, true);
    assert.strictEqual(probeOk.data.backend_matches, true);
    assert.strictEqual(probeOk.data.troop_id, '0082');
    const probeUnknown = await verifier({ ticket: 'test', apikey: 'NOT-A-KEY', backendHash: backendHash(EXEC_URL) });
    assert.strictEqual(probeUnknown.data.troop_known, false);
    const probeMismatch = await verifier({ ticket: 'test', troopId: '0082', apikey: 'WRONG', backendHash: backendHash(MISMATCH_URL) });
    assert.strictEqual(probeMismatch.data.troop_known, true);
    assert.strictEqual(probeMismatch.data.key_ok, false, '冇本團 KEY 唔會確認後端');
    assert.strictEqual(probeMismatch.data.backend_matches, false);
    const probeText = JSON.stringify([probeOk.data, probeUnknown.data, probeMismatch.data]);
    assert(probeText.indexOf('127.0.0.1') < 0 && probeText.indexOf(KEY) < 0, 'probe 唔可以洩漏後端網址或 API Key');
    ok('驗票端點自我檢查：旅團登記／KEY／後端一致性只回 booleans，無後端網址亦無 Key');

    // ---- 7. 端點係常數：前端寫入嘅 https 覆寫永遠唔會生效 ----
    // （如果呢個檢查消失，任何拎到領袖 token 嘅人就可以把票＋本團 API Key 送去自己部機，
    //   再拿住張有效票去開中央 session。）
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', 'https://evil.example.com/api/verify-super-ticket');
    assert.strictEqual(gas.sandbox.superVerifyUrl(), 'https://scoutbadge.vercel.app/api/verify-super-ticket',
      '非 loopback 覆寫一定要被忽略');
    assert.strictEqual(gas.sandbox.superVerifyUrl().indexOf('evil.example.com') < 0, true);
    let threw = false;
    try { gas.sandbox.configureTrustedTicketVerifier('https://evil.example.com/x', '0082'); } catch (e) { threw = true; }
    assert.strictEqual(threw, true, '非 loopback 覆寫一定要拋錯');
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', `${BASE}/api/verify-super-ticket`);
    assert.strictEqual(gas.sandbox.superVerifyUrl(), `${BASE}/api/verify-super-ticket`, 'loopback 覆寫係本地測試唯一例外');
    ok('常數優先：非 loopback 覆寫被忽略、被拒；只有 127.0.0.1 可以做本地覆寫');

    // ---- 8. 舊版後端／未部署新版本 → 可行動提示 ----
    const old = await proxy({ troopId: '0077', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(old.status, 409, JSON.stringify(old.data));
    assert(String(old.data.error).indexOf('回打驗票') >= 0, old.data.error);
    assert(String(old.data.error).indexOf('Unknown action') < 0, '唔好直接彈後端原文畀使用者');
    const legacy = await proxy({ troopId: '0066', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(legacy.status, 409, JSON.stringify(legacy.data));
    assert(String(legacy.data.error).indexOf('管理部署作業') >= 0, legacy.data.error);
    ok('舊版後端：提示「未支援中央登入回打驗票」＋去「部署 → 管理部署作業」建立新版本');

    // ---- 9. 密碼真係錯 → 仍然要擋（5 次後 429）----
    let locked = null;
    for (let i = 0; i < 5; i++) {
      locked = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: 'wrong-' + i });
      assert.strictEqual(locked.status, 401, JSON.stringify(locked.data));
    }
    const afterLimit = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(afterLimit.status, 429, '密碼錯誤仍然要 rate limit：' + JSON.stringify(afterLimit.data));
    ok('密碼錯誤：5 次後仍然 429（rate limit 只針對密碼猜測）');

    // ---- 10. 驗票端點連唔到 → fail closed（唔會偷偷放行）----
    // 上面 5 次錯密碼把同一個 IP 鎖咗（15 分鐘），所以呢兩次用另一個 IP：
    // 想驗嘅係「端點死咗會唔會偷偷放行」，唔係 rate limit。
    const otherIp = { 'x-forwarded-for': '203.0.113.7' };
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', 'http://127.0.0.1:39599/api/verify-super-ticket');
    const dead = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD }, otherIp);
    assert.strictEqual(dead.status, 503, JSON.stringify(dead.data));
    assert.strictEqual(dead.data.success, false);
    assert(String(dead.data.error).indexOf('驗票') >= 0, '要講明係驗票端點問題：' + dead.data.error);
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', `${BASE}/api/verify-super-ticket`);
    const recovered = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD }, otherIp);
    assert.strictEqual(recovered.data.success, true, JSON.stringify(recovered.data));
    ok('驗票端點連唔到：503 fail closed（唔會回退單向授權）；端點返嚟即刻恢復');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 500); });
    gasServer.close();
    oldServer.close();
    legacyServer.close();
  }

  console.log(`\n=== 中央登入診斷：${passed} 通過 ===`);
}

run().catch((err) => {
  console.error('\n[CENTRAL LOGIN FAIL]', err && (err.stack || err.message));
  process.exit(1);
});
