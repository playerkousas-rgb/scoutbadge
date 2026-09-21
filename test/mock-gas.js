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
  constructor({ name, apikey, users, execUrl }) {
    this.name = name;
    this.apikey = apikey;
    this.execUrl = execUrl || 'http://127.0.0.1:0/exec';
    this.users = new Map(); // ymis -> { ymis, name, email, role, password, status }
    this.tokens = new Map(); // token -> ymis
    for (const u of users) this.users.set(u.ymis, { ...u, status: 'active' });
    this.requests = [];
    this.calls = [];
    // Mirrors the GAS script properties set by configureTrustedTicketVerifier.
    this.authProps = null; // { verifyUrl, troopId, backendHash }
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

  _validBootstrap(bootstrap, verifyUrl, troopId) {
    if (!bootstrap || !verifyUrl || !troopId) return false;
    const parts = String(bootstrap).split('.');
    if (parts.length !== 2) return false;
    const exp = Number(parts[0]);
    if (!Number.isFinite(exp) || exp <= 0) return false;
    const nowS = Math.floor(Date.now() / 1000);
    if (exp < nowS - 60 || exp > nowS + 600) return false;
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', this.apikey)
      .update(`${String(verifyUrl)}|${String(troopId)}|${parts[0]}`, 'utf8')
      .digest('hex');
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(String(parts[1] || '').trim().toLowerCase(), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
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

    if (action === 'login') {
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

    // Central-login verifier bootstrap (mirrors Code.gs: apikey + leader token).
    if (action === 'configureTrustedTicketVerifier' || action === 'testTrustedTicketVerifier') {
      if (!body.apikey || body.apikey !== this.apikey) {
        return this._json(res, 200, { success: false, error: '未授權' });
      }
      // Mirrors Code.gs: either a leader token, or the short-lived bootstrap
      // the proxy signs with this troop's own API key (only issued after the
      // central password matched). A browser has no API key and cannot forge it.
      const bootOk = this._validBootstrap(body.bootstrap, body.verifyUrl, body.troopId);
      const cfgYmis = this._validate(body.token);
      const cfgUser = bootOk ? { role: 'admin' } : (cfgYmis ? this.users.get(cfgYmis) : null);
      const roleLevel = { member: 0, branch_leader: 40, group_leader: 60, admin: 80, super_admin: 100 }[cfgUser ? cfgUser.role : ''] || 0;
      if (!cfgUser || roleLevel < 40) return this._json(res, 200, { success: false, error: '需領袖權限' });
      if (action === 'configureTrustedTicketVerifier') {
        const verifyUrl = String(body.verifyUrl || '').trim();
        const troopId = String(body.troopId || '').trim();
        if (!/^https?:\/\//i.test(verifyUrl) || !troopId) return this._json(res, 200, { success: false, error: '設定資料無效' });
        const crypto = require('crypto');
        this.authProps = {
          verifyUrl,
          troopId,
          backendHash: crypto.createHash('sha256').update(this.execUrl).digest('hex')
        };
        return this._json(res, 200, { success: true, troopId });
      }
      if (!this.authProps) return this._json(res, 200, { success: false, error: '尚未設定驗證端點' });
      try {
        const response = await fetch(this.authProps.verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: 'test', troopId: this.authProps.troopId, backendHash: this.authProps.backendHash })
        });
        // Mirrors Code.gs: the probe must answer on HTTP 200 and confirm both
        // the troop registration and the backend hash — a bare status code is
        // not proof that central login will work.
        let probe = null;
        try { probe = await response.json(); } catch (_) { probe = null; }
        const healthy = response.status === 200 && Boolean(probe) &&
          probe.probe === true && probe.troop_known === true && probe.backend_matches === true;
        return this._json(res, 200, {
          success: healthy,
          status: response.status,
          detail: healthy ? '旅團已登記、後端一致，中央登入可用。' : '驗證端點自我檢查未通過。'
        });
      } catch (err) {
        return this._json(res, 200, { success: false, error: '連唔上驗證端點' });
      }
    }

    // Central super login: verify the proxy-signed ticket via the configured
    // verifier callback, exactly like Code.gs handleSuperLoginTicket.
    if (action === 'superLogin') {
      const superUser = [...this.users.values()].find((u) => u.role === 'super_admin');
      if (!superUser || String(body.login_id) !== superUser.ymis) {
        return this._json(res, 200, { success: false, error: '登入失敗' });
      }
      if (String(body.apikey) !== this.apikey) return this._json(res, 200, { success: false, error: '登入失敗' });
      // Mirrors Code.gs: an unconfigured verifier is reported as 409 with a
      // reason, which is what lets the proxy open the troop itself.
      if (!this.authProps) {
        return this._json(res, 200, { success: false, code: 409, reason: 'central_verifier_not_configured', error: '中央登入尚未設定' });
      }
      let valid = false;
      try {
        const response = await fetch(this.authProps.verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticket: String(body.ticket),
            troopId: this.authProps.troopId,
            backendHash: this.authProps.backendHash,
            loginId: superUser.ymis
          })
        });
        if (response.status === 200) {
          const out = await response.json();
          valid = out && out.valid === true;
        }
      } catch (_) { valid = false; }
      if (!valid) return this._json(res, 200, { success: false, error: '登入失敗' });
      const token = this._tokenFor(superUser.ymis);
      return this._json(res, 200, {
        success: true,
        token,
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
