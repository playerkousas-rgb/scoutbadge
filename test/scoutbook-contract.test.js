'use strict';

/*
 * SCOUTBOOK v2.0.0 handoff (docs/partner-scoutbook.md in that repo).
 * Covers the four required changes and the decisions that must not drift:
 *   CORS for the book origins, stable troop ids + legacyIds, machine codes,
 *   idempotent requestComplete, and refusal of local-only OT-* / AYP-* ids.
 * Item ids and the load quartet are asserted unchanged.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const proxyHandler = require('../api/proxy');
const troopsHandler = require('../api/troops');
const { localOnlyItem } = require('../lib/book-sync');
const { annotatePartnerCode } = require('../lib/error-codes');
const loginRateLimit = require('../lib/login-rate-limit');
const { makeGas } = require('./gasvm');

const BOOK_ORIGINS = [
  'https://scoutbook-five.vercel.app',
  'https://scoutbook.vercel.app'
];

function configure() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TROOP_') || key.startsWith('SUPER_') || key === 'SCOUTBOOK_ORIGINS') delete process.env[key];
  }
  process.env.TROOP_0082_NAME = '第 82 旅';
  process.env.TROOP_0082_BACKEND = 'https://script.google.com/macros/s/TROOP_A/exec';
  process.env.TROOP_0082_APIKEY = 'server-key-a';
  process.env.TROOP_0082_LEGACYIDS = 'OLD82, 0082, not-valid, 82';
  process.env.TROOP_82_NAME = '第 82 短編號旅';
  process.env.TROOP_82_BACKEND = 'https://script.google.com/macros/s/TROOP_B/exec';
  process.env.TROOP_82_APIKEY = 'server-key-b';
  process.env.SUPER_KEY = '0007';
  loginRateLimit.resetForTests();
}

function response() {
  const out = { statusCode: 0, body: null, headers: {}, ended: false };
  out.setHeader = (name, value) => { out.headers[name.toLowerCase()] = value; };
  out.status = (statusCode) => { out.statusCode = statusCode; return out; };
  out.json = (body) => { out.body = body; out.ended = true; return out; };
  out.end = (chunk) => { out.ended = true; if (chunk) out.raw = String(chunk); return out; };
  return out;
}

async function callProxy(body, reqExtras = {}) {
  const res = response();
  await proxyHandler({ method: 'POST', body, headers: {}, ...reqExtras }, res);
  return res;
}

function callTroops(req) {
  const res = response();
  troopsHandler(req || { method: 'GET', headers: {} }, res);
  return res;
}

async function run() {
  console.log('=== SCOUTBOOK contract ===\n');
  configure();
  const originalFetch = global.fetch;

  console.log('1. CORS: book origins, OPTIONS 204, no wildcard');
  for (const origin of BOOK_ORIGINS) {
    const pre = callTroops({ method: 'OPTIONS', headers: { origin } });
    assert.strictEqual(pre.statusCode, 204, origin);
    assert.strictEqual(pre.ended, true);
    assert.strictEqual(pre.headers['access-control-allow-origin'], origin);
    assert.strictEqual(pre.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.strictEqual(pre.headers['access-control-allow-headers'], 'Content-Type');
    assert.strictEqual(pre.headers['access-control-allow-credentials'], undefined);
    assert.notStrictEqual(pre.headers['access-control-allow-origin'], '*');

    const get = callTroops({ method: 'GET', headers: { origin } });
    assert.strictEqual(get.statusCode, 200);
    assert.strictEqual(get.headers['access-control-allow-origin'], origin);
    assert.strictEqual(get.headers.vary, 'Origin');

    const proxyPre = response();
    await proxyHandler({ method: 'OPTIONS', headers: { origin } }, proxyPre);
    assert.strictEqual(proxyPre.statusCode, 204, 'proxy OPTIONS ' + origin);
    assert.strictEqual(proxyPre.headers['access-control-allow-origin'], origin);
  }
  const evil = callTroops({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.strictEqual(evil.statusCode, 204);
  assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);
  const local = callTroops({ method: 'GET', headers: { origin: 'http://localhost:5173' } });
  assert.strictEqual(local.headers['access-control-allow-origin'], 'http://localhost:5173');
  process.env.SCOUTBOOK_ORIGINS = 'https://book.example.org/, http://not-https.example';
  const extra = callTroops({ method: 'GET', headers: { origin: 'https://book.example.org' } });
  assert.strictEqual(extra.headers['access-control-allow-origin'], 'https://book.example.org');
  const rejectedHttp = callTroops({ method: 'GET', headers: { origin: 'http://not-https.example' } });
  assert.strictEqual(rejectedHttp.headers['access-control-allow-origin'], undefined);
  delete process.env.SCOUTBOOK_ORIGINS;
  console.log('  [PASS] scoutbook + scoutbook-five allowed; OPTIONS 204; no *');

  console.log('\n2. Troop ids stay stable; legacyIds only when configured');
  const catalogue = callTroops({ method: 'GET', headers: {} });
  assert.strictEqual(catalogue.body.success, true);
  assert.strictEqual(Array.isArray(catalogue.body.troops), false, 'BOOK object parser must not receive an array');
  assert.deepStrictEqual(Object.keys(catalogue.body.troops).sort(), ['0082', '82']);
  assert.strictEqual(catalogue.body.troops['0082'].id, '0082');
  assert.deepStrictEqual(catalogue.body.troops['0082'].legacyIds, ['OLD82']);
  assert.deepStrictEqual(catalogue.body.troops['82'].legacyIds, []);
  assert.deepStrictEqual(catalogue.body.legacyIds, { OLD82: '0082' });
  assert(!JSON.stringify(catalogue.body).includes('server-key'));
  assert(!JSON.stringify(catalogue.body).includes('script.google.com'));
  assert.strictEqual(catalogue.body.troops['0082'].backend, undefined);
  console.log('  [PASS] 0082 and 82 are not aliased; live id 82 is not swallowed as a legacy id');

  console.log('\n3. Machine codes, without relabelling a wrong password');
  const missingAction = await callProxy({ troopId: '0082' });
  assert.strictEqual(missingAction.statusCode, 400);
  assert.strictEqual(missingAction.body.code, 'VALIDATION');

  const missingTroop = await callProxy({ troopId: '9999', action: 'load' });
  assert.strictEqual(missingTroop.statusCode, 404);
  assert.strictEqual(missingTroop.body.code, 'NOT_FOUND');

  const expired = await callProxy({ troopId: '0082', action: 'load', token: 'sbs1.not-a-real-session' });
  assert.strictEqual(expired.statusCode, 401);
  assert.strictEqual(expired.body.code, 'AUTH_EXPIRED');
  assert.strictEqual(expired.body.errorCode, 'AUTH_EXPIRED');

  for (let i = 0; i < 5; i++) {
    const wrong = await callProxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: 'wrong' });
    assert.strictEqual(wrong.statusCode, 401, JSON.stringify(wrong.body));
    assert.notStrictEqual(wrong.body.code, 'AUTH_EXPIRED');
  }
  const limited = await callProxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: 'wrong' });
  assert.strictEqual(limited.statusCode, 429);
  assert.strictEqual(limited.body.code, 'RATE_LIMITED');
  loginRateLimit.resetForTests();

  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: false, error: 'Token 無效或過期', code: 401 })
  });
  const forwarded = await callProxy({ troopId: '0082', action: 'load' });
  assert.strictEqual(forwarded.statusCode, 200);
  assert.strictEqual(forwarded.body.code, 'AUTH_EXPIRED');
  assert.strictEqual(forwarded.body.legacyCode, 401);
  assert.strictEqual(forwarded.body.error, 'Token 無效或過期');

  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: false, error: '登入失敗', code: 401 })
  });
  const badPassword = await callProxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'nope' });
  assert.strictEqual(badPassword.body.code, 401);
  assert.notStrictEqual(badPassword.body.errorCode, 'AUTH_EXPIRED');

  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: false, error: '未授權：缺少 API Key 或有效簽名', code: 403 })
  });
  const denied = await callProxy({ troopId: '0082', action: 'load' });
  assert.strictEqual(denied.body.code, 403, 'numeric leaf 403 must stay numeric');

  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: false, error: '登入失敗次數過多，請於 15 分鐘後再試', code: 401 })
  });
  const locked = await callProxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'nope' });
  assert.strictEqual(locked.body.code, 'RATE_LIMITED');
  assert.strictEqual(locked.body.legacyCode, 401);

  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, duplicate: true, request_id: 'REQ_1', status: 'pending' })
  });
  const dupPass = await callProxy({
    troopId: '0082',
    action: 'requestComplete',
    token: '',
    itemId: 'L1-M1',
    requested_date: '2026-11-06'
  });
  assert.strictEqual(dupPass.statusCode, 200);
  assert.deepStrictEqual(dupPass.body, { success: true, duplicate: true, request_id: 'REQ_1', status: 'pending' });

  global.fetch = async () => { throw new Error('local-only must not reach GAS'); };
  const blocked = await callProxy({ troopId: '0082', action: 'requestComplete', itemId: 'OT-LD-3', requested_date: '2026-11-06' });
  assert.strictEqual(blocked.statusCode, 400);
  assert.strictEqual(blocked.body.code, 'VALIDATION');
  assert.strictEqual(blocked.body.localOnly, true);
  assert.strictEqual(blocked.body.officialId, 'SC-OTH-002');
  assert.strictEqual(localOnlyItem('L1-M1'), null);
  assert.strictEqual(localOnlyItem('SC-OTH-001'), null);
  assert.strictEqual(annotatePartnerCode({ success: true, progress: {} }).progress !== undefined, true);
  console.log('  [PASS] AUTH_EXPIRED / NOT_FOUND / RATE_LIMITED / VALIDATION; wrong password is not a re-login');

  console.log('\n4. requestComplete is idempotent and does not confirm progress');
  const gas = makeGas({ apiKey: 'KEYBOOK' });
  gas.sandbox.initializeSheets();
  const token = gas.sandbox.createToken('1234567890');
  const progressBefore = gas.sheets.get('進度追蹤')._rows.length;
  function post(extra) {
    const out = gas.sandbox.doPost({
      postData: {
        contents: JSON.stringify(Object.assign({
          action: 'requestComplete',
          apikey: 'KEYBOOK',
          token,
          ymis: '1234567890',
          itemId: 'L1-M1',
          itemName: '加入安排',
          requested_date: '2026-11-06',
          evidence: '由 SCOUTBOOK 個人電子紀錄冊申報（待領袖核實）'
        }, extra || {}))
      }
    });
    return JSON.parse(out.getContent());
  }
  const first = post();
  assert.strictEqual(first.success, true, JSON.stringify(first));
  assert.notStrictEqual(first.duplicate, true);
  assert.strictEqual(first.status, 'pending');
  const second = post();
  assert.strictEqual(second.success, true, JSON.stringify(second));
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.request_id, first.request_id);
  const pendingRows = () => gas.sheets.get('待批完成')._rows.filter((row, index) => index > 0 && String(row[7]) === 'pending');
  assert.strictEqual(pendingRows().length, 1);
  assert.strictEqual(gas.sheets.get('進度追蹤')._rows.length, progressBefore, 'requestComplete must not write verified progress');

  const otherDate = post({ requested_date: '2026-11-07' });
  assert.strictEqual(otherDate.success, true);
  assert.notStrictEqual(otherDate.duplicate, true);
  assert.strictEqual(pendingRows().length, 2);

  const otherItem = post({ itemId: 'L2-P1', requested_date: '2026-11-06' });
  assert.strictEqual(otherItem.success, true);
  assert.notStrictEqual(otherItem.duplicate, true);

  const sheet = gas.sheets.get('待批完成');
  const rejectedRow = sheet._rows.find((row) => String(row[0]) === first.request_id);
  rejectedRow[7] = 'rejected';
  const afterReject = post();
  assert.strictEqual(afterReject.success, true);
  assert.notStrictEqual(afterReject.duplicate, true, 'a rejected key may be submitted again');

  const localGas = post({ itemId: 'AYP-BRONZE' });
  assert.strictEqual(localGas.success, false);
  assert.strictEqual(localGas.code, 'VALIDATION');
  assert.strictEqual(localGas.officialId, 'SC-OTH-009');
  const missingItem = post({ itemId: '   ' });
  assert.strictEqual(missingItem.code, 'VALIDATION');

  const load = JSON.parse(gas.sandbox.doGet({
    parameter: { action: 'load', apikey: 'KEYBOOK', token }
  }).getContent());
  for (const field of ['progress', 'flatProgress', 'otherBadges', 'pendingRequests']) {
    assert.ok(Object.prototype.hasOwnProperty.call(load, field), 'load must still return ' + field);
  }
  assert.ok(load.pendingRequests.some((row) => row.item_id === 'L1-M1' && row.status === 'pending'));
  console.log('  [PASS] same (ymis, itemId, requested_date) pending row is not duplicated');

  console.log('\n5. Catalogue ids and deployment copy are unchanged where the partner said not to follow');
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'items.json'), 'utf8'));
  const ids = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') ids.push(node.id);
    for (const value of Object.values(node)) walk(value);
  };
  walk(items);
  for (const id of ['L1-M1', 'L5-D5', 'SC-OTH-001', 'SC-OTH-002', 'SC-OTH-004', 'SC-OTH-005', 'SC-OTH-008', 'SC-OTH-009']) {
    assert.ok(ids.includes(id), 'must not rename ' + id);
  }
  assert.ok(!ids.includes('OT-LD') && !ids.includes('AYP-BRONZE'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('要用純文字開啟'));
  assert.ok(html.includes('全選蓋掉原本 SCRIPT'));
  assert.ok(html.includes('open the download as plain text'));
  assert.ok(html.includes('do not append it below the old script'));
  assert.ok(html.includes('不要把紙本頁碼改寫成 p001'));
  assert.ok(!html.includes("'/p/p01'") && !html.includes('"/p/p50"'));
  console.log('  [PASS] L1–L5 / SC-OTH ids kept; GS paste warning is in the deploy steps');

  global.fetch = originalFetch;
  console.log('\n=== SCOUTBOOK contract passed ===');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
