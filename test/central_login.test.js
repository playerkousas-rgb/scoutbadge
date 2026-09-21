'use strict';

/*
 * 中央登入（sheep）故障診斷 e2e —— 打真 apps-script/Code.gs：
 *   dev server → /api/proxy → http /exec（vm 內執行原碼）→ /api/verify-super-ticket 回調
 *
 * 目的：中央登入失敗時，管理員要睇到「邊一關衰」同「下一步做咩」，
 * 而唔係一個無差別嘅「登入失敗」。呢個檔同時鎖死兩個舊 bug：
 *   1. 「測試連線」之前淨係睇 HTTP status，4xx／雜湊唔一致都會報成功；
 *   2. 設定壞咗時，重試 5 次會被 rate limit 鎖死 15 分鐘（修唔到設定）。
 *
 * 覆蓋：
 *   - 未設定 verifier → 409＋可行動提示
 *   - 設定正確 → 測試連線報 detail，sheep 登入成功（含大小寫／空白／舊別名）
 *   - 後端網址唔一致 → 測試連線講明「唔一致」，登入被拒但唔會鎖死
 *   - 舊版後端（無 superLogin）→ proxy 轉譯成「尚未更新」
 *   - SUPER_KEY 前後空白（Vercel 貼上常見）→ 照樣登入得
 *   - 密碼真係錯 → 仍然 5 次後 429
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { makeGas } = require('./gasvm');
const { backendHash, isCentralLoginCandidate, centralSubject } = require('../lib/super-auth');

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

    // ---- 2. 未設定 verifier：GAS 要講得出關卡，Proxy 要識自己開通 ----
    // 2a. GAS 合約：未設定時回 409 ＋ 可行動提示
    const direct = await gasDirect({ action: 'superLogin', apikey: KEY, login_id: 'sheep', ticket: 'x' });
    assert.strictEqual(direct.success, false, JSON.stringify(direct));
    assert.strictEqual(direct.code, 409);
    assert(String(direct.error).indexOf('尚未設定') >= 0, direct.error);
    assert(String(direct.error).indexOf('成員管理') >= 0, direct.error);
    // 2b. 經 Proxy：密碼啱 → 自動幫旅團開通（唔使預先有領袖 session）
    const first = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(first.status, 200, JSON.stringify(first.data));
    assert.strictEqual(first.data.success, true, JSON.stringify(first.data));
    assert.strictEqual(first.data.user.role, 'super_admin');
    ok('未設定 verifier：GAS 回 409＋提示；Proxy 用 SUPER_KEY 自動開通（解決雞生蛋）');

    // ---- 2c. 偽造 bootstrap：無 apikey 簽唔到，仍然要領袖權限 ----
    const forged = await gasDirect({
      action: 'configureTrustedTicketVerifier',
      apikey: KEY,
      verifyUrl: 'https://evil.example/api/verify-super-ticket',
      troopId: '0082',
      bootstrap: '99999999999.deadbeef'
    });
    assert.strictEqual(forged.success, false, JSON.stringify(forged));
    assert(String(forged.error).indexOf('需領袖權限') >= 0, JSON.stringify(forged));
    const stillOurs = await gasDirect({ action: 'testTrustedTicketVerifier', apikey: KEY, token: (await proxy({ troopId: '0082', action: 'login', login_id: '1234567890', password: 'PassA!234567' })).data.token });
    assert.strictEqual(stillOurs.success, true, '偽造 bootstrap 唔可以改到設定：' + JSON.stringify(stillOurs));
    ok('偽造 bootstrap 被拒：只有 Proxy（持有 apikey）先簽到開通許可');

    // ---- 3. 設定正確 → 測試連線要有 detail，唔係淨係 HTTP status ----
    const leader = await proxy({ troopId: '0082', action: 'login', login_id: '1234567890', password: 'PassA!234567' });
    assert.strictEqual(leader.data.success, true, JSON.stringify(leader.data));
    const cfg = await proxy({ troopId: '0082', action: 'configureTrustedTicketVerifier', verifyUrl: `${BASE}/api/verify-super-ticket`, token: leader.data.token });
    assert.strictEqual(cfg.data.success, true, JSON.stringify(cfg.data));
    const test = await proxy({ troopId: '0082', action: 'testTrustedTicketVerifier', token: leader.data.token });
    assert.strictEqual(test.data.success, true, JSON.stringify(test.data));
    assert.strictEqual(test.data.status, 200);
    assert(String(test.data.detail || '').indexOf('後端一致') >= 0, '成功時要有可讀 detail：' + JSON.stringify(test.data));
    ok('設定正確：測試連線回報「旅團已登記、後端一致」＋HTTP 200');

    // ---- 4. 中央登入全循環（真 Code.gs 回調）----
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

    // ---- 6. 後端網址唔一致（Vercel 登記多咗斜線）→ 要測得到、講得出、唔好鎖死 ----
    const cfg99 = await proxy({ troopId: '0099', action: 'configureTrustedTicketVerifier', verifyUrl: `${BASE}/api/verify-super-ticket`, token: leader.data.token });
    assert.strictEqual(cfg99.data.success, true, JSON.stringify(cfg99.data));
    const test99 = await proxy({ troopId: '0099', action: 'testTrustedTicketVerifier', token: leader.data.token });
    assert.strictEqual(test99.data.success, false, '雜湊唔一致時「測試連線」不可以報成功：' + JSON.stringify(test99.data));
    assert(String(test99.data.error).indexOf('唔一致') >= 0, test99.data.error);
    assert(String(test99.data.error).indexOf('TROOP_0099_BACKEND') >= 0, test99.data.error);
    const bad99 = await proxy({ troopId: '0099', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(bad99.status, 401);
    assert(String(bad99.data.error).indexOf('票據被拒') >= 0, bad99.data.error);
    // 修設定期間重試唔可以被 rate limit 鎖死
    for (let i = 0; i < 7; i++) {
      const again = await proxy({ troopId: '0099', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
      assert.strictEqual(again.status, 401, '設定問題唔可以升級做 429：' + JSON.stringify(again.data));
      assert(String(again.data.error).indexOf('票據被拒') >= 0);
    }
    ok('後端網址唔一致：測試連線報「唔一致」＋指名 TROOP_0099_BACKEND；重試 7 次都唔會被鎖死');

    // ---- 7. 舊版後端（冇 superLogin）→ 轉譯成可行動提示 ----
    const old = await proxy({ troopId: '0077', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(old.status, 401);
    assert(String(old.data.error).indexOf('尚未更新') >= 0, old.data.error);
    assert(String(old.data.error).indexOf('Unknown action') < 0, '唔好直接彈後端原文畀使用者');
    ok('舊版後端：提示「尚未更新（缺少中央登入 superLogin）」而唔係 Unknown action');

    // ---- 8. 識回 409 但唔支援自動開通（Code.gs 冇部署新版本）→ 要講明「部署新版本」----
    const legacy = await proxy({ troopId: '0066', action: 'login', login_id: 'sheep', password: SUPER_PASSWORD });
    assert.strictEqual(legacy.status, 401);
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
