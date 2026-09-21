'use strict';

/*
 * End-to-end HTTP test: real dev server + real /api/proxy + real /api/troops
 * + /api/verify-super-ticket + mock GAS troops over loopback. This is the
 * same HTTP pipeline that runs in production, so it catches integration
 * breakage that unit-level fetch mocks cannot.
 *
 * Covers:
 *   - static surface (/, /apps-script/Code.gs)
 *   - troop catalogue (id+name only)
 *   - method / input guards
 *   - member & leader login, load (GET + injected apikey), save
 *   - cross-troop token isolation
 *   - central (super) login: full bootstrap loop
 *       leader token → configureTrustedTicketVerifier → testTrustedTicketVerifier
 *       → proxy signs ticket → GAS calls back /api/verify-super-ticket → sealed session
 *   - submitContact registration (fixed server-side admin inbox, unregistered troop OK;
 *     503 when SCOUTBADGE_ADMIN_API is unset)
 *
 * Requires lib/registry.js loopback test escape hatch (SCOUTBADGE_PROXY_TEST=1,
 * disabled automatically on Vercel).
 */

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { startMockGas } = require('./mock-gas');

const MOCK_A_PORT = 39111;
const MOCK_B_PORT = 39112;
const ADMIN_PORT = 39114;
const DEV_PORT = 39113;
const DEV_PORT_NOADMIN = 39115;
const BASE = `http://127.0.0.1:${DEV_PORT}`;
const BASE_NOADMIN = `http://127.0.0.1:${DEV_PORT_NOADMIN}`;

function baseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TROOP_') || key.startsWith('SUPER_') || key === 'SCOUTBADGE_ADMIN_API') delete env[key];
  }
  return {
    ...env,
    SCOUTBADGE_PROXY_TEST: '1',
    TROOP_0082_NAME: '第 82 旅（測試）',
    TROOP_0082_BACKEND: `http://127.0.0.1:${MOCK_A_PORT}/exec`,
    TROOP_0082_APIKEY: 'KEY_A',
    TROOP_82_NAME: '第 82a 旅（測試）',
    TROOP_82_BACKEND: `http://127.0.0.1:${MOCK_B_PORT}/exec`,
    TROOP_82_APIKEY: 'KEY_B',
    SUPER_KEY: 'test-super-key-42'
  };
}

async function proxy(base, body, method = 'POST') {
  const res = await fetch(`${base}/api/proxy`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-json */ }
  return { status: res.status, data };
}

function startAdminInbox(port) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* ignore */ }
        seen.push({ url: req.url, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }));
  });
}

async function waitForServer(url, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start: ${url}`);
}

async function run() {
  const mockA = await startMockGas({
    port: MOCK_A_PORT, name: '旅團A', apikey: 'KEY_A',
    execUrl: `http://127.0.0.1:${MOCK_A_PORT}/exec`,
    users: [
      { ymis: '1234567890', name: '陳大文', email: 'leader@example.org', role: 'group_leader', password: 'PassA!234567' },
      { ymis: '1234560001', name: '成員甲', email: 'member@example.org', role: 'member', password: 'MemberA!234' },
      { ymis: 'S1', name: '中央管代', email: '', role: 'super_admin', password: 'irrelevant' }
    ]
  });
  const mockB = await startMockGas({
    port: MOCK_B_PORT, name: '旅團B', apikey: 'KEY_B',
    execUrl: `http://127.0.0.1:${MOCK_B_PORT}/exec`,
    users: [{ ymis: '9999999999', name: '旅團B成員', email: '', role: 'member', password: 'B!pass' }]
  });
  const inbox = await startAdminInbox(ADMIN_PORT);

  const children = [];
  const spawnDev = (port, extraEnv) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...baseEnv(), PORT: String(port), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.serverLog = '';
    child.stdout.on('data', (d) => { child.serverLog += d; });
    child.stderr.on('data', (d) => { child.serverLog += d; });
    children.push(child);
    return child;
  };
  spawnDev(DEV_PORT, { SCOUTBADGE_ADMIN_API: `http://127.0.0.1:${ADMIN_PORT}/exec` });
  spawnDev(DEV_PORT_NOADMIN, {});

  try {
    await waitForServer(`${BASE}/api/troops`);
    await waitForServer(`${BASE_NOADMIN}/api/troops`);
    let passed = 0;
    const ok = (label) => { console.log(`  [PASS] ${label}`); passed += 1; };

    // --- static surface ---
    const home = await fetch(`${BASE}/`);
    assert.strictEqual(home.status, 200);
    const homeText = await home.text();
    assert(homeText.includes('童軍支部進度及行政平台'), 'home page should be the ScoutBadge app');
    ok('GET / serves index.html');

    const gs = await fetch(`${BASE}/apps-script/Code.gs`);
    assert.strictEqual(gs.status, 200);
    ok('GET /apps-script/Code.gs serves the download file');

    // --- troop catalogue ---
    const troopsRes = await fetch(`${BASE}/api/troops`);
    assert.strictEqual(troopsRes.status, 200);
    const troops = await troopsRes.json();
    assert.deepStrictEqual(Object.keys(troops.troops).sort(), ['0082', '82']);
    for (const t of Object.values(troops.troops)) {
      assert.strictEqual(typeof t.name, 'string');
      assert.strictEqual(t.backend, undefined);
      assert.strictEqual(t.apikey, undefined);
      assert.strictEqual(t.apiKey, undefined);
    }
    ok('/api/troops exposes id+name only, no backend/apikey');

    // --- method + input guards ---
    const get405 = await proxy(BASE, { troopId: '0082', action: 'load' }, 'GET');
    assert.strictEqual(get405.status, 405);
    ok('GET /api/proxy → 405');

    const badTroop = await proxy(BASE, { troopId: '9999', action: 'load' });
    assert.strictEqual(badTroop.status, 404);
    ok('unknown troopId → 404');

    const superDirect = await proxy(BASE, { troopId: '0082', action: 'superLogin', login_id: 'S1', ticket: 'x' });
    assert.strictEqual(superDirect.status, 403);
    ok('direct superLogin action is refused');

    // --- normal member login → load ---
    const login = await proxy(BASE, { troopId: '0082', action: 'login', login_id: '1234560001', password: 'MemberA!234' });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.data.success, true);
    assert(typeof login.data.token === 'string' && login.data.token.length > 0);
    assert.strictEqual(login.data.user.role, 'member');
    ok('member login returns token');
    const memberToken = login.data.token;

    const badLogin = await proxy(BASE, { troopId: '0082', action: 'login', login_id: '1234560001', password: 'wrong' });
    assert.strictEqual(badLogin.status, 200);
    assert.strictEqual(badLogin.data.success, false);
    ok('wrong password → success:false (GAS business error preserved)');

    const load = await proxy(BASE, { troopId: '0082', action: 'load', token: memberToken });
    assert.strictEqual(load.status, 200);
    assert.strictEqual(load.data.success, true);
    assert.strictEqual(load.data.troop, '旅團A');
    const loadCall = mockA.calls.at(-1);
    assert.strictEqual(loadCall.method, 'GET');
    ok('load goes to troop A backend via GET');

    const loadRaw = new URL(mockA.calls.find((c) => c.method === 'GET').url.replace(/^\/exec/, `http://127.0.0.1:${MOCK_A_PORT}/exec`));
    assert.strictEqual(loadRaw.searchParams.get('apikey'), 'KEY_A');
    ok('proxy injects the server-side apikey (never from the browser)');

    // --- cross-troop token isolation ---
    const cross = await proxy(BASE, { troopId: '82', action: 'load', token: memberToken });
    assert(cross.status === 401 || cross.data.success === false, 'troop A token must not work on troop B');
    ok('troop A token rejected on troop B');

    // --- save with server-injected apikey ---
    const save = await proxy(BASE, {
      troopId: '0082', action: 'save',
      changes: [{ ymis: '1234560001', item: 'X', done: true }],
      confirmer: '陳大文'
    });
    assert.strictEqual(save.status, 200);
    assert.strictEqual(save.data.success, true);
    assert.strictEqual(save.data.saved, 1);
    ok('save succeeds with server-injected apikey');

    // --- leader flow ---
    const leaderLogin = await proxy(BASE, { troopId: '0082', action: 'login', login_id: 'leader@example.org', password: 'PassA!234567' });
    assert.strictEqual(leaderLogin.data.success, true);
    const leaderToken = leaderLogin.data.token;
    const users = await proxy(BASE, { troopId: '0082', action: 'getAllUsers', token: leaderToken });
    assert.strictEqual(users.data.success, true);
    assert(Array.isArray(users.data.users) && users.data.users.length >= 3);
    ok('leader login + getAllUsers');

    // --- central login bootstrap (leader configures the GAS verifier) ---
    const preBootstrap = await proxy(BASE, { troopId: '0082', action: 'login', login_id: 'S1', password: 'test-super-key-42' });
    assert(preBootstrap.status === 401 && preBootstrap.data.success === false, 'central login must fail before bootstrap');
    ok('central login fails before the verifier is configured');

    const memberConfigure = await proxy(BASE, {
      troopId: '0082', action: 'configureTrustedTicketVerifier',
      verifyUrl: `${BASE}/api/verify-super-ticket`, token: memberToken
    });
    assert.strictEqual(memberConfigure.data.success, false, 'members must not configure the verifier');
    ok('member cannot configure the verifier');

    const configure = await proxy(BASE, {
      troopId: '0082', action: 'configureTrustedTicketVerifier',
      verifyUrl: `${BASE}/api/verify-super-ticket`, token: leaderToken
    });
    assert.strictEqual(configure.status, 200, JSON.stringify(configure.data));
    assert.strictEqual(configure.data.success, true);
    assert.strictEqual(configure.data.troopId, '0082', 'GAS must receive the routed troop id');
    ok('leader configures the verifier (troopId carried through the proxy)');

    const testCfg = await proxy(BASE, { troopId: '0082', action: 'testTrustedTicketVerifier', token: leaderToken });
    assert.strictEqual(testCfg.data.success, true, JSON.stringify(testCfg.data));
    ok('testTrustedTicketVerifier confirms the callback loop');

    const superLogin = await proxy(BASE, { troopId: '0082', action: 'login', login_id: 'S1', password: 'test-super-key-42' });
    assert.strictEqual(superLogin.status, 200, JSON.stringify(superLogin.data));
    assert.strictEqual(superLogin.data.success, true, JSON.stringify(superLogin.data));
    assert.strictEqual(superLogin.data.user.role, 'super_admin');
    // The browser token is an opaque sealed session, not the raw GAS token.
    assert(superLogin.data.token.startsWith('sbs1.'), 'central session must be a sealed sbs1 envelope');
    ok('central login: proxy signs ticket, GAS verifies via callback, sealed session returned');

    const superLoad = await proxy(BASE, { troopId: '0082', action: 'load', token: superLogin.data.token });
    assert.strictEqual(superLoad.status, 200);
    assert.strictEqual(superLoad.data.success, true);
    ok('sealed central session unwraps and routes to the right troop');

    const superWrongPw = await proxy(BASE, { troopId: '0082', action: 'login', login_id: 'S1', password: 'nope' });
    assert.strictEqual(superWrongPw.status, 401);
    ok('central login with wrong key → 401, no upstream call');

    // --- verify-super-ticket direct guards ---
    const v1 = await fetch(`${BASE}/api/verify-super-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'sbt1.fake', troopId: '0082', backendHash: 'x', loginId: 'S1' })
    });
    const v1d = await v1.json();
    assert.strictEqual(v1d.valid, false);
    ok('verify-super-ticket rejects forged ticket');

    const v2 = await fetch(`${BASE}/api/verify-super-ticket`, { method: 'GET' });
    assert.strictEqual(v2.status, 405);
    ok('verify-super-ticket refuses non-POST');

    // --- submitContact (new-troop registration) ---
    const reg = await proxy(BASE, {
      troopId: '0777', // not registered yet — must still work
      action: 'submitContact',
      troopName: '新旅團',
      scriptUrl: 'https://script.google.com/macros/s/FAKEDEPLOYID1234567890/exec',
      apiKey: 'NEW-TROOP-KEY',
      appType: 'scoutbadge',
      note: '測試申請'
    });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.data));
    assert.strictEqual(reg.data.success, true);
    assert.strictEqual(inbox.seen.length, 1);
    assert.strictEqual(inbox.seen[0].body.troopId, '0777');
    assert.strictEqual(inbox.seen[0].body.apiKey, 'NEW-TROOP-KEY');
    assert.strictEqual(inbox.seen[0].body.appType, 'scoutbadge');
    ok('submitContact forwards to the fixed server-side admin inbox (unregistered troop ok)');

    const regNoConfig = await proxy(BASE_NOADMIN, {
      troopId: '0777',
      action: 'submitContact',
      troopName: '新旅團',
      scriptUrl: 'https://script.google.com/macros/s/FAKEDEPLOYID1234567890/exec',
      apiKey: 'NEW-TROOP-KEY',
      appType: 'scoutbadge',
      note: ''
    });
    assert.strictEqual(regNoConfig.status, 503);
    assert(regNoConfig.data.success === false && regNoConfig.data.error.length > 0);
    assert.strictEqual(inbox.seen.length, 1, 'unconfigured registration must not reach any backend');
    ok('submitContact without SCOUTBADGE_ADMIN_API → clean 503, no upstream call');

    const regBad = await proxy(BASE, { troopId: '0777', action: 'submitContact', troopName: 'x' });
    assert.strictEqual(regBad.status, 400);
    ok('submitContact with incomplete data → 400');

    console.log(`\n=== E2E HTTP：${passed} 通過 ===`);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((c) => new Promise((r) => { c.once('exit', r); setTimeout(r, 500); })));
    mockA.server && mockA.server.close();
    mockB.server && mockB.server.close();
    inbox.server && inbox.server.close();
  }
}

run().catch((err) => {
  console.error('\n[E2E FAIL]', err.message);
  process.exit(1);
});
