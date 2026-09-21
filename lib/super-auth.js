'use strict';

const crypto = require('crypto');

const TICKET_PREFIX = 'sbt1';
const SESSION_PREFIX = 'sbs1';
const TICKET_TTL_MS = 2 * 60 * 1000;
// Match the existing GAS token lifetime so the upgrade does not shorten normal sessions.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function superConfigured() {
  return typeof process.env.SUPER_KEY === 'string' &&
    process.env.SUPER_KEY.length >= 4;
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordMatches(input) {
  return superConfigured() && equalText(String(input || ''), process.env.SUPER_KEY);
}

// The normal UI accepts a 10-digit member ID or an email address. The central
// identifier is intentionally not duplicated outside GAS, so Vercel only
// treats a compact non-email identifier as a central-login candidate. GAS
// remains the authoritative identity check before it creates a session.
function isCentralLoginCandidate(loginId) {
  const id = String(loginId || '').trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && !/^L\d+$/i.test(id);
}

function keyFor(purpose, troopApiKey) {
  if (!superConfigured() || typeof troopApiKey !== 'string' || !troopApiKey) return null;
  // The per-troop server-only API key adds entropy without requiring another
  // deployment variable, and creates distinct ticket/session keys per troop.
  return crypto.createHmac('sha256', process.env.SUPER_KEY)
    .update(`scoutbadge:${purpose}:${troopApiKey}`, 'utf8')
    .digest();
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64url(value) {
  return Buffer.from(value, 'base64url');
}

function seal(prefix, troopApiKey, payload) {
  const key = keyFor(prefix, troopApiKey);
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

function open(prefix, troopApiKey, envelope) {
  const key = keyFor(prefix, troopApiKey);
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

function backendHash(backend) {
  return crypto.createHash('sha256').update(String(backend), 'utf8').digest('hex');
}

function now() {
  return Date.now();
}

function createSuperTicket({ troopId, backend, apikey, loginId }) {
  const issuedAt = now();
  return seal(TICKET_PREFIX, apikey, {
    kind: 'super-ticket',
    subject: String(loginId || '').trim(),
    troopId,
    backendHash: backendHash(backend),
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
    nonce: b64url(crypto.randomBytes(18))
  });
}

function verifySuperTicket(ticket, troopId, expectedBackendHash, expectedSubject, apikey) {
  const payload = open(TICKET_PREFIX, apikey, ticket);
  if (!payload || payload.kind !== 'super-ticket') return false;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < now()) return false;
  if (!equalText(payload.subject || '', String(expectedSubject || '').trim())) return false;
  if (!equalText(payload.troopId || '', String(troopId || ''))) return false;
  return equalText(payload.backendHash || '', String(expectedBackendHash || ''));
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
  passwordMatches,
  createSuperTicket,
  verifySuperTicket,
  createBrowserSession,
  unwrapBrowserSession,
  backendHash
};
