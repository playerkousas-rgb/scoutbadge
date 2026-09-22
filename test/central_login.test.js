'use strict';

// Real Code.gs HTTP regression: Vercel -> GAS only, no outbound GAS requests.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { makeGas } = require('./gasvm');
const { backendHash, isCentralLoginCandidate, centralSubject, createCentralBootstrap } = require('../lib/super-auth');

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

async function proxy(body) {
  const res = await fetch(`${BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  gas.sheets.get('成員名單').appendRow(['1234567890', '陳大文', '2026-01-01', '', '', 'A隊']);
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
  let callbacks = 0;
  gas.sandbox.UrlFetchApp = { fetch() { callbacks++; throw new Error('External requests forbidden'); } };
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
    assert.strictEqual(diagBefore.configured, false, JSON.stringify(diagBefore));
    assert.strictEqual(diagBefore.storedHashTail, '');
    assert(typeof diagBefore.hint === 'string' && diagBefore.hint.length > 0);

    // No verifier config or external-request permission is needed.
    const validBody = { action: 'superLogin', apikey: KEY, login_id: 'sheep', isSuperAdmin: true };
    for (const patch of [{apikey: ''}, {apikey: 'wrong'}, {login_id: '1234567890'}, {isSuperAdmin: false}, {isSuperAdmin: 'true'}, {isSuperAdmin: null}]) {
      const denied = await gasDirect({...validBody, ...patch});
      assert.strictEqual(denied.success, false, JSON.stringify(patch));
      assert(!denied.token);
    }
    assert.strictEqual((await gasDirect(validBody)).success, true);
    assert.strictEqual((await gasDirect({action:'login', apikey:KEY, login_id:'sheep', password:'anything', isSuperAdmin:true})).success, false);
    const first = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(first.status, 200, JSON.stringify(first.data));
    assert.strictEqual(first.data.user.role, 'super_admin');
    assert.strictEqual(gas.props.has('CENTRAL_AUTH_VERIFY_URL'), false, 'No automatic callback bootstrap');
    ok('純單向登入：無 verifier 設定仍可登入；API_KEY、超管身份及 boolean 旗標必須全部正確');

    // ---- 2b+. 兩邊簽名互通回歸：Vercel（Node crypto）簽嘅開通許可真係要畀 GAS 驗到 ----
    // 回歸 #23：hmacHex 之前誤傳 'SHA_256' 做 value、真正嘅 key 被丟棄，
    // 兩邊簽名永遠唔一致 → 自動開通 100% 失敗（「中央登入尚未設定，自動開通又失敗」）。
    const bootVerifyUrl = 'https://example.vercel.app/api/verify-super-ticket';
    const bootSig = createCentralBootstrap({ verifyUrl: bootVerifyUrl, troopId: '0082', apikey: KEY });
    assert.strictEqual(gas.sandbox.validCentralBootstrap(bootSig, bootVerifyUrl, '0082'), true,
      'Vercel（Node crypto）簽嘅開通許可，GAS 一定要接受');
    assert.strictEqual(gas.sandbox.validCentralBootstrap(bootSig, bootVerifyUrl, '9999'), false, '簽名唔可以換旅團重用');
    assert.strictEqual(
      gas.sandbox.hmacHex(KEY, 'scoutbadge|interop|vector'),
      crypto.createHmac('sha256', KEY).update('scoutbadge|interop|vector', 'utf8').digest('hex'),
      'GAS hmacHex 要同 Node crypto 一致（value／key 次序）'
    );
    ok('兩邊簽名互通：Node crypto 簽嘅開通許可畀真 Code.gs 驗到；hmacHex 同 Node 一致');

    // ---- 3. 設定正確 → 測試連線要有 detail，唔係淨係 HTTP status ----
    const leader = await proxy({ troopId: '0082', action: 'login', login_id: '1234567890', password: 'PassA!234567' });
    assert.strictEqual(leader.data.success, true, JSON.stringify(leader.data));
    const cfg = await proxy({ troopId: '0082', action: 'configureTrustedTicketVerifier', verifyUrl: `${BASE}/api/verify-super-ticket`, token: leader.data.token });
    assert.strictEqual(cfg.data.success, true, JSON.stringify(cfg.data));
    const test = await proxy({ troopId: '0082', action: 'testTrustedTicketVerifier', token: leader.data.token });
    assert.strictEqual(test.data.success, true, JSON.stringify(test.data));
    assert.strictEqual(test.data.status, 200);
    assert(String(test.data.detail || '').indexOf('無需外部回調') >= 0, '成功時要有可讀 detail：' + JSON.stringify(test.data));
    ok('相容診斷：明確回報純單向模式，沒有聲稱已驗證 Vercel 登記');

    // ---- 4. 中央登入全循環（真 Code.gs 單向）----
    for (const id of ['sheep', 'Sheep', '  sheep  ', 'sheep@scoutbadge.local']) {
      const r = await proxy({ troopId: '0082', action: 'login', login_id: id, password: SUPER_PASSWORD });
      assert.strictEqual(r.status, 200, `${id}: ${JSON.stringify(r.data)}`);
      assert.strictEqual(r.data.success, true, `${id}: ${JSON.stringify(r.data)}`);
      assert.strictEqual(r.data.user.role, 'super_admin');
      assert(String(r.data.token).startsWith('sbs1.'));
    }
    // SUPER_KEY 前後有空白、輸入又打字時多咗空白，都要照入
    const padded = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: ` ${SUPER_PASSWORD}\n` });
    assert.strictEqual(padded.data.success, true, JSON.stringify(padded.data));
    ok('中央登入全循環：sheep／Sheep／空白／舊別名／SUPER_KEY 前後空白全部入到');

    // ---- 5. 驗證端點自我檢查（probe）：只回 booleans，唔回後端網址／Key ----
    const probeOk = await verifier({ ticket: 'test', troopId: '0082', backendHash: backendHash(EXEC_URL) });
    assert.strictEqual(probeOk.status, 200);
    assert.deepStrictEqual(probeOk.data, {
      valid: false, probe: true, verifier: 'scoutbadge-leaf', troop_known: true, backend_matches: true
    });
    const probeUnknown = await verifier({ ticket: 'test', troopId: '0000', backendHash: backendHash(EXEC_URL) });
    assert.strictEqual(probeUnknown.data.probe, true);
    assert.strictEqual(probeUnknown.data.troop_known, false);
    const probeMismatch = await verifier({ ticket: 'test', troopId: '0082', backendHash: backendHash(MISMATCH_URL) });
    assert.strictEqual(probeMismatch.data.backend_matches, false);
    const probeText = JSON.stringify([probeOk.data, probeUnknown.data, probeMismatch.data]);
    assert(probeText.indexOf('127.0.0.1') < 0 && probeText.indexOf(KEY) < 0, 'probe 唔可以洩漏後端網址或 API Key');
    ok('驗證端點自我檢查：只回 troop_known／backend_matches，無後端網址亦無 Key');

    // Stale callback configuration cannot affect one-way authentication.
    gas.props.set('CENTRAL_AUTH_VERIFY_URL', 'https://unreachable.invalid/verify');
    gas.props.set('CENTRAL_AUTH_BACKEND_HASH', '0'.repeat(64));
    for (let i = 0; i < 7; i++) {
      const again = await proxy({ troopId: '0099', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
      assert.strictEqual(again.status, 200, JSON.stringify(again.data));
    }
    assert.strictEqual(callbacks, 0, 'GAS must never call an external verifier');
    ok('過期／不一致的舊回調設定不影響純單向登入；外部請求次數為零');

    // ---- 7. 舊版後端（冇 superLogin）→ 轉譯成可行動提示 ----
    const old = await proxy({ troopId: '0077', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(old.status, 401);
    assert(String(old.data.error).indexOf('尚未更新') >= 0, old.data.error);
    assert(String(old.data.error).indexOf('Unknown action') < 0, '唔好直接彈後端原文畀使用者');
    ok('舊版後端：提示「尚未更新（缺少中央登入 superLogin）」而唔係 Unknown action');

    // ---- 8. 識回 409 但唔支援自動開通（Code.gs 冇部署新版本）→ 要講明「部署新版本」----
    const legacy = await proxy({ troopId: '0066', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(legacy.status, 409);
    assert(String(legacy.data.error).indexOf('管理部署作業') >= 0, legacy.data.error);
    assert(String(legacy.data.error).indexOf('新版本') >= 0, legacy.data.error);
    ok('未部署新版本：提示去「部署 → 管理部署作業」建立新版本（貼 Code.gs 唔等於 deploy）');

    // ---- 9. 密碼真係錯 → 仍然要擋（5 次後 429）----
    let locked = null;
    for (let i = 0; i < 5; i++) {
      locked = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: 'wrong-' + i });
      assert.strictEqual(locked.status, 401, JSON.stringify(locked.data));
    }
    const afterLimit = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(afterLimit.status, 429, '密碼錯誤仍然要 rate limit：' + JSON.stringify(afterLimit.data));
    ok('密碼錯誤：5 次後仍然 429（rate limit 只針對密碼猜測）');
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
