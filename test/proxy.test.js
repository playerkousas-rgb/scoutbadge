const http = require('http');
const assert = require('assert');
const proxyHandler = require('../api/proxy');
const troopsHandler = require('../api/troops');
const { getRegistry, getTroopConfig } = require('../api/_registry');

async function runTests() {
  console.log('=== Starting Test Suite for GAS Proxy Architecture ===\n');

  // Test 1: Registry Lookup
  console.log('Test 1: Registry Lookup');
  const reg = getRegistry();
  assert(reg['0082'] || reg['82'], 'Troop 0082 should exist in registry');
  const config0082 = getTroopConfig('0082');
  assert.strictEqual(config0082.name, '第 82 旅');
  assert(config0082.backend.startsWith('https://script.google.com/'), 'Troop 0082 backend should point to script.google.com');
  assert.strictEqual(getTroopConfig('INVALID_TROOP_9999'), null, 'Invalid troop should return null');
  console.log('  [PASS] Registry lookup verified');

  // Test 2: Method Validation (405)
  console.log('\nTest 2: Disallowed HTTP Method');
  let status = 0, jsonRes = null;
  const mockResMethod = {
    setHeader: () => {},
    status: (c) => { status = c; return mockResMethod; },
    json: (obj) => { jsonRes = obj; return mockResMethod; }
  };
  await proxyHandler({ method: 'PUT' }, mockResMethod);
  assert.strictEqual(status, 405);
  assert.strictEqual(jsonRes.success, false);
  console.log('  [PASS] Method PUT correctly rejected with 405');

  // Test 3: Unregistered Troop Rejection (404)
  console.log('\nTest 3: Unregistered Troop Rejection');
  const mockRes404 = {
    setHeader: () => {},
    status: (c) => { status = c; return mockRes404; },
    json: (obj) => { jsonRes = obj; return mockRes404; }
  };
  await proxyHandler({ method: 'POST', body: { troopId: 'UNKNOWN_999', action: 'login' } }, mockRes404);
  assert.strictEqual(status, 404);
  assert.strictEqual(jsonRes.success, false);
  console.log('  [PASS] Unregistered troop rejected with 404');

  // Test 4: Missing Action Rejection (400)
  console.log('\nTest 4: Missing Action Rejection');
  const mockRes400 = {
    setHeader: () => {},
    status: (c) => { status = c; return mockRes400; },
    json: (obj) => { jsonRes = obj; return mockRes400; }
  };
  await proxyHandler({ method: 'POST', body: { troopId: '0082' } }, mockRes400);
  assert.strictEqual(status, 400);
  assert.strictEqual(jsonRes.success, false);
  console.log('  [PASS] Request missing action rejected with 400');

  // Test 5: SSRF / Open Proxy Prevention
  console.log('\nTest 5: SSRF / Open Proxy Prevention');
  const mockResSSRF = {
    setHeader: () => {},
    status: (c) => { status = c; return mockResSSRF; },
    json: (obj) => { jsonRes = obj; return mockResSSRF; }
  };
  await proxyHandler({
    method: 'POST',
    body: {
      troopId: 'EVIL_TROOP',
      backend: 'http://169.254.169.254/latest/meta-data/',
      action: 'login'
    }
  }, mockResSSRF);
  assert.strictEqual(status, 404, 'Arbitrary troopId with evil backend must be rejected with 404');
  console.log('  [PASS] Arbitrary client backend URL ignored and evil troopId rejected');

  // Test 6: API Troops Endpoint (/api/troops)
  console.log('\nTest 6: /api/troops Response');
  let troopsResObj = null;
  const mockResTroops = {
    setHeader: () => {},
    status: (c) => { status = c; return mockResTroops; },
    json: (obj) => { troopsResObj = obj; return mockResTroops; }
  };
  troopsHandler({}, mockResTroops);
  assert.strictEqual(status, 200);
  assert(troopsResObj.troops['0082'], 'Troop 0082 should be present in /api/troops');
  console.log('  [PASS] /api/troops lists all registered troops');

  // Test 7: POST load is translated to Apps Script doGet
  console.log('\nTest 7: POST load forwarding');
  let loadFetchUrl = null;
  const origLoadFetch = global.fetch;
  global.fetch = async (url, options) => {
    loadFetchUrl = { url: String(url), options };
    return { status: 200, text: async () => JSON.stringify({ success: true, members: [] }) };
  };
  const mockResLoad = {
    setHeader: () => {},
    status: (c) => mockResLoad,
    json: () => mockResLoad
  };
  await proxyHandler({
    method: 'POST',
    body: { troopId: '0082', action: 'load', token: 'LOAD_TOKEN', apikey: 'LOAD_KEY' }
  }, mockResLoad);
  global.fetch = origLoadFetch;
  assert(loadFetchUrl, 'load should call the upstream backend');
  assert.strictEqual(loadFetchUrl.options.method, 'GET');
  assert(loadFetchUrl.url.includes('action=load'));
  assert(loadFetchUrl.url.includes('token=LOAD_TOKEN'));
  assert(loadFetchUrl.url.includes('apikey=LOAD_KEY'));
  console.log('  [PASS] POST load is forwarded as GET to Apps Script doGet');

  // Test 8: Sensitive Data Logging Check
  console.log('\nTest 8: Sensitive Data Logging Check');
  let loggedMessages = [];
  const origLog = console.log;
  console.log = (...args) => {
    loggedMessages.push(args.join(' '));
    origLog(...args);
  };

  const origFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: true })
  });

  const mockResLog = {
    setHeader: () => {},
    status: (c) => mockResLog,
    json: () => mockResLog
  };

  await proxyHandler({
    method: 'POST',
    body: {
      troopId: '0082',
      action: 'login',
      password: 'SUPER_SECRET_PASSWORD_123',
      token: 'SENSITIVE_USER_TOKEN_ABC'
    }
  }, mockResLog);

  global.fetch = origFetch;
  console.log = origLog;

  const logOutput = loggedMessages.join('\n');
  assert(!logOutput.includes('SUPER_SECRET_PASSWORD_123'), 'Passwords MUST NOT appear in server logs');
  assert(!logOutput.includes('SENSITIVE_USER_TOKEN_ABC'), 'Tokens MUST NOT appear in server logs');
  console.log('  [PASS] No passwords or tokens printed in proxy server logs');

  console.log('\n=== All Tests Passed Successfully! ===');
}

runTests().catch(err => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
