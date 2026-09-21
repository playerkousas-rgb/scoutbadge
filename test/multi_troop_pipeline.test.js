'use strict';

const assert = require('assert');
const proxyHandler = require('../api/proxy');
const { createBrowserSession } = require('../lib/super-auth');

function env(id, suffix, key) {
  process.env[`TROOP_${id}_NAME`] = `Troop ${id}`;
  process.env[`TROOP_${id}_BACKEND`] = `https://script.google.com/macros/s/${suffix}/exec`;
  process.env[`TROOP_${id}_APIKEY`] = key;
}

function response() {
  const res = { statusCode: 0, body: null };
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function invoke(body) {
  const res = response();
  await proxyHandler({ method: 'POST', body, headers: {} }, res);
  return res;
}

async function run() {
  console.log('=== Multi-troop isolation and upstream failure tests ===\n');
  for (const key of Object.keys(process.env)) if (key.startsWith('TROOP_') || key.startsWith('SUPER_')) delete process.env[key];
  env('0082', 'TROOP_A_GAS', 'key-a');
  env('82', 'TROOP_B_GAS', 'key-b');
  env('0084', 'HTML_ERROR_GAS', 'key-html');
  env('0085', 'TIMEOUT_GAS', 'key-timeout');
  process.env.SUPER_SESSION_SECRET = 's'.repeat(40);

  const originalFetch = global.fetch;
  const captured = [];
  global.fetch = async (url, options) => {
    captured.push({ url: String(url), options });
    if (String(url).includes('TROOP_A_GAS')) return { status: 200, text: async () => JSON.stringify({ success: true, troop: 'A' }) };
    if (String(url).includes('TROOP_B_GAS')) return { status: 200, text: async () => JSON.stringify({ success: true, troop: 'B' }) };
    if (String(url).includes('HTML_ERROR_GAS')) return { status: 500, text: async () => '<html>upstream failure</html>' };
    if (String(url).includes('TIMEOUT_GAS')) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    throw new Error('unexpected backend');
  };

  const a = await invoke({ troopId: '0082', action: 'load', token: 'token-a' });
  assert.strictEqual(a.statusCode, 200);
  assert.strictEqual(a.body.troop, 'A');
  assert(captured.at(-1).url.includes('TROOP_A_GAS'));
  assert(captured.at(-1).url.includes('apikey=key-a'));
  console.log('  [PASS] 0082 routes only to its configured backend');

  const b = await invoke({ troopId: '82', action: 'load', token: 'token-b' });
  assert.strictEqual(b.statusCode, 200);
  assert.strictEqual(b.body.troop, 'B');
  assert(captured.at(-1).url.includes('TROOP_B_GAS'));
  assert(captured.at(-1).url.includes('apikey=key-b'));
  console.log('  [PASS] 82 remains a separate route and does not alias 0082');

  const crossTroopSession = createBrowserSession({
    gasToken: 'gas-token-for-0082',
    troopId: '0082',
    backend: 'https://script.google.com/macros/s/TROOP_A_GAS/exec'
  });
  const callsBefore = captured.length;
  const cross = await invoke({ troopId: '82', action: 'load', token: crossTroopSession });
  assert.strictEqual(cross.statusCode, 401);
  assert.strictEqual(captured.length, callsBefore, 'invalid wrapped session must not reach GAS');
  console.log('  [PASS] central browser sessions cannot cross troop/backend boundaries');

  const html = await invoke({ troopId: '0084', action: 'login', login_id: 'user', password: 'pass' });
  assert.strictEqual(html.statusCode, 502);
  assert.strictEqual(html.body.success, false);
  assert(!html.body.error.includes('upstream failure'));
  console.log('  [PASS] upstream HTML is converted to a generic response without internals');

  const timeout = await invoke({ troopId: '0085', action: 'save' });
  assert.strictEqual(timeout.statusCode, 504);
  assert.strictEqual(timeout.body.success, false);
  console.log('  [PASS] upstream timeout is handled cleanly');

  global.fetch = originalFetch;
  console.log('\n=== Multi-troop tests passed ===');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
