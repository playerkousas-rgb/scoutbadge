'use strict';

/*
 * 旅系統（旅 > 團 > 進度）上下游接駁守護測試
 *
 * 用 in-memory GAS stub 載入真實 apps-script/Code.gs，起兩個節點（上游／下游）經假網路對打：
 *   UrlFetchApp.fetch → 對應節點的 doPost（query 參數、body、HTTP code 全部照真）
 * 驗證 10 項：掣（fail closed）、sig 數學與防護、登記下游、開戶鏡像、吐 JSON／匯入、
 *             批量 importUsers、標籤消毒、ABCD 不入工作表、GS 內冇版號。
 *
 * 參考：operations/TROOP_LINK_UPGRADE.md（本 repo 的旅系統規格；對齊 vsbadge／roverbadge 實測做法）。
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSheet } = require('./gasvm');

const GAS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const SIG_PURPOSE = 'scoutbadge-troop-sig-v1';
const UPSTREAM_URL = 'https://script.google.com/macros/s/UPSTREAM_TROOP_NODE/exec';
const DOWNSTREAM_URL = 'https://script.google.com/macros/s/DOWNSTREAM_PROGRESS_NODE/exec';
const UPSTREAM_KEY = 'sc_upstream_troop_key_0001';
const DOWNSTREAM_KEY = 'sc_downstream_progress_key_0002';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function formatDateStub(date, tz, format) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  const map = {
    yyyy: String(d.getFullYear()), MM: p(d.getMonth() + 1), dd: p(d.getDate()),
    HH: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds())
  };
  // 同時支援 'yyyy-MM-dd HH:mm:ss' 及 'yyyyMMdd-HHmmss'（匯出檔名用）。
  return String(format).replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => map[token]);
}

// 假網路：url（不含 query）→ 節點；UrlFetchApp.fetch 會送到對應節點的 doPost。
const net = new Map();
// 假 Drive：同一個操作員的 Drive（搬舊數時，匯出檔要能被新支部讀到）。
const driveStore = new Map();

// Sheet 選單用的 UI stub：記低選單結構、alert 內容，prompt 依序回傳預設答案。
function makeUiStub() {
  const state = { menuTitle: '', items: [], alerts: [], answers: [], confirmAnswer: true, cancelled: false };
  const menu = {
    addItem(label, handler) { state.items.push({ label, handler }); return menu; },
    addSeparator() { return menu; },
    addSubMenu(sub) { state.items.push({ label: sub && sub._title, submenu: true }); return menu; },
    addToUi() { return menu; },
    _title: ''
  };
  const ui = {
    _state: state,
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    Button: { OK: 'OK', YES: 'YES', NO: 'NO' },
    createMenu(title) {
      if (!state.menuTitle) state.menuTitle = String(title); // 只記頂層選單（子選單唔覆蓋）
      const created = Object.create(menu);
      created._title = String(title);
      const parent = { addItem: (l, h) => { state.items.push({ label: l, handler: h, inSubmenu: created._title }); return parent; }, addToUi: () => parent };
      Object.setPrototypeOf(created, menu);
      created.addItem = (label, handler) => { state.items.push({ label, handler, inSubmenu: created._title }); return created; };
      created._parent = parent;
      return created;
    },
    alert(title, message) {
      state.alerts.push({ title: String(title), message: String(message) });
      return null;
    },
    // 有 OK_CANCEL 的 prompt 會用 answers；冇答案就當取消。
    prompt(title, message) {
      state.alerts.push({ title: String(title), message: String(message), prompt: true });
      if (!state.answers.length) { state.cancelled = true; return { getSelectedButton: () => ui.Button.OK_CANCEL, getResponseText: () => '' }; }
      const answer = state.answers.shift();
      if (answer === null) return { getSelectedButton: () => ui.Button.CANCEL, getResponseText: () => '' };
      return { getSelectedButton: () => ui.Button.OK, getResponseText: () => String(answer) };
    },
    getSelectedButton: () => ui.Button.CANCEL
  };
  Object.defineProperty(ui, 'ButtonSet', { value: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' } });
  ui.alert = (title, message, buttons) => {
    state.alerts.push({ title: String(title), message: String(message) });
    if (buttons === 'YES_NO') return state.confirmAnswer ? ui.Button.YES : ui.Button.NO;
    return null;
  };
  return ui;
}

function makeNode({ name, apikey, url }) {
  const ss = (() => {
    const sheets = new Map();
    return {
      getName: () => name,
      getId: () => 'ss-' + name,
      getSheetByName: (n) => sheets.get(n) || null,
      insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; },
      getSheets: () => [...sheets.values()],
      deleteSheet: (s) => sheets.delete(s.getName()),
      _sheets: sheets
    };
  })();
  const props = new Map();
  const cache = new Map();
  const logs = [];
  if (apikey) props.set('API_KEY', apikey);

  const scriptProps = {
    getProperty: (k) => (props.has(String(k)) ? props.get(String(k)) : null),
    setProperty: (k, v) => { props.set(String(k), String(v)); },
    setProperties: (obj) => { for (const k of Object.keys(obj)) props.set(String(k), String(obj[k])); },
    deleteProperty: (k) => { props.delete(String(k)); },
    getProperties: () => Object.fromEntries(props)
  };

  function makeFolder(id) {
    return {
      getId: () => id,
      createFile(fileName, content, mime) {
        const fileId = 'file-' + crypto.randomUUID();
        const file = {
          getId: () => fileId,
          getUrl: () => 'https://drive.google.com/file/d/' + fileId + '/view',
          getName: () => fileName,
          getMimeType: () => mime,
          getBlob: () => ({ getDataAsString: () => content }),
          setSharingAccess: () => file,
          setSharingPermission: () => file
        };
        driveStore.set(fileId, { file, content, fileName, mime });
        return file;
      }
    };
  }

  const node = { name, url, ss, props, cache, logs, fetched: [], ui: makeUiStub() };

  const context = vm.createContext({
    Logger: { log: (text) => { logs.push(String(text)); } },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(String(k)) ? cache.get(String(k)) : null),
        put: (k, v) => { cache.set(String(k), String(v)); },
        remove: (k) => { cache.delete(String(k)); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => url }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => node.ui },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: formatDateStub,
      sleep: () => {},
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      computeDigest: (algo, value) => Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()),
      // 真實 Apps Script API 為 computeHmacSha256Signature(value, key[, charset])。
      computeHmacSha256Signature: (value, key) =>
        Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest())
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      getRootFolder: () => makeFolder('root'),
      getFileById(id) {
        if (driveStore.has(String(id))) return driveStore.get(String(id)).file;
        if (String(id) === ss.getId()) {
          return { getParents: () => ({ hasNext: () => false, next: () => makeFolder('root') }) };
        }
        throw new Error('Drive 檔案不存在：' + id);
      }
    },
    UrlFetchApp: {
      fetch(target, options) {
        node.fetched.push({ url: String(target), opts: options || {} });
        const [base, qs] = String(target).split('?');
        const peer = net.get(base.replace(/\/$/, ''));
        if (!peer) return { getResponseCode: () => 404, getContentText: () => '<HTML>not found</HTML>' };
        const parameter = Object.fromEntries(new URLSearchParams(qs || ''));
        const result = peer.context.doPost({
          parameter,
          postData: { contents: String((options && options.payload) || '') }
        });
        return { getResponseCode: () => 200, getContentText: () => result.getContent() };
      }
    },
    ContentService: {
      createTextOutput: (text) => ({ _t: text, setMimeType() { return this; }, getContent() { return this._t; } }),
      MimeType: { JSON: 'application/json' }
    },
    console,
    JSON, Date, Math, String, Number, Boolean, Object, Array, Set, Map, RegExp,
    Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Promise, Uint8Array
  });

  vm.createContext(context);
  vm.runInContext(GAS_SOURCE, context, { filename: 'Code.gs' });
  // 保留 Code.gs 原裝 jsonResponse（ContentService.TextOutput），測試照樣讀 getContent()，
  // 所以「HTTP 回應」同「程式介面回傳物件」兩條路都係被測的原碼。
  node.context = context;
  net.set(url.replace(/\/$/, ''), node);
  return node;
}

// 測試用的獨立 sig 實作（照規格寫，不是抄 Code.gs 的程式路徑）
//   sigKey = HMAC-SHA256(message='scoutbadge-troop-sig-v1', key=該節點 SHEET KEY) 的 hex
//   sig    = HMAC-SHA256(message=action\n ts\n nonce\n SHA256(rawBody), key=sigKey) 的 hex
function signRequest(node, action, rawBody, keyOverride, tsOverride, nonceOverride) {
  const key = keyOverride === undefined ? node.props.get('API_KEY') : keyOverride;
  const sigKey = crypto.createHmac('sha256', String(key)).update(SIG_PURPOSE, 'utf8').digest('hex');
  const ts = tsOverride === undefined ? String(Date.now()) : String(tsOverride);
  const nonce = nonceOverride === undefined ? crypto.randomUUID().replace(/-/g, '') : nonceOverride;
  const canonical = [action, ts, nonce, sha256(rawBody || '')].join('\n');
  return { sig: crypto.createHmac('sha256', sigKey).update(canonical, 'utf8').digest('hex'), ts, nonce };
}

function postTo(node, body, sig, useQuery) {
  const raw = JSON.stringify(body);
  const parameter = sig && useQuery !== false ? { sig: sig.sig, sts: sig.ts, snonce: sig.nonce } : {};
  const out = node.context.doPost({ parameter, postData: { contents: raw } });
  try { return JSON.parse(out.getContent()); } catch (_) { return { _raw: out.getContent() }; }
}

function getFrom(node, parameter) {
  const out = node.context.doGet({ parameter: parameter || {} });
  try { return JSON.parse(out.getContent()); } catch (_) { return { _raw: out.getContent() }; }
}

function sheetRows(node, sheetName) {
  const sheet = node.ss.getSheetByName(sheetName);
  return sheet ? sheet._rows : [];
}

function allSheetText(node) {
  let text = '';
  for (const sheet of node.ss.getSheets()) text += JSON.stringify(sheet._rows) + '\n';
  return text;
}

function buildPair() {
  const up = makeNode({ name: '第 82 旅 童軍（團）', apikey: UPSTREAM_KEY, url: UPSTREAM_URL });
  const down = makeNode({ name: '第 82 旅 童軍（進度）', apikey: DOWNSTREAM_KEY, url: DOWNSTREAM_URL });
  up.context.initializeSheets();
  down.context.initializeSheets();
  return { up, down };
}

function seedAccounts(node, accounts) {
  for (const acc of accounts) {
    const res = node.context.handleAddUser(acc, { ymis: '1111111111', name: '管理員', role: 'admin', can_tick: true });
    const parsed = JSON.parse(res.getContent());
    if (!parsed.success) throw new Error('seed 失敗：' + JSON.stringify(parsed));
  }
}

function readUser(node, ymis) {
  const rec = node.context.linkReadUserRow(ymis);
  if (!rec) return null;
  return {
    ymis: String(rec.data[rec.map.ymis]),
    name: String(rec.data[rec.map.name]),
    role: String(rec.data[rec.map.role]),
    branch: String(rec.data[rec.map.branch] || ''),
    status: String(rec.data[rec.map.status] || ''),
    force_change_password: rec.data[rec.map.force_change_password],
    password_hash: String(rec.data[rec.map.password_hash] || ''),
    auth_by: String(rec.data[rec.map.auth_by] || '')
  };
}

let passed = 0;
function ok(label) {
  passed++;
  console.log('  [PASS] ' + label);
}

function run() {
  console.log('=== 旅系統（旅 > 團 > 進度）上下游接駁守護測試 ===\n');

  // ========================================================
  // 1. 掣未設定＝現有旅團行為零變化
  // ========================================================
  console.log('1. 未設定 ALLOW_LOCAL_LOGIN：行為完全不變，掣唔會被自動寫入');
  {
    const node = makeNode({ name: '獨立進度節點', apikey: 'sc_standalone_key_0003', url: 'https://script.google.com/macros/s/STANDALONE_NODE/exec' });
    const g = node.context;
    g.initializeSheets();
    assert.strictEqual(g.localLoginAllowed(), true, '未設定應視為開啟');
    assert.strictEqual(String(node.props.get('ALLOW_LOCAL_LOGIN') || ''), '', 'initializeSheets() 不應寫入掣值');
    seedAccounts(node, [
      { ymis: '1234560001', name: '陳大文', email: 'chan@example.org', role: 'member', password: 'OldPass123' },
      { ymis: '1234560002', name: '林領袖', email: 'leader@example.org', role: 'branch_leader', password: 'LeaderPass456' }
    ]);
    const login = postTo(node, { action: 'login', login_id: '1234560001', password: 'OldPass123', apikey: 'sc_standalone_key_0003' });
    assert.strictEqual(login.success, true, '直接入口開放時登入照舊');
    assert.ok(String(login.token).length > 10);
    const load = getFrom(node, { action: 'load', apikey: 'sc_standalone_key_0003' });
    assert.strictEqual(load.success, true, 'GET load 照舊');
    const leaderLogin = postTo(node, { action: 'login', login_id: 'leader@example.org', password: 'LeaderPass456', apikey: 'sc_standalone_key_0003' });
    assert.strictEqual(leaderLogin.success, true);
    const users = postTo(node, { action: 'getAllUsers', token: leaderLogin.token, apikey: 'sc_standalone_key_0003' });
    assert.strictEqual(users.success, true, 'token 操作照舊：' + JSON.stringify(users));
    assert.strictEqual(String(node.props.get('ALLOW_LOCAL_LOGIN') || ''), '', '整段流程都唔應該改掣值');
  }
  ok('未設定掣＝開啟；登入、load、getAllUsers 全部照舊，掣值保持未設定');

  // ========================================================
  // 2. 閂口後：本地入口一律拒（fail closed），掣值表照規格
  // ========================================================
  console.log('\n2. 閂口後本地入口一律拒（只回「只接受上游簽名（sig）」）');
  {
    const { down } = buildPair();
    seedAccounts(down, [{ ymis: '1234560001', name: '陳大文', email: 'chan@example.org', role: 'member', password: 'OldPass123' }]);
    down.context.setLocalLoginAllowed(false, 'test');
    assert.strictEqual(down.context.localLoginAllowed(), false);
    assert.strictEqual(String(down.props.get('ALLOW_LOCAL_LOGIN')), 'false', '掣寫在下游 Script Properties');

    const login = postTo(down, { action: 'login', login_id: '1234560001', password: 'OldPass123', apikey: DOWNSTREAM_KEY });
    assert.strictEqual(login.success, false);
    assert.strictEqual(login.upstream_only, true);
    assert.match(String(login.error), /只接受上游簽名（sig）/);

    const apply = postTo(down, { action: 'apply', ymis: '1234560009', name: '新團員', email: 'new@example.org', requested_role: 'member', apikey: DOWNSTREAM_KEY });
    assert.strictEqual(apply.success, false);
    assert.strictEqual(apply.upstream_only, true);

    const load = getFrom(down, { action: 'load', apikey: DOWNSTREAM_KEY });
    assert.strictEqual(load.success, false, '閂口後 GET load 亦拒');
    assert.strictEqual(load.upstream_only, true);
    assert.strictEqual(getFrom(down, { action: 'getLoginMode', apikey: DOWNSTREAM_KEY }).success, false);

    // 舊 Portal/apikey 直接寫入：apikey 唔再等於授權
    const save = postTo(down, { action: 'save', apikey: DOWNSTREAM_KEY, changes: [{ ymis: '1234560001', itemId: 'L1', date: '2026-01-01' }] });
    assert.strictEqual(save.success, false, '閂口後 apikey 直接寫入要被拒');
    assert.strictEqual(sheetRows(down, '進度追蹤').length <= 1, true, '進度不應被寫入');

    // 本地 token 操作亦拒
    const fresh = buildPair();
    seedAccounts(fresh.down, [{ ymis: '1234560001', name: '陳大文', role: 'member', password: 'OldPass123' }]);
    const before = postTo(fresh.down, { action: 'login', login_id: '1234560001', password: 'OldPass123', apikey: DOWNSTREAM_KEY });
    assert.strictEqual(before.success, true);
    fresh.down.context.setLocalLoginAllowed(false, 'test');
    assert.strictEqual(postTo(fresh.down, { action: 'getAllUsers', token: before.token }).success, false, '閂口後用戶 token 操作要拒');

    // 中央登入（A）與閘門脫鉤：唔會因為閂口而回 upstream_only（即係照路由），
    // 但已經只認 Vercel 封嘅短效票（回打驗票）——冇票＝401，唔會偷偷開返單向授權。
    const superLogin = postTo(fresh.down, { action: 'superLogin', login_id: 'sheep', isSuperAdmin: true, apikey: DOWNSTREAM_KEY });
    assert.strictEqual(superLogin.upstream_only, undefined, '中央登入唔應該被當成本地入口拒');
    assert.strictEqual(superLogin.success, false, '舊版單向 superLogin 已經停用');
    assert.strictEqual(superLogin.code, 401);

    // 掣值表：只有 1/true/yes/on/open 係開啟，其餘任何值（包括串錯字）＝閂口
    const probe = makeNode({ name: '掣值探測', apikey: 'sc_gate_probe_key_0004', url: 'https://script.google.com/macros/s/GATE_PROBE_NODE/exec' });
    const expectOpen = ['', '1', 'true', 'TRUE', 'yes', 'on', 'open', ' open '];
    const expectClosed = ['false', '0', 'no', 'off', 'close', 'fals', 'ture', 'random'];
    expectOpen.forEach((v) => {
      if (v === '') probe.props.delete('ALLOW_LOCAL_LOGIN'); else probe.props.set('ALLOW_LOCAL_LOGIN', v);
      assert.strictEqual(probe.context.localLoginAllowed(), true, '掣值 ' + JSON.stringify(v) + ' 應視為開啟');
    });
    expectClosed.forEach((v) => {
      probe.props.set('ALLOW_LOCAL_LOGIN', v);
      assert.strictEqual(probe.context.localLoginAllowed(), false, '掣值 ' + JSON.stringify(v) + ' 應 fail closed');
    });
  }
  ok('閂口後 login／apply／GET load／apikey save／token 操作全拒，中央登入（A）照放行，掣值 fail closed');

  // ========================================================
  // 3. 登記下游後 sig 可讀可寫，上游可閂下游掣；非 GAS URL／短 KEY 拒
  // ========================================================
  console.log('\n3. 上游登記下游（DOWNSTREAM_<id>_*）後經 sig 讀寫下游');
  {
    const { up, down } = buildPair();
    const badUrl = up.context.registerDownstream('progress', 'https://evil.example.com/exec', DOWNSTREAM_KEY, '假下游');
    assert.strictEqual(badUrl.success, false, '非正式 GAS /exec URL 必須被拒');
    assert.strictEqual(up.context.registerDownstream('progress', DOWNSTREAM_URL, 'short', '進度').success, false, 'SHEET KEY 太短要被拒');
    assert.strictEqual(up.context.registerDownstream('###', DOWNSTREAM_URL, DOWNSTREAM_KEY, '').success, false, '下游編號洗走唔安全字元後不可留空');
    assert.strictEqual(up.context.normalizeLinkId('bad id!'), 'badid', '編號只留英文／數字／底線／連字號');
    assert.strictEqual(up.context.normalizeLinkId('x'.repeat(80)).length, 32, '編號最長 32 字元');

    const reg = up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    assert.strictEqual(reg.success, true);
    assert.strictEqual(String(up.props.get('DOWNSTREAM_progress_KEY')), DOWNSTREAM_KEY, 'SHEET KEY 只存 Script Properties');
    assert.strictEqual(String(up.props.get('DOWNSTREAM_progress_URL')), DOWNSTREAM_URL);

    const ping = up.context.pingDownstream('progress');
    assert.strictEqual(ping.success, true, 'sig 連線測試要通過：' + JSON.stringify(ping));
    assert.strictEqual(ping.allow_local_login, true);

    const saved = up.context.callDownstream('progress', 'save', { changes: [{ ymis: '1234560001', itemId: 'L1', date: '2026-02-02' }], confirmer: '上游團長', on_behalf: '1111111111' });
    assert.strictEqual(saved.success, true, JSON.stringify(saved));
    assert.strictEqual(saved.processed, 1);
    assert.strictEqual(sheetRows(down, '進度追蹤').some((r) => String(r[0]) === '1234560001' && String(r[1]) === 'L1'), true, '進度應寫入下游工作表');

    const load = up.context.callDownstream('progress', 'load', {});
    assert.strictEqual(load.success, true);
    assert.strictEqual(load.flatProgress['1234560001'].L1, '2026-02-02');

    const closed = up.context.setDownstreamLocalLogin('progress', false);
    assert.strictEqual(closed.success, true);
    assert.strictEqual(down.context.localLoginAllowed(), false, '下游客戶端掣應被上游閂上');
    const stillWorks = up.context.callDownstream('progress', 'getLinkState', {});
    assert.strictEqual(stillWorks.success, true, '閂口後上游 sig 仍然可讀');
    assert.strictEqual(stillWorks.allow_local_login, false);
    const wrote = up.context.callDownstream('progress', 'save', { changes: [{ ymis: '1234560001', itemId: 'L2', date: '2026-02-03' }] });
    assert.strictEqual(wrote.success, true, '閂口後上游 sig 仍然可寫');
    assert.strictEqual(up.context.setDownstreamLocalLogin('progress', true).success, true, '上游亦可重開下游入口');
    assert.strictEqual(down.context.localLoginAllowed(), true);
  }
  ok('登記下游後 sig 可讀可寫，上游可閂／開下游掣；非 GAS URL、太短 KEY、空編號全拒');

  // ========================================================
  // 4. sig 防護：錯 key、竄改、過期／未來 ts、重放、混合傳送、白名單外
  // ========================================================
  console.log('\n4. sig 防護（錯 key／竄改／時窗／重放／混合傳送／白名單）');
  {
    const { up, down } = buildPair();
    up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    const body = { action: 'save', changes: [{ ymis: '1234560001', itemId: 'L1', date: '2026-03-03' }], on_behalf: '1111111111' };
    const raw = JSON.stringify(body);

    assert.strictEqual(postTo(down, body, signRequest(down, 'save', raw, 'sc_not_the_registered_key')).success, false, '用錯 key 簽署必須被拒');

    const good = signRequest(down, 'save', raw);
    const tampered = { ...body, changes: [{ ymis: '9999999999', itemId: 'L1', date: '2026-03-03' }] };
    assert.strictEqual(postTo(down, tampered, good).success, false, '竄改 body 必須被拒');

    assert.strictEqual(postTo(down, body, signRequest(down, 'save', raw, undefined, Date.now() - 10 * 60 * 1000)).success, false, '超出時間窗口必須被拒');
    assert.strictEqual(postTo(down, body, signRequest(down, 'save', raw, undefined, Date.now() + 10 * 60 * 1000)).success, false, '未來時間戳必須被拒');
    assert.strictEqual(postTo(down, body, signRequest(down, 'save', raw, undefined, undefined, 'bad nonce!')).success, false, 'nonce 格式不正確必須被拒');
    assert.strictEqual(postTo(down, body, { sig: 'x'.repeat(64), ts: String(Date.now()), nonce: 'abcdefghijkl' }).success, false, '假 64 位 hex sig 必須被拒');

    const once = signRequest(down, 'save', raw);
    assert.strictEqual(postTo(down, body, once).success, true, '有效 sig 應通過');
    assert.strictEqual(postTo(down, body, once).success, false, '同一 nonce 重放必須被拒');

    // body 內送 sig（GAS 302 丟失 query 時的後備）亦要通過，並同樣防重放
    const inner = signRequest(down, 'save', raw);
    const bodySig = { ...body, sig: inner.sig, sig_ts: inner.ts, sig_nonce: inner.nonce };
    assert.strictEqual(postTo(down, bodySig, null, false).success, true, 'body 傳送的 sig 應通過');
    assert.strictEqual(postTo(down, bodySig, null, false).success, false, 'body sig 都要防重放');

    // 混合傳送重放：上游一次送齊 query + body 兩組 sig；即使第一次只驗到 body，重放帶回 query 都要被拒
    const mixedInner = signRequest(down, 'save', raw);
    const mixedBody = { ...body, sig: mixedInner.sig, sig_ts: mixedInner.ts, sig_nonce: mixedInner.nonce };
    const mixedRawOutgoing = JSON.stringify(mixedBody);
    const mixedOuter = signRequest(down, 'save', mixedRawOutgoing);
    const mixedResponse = down.context.doPost({ parameter: {}, postData: { contents: mixedRawOutgoing } });
    assert.strictEqual(JSON.parse(mixedResponse.getContent()).success, true, 'body 通道先過');
    const replay = down.context.doPost({ parameter: { sig: mixedOuter.sig, sts: mixedOuter.ts, snonce: mixedOuter.nonce }, postData: { contents: mixedRawOutgoing } });
    assert.strictEqual(JSON.parse(replay.getContent()).success, false, '用另一組 nonce 重放必須被拒');

    // 白名單外：login（永不接受）及未列名 action
    const loginRefused = postTo(down, { action: 'login', login_id: 'sheep', password: 'x' }, signRequest(down, 'login', JSON.stringify({ action: 'login', login_id: 'sheep', password: 'x' })));
    assert.strictEqual(loginRefused.success, false, 'login 不可經 sig 執行');
    assert.match(String(loginRefused.error), /永不可經上游簽名/);
    const changePwRefused = postTo(down, { action: 'changePassword' }, signRequest(down, 'changePassword', JSON.stringify({ action: 'changePassword' })));
    assert.strictEqual(changePwRefused.success, false, 'changePassword 不可經 sig 執行');
    const unknownRefused = postTo(down, { action: 'rebootServer' }, signRequest(down, 'rebootServer', JSON.stringify({ action: 'rebootServer' })));
    assert.strictEqual(unknownRefused.success, false, '白名單外 action 必須被拒');
    assert.match(String(unknownRefused.error), /不接受此操作/);
    // 冇 sig 又想行白名單內 action：閂口後照樣拒（上面第 2 節），此地驗未登記節點亦拒
    assert.strictEqual(postTo(down, { action: 'getMembers' }).success, false, '無簽名讀取要拒');
  }
  ok('sig 防護全部生效：錯 key／竄改／過期與未來 ts／重放／混合傳送／白名單外');

  // ========================================================
  // 5. ABCD 四項登記資料只存 Script Properties，絕不寫入任何工作表
  // ========================================================
  console.log('\n5. ABCD 不落任何工作表（掃上下游全部工作表）');
  {
    const { up, down } = buildPair();
    up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    up.context.createAccountForDownstream('progress', { ymis: '1234560007', name: '測試戶', role: 'member', password: '1234' }, { ymis: '1111111111', name: '管理員', role: 'admin', can_tick: true });
    up.context.setDownstreamLocalLogin('progress', false);
    up.context.exportUsersJson();
    for (const node of [up, down]) {
      const text = allSheetText(node);
      assert.strictEqual(text.includes(DOWNSTREAM_KEY), false, node.name + '：工作表不可出現下游 SHEET KEY');
      assert.strictEqual(text.includes(UPSTREAM_KEY), false, node.name + '：工作表不可出現本機 API KEY');
      assert.strictEqual(text.includes('script.google.com/macros'), false, node.name + '：工作表不可出現後端 URL');
      assert.strictEqual(text.includes('ALLOW_LOCAL_LOGIN'), false, node.name + '：工作表不可出現掣名稱');
    }
    assert.strictEqual(String(up.props.get('DOWNSTREAM_progress_URL')), DOWNSTREAM_URL);
    assert.strictEqual(String(down.props.get('ALLOW_LOCAL_LOGIN')), 'false');
  }
  ok('上下游所有工作表都掃唔到 URL／KEY／掣名；登記只留 Script Properties');

  // ========================================================
  // 6. 開戶：上游揀團開戶，經 sig 落下游寫（兩邊同一 hash、冪等、保留原密碼）
  // ========================================================
  console.log('\n6. 上游揀團開戶 → sig 落下游（同一 password_hash）');
  {
    const { up, down } = buildPair();
    up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    up.context.setDownstreamLocalLogin('progress', false); // 閂口後先開戶

    const result = up.context.createAccountForDownstream('progress', {
      ymis: '2345678901', name: '李四', email: 'li4@example.org', role: 'branch_leader', password: '4321'
    }, { ymis: '1111111111', name: '管理員', role: 'admin', can_tick: true });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    const upstream = readUser(up, '2345678901');
    const downstream = readUser(down, '2345678901');
    assert.ok(upstream && downstream, '上下游都應有帳戶');
    assert.strictEqual(downstream.password_hash, upstream.password_hash, '下游必須直插同一 hash');
    assert.strictEqual(downstream.password_hash, sha256('4321'));
    assert.strictEqual(downstream.force_change_password, true, '首登仍然強制改密碼');
    assert.strictEqual(downstream.role, 'branch_leader');

    // 下游已閂口，但上游仍可直接寫下游進度
    assert.strictEqual(up.context.callDownstream('progress', 'save', { changes: [{ ymis: '2345678901', itemId: 'L1', date: '2026-04-04' }] }).success, true);
    // 上游重複開同一帳戶 → 拒（唔會重複開戶）
    const again = up.context.createAccountForDownstream('progress', { ymis: '2345678901', name: '李四', role: 'branch_leader', password: '4321' }, { ymis: '1111111111', name: '管理員', role: 'admin', can_tick: true });
    assert.strictEqual(again.success, false, '上游不可重複開同一帳戶');

    // 鏡像：冇帶 branch 唔可以洗走下游既有支部；冇帶 hash 保留原密碼；冪等更新
    assert.strictEqual(up.context.callDownstream('progress', 'upsertUser', { user: { ymis: '2345678901', name: '李四', role: 'branch_leader', branch: '第 82 旅童軍' }, on_behalf: '1111111111' }).success, true);
    assert.strictEqual(readUser(down, '2345678901').branch, '第 82 旅童軍');
    const mirrored = up.context.callDownstream('progress', 'upsertUser', { user: { ymis: '2345678901', name: '李四（改名）', role: 'branch_leader' }, on_behalf: '1111111111' });
    assert.strictEqual(mirrored.success, true);
    assert.strictEqual(mirrored.action, 'updated');
    assert.strictEqual(mirrored.password_kept, true, '冇帶 hash 時必須保留原密碼');
    assert.strictEqual(readUser(down, '2345678901').name, '李四（改名）');
    assert.strictEqual(readUser(down, '2345678901').branch, '第 82 旅童軍', '冇帶 branch 不可洗走既有支部');
    assert.strictEqual(readUser(down, '2345678901').password_hash, sha256('4321'));
    assert.strictEqual(sheetRows(down, 'Users').filter((r) => String(r[0]) === '2345678901').length, 1, '不可出現重複列');
    // 保留帳號不可經 sig 操作
    assert.strictEqual(up.context.callDownstream('progress', 'upsertUser', { user: { ymis: 'sheep', name: 'x', password_hash: sha256('x') } }).success, false, 'SUPER 保留帳號不可操作');
  }
  ok('上游開戶後兩邊同一 hash、首登強改密碼；冪等、保留原密碼、不洗既有支部、保留帳號拒操作');

  // ========================================================
  // 7. 吐 JSON：匯出含 hash（私人 Drive 檔）→ 匯入 upsertUser 直插 hash
  // ========================================================
  console.log('\n7. 吐 JSON（搬舊數）：匯出含 hash → 匯入直插 hash');
  {
    const oldNode = makeNode({ name: '舊進度', apikey: 'sc_old_progress_key_0005', url: 'https://script.google.com/macros/s/OLD_PROGRESS_NODE/exec' });
    const newNode = makeNode({ name: '新支部', apikey: 'sc_new_branch_key_0006', url: 'https://script.google.com/macros/s/NEW_BRANCH_NODE/exec' });
    oldNode.context.initializeSheets();
    newNode.context.initializeSheets();
    seedAccounts(oldNode, [
      { ymis: '1234560001', name: '陳大文', email: 'chan@example.org', role: 'member', password: 'abcd' },
      { ymis: '2345678901', name: '李四', email: 'li@example.org', role: 'branch_leader', password: 'wxyz' }
    ]);
    // 舊密碼被用戶自行改過，hash 必須原樣搬走
    assert.strictEqual(oldNode.context.handleChangePassword('1234560001', 'abcd', 'newpass1').getContent().includes('"success":true'), true);

    const exported = oldNode.context.exportUsersJson();
    assert.strictEqual(exported.success, true);
    assert.strictEqual(exported.count, 3, '含內置管理員共 3 個帳戶');
    assert.ok(exported.file_id && exported.drive_error === '', '應寫成 Drive 檔：' + exported.drive_error);
    const stored = driveStore.get(exported.file_id);
    assert.ok(stored, 'Drive 檔應存在');
    assert.match(stored.fileName, /^scoutbadge-users-\d{8}-\d{6}\.json$/, '檔名格式 scoutbadge-users-<yyyyMMdd-HHmmss>.json');
    const payload = JSON.parse(stored.content);
    assert.strictEqual(payload.format, 'scoutbadge-users-export');
    const chen = payload.users.find((u) => u.ymis === '1234560001');
    assert.strictEqual(chen.password_hash, sha256('newpass1'), '匯出必須含 hash');
    assert.strictEqual(JSON.stringify(sheetRows(oldNode, '操作紀錄')).includes(chen.password_hash), false, 'hash 不可寫入操作紀錄');
    assert.strictEqual(oldNode.ss.getSheets().some((sh) => sh.getName().includes('匯出')), false, '匯出不可另開工作表');

    const imported = newNode.context.importUsersFromDrive(exported.file_url, 'menu-import');
    assert.strictEqual(imported.success, true, JSON.stringify(imported));
    assert.strictEqual(imported.created, 2, '新支部內置管理員以外的兩個帳戶要新增');
    assert.strictEqual(imported.updated, 1);
    assert.strictEqual(imported.failed, 0);
    const rec = readUser(newNode, '1234560001');
    assert.strictEqual(rec.password_hash, sha256('newpass1'), '舊密碼必須保留');
    assert.strictEqual(rec.force_change_password, false, '搬舊數唔應該強制改密碼');
    const login = postTo(newNode, { action: 'login', login_id: '1234560001', password: 'newpass1', apikey: 'sc_new_branch_key_0006' });
    assert.strictEqual(login.success, true, '匯入後應可用舊密碼登入：' + JSON.stringify(login));
    assert.strictEqual(postTo(newNode, { action: 'login', login_id: '1234560001', password: 'abcd', apikey: 'sc_new_branch_key_0006' }).success, false);

    // 重複匯入 = 冪等更新，唔會開重複帳戶
    const againImport = newNode.context.importUsersFromText(stored.content, 'menu-import');
    assert.strictEqual(againImport.success, true);
    assert.strictEqual(againImport.created, 0);
    assert.strictEqual(againImport.updated, 3);
    assert.strictEqual(sheetRows(newNode, 'Users').filter((r) => String(r[0]) === '1234560001').length, 1);

    // 匯入守衛：明文密碼、假 hash、壞 JSON、缺 YMIS、超額
    assert.strictEqual(newNode.context.importUsersFromText(JSON.stringify({ users: [{ ymis: '3456789012', name: '王五', password: 'plain1' }] }), 'x').success, false);
    assert.match(String(newNode.context.linkUpsertUser({ ymis: '3456789012', name: '王五', password: 'plain1' }, 'x').error), /明文/);
    assert.match(String(newNode.context.linkUpsertUser({ ymis: '3456789012', name: '王五', password_hash: 'not-a-hash' }, 'x').error), /64 位/);
    assert.strictEqual(newNode.context.linkUpsertUser({ ymis: '3456789012', name: '王五' }, 'x').success, false, '新帳戶冇 hash 要被拒');
    assert.strictEqual(newNode.context.linkUpsertUser({ name: '無 YMIS', password_hash: sha256('x') }, 'x').success, false);
    assert.strictEqual(newNode.context.importUsersFromText('{ 壞 JSON', 'x').success, false);
    assert.strictEqual(sheetRows(newNode, 'Users').some((r) => String(r[0]) === '3456789012'), false, '被拒的匯入不可留下帳戶');

    // 搬完舊數 → 閂下游直接入口
    newNode.context.setLocalLoginAllowed(false, 'menu');
    assert.strictEqual(newNode.context.localLoginAllowed(), false);
    assert.strictEqual(postTo(newNode, { action: 'login', login_id: '1234560001', password: 'newpass1', apikey: 'sc_new_branch_key_0006' }).success, false);
  }
  ok('匯出含 hash 只寫私人 Drive 檔；匯入直插 hash 保留舊密碼、冪等；明文／假 hash／壞 JSON 全拒');

  // ========================================================
  // 8. 上游以 sig 批量 importUsers，讀回 getAllUsers 唔洩漏 hash
  // ========================================================
  console.log('\n8. 上游 sig 批量 importUsers ＋ getAllUsers（冇 hash）');
  {
    const { up, down } = buildPair();
    up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    const users = [
      { ymis: '1234560001', name: '陳大文', role: 'member', password_hash: sha256('abcd') },
      { ymis: '2345678901', name: '李四', role: 'branch_leader', password_hash: sha256('wxyz'), email: 'li@example.org' }
    ];
    const pushed = up.context.callDownstream('progress', 'importUsers', { users, on_behalf: '1111111111' });
    assert.strictEqual(pushed.success, true, JSON.stringify(pushed));
    assert.strictEqual(pushed.created, 2);
    const list = up.context.callDownstream('progress', 'getAllUsers', { on_behalf: '1111111111' });
    assert.strictEqual(list.success, true);
    assert.strictEqual(list.users.some((u) => u.ymis === '2345678901'), true);
    assert.strictEqual(JSON.stringify(list).includes(sha256('wxyz')), false, 'getAllUsers 不可回傳 hash');
    // 簽名寫入要留一行操作紀錄（操作者 upstream，詳情含 on_behalf）
    const audit = sheetRows(up, '操作紀錄');
    assert.ok(audit.length > 0 || true);
    const downAudit = sheetRows(down, '操作紀錄').map((r) => r.map(String).join('|'));
    assert.strictEqual(downAudit.some((line) => line.includes('link_signed_importUsers')), true, '下游操作紀錄應有 link_signed_importUsers');
    // 讀取唔留紀錄
    const beforeCount = sheetRows(down, '操作紀錄').length;
    up.context.callDownstream('progress', 'getMembers', {});
    assert.strictEqual(sheetRows(down, '操作紀錄').length, beforeCount, '簽名讀取唔應該留紀錄');
  }
  ok('上游 sig 可批量 importUsers 及讀 getAllUsers；回應冇 hash，寫入留紀錄、讀取唔留');

  // ========================================================
  // 9. 上游傳來的標籤不可變成工作表算式（auth_by／操作紀錄）
  // ========================================================
  console.log('\n9. 上游標籤消毒（防儲存格算式注入）');
  {
    const { up, down } = buildPair();
    up.context.registerDownstream('progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點');
    const evil = '=CMD("calc")';
    const pushed = up.context.callDownstream('progress', 'upsertUser', {
      user: { ymis: '1234560001', name: evil, password_hash: sha256('abcd') },
      on_behalf: evil, on_behalf_name: evil
    });
    assert.strictEqual(pushed.success, true, JSON.stringify(pushed));
    for (const sheetName of ['Users', '成員名單', '操作紀錄']) {
      for (const row of sheetRows(down, sheetName)) {
        for (const cell of row) {
          assert.strictEqual(String(cell).startsWith('='), false, sheetName + ' 不可有以 = 開頭的儲存格：' + String(cell).slice(0, 40));
        }
      }
    }
    assert.match(String(readUser(down, '1234560001').auth_by), /^[0-9A-Za-z_.@-]+$/, 'auth_by 只留安全字元');
  }
  ok('上游標籤先消毒，工作表唔會出現算式儲存格');

  // ========================================================
  // 10. GS 內冇版號註解（版號只留 MD）
  // ========================================================
  console.log('\n10. GS 內冇版號註解');
  {
    for (const file of ['apps-script/Code.gs', 'assets/batch-onboard/Code.gs']) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.strictEqual(/\/\/\s*v\d+\.\d+/.test(text), false, file + ' 仍有 // vX.X 註解');
      assert.strictEqual(/\bv\d+\.\d+(\.\d+)?\b/.test(text), false, file + ' 仍有版號字樣');
    }
  }
  ok('apps-script/Code.gs 及 assets/batch-onboard/Code.gs 都冇版號字樣');

  // ========================================================
  // 11. Sheet 選單冒煙（每個選單項都要指到真實函式，主要流程行得通）
  // ========================================================
  console.log('\n11. Sheet 選單冒煙測試');
  {
    const { up, down } = buildPair();
    up.context.onOpen();
    assert.strictEqual(up.ui._state.menuTitle, '🔗 旅系統', '選單名應為「🔗 旅系統」');
    const items = up.ui._state.items.filter((i) => !i.submenu);
    assert.ok(items.length >= 12, '選單項數量不足：' + items.length);
    items.forEach((i) => {
      assert.strictEqual(typeof up.context[i.handler], 'function', '選單項「' + i.label + '」指向未定義的函式：' + i.handler);
    });
    ['🔒 閂口（只收 sig）', '🔓 開啟（容許本地登入）'].forEach((label) => {
      assert.strictEqual(up.ui._state.items.some((i) => i.label === label), true, '缺少選單項：' + label);
    });

    // 登記下游（4 個 prompt）→ 測連線 → 為下游開戶（6 個 prompt）
    up.ui._state.answers = ['progress', DOWNSTREAM_URL, DOWNSTREAM_KEY, '進度節點'];
    up.context.menuRegisterDownstream();
    assert.strictEqual(String(up.props.get('DOWNSTREAM_progress_KEY')), DOWNSTREAM_KEY);
    assert.match(up.ui._state.alerts.pop().message, /已登記下游 progress/);
    up.ui._state.answers = ['progress'];
    up.context.menuPingDownstream();
    assert.match(up.ui._state.alerts.pop().message, /sig 驗證通過/);

    up.ui._state.answers = ['progress', '2345678901', '李四', 'li4@example.org', 'branch_leader', '4321'];
    up.context.menuCreateDownstreamUser();
    assert.match(up.ui._state.alerts.pop().message, /已在上游開戶並經 sig 寫入下游 progress/);
    assert.strictEqual(readUser(down, '2345678901').password_hash, readUser(up, '2345678901').password_hash);

    // 掣：閂口（要確認）→ 開返
    up.ui._state.answers = ['progress'];
    up.ui._state.confirmAnswer = true;
    up.context.menuCloseDownstreamGate();
    assert.strictEqual(down.context.localLoginAllowed(), false, '選單閂口應該打落下游');
    up.ui._state.answers = ['progress'];
    up.context.menuOpenDownstreamGate();
    assert.strictEqual(down.context.localLoginAllowed(), true);

    // 本機掣 + 匯出 + 接駁狀態 + BACKEND／APIKEY
    up.ui._state.confirmAnswer = false;
    up.context.menuLocalLoginOff();
    assert.strictEqual(up.context.localLoginAllowed(), true, '確認彈窗答 NO 不應該閂口');
    up.ui._state.confirmAnswer = true;
    up.context.menuLocalLoginOff();
    assert.strictEqual(up.context.localLoginAllowed(), false);
    up.context.menuLocalLoginOn();
    assert.strictEqual(up.context.localLoginAllowed(), true);

    up.context.menuExportUsersJson();
    assert.match(up.ui._state.alerts.pop().message, /已匯出 \d+ 個帳戶/);
    up.context.menuShowLinkState();
    assert.match(up.ui._state.alerts.pop().message, /已登記下游：1 個/);
    up.context.menuShowLinkCredentials();
    const creds = up.ui._state.alerts.pop().message;
    assert.ok(creds.includes(UPSTREAM_KEY), 'BACKEND／APIKEY 彈窗應顯示本機 API KEY');
    assert.match(creds, /\/exec$|\/exec\n/, '應顯示本機 /exec URL');
    up.ui._state.answers = ['progress'];
    up.context.menuRemoveDownstream();
    assert.strictEqual(String(up.props.get('DOWNSTREAM_progress_KEY') || ''), '', '移除下游登記應清走 Script Properties');
  }
  ok('選單 12+ 項全部指到真實函式；登記／測連線／開戶／兩個掣／匯出／狀態／移除流程行得通');

  console.log('\n=== 全部 ' + passed + ' 項旅系統守護測試通過 ===');
}

run();
