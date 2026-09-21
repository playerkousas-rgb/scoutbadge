'use strict';

/*
 * v4.1.0 整合合約 e2e —— 打「真 Code.gs」：
 *   dev server → /api/proxy → http /exec（vm 內執行 apps-script/Code.gs 原碼）
 * 以及直接打 /exec 驗 requireAuth（無 key 無 sig → 拒）。
 *
 * 覆蓋（對照 readme 倉 v4.1.0 FINAL 文件）：
 *   01_AUTH_FINAL  requireAuth 全體 / 信任鏈 sig（成員・領袖・家長）/ 家長超然=子女聯集
 *   02_REGISTRY    getRegistrySafe（無密碼）/ normId childId 綁定
 *   06_PARENT      家長只讀自己子女；寫入／審批 403
 *   三點進入並存     本團密碼 + 上層 sig + 家長 sig 同時可用（上層「食」咗唔會鎖死本端）
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const { makeGas } = require('./gasvm');

const GAS_PORT = 39411;
const DEV_PORT = 39413;
const KEY = 'KEY_A';
const EXEC_URL = `http://127.0.0.1:${GAS_PORT}/exec`;
const BASE = `http://127.0.0.1:${DEV_PORT}`;

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}
// scope 必須以「原始字串」入簽（同 GAS 端 verifyPortalSig）
function sign({ childId = 'PROG_0082S', sub, role, children_ids, targetYmis, exp, key = KEY }) {
  const scopeObj = { role };
  if (children_ids) scopeObj.children_ids = children_ids;
  if (targetYmis) scopeObj.targetYmis = targetYmis;
  const scope = JSON.stringify(scopeObj);
  const sig = hmacHex(key, `${childId}|${sub}|${scope}|${exp}`);
  return { childId, sub, scope, exp, sig };
}

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

function seed(gas) {
  const users = gas.sheets.get('Users');
  const roster = gas.sheets.get('成員名單');
  const hash = gas.sandbox.hashPassword;
  const row = (ymis, name, email, role, pass, canTick) => [
    ymis, name, email, role, hash(pass), '', canTick, 'test', '2026-01-01', '2026-01-01', '', 'active', '', 'A隊', 'member', false
  ];
  users.appendRow(row('1234567890', '陳大文', 'leader@example.org', 'group_leader', 'PassA!234567', true));
  users.appendRow(row('1234560001', '成員甲', '', 'member', 'MemberA!234', false));
  users.appendRow(row('1234560002', '成員乙', '', 'member', 'MemberB!234', false));
  users.appendRow(row('1234560003', '路人丙', '', 'member', 'MemberC!234', false));
  ['1234560001', '1234560002', '1234560003'].forEach((y) => {
    roster.appendRow([y, { '1234560001': '成員甲', '1234560002': '成員乙', '1234560003': '路人丙' }[y], '2026-01-01', '', '', 'A隊']);
  });
  gas.sheets.get('進度追蹤').appendRow(['1234560001', 'ITEM_X', '2026-01-05', '2026-01-05', '陳大文', '']);
  gas.sheets.get('進度追蹤').appendRow(['1234560002', 'ITEM_X', '2026-01-06', '2026-01-06', '陳大文', '']);
  gas.sheets.get('進度追蹤').appendRow(['1234560003', 'ITEM_X', '2026-01-07', '2026-01-07', '陳大文', '']);
  gas.sheets.get('其他獎章').appendRow(['1234560001', 'OB_1', '游泳章', '2026-01-02', 'C001', '', '2026-01-02']);
  gas.sheets.get('其他獎章').appendRow(['1234560002', 'OB_1', '游泳章', '2026-01-03', 'C002', '', '2026-01-03']);
  gas.sheets.get('其他獎章').appendRow(['1234560003', 'OB_1', '游泳章', '2026-01-04', 'C003', '', '2026-01-04']);
}

async function run() {
  const gas = makeGas({ apiKey: KEY, execUrl: EXEC_URL });
  gas.sandbox.initializeSheets();
  seed(gas);
  const gasServer = await gasHttpServer(gas);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      SCOUTBADGE_PROXY_TEST: '1',
      PORT: String(DEV_PORT),
      TROOP_0082_NAME: '第 82 旅（realgas）',
      TROOP_0082_BACKEND: EXEC_URL,
      TROOP_0082_APIKEY: KEY,
      SUPER_KEY: 'test-super-key-42'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let passed = 0;
  const ok = (label) => { console.log(`  [PASS] ${label}`); passed += 1; };

  try {
    // wait for dev server
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await fetch(`${BASE}/api/troops`); break; }
      catch (_) {
        if (Date.now() > deadline) throw new Error('dev server did not start');
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // ---- requireAuth（修 #5）：/exec 直接打，無 key 無 sig → 無效 ----
    const bareGet = await fetch(`${EXEC_URL}?action=load`).then((r) => r.json());
    assert.strictEqual(bareGet.success, false);
    assert.strictEqual(bareGet.code, 403);
    const barePost = await fetch(EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'getMembers' })
    }).then((r) => r.json());
    assert.strictEqual(barePost.success, false);
    assert.strictEqual(barePost.code, 403);
    ok('requireAuth：/exec 直接打（無 apikey 無 sig）→ 403');

    // ---- standalone 基線（回歸）----
    const login = await proxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'MemberA!234' });
    assert.strictEqual(login.data.success, true);
    const memberToken = login.data.token;
    const load = await proxy({ troopId: '0082', action: 'load', token: memberToken });
    assert.strictEqual(load.data.success, true);
    assert.strictEqual(load.data.view_as, 'member');
    ok('standalone 基線：密碼登入 + load 照常');

    // ---- getRegistrySafe（02：無密碼）----
    const reg = await proxy({ troopId: '0082', action: 'getRegistrySafe' });
    assert.strictEqual(reg.data.success, true);
    assert(Array.isArray(reg.data.members));
    assert(reg.data.members.some((m) => m.ymis === '1234560001'));
    for (const m of reg.data.members) {
      assert.strictEqual(m.password_hash, undefined);
      assert.strictEqual(m.token, undefined);
    }
    ok('getRegistrySafe：server-side 名冊無密碼／無 token');

    // ---- 信任鏈 sig：成員 ----
    const nowS = Math.floor(Date.now() / 1000);
    const memberSig = sign({ sub: '1234560001', role: 'member', exp: nowS + 600 });
    const pLogin = await proxy({ troopId: '0082', action: 'portalLogin', ...memberSig });
    assert.strictEqual(pLogin.data.success, true, JSON.stringify(pLogin.data));
    assert.strictEqual(pLogin.data.auth_mode, 'token');
    assert.strictEqual(pLogin.data.user.ymis, '1234560001');
    const sigLoad = await proxy({ troopId: '0082', action: 'load', token: pLogin.data.token });
    assert.strictEqual(sigLoad.data.success, true);
    ok('sig（成員 YMIS）→ portalLogin 發本地 token → load');

    // ---- 信任鏈 sig：領袖（EMAIL）----
    const leaderSig = sign({ sub: 'leader@example.org', role: 'group_leader', exp: nowS + 600 });
    const lLogin = await proxy({ troopId: '0082', action: 'portalLogin', ...leaderSig });
    assert.strictEqual(lLogin.data.success, true, JSON.stringify(lLogin.data));
    const lUsers = await proxy({ troopId: '0082', action: 'getAllUsers', token: lLogin.data.token });
    assert.strictEqual(lUsers.data.success, true);
    ok('sig（領袖 EMAIL）→ 領袖權限操作');

    // ---- 家長超然（06）：children_ids → 本團聯集 ----
    const parentSig = sign({
      sub: 'parent@example.org', role: 'parent',
      children_ids: ['SCOUT_童_1234560001', 'SCOUT_童_1234560002', 'TROOP_0082_9999999999'],
      exp: nowS + 600
    });
    const parLogin = await proxy({ troopId: '0082', action: 'portalLogin', ...parentSig });
    assert.strictEqual(parLogin.data.success, true, JSON.stringify(parLogin.data));
    assert.strictEqual(parLogin.data.auth_mode, 'sig');
    assert.deepStrictEqual(parLogin.data.visible_children.sort(), ['1234560001', '1234560002']);
    ok('sig（家長）→ visible_children = 子女 ∩ 本團（跨團 999… 被剔）');

    const parLoad = await proxy({ troopId: '0082', action: 'load', ...parentSig });
    assert.strictEqual(parLoad.data.success, true, JSON.stringify(parLoad.data).slice(0, 200));
    assert.strictEqual(parLoad.data.view_as, 'parent');
    const parYmises = parLoad.data.members.map((m) => m.ymis).sort();
    assert.deepStrictEqual(parYmises, ['1234560001', '1234560002']);
    assert.deepStrictEqual(Object.keys(parLoad.data.progress).sort(), ['1234560001', '1234560002']);
    assert.deepStrictEqual(Object.keys(parLoad.data.otherBadges).sort(), ['1234560001', '1234560002']);
    ok('家長 load：名冊／進度／其他獎章收縮到子女聯集');

    const obOk = await proxy({ troopId: '0082', action: 'getOtherBadges', target_ymis: '1234560001', ...parentSig });
    assert.strictEqual(obOk.data.success, true);
    const obNo = await proxy({ troopId: '0082', action: 'getOtherBadges', target_ymis: '1234560003', ...parentSig });
    assert.strictEqual(obNo.data.success, false);
    assert.strictEqual(obNo.data.code, 403);
    ok('家長定向讀：子女 OK，非子女 → 403');

    const parTick = await proxy({ troopId: '0082', action: 'reviewRequest', request_id: 'R1', decision: 'approved', ...parentSig });
    assert.strictEqual(parTick.data.success, false);
    assert.strictEqual(parTick.data.code, 403);
    ok('家長審批／寫入 → 403（只讀）');

    // ---- sig 安全：篡改／過期／錯 key ----
    const badTamper = { ...parentSig, sig: (parentSig.sig.slice(0, 8) + 'deadbeef') };
    const rTamper = await proxy({ troopId: '0082', action: 'portalLogin', ...badTamper });
    assert(rTamper.data.success === false && rTamper.data.code === 403);
    const rExp = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ sub: '1234560001', role: 'member', exp: nowS - 7200 }) });
    assert(rExp.data.success === false && rExp.data.code === 403);
    const rKey = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ sub: '1234560001', role: 'member', exp: nowS + 600, key: 'WRONG_KEY' }) });
    assert(rKey.data.success === false && rKey.data.code === 403);
    ok('篡改 / 過期 / 錯 key 的 sig → 403');

    // ---- 無旅不超然：children 全唔喺本團 → 拒 ----
    const noChildSig = sign({ sub: 'otherparent@example.org', role: 'parent', children_ids: ['SCOUT_幼_8888888888'], exp: nowS + 600 });
    const rNoChild = await proxy({ troopId: '0082', action: 'portalLogin', ...noChildSig });
    assert(rNoChild.data.success === false && rNoChild.data.code === 403);
    ok('家長 children_ids 全唔喺本團 → 拒（有旅才有超然）');

    // ---- GET load 純 sig（無 apikey）→ requireAuth 過 ----
    const directGet = await fetch(`${EXEC_URL}?action=load&childId=${encodeURIComponent(parentSig.childId)}&sub=${encodeURIComponent(parentSig.sub)}&scope=${encodeURIComponent(parentSig.scope)}&exp=${parentSig.exp}&sig=${encodeURIComponent(parentSig.sig)}`).then((r) => r.json());
    assert.strictEqual(directGet.success, true);
    assert.strictEqual(directGet.view_as, 'parent');
    ok('GET load 純 sig（無 apikey）→ 放行（ requireAuthParams 路徑）');

    // ---- normId childId 綁定（02 修 #12）：82S 與 0082S 唔撞號 ----
    gas.props.set('PORTAL_GLOBAL_ID', '0082S');
    const rNorm = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ childId: '82S', sub: '1234560001', role: 'member', exp: nowS + 600 }) });
    assert.strictEqual(rNorm.data.success, true, '82S 經 normId 應等於 0082S');
    const rNorm2 = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ childId: '0082S', sub: '1234560001', role: 'member', exp: nowS + 600 }) });
    assert.strictEqual(rNorm2.data.success, true);
    const rNormBad = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ childId: '0083S', sub: '1234560001', role: 'member', exp: nowS + 600 }) });
    assert(rNormBad.data.success === false && rNormBad.data.code === 403);
    gas.props.delete('PORTAL_GLOBAL_ID');
    ok('normId：childId 綁定 PORTAL_GLOBAL_ID（82S→0082S 唔撞號，0083S 拒）');

    // ---- 三點進入並存（設計決定：上層「食」咗唔會停用本端入口）----
    // 入口 1：本團密碼登入 —— 永遠可用
    const entryLocal = await proxy({ troopId: '0082', action: 'login', login_id: '1234560001', password: 'MemberA!234' });
    assert.strictEqual(entryLocal.data.success, true, '本團密碼登入必須成功：' + JSON.stringify(entryLocal.data));
    // 入口 2：上層 sig（成員）—— 免檢，與入口 1 並存
    const entrySig = await proxy({ troopId: '0082', action: 'portalLogin', ...sign({ sub: '1234560001', role: 'member', exp: nowS + 600 }) });
    assert.strictEqual(entrySig.data.success, true, '上層 sig 入口必須成功：' + JSON.stringify(entrySig.data));
    // 入口 3：家長 sig —— 子女聯集視角，與入口 1／2 並存
    const entryParent = await proxy({ troopId: '0082', action: 'load', ...sign({ sub: 'parent@example.org', role: 'parent', children_ids: ['SCOUT_童_1234560001', 'SCOUT_童_1234560002'], exp: nowS + 600 }) });
    assert.strictEqual(entryParent.data.view_as, 'parent', '家長 sig 入口必須成功：' + JSON.stringify(entryParent.data));
    ok('三點進入並存：本團密碼 + 上層 sig + 家長 sig 同時可用（無鎖死）');

    // ---- 中央登入（standalone 既有流程，真 Code.gs 回調）----
    const cfg = await proxy({
      troopId: '0082', action: 'configureTrustedTicketVerifier',
      verifyUrl: `${BASE}/api/verify-super-ticket`, token: lLogin.data.token
    });
    assert.strictEqual(cfg.data.success, true, JSON.stringify(cfg.data));
    const tCfg = await proxy({ troopId: '0082', action: 'testTrustedTicketVerifier', token: lLogin.data.token });
    assert.strictEqual(tCfg.data.success, true, JSON.stringify(tCfg.data));
    const superLogin = await proxy({ troopId: '0082', action: 'login', login_id: 'sheep', password: 'test-super-key-42' });
    assert.strictEqual(superLogin.data.success, true, JSON.stringify(superLogin.data));
    assert.strictEqual(superLogin.data.user.role, 'super_admin');
    assert(superLogin.data.token.startsWith('sbs1.'));
    ok('中央登入全循環（真 Code.gs 回調 /api/verify-super-ticket）');

    console.log(`\n=== Realgas v4.1.0 合約：${passed} 通過 ===`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 500); });
    gasServer.close();
  }
}

run().catch((err) => {
  console.error('\n[REALGAS FAIL]', err && (err.stack || err.message));
  process.exit(1);
});
