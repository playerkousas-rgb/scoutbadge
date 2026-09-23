'use strict';

const crypto = require('crypto');

const TICKET_PREFIX = 'sbt1';
const SESSION_PREFIX = 'sbs1';
// A callback ticket lives one minute: long enough for the browser round trip,
// short enough to stay well inside the leaf's 120 s replay cache (a ticket that
// outlives its cache entry could be replayed).
const TICKET_TTL_MS = 60 * 1000;
// Match the existing GAS token lifetime so the upgrade does not shorten normal sessions.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Vercel environment values are frequently pasted with a trailing space or a
// newline. Trim once, here, so every function (and both serverless entry
// points) derives the same key material; an invisible whitespace difference
// used to turn every central login into an opaque 「登入失敗」.
function configuredKey() {
  const raw = process.env.SUPER_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

function superConfigured() {
  return configuredKey().length >= 4;
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordMatches(input) {
  const provided = String(input === undefined || input === null ? '' : input).trim();
  return superConfigured() && equalText(provided, configuredKey());
}

// The normal UI accepts a 10-digit member ID or an email address. The central
// identifier is intentionally not duplicated outside GAS, so Vercel only
// treats a compact non-email identifier as a central-login candidate. GAS
// remains the authoritative identity check before it creates a session.
// The pre-#18 central account also answered to the legacy e-mail style alias,
// so old bookmarks must still reach the central path instead of falling
// through to GAS and failing with 「找不到此帳號」.
const LEGACY_SUPER_ALIAS = /^([A-Za-z][A-Za-z0-9_-]{0,63})@scoutbadge\.local$/i;

// Returns the identifier GAS should treat as the central subject, or null when
// the supplied id belongs to a normal troop account.
function centralSubject(loginId) {
  const id = String(loginId === undefined || loginId === null ? '' : loginId).trim();
  if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && !/^L\d+$/i.test(id)) return id;
  const alias = LEGACY_SUPER_ALIAS.exec(id);
  return alias ? alias[1] : null;
}

function isCentralLoginCandidate(loginId) {
  return centralSubject(loginId) !== null;
}

function keyFor(purpose, troopApiKey) {
  const key = configuredKey();
  if (!key || typeof troopApiKey !== 'string' || !troopApiKey) return null;
  // The per-troop server-only API key adds entropy without requiring another
  // deployment variable, and keeps browser sessions bound to one troop.
  return crypto.createHmac('sha256', key)
    .update(`scoutbadge:${purpose}:${troopApiKey}`, 'utf8')
    .digest();
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64url(value) {
  return Buffer.from(value, 'base64url');
}

function sealWithKey(key, prefix, payload) {
  if (!key) throw new Error('secure envelope is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(prefix, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return [prefix, b64url(iv), b64url(encrypted), b64url(cipher.getAuthTag())].join('.');
}

function openWithKey(key, prefix, envelope) {
  if (!key || typeof envelope !== 'string') return null;
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== prefix) return null;
  try {
    const iv = unb64url(parts[1]);
    const encrypted = unb64url(parts[2]);
    const tag = unb64url(parts[3]);
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(prefix, 'utf8'));
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
}

function seal(prefix, troopApiKey, payload) {
  return sealWithKey(keyFor(prefix, troopApiKey), prefix, payload);
}

function open(prefix, troopApiKey, envelope) {
  return openWithKey(keyFor(prefix, troopApiKey), prefix, envelope);
}

function backendHash(backend) {
  return crypto.createHash('sha256').update(String(backend), 'utf8').digest('hex');
}

function now() {
  return Date.now();
}

// The callback ticket is sealed with the deployment key only, because the
// verifier must open it BEFORE it knows which troop is asking; the troop
// identity (id + API key thumbprint + backend hash) travels inside the sealed
// payload. This is the vsbadge/roverbadge shape, and it is what lets the leaf
// work without any per-troop verifier configuration.
function ticketKey() {
  const key = configuredKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update('scoutbadge:super-ticket', 'utf8').digest();
}

// TTL must stay shorter than the leaf's replay cache window, otherwise a
// ticket could be replayed after the leaf forgot it had been used.
function ticketTtlMs() {
  return TICKET_TTL_MS;
}

function createSuperTicket({ troopId, backend, apikey, loginId }) {
  const issuedAt = now();
  return sealWithKey(ticketKey(), TICKET_PREFIX, {
    kind: 'super-ticket',
    subject: String(loginId || '').trim(),
    troopId: String(troopId || ''),
    apikey: String(apikey || ''),
    backendHash: backendHash(backend),
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
    nonce: b64url(crypto.randomBytes(18))
  });
}

// Every field is compared against what the caller claims. A missing claim is a
// failure, never a wildcard: the leaf always knows its own API key and /exec
// URL, and the identity it is trying to log in.
function verifySuperTicket(ticket, expected) {
  const payload = openWithKey(ticketKey(), TICKET_PREFIX, ticket);
  if (!payload || payload.kind !== 'super-ticket') return false;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < now()) return false;
  const want = expected && typeof expected === 'object' ? expected : {};
  if (!want.apikey || !want.backendHash || !want.subject) return false;
  if (!equalText(payload.apikey || '', String(want.apikey))) return false;
  if (!equalText(payload.backendHash || '', String(want.backendHash))) return false;
  if (!equalText(payload.subject || '', String(want.subject).trim())) return false;
  if (!payload.troopId) return false;
  return true;
}

function openSuperTicket(ticket) {
  const payload = openWithKey(ticketKey(), TICKET_PREFIX, ticket);
  if (!payload || payload.kind !== 'super-ticket') return null;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < now()) return null;
  return payload;
}

function createBrowserSession({ gasToken, troopId, backend, apikey }) {
  const issuedAt = now();
  return seal(SESSION_PREFIX, apikey, {
    kind: 'super-session',
    gasToken,
    troopId,
    backendHash: backendHash(backend),
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_MS
  });
}

function unwrapBrowserSession(token, { troopId, backend, apikey }) {
  if (typeof token !== 'string' || !token.startsWith(`${SESSION_PREFIX}.`)) {
    return { wrapped: false, valid: true, gasToken: token };
  }
  const payload = open(SESSION_PREFIX, apikey, token);
  if (!payload || payload.kind !== 'super-session' || typeof payload.gasToken !== 'string') {
    return { wrapped: true, valid: false };
  }
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < now()) {
    return { wrapped: true, valid: false };
  }
  if (!equalText(payload.troopId || '', String(troopId || '')) ||
      !equalText(payload.backendHash || '', backendHash(backend))) {
    return { wrapped: true, valid: false };
  }
  return { wrapped: true, valid: true, gasToken: payload.gasToken };
}

module.exports = {
  superConfigured,
  isCentralLoginCandidate,
  centralSubject,
  passwordMatches,
  ticketTtlMs,
  createSuperTicket,
  verifySuperTicket,
  openSuperTicket,
  createBrowserSession,
  unwrapBrowserSession,
  backendHash
};
