'use strict';

const { getTroopConfig, isTrustedBackend } = require('../lib/registry');
const {
  centralSubject,
  passwordMatches,
  superConfigured,
  createSuperTicket,
  createBrowserSession,
  unwrapBrowserSession
} = require('../lib/super-auth');
const loginRateLimit = require('../lib/login-rate-limit');

const UPSTREAM_TIMEOUT_MS = 25_000;

function attachResponseHelpers(res) {
  if (!res.status) {
    res.status = function status(code) {
      res.statusCode = code;
      return res;
    };
  }
  if (!res.json) {
    res.json = function json(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return res;
    };
  }
}

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function parsePayload(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body || '{}');
  if (typeof body === 'object' && !Array.isArray(body)) return body;
  throw new Error('invalid request body');
}

function safeAction(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : '';
}

function sanitizeForwardPayload(payload, troopConfig) {
  const forward = { ...payload };
  delete forward.troopId;
  delete forward.troopKey;
  delete forward.troop;
  delete forward.backend;
  delete forward.apikey;
  delete forward.apiKey;
  delete forward.portalOrigin;
  delete forward.isSuperAdmin;
  delete forward.ticket;
  delete forward.bootstrap;
  // The API key is always added here, never taken from the browser.
  forward.apikey = troopConfig.apikey;
  return forward;
}

function logResult({ troopId, action, status, startedAt, success, central, centralFail }) {
  // Keep diagnostics useful without logging a password, ticket, API key,
  // backend URL, browser token, or request body.
  console.log(`[proxy] troop=${troopId} action=${action} status=${status} duration=${Date.now() - startedAt}ms success=${success} central=${central}${centralFail ? ` centralFail=${centralFail}` : ''}`);
}


// Reads go to Apps Script as a GET with the server-side key on the query
// string; writes and every other action are POSTed as before.
async function getUpstream(troopConfig, forwardPayload) {
  const target = new URL(troopConfig.backend);
  target.searchParams.set('action', 'load');
  if (forwardPayload.token) target.searchParams.set('token', forwardPayload.token);
  // ecportal v4.1.0：家長 sig bearer 可經 GET load 讀自己子女範圍
  // （exp 係 number，一併 stringify；簽名訊息由 GAS 端還原）
  for (const field of ['childId', 'sub', 'scope', 'exp', 'sig']) {
    const v = forwardPayload[field];
    if (v !== undefined && v !== null && v !== '') {
      target.searchParams.set(field, String(v));
    }
  }
  target.searchParams.set('apikey', troopConfig.apikey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function postUpstream(backend, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(backend, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Fixed server-side destination for the "new troop deployment" registration
// form (see the 新旅團部署 tab). The applicant's GAS URL and API key are
// forwarded to this admin inbox only; the browser never learns the destination
// and it is never accepted from the request. Leave unset to disable the form
// with a clear message instead of routing it to a troop backend.
const ADMIN_API_ENV = 'SCOUTBADGE_ADMIN_API';

function trustedAdminApi() {
  const raw = String(process.env[ADMIN_API_ENV] || '').trim();
  return raw && isTrustedBackend(raw) ? raw : null;
}

function clampText(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

async function handleRegistration(res, payload, startedAt) {
  const adminApi = trustedAdminApi();
  if (!adminApi) {
    logResult({ troopId: 'REG', action: 'submitContact', status: 503, startedAt, success: false, central: false });
    return fail(res, 503, '接入申請功能尚未啟用，請直接聯絡管理員');
  }
  const regPayload = {
    troopId: clampText(payload.troopId, 32),
    troopName: clampText(payload.troopName, 100),
    scriptUrl: clampText(payload.scriptUrl, 300),
    apiKey: clampText(payload.apiKey, 120),
    appType: 'scoutbadge',
    note: clampText(payload.note, 500)
  };
  if (!regPayload.troopId || !regPayload.scriptUrl || !regPayload.apiKey) {
    return fail(res, 400, '申請資料不完整');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(adminApi, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(regPayload),
      redirect: 'follow',
      signal: controller.signal
    });
    const raw = await upstream.text();
    let result = null;
    try { result = JSON.parse(raw); } catch (_) { /* non-JSON inbox response */ }
    if (!upstream.ok || !result || result.success !== true) {
      console.error(`[proxy] registration_upstream_bad status=${upstream.status}`);
      logResult({ troopId: 'REG', action: 'submitContact', status: 502, startedAt, success: false, central: false });
      return fail(res, 502, '申請未能送達管理員，請稍後重試');
    }
    logResult({ troopId: 'REG', action: 'submitContact', status: upstream.status, startedAt, success: true, central: false });
    return res.status(200).json({ success: true, message: '申請已提交' });
  } catch (error) {
    const timeoutHit = error && error.name === 'AbortError';
    console.error(`[proxy] registration_fetch_error timeout=${timeoutHit}`);
    logResult({ troopId: 'REG', action: 'submitContact', status: timeoutHit ? 504 : 502, startedAt, success: false, central: false });
    return fail(res, timeoutHit ? 504 : 502, timeoutHit ? '提交逾時，請稍後重試' : '申請未能送達管理員，請稍後重試');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  attachResponseHelpers(res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, '請求方法不被支援');
  }

  const startedAt = Date.now();
  let action = '';
  let troopId = '';
  let central = false;
  let centralSubjectId = null;

  try {
    const payload = parsePayload(req.body);
    troopId = typeof payload.troopId === 'string' || typeof payload.troopId === 'number'
      ? String(payload.troopId).trim().toUpperCase()
      : '';
    action = safeAction(payload.action);
    if (!troopId || !action) return fail(res, 400, '請求資料不完整');

    if (action === 'superLogin') return fail(res, 403, '未授權請求');
    // Registration applies to a troop that is NOT registered yet, so it must
    // be resolved before the registry lookup (the destination is fixed
    // server-side, never the troop's own backend).
    if (action === 'submitContact') return handleRegistration(res, payload, startedAt);

    const troopConfig = getTroopConfig(troopId);
    if (!troopConfig) return fail(res, 404, '找不到指定旅團');

    centralSubjectId = action === 'login' ? centralSubject(payload.login_id) : null;
    central = centralSubjectId !== null;
    let forwardPayload;

    if (central) {
      if (!loginRateLimit.allowed(req)) {
        return fail(res, 429, '登入嘗試次數過多，請稍後再試');
      }
      // A short or missing key is rejected locally. No request reaches GAS.
      if (!superConfigured()) {
        logResult({ troopId, action, status: 503, startedAt, success: false, central, centralFail: 'key_unset' });
        return fail(res, 503, '中央登入尚未設定（Vercel 環境變數 SUPER_KEY 未設定或太短），請聯絡管理員');
      }
      if (!passwordMatches(payload.password)) {
        // Only a wrong password is password guessing: count it.
        loginRateLimit.failed(req);
        logResult({ troopId, action, status: 401, startedAt, success: false, central, centralFail: 'password' });
        return fail(res, 401, '登入失敗');
      }

      // The password never leaves this function: what the troop backend gets is
      // a short-lived ticket sealed with SUPER_KEY, which only that leaf's
      // callback can redeem. The per-troop API key alone is no longer enough to
      // open a central session (that was the parked one-way release).
      const superTicket = createSuperTicket({
        troopId: troopConfig.id,
        backend: troopConfig.backend,
        apikey: troopConfig.apikey,
        loginId: centralSubjectId
      });
      forwardPayload = {
        action: 'superLogin',
        login_id: centralSubjectId,
        apikey: troopConfig.apikey,
        super_ticket: superTicket
      };
    } else {
      forwardPayload = sanitizeForwardPayload(payload, troopConfig);
      // The verifier bootstrap always targets the routed troop itself; the
      // sanitiser stripped the routing key, so hand it back explicitly.
      if (action === 'configureTrustedTicketVerifier') {
        forwardPayload.troopId = troopConfig.id;
      }
      if (typeof forwardPayload.token === 'string' && forwardPayload.token) {
        const session = unwrapBrowserSession(forwardPayload.token, {
          troopId: troopConfig.id,
          backend: troopConfig.backend,
          apikey: troopConfig.apikey
        });
        if (!session.valid) return fail(res, 401, '登入狀態無效或已過期');
        forwardPayload.token = session.gasToken;
      }
    }

    let upstream = action === 'load'
      ? await getUpstream(troopConfig, forwardPayload)
      : await postUpstream(troopConfig.backend, forwardPayload);

    let raw = await upstream.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (_) {
      console.error(`[proxy] upstream_non_json troop=${troopId} action=${action} status=${upstream.status}`);
      return fail(res, 502, '後端服務暫時無法使用，請稍後再試');
    }

    if (central) {
      if (!result || result.success !== true || typeof result.token !== 'string' || !result.token) {
        // Only a leaf that answers with the callback tag is a current build;
        // everything else cannot redeem a ticket and needs a redeploy.
        if (!result || result.central !== 'callback') {
          logResult({ troopId, action, status: 409, startedAt, success: false, central, centralFail: 'backend_not_updated' });
          return fail(res, 409, '旅團後端仍未支援中央登入回打驗票（舊版單向授權已停用）：請覆寫 apps-script/Code.gs，再到「部署 → 管理部署作業」為既有 Web App 建立新版本。');
        }
        if (result.reason === 'central_verify_unreachable') {
          logResult({ troopId, action, status: 503, startedAt, success: false, central, centralFail: 'verify_unreachable' });
          return fail(res, 503, String(result.error || '中央登入驗票端點暫時連不上，請稍後再試'));
        }
        logResult({
          troopId,
          action,
          status: upstream.status,
          startedAt,
          success: false,
          central,
          centralFail: 'ticket'
        });
        // Wrong, expired, replayed, or minted for someone else: one answer.
        return fail(res, 401, '登入失敗');
      }
      loginRateLimit.succeeded(req);
      result = {
        ...result,
        token: createBrowserSession({
          gasToken: result.token,
          troopId: troopConfig.id,
          backend: troopConfig.backend,
          apikey: troopConfig.apikey
        })
      };
    }

    logResult({
      troopId,
      action,
      status: upstream.status,
      startedAt,
      success: result && result.success !== false,
      central
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.error(`[proxy] upstream_timeout troop=${troopId || 'unknown'} action=${action || 'unknown'} duration=${Date.now() - startedAt}ms`);
      return fail(res, 504, '後端服務連線逾時，請稍後再試');
    }
    // Do not expose configuration, fetch, or parsing details to the browser.
    console.error(`[proxy] request_error troop=${troopId || 'unknown'} action=${action || 'unknown'} message=${error && error.message ? error.message : 'unknown'}`);
    return fail(res, 500, '服務暫時無法使用，請稍後再試');
  }
};
