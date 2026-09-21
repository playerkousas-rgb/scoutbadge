'use strict';

const assert = require('assert');
const proxyHandler = require('../api/proxy');
const troopsHandler = require('../api/troops');
const verifyTicketHandler = require('../api/verify-super-ticket');
const { getTroopConfig, getRegistry, getPortalConfig } = require('../lib/registry');
const { unwrapBrowserSession } = require('../lib/super-auth');
const loginRateLimit = require('../lib/login-rate-limit');

function configure() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TROOP_') || key.startsWith('SUPER_') || key.startsWith('PORTAL_')) delete process.env[key];
  }
  process.env.TROOP_0082_NAME = '第 82 旅';
  process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TROOP_A/exec';
  process.env.TROOP_0082_APIKEY = 'server-key-a';
  process.env.TROOP_82_NAME = '第 82 短編號旅';
  process.env.TROOP_82_BACKEND = 'https://script.google.com/macros/s/TROOP_B/exec';
  process.env.TROOP_82_APIKEY = 'server-key-b';
  process.env.TROOP_0099_NAME = '不完整旅團';
  process.env.TROOP_0099_BACKEND = 'https://script.google.com/macros/s/INCOMPLETE/exec';
  process.env.PORTAL_DEFAULT_ORIGIN = 'https://portal.example.test';
  process.env.PORTAL_DEFAULT_ROLES = 'member,group_leader';
  process.env.TROOP_0082_PORTALDISABLED = 'true';
  loginRateLimit.resetForTests();
}

function response() {
  const out = { statusCode: 0, body: null, headers: {} };
  out.setHeader = (name, value) => { out.headers[name.toLowerCase()] = value; };
  out.status = (statusCode) => { out.statusCode = statusCode; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
}

async function callProxy(body, reqExtras = {}) {
  const res = response();
  await proxyHandler({ method: 'POST', body, headers: {}, ...reqExtras }, res);
  return res;
}

async function run() {
  console.log('=== Proxy, registry, and central-login regression tests ===\n');
  configure();

  console.log('1. Environment-only registry and public catalogue');
  assert.deepStrictEqual(Object.keys(getRegistry()).sort(), ['0082', '82']);
  assert.strictEqual(getTroopConfig('0082').name, '第 82 旅');
  assert.strictEqual(getTroopConfig('82').name, '第 82 短編號旅');
  assert.strictEqual(getTroopConfig('00082'), null, 'IDs must not be padded or aliased');
  assert.deepStrictEqual(getPortalConfig('0082'), { disabled: true, origin: 'https://portal.example.test', roles: ['member', 'group_leader'] });
  const troopsRes = response();
  troopsHandler({}, troopsRes);
  assert.deepStrictEqual(troopsRes.body, {
    troops: { '82': { name: '第 82 短編號旅' }, '0082': { name: '第 82 旅' } }
  });
  assert(!JSON.stringify(troopsRes.body).includes('server-key-a'));
  assert(!JSON.stringify(troopsRes.body).includes('script.google.com'));
  console.log('  [PASS] only complete environment triplets register; public list has ID and name only');

  console.log('\n2. Server injects API key and ignores browser-supplied key');
  const originalFetch = global.fetch;
  let fetchCall;
  global.fetch = async (url, options) => {
    fetchCall = { url: String(url), options };
    return { status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  const normal = await callProxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'member-password', apikey: 'browser-key' });
  assert.strictEqual(normal.statusCode, 200);
  const forwarded = JSON.parse(fetchCall.options.body);
  assert.strictEqual(fetchCall.url, 'https://script.google.com/macros/s/TROOP_A/exec');
  assert.strictEqual(forwarded.apikey, 'server-key-a');
  assert.strictEqual(forwarded.password, 'member-password');
  assert.strictEqual(forwarded.troopId, undefined);
  console.log('  [PASS] browser key is discarded and the registered key is injected server-side');

  console.log('\n3. Four-character key policy rejects only central login locally');
  process.env.SUPER_ADMIN_ID = 'central-test-id';
  delete process.env.SUPER_KEY;
  let upstreamCalls = 0;
  global.fetch = async () => { upstreamCalls += 1; return { status: 200, text: async () => JSON.stringify({ success: true }) }; };
  let local = await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: '0007' });
  assert.strictEqual(local.statusCode, 503);
  assert.strictEqual(upstreamCalls, 0);
  process.env.SUPER_KEY = '';
  local = await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: '0007' });
  assert.strictEqual(local.statusCode, 503);
  assert.strictEqual(upstreamCalls, 0);
  process.env.SUPER_KEY = '123';
  local = await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: '0007' });
  assert.strictEqual(local.statusCode, 503);
  assert.strictEqual(upstreamCalls, 0);
  // An ordinary user is still sent to GAS when the central key is unavailable.
  local = await callProxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'member-password' });
  assert.strictEqual(local.statusCode, 200);
  assert.strictEqual(upstreamCalls, 1);
  console.log('  [PASS] missing, empty, and short settings are rejected without GAS; ordinary login is unaffected');

  console.log('\n4. Correct four-character key uses a short-lived ticket and encrypted troop-bound browser session');
  process.env.SUPER_KEY = '0007';
  process.env.SUPER_TICKET_SECRET = 't'.repeat(40);
  process.env.SUPER_SESSION_SECRET = 's'.repeat(40);
  upstreamCalls = 0;
  global.fetch = async (url, options) => {
    upstreamCalls += 1;
    const body = JSON.parse(options.body);
    assert.strictEqual(body.action, 'superLogin');
    assert.strictEqual(body.login_id, undefined);
    assert.strictEqual(body.password, undefined);
    assert.strictEqual(body.apikey, 'server-key-a');
    return { status: 200, text: async () => JSON.stringify({ success: true, token: 'gas-session-token', user: { role: 'super_admin' } }) };
  };
  local = await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: 'wrong' });
  assert.strictEqual(local.statusCode, 401);
  assert.strictEqual(upstreamCalls, 0);
  local = await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: '0007' });
  assert.strictEqual(local.statusCode, 200);
  assert.strictEqual(upstreamCalls, 1);
  assert(local.body.token.startsWith('sbs1.'));
  const opened = unwrapBrowserSession(local.body.token, {
    troopId: '0082',
    backend: 'https://script.google.com/macros/s/TROOP_A/exec'
  });
  assert.deepStrictEqual(opened, { wrapped: true, valid: true, gasToken: 'gas-session-token' });
  const wrongTroop = unwrapBrowserSession(local.body.token, {
    troopId: '82',
    backend: 'https://script.google.com/macros/s/TROOP_B/exec'
  });
  assert.strictEqual(wrongTroop.valid, false);
  console.log('  [PASS] four-character string with leading zero succeeds only on full match; session is encrypted and troop-bound');

  console.log('\n5. Verification endpoint accepts only the matching opaque ticket audience');
  const superLoginBody = JSON.parse(fetchCall && fetchCall.options && fetchCall.options.body || '{}');
  // Issue a new ticket through proxy so it is available to verifier without exposing it in client responses.
  let capturedTicket = '';
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedTicket = body.ticket;
    return { status: 200, text: async () => JSON.stringify({ success: true, token: 'gas-ticket-check', user: { role: 'super_admin' } }) };
  };
  await callProxy({ troopId: '0082', action: 'login', login_id: 'central-test-id', password: '0007' });
  const verifyRes = {
    statusCode: 0,
    setHeader(){},
    end(raw){ this.body = JSON.parse(raw); }
  };
  verifyTicketHandler({ method: 'POST', body: { ticket: capturedTicket, troopId: '0082', backendHash: require('../lib/super-auth').backendHash('https://script.google.com/macros/s/TROOP_A/exec') } }, verifyRes);
  assert.deepStrictEqual(verifyRes.body, { valid: true });
  const badVerifyRes = { statusCode: 0, setHeader(){}, end(raw){ this.body = JSON.parse(raw); } };
  verifyTicketHandler({ method: 'POST', body: { ticket: capturedTicket, troopId: '82', backendHash: require('../lib/super-auth').backendHash('https://script.google.com/macros/s/TROOP_B/exec') } }, badVerifyRes);
  assert.deepStrictEqual(badVerifyRes.body, { valid: false });
  console.log('  [PASS] ticket verifier checks fixed troop and backend audience');

  console.log('\n6. Logs exclude sensitive values');
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  global.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ success: true }) });
  await callProxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'do-not-log-password', token: 'do-not-log-token', apikey: 'do-not-log-key' });
  console.log = originalLog;
  const output = logged.join('\n');
  assert(!output.includes('do-not-log-password'));
  assert(!output.includes('do-not-log-token'));
  assert(!output.includes('do-not-log-key'));
  console.log('  [PASS] proxy diagnostics do not print password, token, or API key');

  global.fetch = originalFetch;
  console.log('\n=== All proxy regression tests passed ===');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
