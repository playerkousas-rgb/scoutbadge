'use strict';

const { getTroopConfig } = require('../lib/registry');
const {
  isCentralLoginAttempt,
  passwordMatches,
  superConfigured,
  ticketReady,
  sessionReady,
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
  // The API key is always added here, never taken from the browser.
  forward.apikey = troopConfig.apikey;
  return forward;
}

function logResult({ troopId, action, status, startedAt, success, central }) {
  // Keep diagnostics useful without logging a password, ticket, API key,
  // backend URL, browser token, or request body.
  console.log(`[proxy] troop=${troopId} action=${action} status=${status} duration=${Date.now() - startedAt}ms success=${success} central=${central}`);
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

  try {
    const payload = parsePayload(req.body);
    troopId = typeof payload.troopId === 'string' || typeof payload.troopId === 'number'
      ? String(payload.troopId).trim().toUpperCase()
      : '';
    action = safeAction(payload.action);
    if (!troopId || !action) return fail(res, 400, '請求資料不完整');

    const troopConfig = getTroopConfig(troopId);
    if (!troopConfig) return fail(res, 404, '找不到指定旅團');
    if (action === 'superLogin') return fail(res, 403, '未授權請求');

    central = action === 'login' && isCentralLoginAttempt(payload.login_id);
    let forwardPayload;

    if (central) {
      // A short or missing key is rejected locally. No request reaches GAS.
      if (!superConfigured() || !ticketReady() || !sessionReady()) {
        return fail(res, 503, '登入服務暫時無法使用，請聯絡管理員');
      }
      if (!loginRateLimit.allowed(req)) {
        return fail(res, 429, '登入嘗試次數過多，請稍後再試');
      }
      if (!passwordMatches(payload.password)) {
        loginRateLimit.failed(req);
        return fail(res, 401, '登入失敗');
      }

      forwardPayload = {
        action: 'superLogin',
        ticket: createSuperTicket({ troopId: troopConfig.id, backend: troopConfig.backend }),
        apikey: troopConfig.apikey
      };
    } else {
      forwardPayload = sanitizeForwardPayload(payload, troopConfig);
      if (typeof forwardPayload.token === 'string' && forwardPayload.token) {
        const session = unwrapBrowserSession(forwardPayload.token, {
          troopId: troopConfig.id,
          backend: troopConfig.backend
        });
        if (!session.valid) return fail(res, 401, '登入狀態無效或已過期');
        forwardPayload.token = session.gasToken;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      if (action === 'load') {
        const target = new URL(troopConfig.backend);
        target.searchParams.set('action', 'load');
        if (forwardPayload.token) target.searchParams.set('token', forwardPayload.token);
        target.searchParams.set('apikey', troopConfig.apikey);
        upstream = await fetch(target, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'follow',
          signal: controller.signal
        });
      } else {
        upstream = await fetch(troopConfig.backend, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(forwardPayload),
          redirect: 'follow',
          signal: controller.signal
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const raw = await upstream.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (_) {
      console.error(`[proxy] upstream_non_json troop=${troopId} action=${action} status=${upstream.status}`);
      return fail(res, 502, '後端服務暫時無法使用，請稍後再試');
    }

    if (central) {
      if (!result || result.success !== true || typeof result.token !== 'string' || !result.token) {
        loginRateLimit.failed(req);
        logResult({ troopId, action, status: upstream.status, startedAt, success: false, central });
        return fail(res, 401, '登入失敗');
      }
      loginRateLimit.succeeded(req);
      result = {
        ...result,
        token: createBrowserSession({
          gasToken: result.token,
          troopId: troopConfig.id,
          backend: troopConfig.backend
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
