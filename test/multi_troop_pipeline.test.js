const assert = require('assert');
const proxyHandler = require('../api/proxy');
const { getRegistry } = require('../api/_registry');

async function testPipeline() {
  console.log('=== Starting Multi-Troop Isolation and Upstream Error Test ===\n');

  // Save original fetch
  const originalFetch = global.fetch;

  let capturedCalls = [];

  // Mock global.fetch to intercept calls from proxyHandler
  global.fetch = async (url, options) => {
    capturedCalls.push({ url, options });

    if (url.includes('TROOP_A_GAS')) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          troop: 'A',
          data: { members: [{ ymis: '1000000001', name: 'Troop A Scout' }] }
        })
      };
    }

    if (url.includes('TROOP_B_GAS')) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          troop: 'B',
          data: { members: [{ ymis: '2000000002', name: 'Troop B Scout' }] }
        })
      };
    }

    if (url.includes('HTML_ERROR_GAS')) {
      return {
        status: 500,
        text: async () => '<html><body><h1>500 Internal Server Error</h1></body></html>'
      };
    }

    if (url.includes('TIMEOUT_GAS')) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    return {
      status: 200,
      text: async () => JSON.stringify({ success: true })
    };
  };

  // Configure environment variables for Troop A (0082) and Troop B (0083)
  process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TROOP_A_GAS/exec';
  process.env.TROOP_0083_BACKEND = 'https://script.google.com/macros/s/TROOP_B_GAS/exec';
  process.env.TROOP_0084_BACKEND = 'https://script.google.com/macros/s/HTML_ERROR_GAS/exec';
  process.env.TROOP_0085_BACKEND = 'https://script.google.com/macros/s/TIMEOUT_GAS/exec';

  // 1. Test Troop A request
  console.log('Test 1: Troop A Request Routing');
  let statusA = 0, jsonA = null;
  const resA = {
    setHeader: () => {},
    status: (code) => { statusA = code; return resA; },
    json: (obj) => { jsonA = obj; return resA; }
  };

  await proxyHandler({
    method: 'POST',
    body: { troopId: '0082', action: 'load', token: 'token_troop_a' }
  }, resA);

  assert.strictEqual(statusA, 200);
  assert.strictEqual(jsonA.troop, 'A');
  assert.strictEqual(jsonA.data.members[0].name, 'Troop A Scout');
  assert(capturedCalls[capturedCalls.length - 1].url.includes('TROOP_A_GAS'), 'Request for Troop A must hit Troop A GAS URL');
  console.log('  [PASS] Troop A request correctly routed to Troop A GAS');

  // 2. Test Troop B request
  console.log('\nTest 2: Troop B Request Routing');
  let statusB = 0, jsonB = null;
  const resB = {
    setHeader: () => {},
    status: (code) => { statusB = code; return resB; },
    json: (obj) => { jsonB = obj; return resB; }
  };

  await proxyHandler({
    method: 'POST',
    body: { troopId: '0083', action: 'load', token: 'token_troop_b' }
  }, resB);

  assert.strictEqual(statusB, 200);
  assert.strictEqual(jsonB.troop, 'B');
  assert.strictEqual(jsonB.data.members[0].name, 'Troop B Scout');
  assert(capturedCalls[capturedCalls.length - 1].url.includes('TROOP_B_GAS'), 'Request for Troop B must hit Troop B GAS URL');
  console.log('  [PASS] Troop B request correctly routed to Troop B GAS');

  // 3. Test Non-JSON Upstream Error (HTML error page from GAS)
  console.log('\nTest 3: Non-JSON Upstream Response (502)');
  let statusErr = 0, jsonErr = null;
  const resErr = {
    setHeader: () => {},
    status: (code) => { statusErr = code; return resErr; },
    json: (obj) => { jsonErr = obj; return resErr; }
  };

  await proxyHandler({
    method: 'POST',
    body: { troopId: '0084', action: 'login' }
  }, resErr);

  assert.strictEqual(statusErr, 502);
  assert.strictEqual(jsonErr.success, false);
  assert(jsonErr.error.includes('GAS Upstream Error'), 'Upstream HTML response should be converted to clean 502 JSON error');
  console.log('  [PASS] Non-JSON HTML response handled gracefully with HTTP 502');

  // 4. Test Upstream Timeout (504)
  console.log('\nTest 4: Upstream Timeout Handling (504)');
  let statusTime = 0, jsonTime = null;
  const resTime = {
    setHeader: () => {},
    status: (code) => { statusTime = code; return resTime; },
    json: (obj) => { jsonTime = obj; return resTime; }
  };

  await proxyHandler({
    method: 'POST',
    body: { troopId: '0085', action: 'save' }
  }, resTime);

  assert.strictEqual(statusTime, 504);
  assert.strictEqual(jsonTime.success, false);
  assert(jsonTime.error.includes('Timeout'), 'Timeout should be converted to clean 504 JSON error');
  console.log('  [PASS] Upstream timeout handled gracefully with HTTP 504');

  // Restore original fetch
  global.fetch = originalFetch;

  console.log('\n=== Multi-Troop Isolation and Upstream Error Tests Passed! ===');
}

testPipeline().catch(err => {
  console.error('Test Pipeline Failed:', err);
  process.exit(1);
});
