'use strict';

const { getTroopConfig, isTrustedBackend, canonicalBackendUrl } = require('../lib/registry');
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

// 密碼相關 action 要等後端做 PBKDF2 核對。GS 6.2.0／6.3.0 寫入的舊雜湊
// （pbkdf2$120000$）在 Apps Script 上要 20–40 秒（每次 HMAC 都要過 JS↔Java
// 邊界），用 25 秒上限就會令所有密碼登入回 504「後端服務連線逾時」——中央
// sheep 登入免密碼核對，所以會出現「超管入得、一般帳號入唔到」。
// GS 6.4.0 起新雜湊只需 1–3 秒；這個較長上限只為「舊雜湊第一次登入」留一次
// 機會（成功後後端會把該帳號改寫成新雜湊，之後即回復正常速度）。
// Vercel 這個 function 的 maxDuration 是 60 秒（vercel.json）。
const PASSWORD_TIMEOUT_MS = 45_000;
const PASSWORD_ACTIONS = new Set([
  'login',
  'setPw',
  'verifyPw',
  'changePassword',
  'resetPassword',
  'confirmPasswordReset',
  'addUser',
  'bulkAddUsers',
  'importUsers',
  'importAll',
  'upsertUser'
]);

function upstreamTimeoutMs(action) {
  return PASSWORD_ACTIONS.has(action) ? PASSWORD_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
}

// 公開入口白名單（未登入可呼叫；其中忘記密碼兩個 action 會強制剝除任何 token／自報身分欄位）
const PUBLIC_ACTIONS = new Set([
  'login',
  'apply',
  'logout',
  'requestPasswordReset',
  'confirmPasswordReset',
  'load',
  'ecStatus',
  'health',
  'healthCheck',
  'getLoginMode',
  'getAllowLocalLogin',
  'getMembers',
  'getConfig',
  'getOtherBadges',
  'getRegistrySafe',
  'portalLogin'
]);

const PASSWORD_RESET_PUBLIC_ACTIONS = new Set([
  'requestPasswordReset',
  'confirmPasswordReset'
]);

// 需憑證（session token 或上游／家長 HMAC 簽章）方可操作的後端 action 白名單
const AUTH_ACTIONS = new Set([
  'save',
  'saveOtherBadge',
  'requestComplete',
  'reviewRequest',
  'addMember',
  'addUser',
  'bulkAddUsers',
  'upsertUser',
  'importUsers',
  'importAll',
  'exportUsers',
  'exportAll',
  'resetPassword',
  'changePassword',
  'setPw',
  'verifyPw',
  'setStatus',
  'deactivateUser',
  'updateUserRole',
  'updatePermissions',
  'updateConfig',
  'getAllUsers',
  'getPendingRequests',
  'getApplications',
  'reviewApplication',
  'getApprovalHistory',
  'getAuditLog',
  'addServiceRecord',
  'getServiceRecords',
  'getLogRecords',
  'getLogRequests',
  'saveLogRecord',
  'deleteLogRecord',
  'requestLogRecord',
  'cancelLogRequest',
  'reviewLogRequest',
  'getLinkState',
  'setLocalLogin',
  'setAllowLocalLogin',
  'getDownstreamAccess',
  'setDownstreamAccess',
  'checkSheets',
  'diagnose',
  'diagnoseSheets',
  'repairSheets',
  'rebootServer',
  'configureTrustedTicketVerifier',
  'testTrustedTicketVerifier'
]);

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


// True when Google answered the upstream request with its sign-in page
// instead of running the web app (deployment access is not 「任何人」).
// The post-redirect response URL is the reliable signal; body markers are
// a fallback for environments whose fetch does not expose it.
function looksLikeGoogleSignIn(upstream, raw) {
  const finalUrl = String((upstream && upstream.url) || '');
  if (/(^|\/\/)accounts\.google\.com(\/|$)/.test(finalUrl)) return true;
  const head = String(raw || '').slice(0, 4096);
  return /accounts\.google\.com|ServiceLogin|signin\/identifier/.test(head);
}

// A deployment that is not published to 「任何人」 — or a deployment that no
// longer exists — answers an anonymous request with Google's Drive error page
// ("Sorry, unable to open the file at this time"), not a sign-in form. This is
// the shape a school Workspace deployment takes when the domain forbids public
// publishing, so it must be named rather than reported as a generic outage.
function looksLikeDriveUnavailable(upstream, raw) {
  const finalUrl = String((upstream && upstream.url) || '');
  if (/(^|\/\/)drive\.google\.com(\/|$)/.test(finalUrl)) return true;
  const head = String(raw || '').slice(0, 8192);
  return /unable to open the file at this time|drive\.google\.com\/start\/apps|無法開啟這個檔案|目前無法開啟/i.test(head);
}

// Registration-time reachability probe. The applicant's deployment is only
// usable by this proxy when an anonymous GET gets JSON back: a Workspace
// deployment restricted to the domain (the /a/macros/<domain>/… form) never
// will, and finding that out at approval time wastes an admin round trip.
// ecStatus is deliberately unauthenticated (Code.gs answers it before the
// auth gate) and cheap, so it doubles as a liveness check for any build.
const PROBE_TIMEOUT_MS = 12_000;

async function probeAnonymousBackend(backend) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const target = new URL(canonicalBackendUrl(backend));
    target.searchParams.set('action', 'ecStatus');
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    const raw = await upstream.text();
    if (looksLikeGoogleSignIn(upstream, raw)) return { verdict: 'signin', status: upstream.status };
    if (looksLikeDriveUnavailable(upstream, raw)) return { verdict: 'restricted', status: upstream.status };
    if (upstream.status === 404) return { verdict: 'not_found', status: 404 };
    if (upstream.status < 200 || upstream.status >= 300) return { verdict: 'http_error', status: upstream.status };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { /* not a JSON build */ }
    if (!parsed || typeof parsed !== 'object') return { verdict: 'not_json', status: upstream.status };
    // ecStatus also reports whether initializeSheets() has run for this build;
    // a backend without its sheets cannot accept a single login yet.
    return {
      verdict: 'ok',
      status: upstream.status,
      gsVersion: String(parsed.gsVersion || ''),
      initRequired: parsed.initRequired === true,
      initializedGsVersion: String(parsed.initializedGsVersion || '')
    };
  } catch (error) {
    return { verdict: error && error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timeout);
  }
}

// Blocking verdicts are permanent for this caller: retrying the same URL can
// never succeed, so the application is refused with the fix in the message.
const REGISTRATION_BLOCKING = {
  signin: '後端要求 Google 登入，無法匿名存取：請喺 Apps Script「部署 → 管理部署作業 → ✏️」把「執行身分」設為「我」、「可存取」設為「任何人」，儲存後用新網址重新提交（API Key 不變）。',
  restricted: '後端未開放匿名存取（Google 回覆「無法開啟檔案」）：通常係部署只限網域內使用（網址帶 /a/macros/<學校域名>/），或該部署已刪除。請設為「任何人」重新部署；學校 Google Workspace 帳戶如被管理員限制公開發佈，請改用個人 Google 帳戶部署，或請學校 IT 開啟權限。',
  not_found: '找不到這個部署（HTTP 404）：請由 Apps Script「部署 → 管理部署作業」複製現行 Web App 的 /exec 網址（不要用 /dev 或已刪除的部署）。'
};

// Reads go to Apps Script as a GET with the server-side key on the query
// string; writes and every other action are POSTed as before. Upstream
// requests always use the canonical /macros/ URL form: a Workspace
// domain-scoped registration (/a/macros/<domain>/…) would force a Google
// sign-in the proxy cannot perform. The registered string itself is never
// rewritten — tickets and sessions stay bound to it (see registry).
async function getUpstream(troopConfig, forwardPayload, action, timeoutMs) {
  const target = new URL(canonicalBackendUrl(troopConfig.backend));
  target.searchParams.set('action', action || 'load');
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
  const timeout = setTimeout(() => controller.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);
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

async function postUpstream(backend, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(canonicalBackendUrl(backend), {
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

// 統一回報（問題回報／意見回饋）固定送往 Scout Admin 的統一收件端（統一回報
// 格式 v1，與 widget.js 同一接收端）。SCOUTBADGE_ADMIN_API 可覆蓋；不設定就
// 用 widget 內建的公開端點，令回報功能不需額外配置也能用。瀏覽器不能指定或
// 讀取這個目的地。送出結果以 deliveryStatus 表達：confirmed（收件系統確認收
// 到）／rejected（收件系統明確未接收）／unknown（送出後未能確認，可能已收）
// ／not_sent（驗證失敗或服務未配置，確定沒有送出）。
const FEEDBACK_API_DEFAULT =
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

function feedbackInboxApi() {
  const raw = String(process.env[ADMIN_API_ENV] || FEEDBACK_API_DEFAULT).trim();
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
  // Scout Admin's Apps Script contract uses type=apply, backendUrl, and
  // responds with { status: 'success' }. Adapt the browser-facing ScoutBadge
  // payload here so the frontend contract can remain unchanged.
  //
  // The note is tagged with an app marker so Scout Admin can attribute an
  // incoming application to ScoutBadge even when the applicant leaves the
  // note blank. Older applications keep their original note; Scout Admin
  // renders them as unlabelled.
  const note = clampText(payload.note, 500);
  const taggedNote = note
    ? (note.toLowerCase().startsWith('[scoutbadge]') ? note : `[scoutbadge] ${note}`)
    : '[scoutbadge]';

  const regPayload = {
    type: 'apply',
    troopId: clampText(payload.troopId, 32),
    troopName: clampText(payload.troopName, 100),
    backendUrl: clampText(payload.scriptUrl, 300),
    apiKey: clampText(payload.apiKey, 120),
    appType: 'scoutbadge',
    note: taggedNote
  };
  if (!regPayload.troopId || !regPayload.backendUrl || !regPayload.apiKey) {
    return fail(res, 400, '申請資料不完整');
  }
  // Only Apps Script web-app URLs are ever registered (registry.js enforces
  // the same rule), so refuse anything else before probing — that also keeps
  // this public entry point from fetching a host of the caller's choosing.
  if (!isTrustedBackend(regPayload.backendUrl)) {
    logResult({ troopId: 'REG', action: 'submitContact', status: 400, startedAt, success: false, central: false });
    return fail(res, 400, '請提供 Apps Script Web App 的 https://script.google.com/…/exec 網址');
  }

  // Prove the deployment answers anonymously *before* the application reaches
  // the admin: a domain-restricted (school Workspace) deployment is permanently
  // unusable here and looks identical to a valid one from the browser.
  const probe = await probeAnonymousBackend(regPayload.backendUrl);
  const blockingMessage = REGISTRATION_BLOCKING[probe.verdict];
  if (blockingMessage) {
    console.error(`[proxy] registration_backend_unusable verdict=${probe.verdict} status=${probe.status || 0}`);
    logResult({ troopId: 'REG', action: 'submitContact', status: 422, startedAt, success: false, central: false });
    return fail(res, 422, blockingMessage);
  }
  // Anything inconclusive (cold start, timeout, transient 5xx, a non-JSON
  // build) must not block a legitimate application; the admin still checks.
  if (probe.verdict !== 'ok') {
    console.error(`[proxy] registration_probe_inconclusive verdict=${probe.verdict} status=${probe.status || 0}`);
  }
  // A build that has never had initializeSheets() run has no Users sheet, so
  // every login would fail. Catch it here instead of after approval: the
  // applicant's own Sheet is the only place the one-time fix can happen.
  if (probe.verdict === 'ok' && probe.initRequired && !probe.initializedGsVersion) {
    console.error(`[proxy] registration_backend_uninitialized gs=${probe.gsVersion || 'unknown'}`);
    logResult({ troopId: 'REG', action: 'submitContact', status: 422, startedAt, success: false, central: false });
    return fail(res, 422, '後端未完成初始化：請喺 Apps Script 執行一次 initializeSheets()（選單「🔗 旅系統 → 🔧 初始化／更新」，或編輯器直接執行 initializeSheets），見到「初始化完成」後用同一條網址重新提交。此動作只會補建缺少的工作表及預設管理員，不會刪改既有資料。');
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
    const accepted = !!result && (result.success === true || result.status === 'success');
    if (!upstream.ok || !accepted) {
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

// 統一回報格式 v1（與 Scout Admin widget 相同欄位）：name／contact／troopId
// 一律選填（可匿名）。前端依 deliveryStatus 決定顯示「已確認收到／未接收／
// 未能確認」，避免把「已送出請求」誤當「已完成傳送」。
async function handleFeedback(res, payload, startedAt) {
  const inbox = feedbackInboxApi();
  if (!inbox) {
    logResult({ troopId: 'FB', action: 'submitFeedback', status: 500, startedAt, success: false, central: false });
    return res.status(500).json({ success: false, deliveryStatus: 'not_sent', error: '回報服務暫時無法使用，請稍後重試' });
  }
  const type = clampText(payload.type, 20).toLowerCase();
  if (type !== 'issue' && type !== 'feedback') {
    return res.status(400).json({ success: false, deliveryStatus: 'not_sent', error: '回報類型不正確' });
  }
  const safeText = (value, limit) => {
    const text = clampText(value, limit);
    return /^[=+\-@]/.test(text) ? "'" + text : text;
  };
  const troopIdRaw = clampText(payload.troopId, 32);
  const troopId = /^[0-9A-Za-z_-]{1,32}$/.test(troopIdRaw) ? troopIdRaw : '';
  const common = {
    type,
    sourceApp: '進度追蹤',
    troopId,
    name: safeText(payload.name, 80),
    contact: safeText(payload.contact, 120)
  };
  let body;
  if (type === 'issue') {
    const title = clampText(payload.title, 120);
    const desc = clampText(payload.desc, 2000);
    if (!title || !desc) {
      return res.status(400).json({ success: false, deliveryStatus: 'not_sent', error: '請簡單寫下問題及需要的協助' });
    }
    const severity = ['低', '中', '高', '緊急'].includes(String(payload.severity || ''))
      ? String(payload.severity)
      : '中';
    body = { ...common, title: safeText(title, 120), desc: safeText(desc, 2000), severity };
  } else {
    const content = clampText(payload.content, 2000);
    if (content.length < 5) {
      return res.status(400).json({ success: false, deliveryStatus: 'not_sent', error: '請簡單描述你的意見' });
    }
    const fbType = ['建議', '讚', '批評', '其他'].includes(String(payload.fbType || ''))
      ? String(payload.fbType)
      : '建議';
    body = { ...common, fbType, content: safeText(content, 2000) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(inbox, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: controller.signal
    });
    const raw = await upstream.text();
    let result = null;
    try { result = JSON.parse(raw); } catch (_) { /* non-JSON inbox response */ }
    // 收件端回應格式可能係 {status:'success'} 或 {success:true}；兩者都接納。
    const confirmed = !!result && typeof result === 'object' &&
      (result.status === 'success' || result.success === true);
    if (confirmed) {
      logResult({ troopId: 'FB', action: 'submitFeedback', status: upstream.status, startedAt, success: true, central: false });
      return res.status(200).json({ success: true, deliveryStatus: 'confirmed', message: '已送出並確認收到' });
    }
    if (result && typeof result === 'object') {
      console.error(`[proxy] feedback_inbox_rejected status=${upstream.status}`);
      logResult({ troopId: 'FB', action: 'submitFeedback', status: 502, startedAt, success: false, central: false });
      return res.status(502).json({ success: false, deliveryStatus: 'rejected', error: '收件系統未有接收這次回報，請稍後再試' });
    }
    console.error(`[proxy] feedback_inbox_bad_response status=${upstream.status}`);
    logResult({ troopId: 'FB', action: 'submitFeedback', status: 502, startedAt, success: false, central: false });
    return res.status(502).json({ success: false, deliveryStatus: 'unknown', error: '暫時未能確認回報是否送達' });
  } catch (error) {
    const timeoutHit = error && error.name === 'AbortError';
    console.error(`[proxy] feedback_send_error timeout=${timeoutHit}`);
    logResult({ troopId: 'FB', action: 'submitFeedback', status: timeoutHit ? 504 : 502, startedAt, success: false, central: false });
    return res.status(timeoutHit ? 504 : 502).json({ success: false, deliveryStatus: 'unknown', error: '暫時未能確認回報是否送達' });
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
    if (!action) return fail(res, 400, '請求資料不完整');
    // 統一回報可匿名、未揀旅團都可送出（其餘 action 一律要有旅團編號）。
    if (action === 'submitFeedback') return handleFeedback(res, payload, startedAt);
    if (!troopId) return fail(res, 400, '請求資料不完整');

    if (action === 'superLogin') return fail(res, 403, '未授權請求');
    // Registration applies to a troop that is NOT registered yet, so it must
    // be resolved before the registry lookup (the destination is fixed
    // server-side, never the troop's own backend).
    if (action === 'submitContact') return handleRegistration(res, payload, startedAt);
    if (!PUBLIC_ACTIONS.has(action) && !AUTH_ACTIONS.has(action)) {
      return fail(res, 400, '不支援的請求動作');
    }

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
      if (PASSWORD_RESET_PUBLIC_ACTIONS.has(action)) {
        // 公開重設入口絕不轉發任何 token、角色、on_behalf 或簽名欄位
        delete forwardPayload.token;
        delete forwardPayload.role;
        delete forwardPayload.on_behalf;
        delete forwardPayload.on_behalf_role;
        delete forwardPayload.sig;
        delete forwardPayload.sig_ts;
        delete forwardPayload.sig_nonce;
        delete forwardPayload.sub;
        delete forwardPayload.scope;
        delete forwardPayload.exp;
      }
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

    const timeoutMs = upstreamTimeoutMs(action);
    let upstream = (action === 'load' || action === 'ecStatus')
      ? await getUpstream(troopConfig, forwardPayload, action, timeoutMs)
      : await postUpstream(troopConfig.backend, forwardPayload, timeoutMs);

    let raw = await upstream.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (_) {
      // A deployment whose access is not 「任何人」 never reaches Code.gs:
      // Google answers with its sign-in page instead. School Google
      // Workspace accounts hit this when the admin policy blocks external
      // publishing (or when access is 「<域名> 內任何人」/「任何 Google
      // 帳戶」rather than 「任何人」), and retrying can never fix it — so
      // name the cause and the remedy. Any other non-JSON upstream keeps
      // the generic 502 and leaks nothing about the backend.
      if (looksLikeGoogleSignIn(upstream, raw)) {
        console.error(`[proxy] upstream_signin_wall troop=${troopId} action=${action} status=${upstream.status}`);
        return fail(res, 502, '旅團後端要求 Google 登入，伺服器無法匿名存取：請喺 Apps Script「部署 → 管理部署作業」將存取權設為「任何人」並建立新版本；學校 Google Workspace 帳戶如被管理員政策限制對外發佈，請改用非學校 Google 帳戶部署該旅團後端');
      }
      // Same root cause, different page: a domain-only (or deleted) deployment
      // reaches Chrome as Drive's "unable to open the file" page.
      if (looksLikeDriveUnavailable(upstream, raw)) {
        console.error(`[proxy] upstream_restricted_wall troop=${troopId} action=${action} status=${upstream.status}`);
        return fail(res, 502, '旅團後端未開放匿名存取（Google 回覆「無法開啟檔案」）：通常係部署只限網域內使用（網址帶 /a/macros/學校域名/）或該部署已刪除。請喺 Apps Script「部署 → 管理部署作業」將存取權設為「任何人」並建立新版本；學校 Google Workspace 帳戶如被管理員限制公開發佈，請改用個人 Google 帳戶部署該旅團後端');
      }
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
      console.error(`[proxy] upstream_timeout troop=${troopId || 'unknown'} action=${action || 'unknown'} limit=${upstreamTimeoutMs(action)}ms duration=${Date.now() - startedAt}ms`);
      return fail(res, 504, '後端服務連線逾時，請稍後再試');
    }
    // Do not expose configuration, fetch, or parsing details to the browser.
    console.error(`[proxy] request_error troop=${troopId || 'unknown'} action=${action || 'unknown'} message=${error && error.message ? error.message : 'unknown'}`);
    return fail(res, 500, '服務暫時無法使用，請稍後再試');
  }
};

module.exports.PUBLIC_ACTIONS = PUBLIC_ACTIONS;
module.exports.AUTH_ACTIONS = AUTH_ACTIONS;
// Exported for unit tests: registration-time reachability classification.
module.exports.looksLikeGoogleSignIn = looksLikeGoogleSignIn;
module.exports.looksLikeDriveUnavailable = looksLikeDriveUnavailable;
module.exports.probeAnonymousBackend = probeAnonymousBackend;
