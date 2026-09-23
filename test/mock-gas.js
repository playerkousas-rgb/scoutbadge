'use strict';

/*
 * In-memory mock of the scoutbadge Google Apps Script backend, just enough to
 * exercise the real HTTP pipeline (dev server + /api/proxy + /api/troops)
 * the same way a deployed troop would behave.
 *
 * Emulates the subset of Code.gs actions the frontend uses:
 *   login, load, getConfig, save, getPendingRequests, reviewRequest,
 *   getApplications, getAllUsers, addMember, resetPassword,
 *   getLogRequests, changePassword, apply, logout
 *
 * Auth model mirrors Code.gs:
 *   - POST body must carry the shared apikey for save/addMember
 *   - other actions require a valid token from the Tokens "sheet"
 */

const http = require('http');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
  });
}

class MockGas {
  constructor({ name, apikey, users, execUrl, verifyUrl }) {
    this.name = name;
    this.apikey = apikey;
    this.execUrl = execUrl || 'http://127.0.0.1:0/exec';
    this.users = new Map(); // ymis -> { ymis, name, email, role, password, status }
    this.tokens = new Map(); // token -> ymis
    for (const u of users) this.users.set(u.ymis, { ...u, status: 'active' });
    this.requests = [];
    this.calls = [];
    // Loopback verifier override, exactly like the Code.gs Script Property a
    // local test sets; the live endpoint is a constant inside Code.gs.
    this.verifyUrl = String(verifyUrl || '');
    this.usedTickets = new Set();
  }

  _sha256Hex(text) {
    return require('crypto').createHash('sha256').update(String(text), 'utf8').digest('hex');
  }

  // Mirrors Code.gs verifyCentralTicket(): one callback per login, tickets are
  // single use (the same ticket replayed is refused).
  async _redeemTicket(ticket, loginId) {
    if (typeof ticket !== 'string' || ticket.length < 8 || ticket.length > 4096) return { ok: false };
    const used = this._sha256Hex(ticket);
    if (this.usedTickets.has(used)) return { ok: false };
    if (!this.verifyUrl) return { ok: false, infra: true, detail: '未設定驗票端點（本地測試要 loopback 覆寫）' };
    try {
      const response = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          apikey: this.apikey,
          backendHash: this._sha256Hex(this.execUrl),
          loginId: String(loginId || '')
        })
      });
      if (response.status !== 200) return { ok: false, infra: true, detail: '驗票端點回應 HTTP ' + response.status };
      const data = await response.json();
      if (!data || data.valid !== true) return { ok: false };
      this.usedTickets.add(used);
      return { ok: true };
    } catch (error) {
      return { ok: false, infra: true, detail: String((error && error.message) || error) };
    }
  }

  async _probeVerifier() {
    if (!this.verifyUrl) return { success: false, mode: 'callback', error: '未設定驗票端點（本地測試要 loopback 覆寫）' };
    try {
      const ping = await fetch(this.verifyUrl, { method: 'GET' });
      const probe = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: 'test', apikey: this.apikey, backendHash: this._sha256Hex(this.execUrl) })
      });
      const parsed = await probe.json();
      const ok = parsed && parsed.troop_known === true && parsed.key_ok === true && parsed.backend_matches === true;
      return {
        success: Boolean(ok), mode: 'callback', status: ping.status,
        verify_url_in_use: this.verifyUrl,
        probe: parsed || null,
        detail: ok ? '旅團已登記、後端一致，中央登入回打驗票可用。' : '旅團登記或後端網址唔一致'
      };
    } catch (error) {
      return { success: false, mode: 'callback', error: '連唔到驗票端點：' + String((error && error.message) || error) };
    }
  }

  _record(url, method) {
    this.calls.push({ url, method, at: Date.now() });
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  _tokenFor(ymis) {
    const token = 'gas_' + Math.random().toString(36).slice(2) + ymis;
    this.tokens.set(token, ymis);
    return token;
  }

  _validate(token) {
    return typeof token === 'string' && this.tokens.has(token) ? this.tokens.get(token) : null;
  }

  handleGet(url, res) {
    const u = new URL(url, 'http://127.0.0.1');
    const action = u.searchParams.get('action');
    this._record(u.pathname + u.search, 'GET');
    if (action === 'load') {
      const reqKey = u.searchParams.get('apikey');
      if (reqKey && reqKey !== this.apikey) {
        return this._json(res, 200, { success: false, error: 'Invalid API Key' });
      }
      const reqToken = u.searchParams.get('token');
      if (reqToken && !this._validate(reqToken)) {
        return this._json(res, 200, { success: false, error: 'Token 無效或過期' });
      }
      return this._json(res, 200, {
        success: true,
        troop: this.name,
        members: [...this.users.values()].map(({ ymis, name: n, email, role }) => ({ ymis, name: n, email, role })),
        progress: {},
        config: { member_progress_scope: 'private', allow_member_requests: 'true' }
      });
    }
    if (action === 'getLoginMode') return this._json(res, 200, { success: true, login_mode: 'standalone' });
    return this._json(res, 200, { success: false, error: 'Unknown action: ' + action });
  }

  async handlePost(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    this._record(url.pathname + url.search, 'POST');
    const action = body.action;

    if (action === 'setDownstreamAccess') {
      const isSig = Boolean(body.sig && body.sub && body.exp);
      if (!isSig) return this._json(res, 200, { success: false, code: 403, error: '未授權：只接受上游簽名驗證' });
      this.allowLocal = body.allowLocal === true || body.allowLocal === 'true';
      return this._json(res, 200, { success: true, allowLocal: this.allowLocal });
    }

    if (action === 'getDownstreamAccess') {
      return this._json(res, 200, { success: true, allowLocal: this.allowLocal !== false });
    }

    if (action === 'exportAll') {
      const users = [...this.users.values()].map(u => {
        const copy = { ...u };
        if (!body.include_hash) delete copy.password;
        return copy;
      });
      return this._json(res, 200, {
        success: true,
        meta: { unit: this.name, exportedAt: new Date().toISOString(), version: '1.0', sha256: 'mocksha', include_hash: Boolean(body.include_hash) },
        data: { users, members: users }
      });
    }

    if (action === 'upsertUser') {
      const u = body.user || body;
      const ymis = String(u.ymis || u.scout_id || '');
      this.users.set(ymis, { ymis, name: u.name || ymis, role: u.role || 'member', password: u.password || '1234' });
      return this._json(res, 200, { success: true, action: 'created', ymis });
    }

    if (action === 'setPw') {
      const u = this.users.get(body.ymis || body.sub);
      if (u) u.password = body.password_hash || body.new_password;
      return this._json(res, 200, { success: Boolean(u) });
    }

    if (action === 'setStatus') {
      return this._json(res, 200, { success: true });
    }

    if (action === 'verifyPw') {
      const u = this.users.get(body.ymis || body.sub);
      return this._json(res, 200, { success: Boolean(u), match: u ? (u.password === (body.password_hash || body.password)) : false });
    }

    if (action === 'login') {
      if (this.allowLocal === false && !body.isSuperAdmin) {
        return this._json(res, 200, { success: false, code: 403, error: '此進度追蹤系統已關閉直接登入，請經由支部／旅管理系統登入' });
      }
      const lid = String(body.login_id || '');
      const pw = String(body.password || '');
      let user = null;
      for (const u of this.users.values()) {
        if (u.ymis === lid || (u.email && u.email.toLowerCase() === lid.toLowerCase())) user = u;
      }
      if (!user) return this._json(res, 200, { success: false, error: '找不到此帳號' });
      if (user.password !== pw) return this._json(res, 200, { success: false, error: '密碼錯誤' });
      const token = this._tokenFor(user.ymis);
      return this._json(res, 200, {
        success: true,
        token,
        user: { ymis: user.ymis, name: user.name, email: user.email, role: user.role }
      });
    }

    if (action === 'logout') {
      if (body.token && this.tokens.has(body.token)) this.tokens.delete(body.token);
      return this._json(res, 200, { success: true });
    }

    // Central-login verifier configuration (mirrors Code.gs: a leader token,
    // and only a loopback endpoint may be stored — the live one is a constant).
    if (action === 'configureTrustedTicketVerifier' || action === 'testTrustedTicketVerifier') {
      if (!body.apikey || body.apikey !== this.apikey) {
        return this._json(res, 200, { success: false, error: '未授權' });
      }
      const cfgYmis = this._validate(body.token);
      const cfgUser = cfgYmis ? this.users.get(cfgYmis) : null;
      const roleLevel = { member: 0, branch_leader: 40, group_leader: 60, admin: 80, super_admin: 100 }[cfgUser ? cfgUser.role : ''] || 0;
      if (!cfgUser || roleLevel < 40) return this._json(res, 200, { success: false, error: '需領袖權限' });
      if (action === 'configureTrustedTicketVerifier') {
        const verifyUrl = String(body.verifyUrl || '').trim();
        const troopId = String(body.troopId || '').trim();
        if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(verifyUrl)) {
          return this._json(res, 200, { success: false, error: '線上驗票端點已固定為 Code.gs 常數；只有 loopback 可作本地覆寫' });
        }
        this.verifyUrl = verifyUrl;
        return this._json(res, 200, { success: true, troopId, loopback_override: true, verify_url_in_use: verifyUrl });
      }
      return this._json(res, 200, await this._probeVerifier());
    }

    // Central login: Vercel's sealed ticket must be redeemed by a real callback
    // to the verifier. The troop API key alone is no longer enough.
    if (action === 'superLogin') {
      const superUser = [...this.users.values()].find((u) => u.role === 'super_admin');
      if (!superUser || String(body.login_id) !== superUser.ymis) {
        return this._json(res, 200, { success: false, error: '登入失敗', code: 401, central: 'callback' });
      }
      const checked = await this._redeemTicket(String(body.super_ticket || ''), superUser.ymis);
      if (!checked.ok) {
        return this._json(res, 200, checked.infra
          ? { success: false, error: '中央登入驗票失敗：' + String(checked.detail || ''), code: 503, reason: 'central_verify_unreachable', central: 'callback' }
          : { success: false, error: '登入失敗', code: 401, central: 'callback' });
      }
      const token = this._tokenFor(superUser.ymis);
      return this._json(res, 200, {
        success: true,
        token,
        central: 'callback',
        user: { ymis: superUser.ymis, name: superUser.name, email: superUser.email, role: superUser.role }
      });
    }

    if (action === 'apply') {
      this.requests.push({
        app_id: 'APP' + (this.requests.length + 1),
        ymis: body.ymis || '',
        name: body.name || '',
        email: body.email || '',
        requested_role: body.requested_role || 'member',
        branch: body.branch || ''
      });
      return this._json(res, 200, { success: true, message: '申請已提交' });
    }

    // save / addMember style: apikey required (or valid token fallback)
    if (['save', 'addMember', 'addUser', 'bulkAddUsers', 'saveOtherBadge'].includes(action)) {
      const reqKey = body.apikey;
      if (reqKey && reqKey !== this.apikey) {
        return this._json(res, 200, { success: false, error: 'Invalid API Key' });
      }
      if (!reqKey && !this._validate(body.token)) {
        return this._json(res, 200, { success: false, error: '未授權 - 需 API Key 或有效 Token' });
      }
      if (action === 'save') {
        const changes = Array.isArray(body.changes) ? body.changes : [];
        return this._json(res, 200, { success: true, saved: changes.length, confirmer: body.confirmer || '' });
      }
      if (action === 'addMember') {
        if (this.users.has(String(body.ymis))) return this._json(res, 200, { success: false, error: '成員已存在' });
        this.users.set(String(body.ymis), {
          ymis: String(body.ymis),
          name: body.name || '',
          email: '',
          role: body.squad_role === 'leader' ? 'branch_leader' : 'member',
          status: 'active'
        });
        return this._json(res, 200, { success: true });
      }
      return this._json(res, 200, { success: true });
    }

    // token-gated actions
    const ymis = this._validate(body.token);
    if (!ymis) return this._json(res, 200, { success: false, error: 'Token 無效或過期' });
    const user = this.users.get(ymis);
    if (!user) return this._json(res, 200, { success: false, error: '找不到用戶' });

    switch (action) {
      case 'getConfig':
        return this._json(res, 200, {
          success: true,
          config: { member_progress_scope: 'private', allow_member_requests: 'true', allow_member_view_others: 'false', allow_squad_comparison: 'false' }
        });
      case 'getPendingRequests':
        return this._json(res, 200, { success: true, requests: this.requests.filter(r => r.status !== 'reviewed') });
      case 'reviewRequest':
        return this._json(res, 200, { success: true, reviewed: body.request_id, decision: body.decision });
      case 'getApplications':
        return this._json(res, 200, { success: true, applications: this.requests });
      case 'getAllUsers':
        return this._json(res, 200, {
          success: true,
          users: [...this.users.values()].map(({ ymis: y, name, email, role, status }) => ({ ymis: y, name, email, role, status }))
        });
      case 'resetPassword': {
        const target = this.users.get(String(body.target_ymis));
        if (!target) return this._json(res, 200, { success: false, error: '找不到成員' });
        target.password = String(body.new_password || '');
        return this._json(res, 200, { success: true });
      }
      case 'changePassword':
        return this._json(res, 200, { success: true });
      case 'getLogRequests':
        return this._json(res, 200, { success: true, requests: [] });
      default:
        return this._json(res, 200, { success: false, error: 'Unknown action: ' + action });
    }
  }

  listen(port) {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        this.handleGet(req.url, res);
      } else {
        parseBody(req)
          .then((body) => this.handlePost(req, res, body))
          .catch(() => this._json(res, 400, { success: false, error: 'bad json' }));
      }
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve(server);
      });
    });
  }
}

async function startMockGas(opts) {
  const mock = new MockGas(opts);
  await mock.listen(opts.port);
  return mock;
}

module.exports = { MockGas, startMockGas };
