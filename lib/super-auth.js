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

function superAdminId() {
  const value = process.env.SUPER_ADMIN_ID;
  return typeof value === 'string' ? value.trim() : '';
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isCentralLoginAttempt(loginId) {
  const id = superAdminId();
  return Boolean(id) && equalText(String(loginId || '').trim().toLowerCase(), id.toLowerCase());
}

function passwordMatches(input) {
  return superConfigured() && equalText(String(input || ''), process.env.SUPER_KEY);
}

function secret(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.length >= 32 ? value : '';
}

function keyFor(secretValue) {
  return crypto.createHash('sha256').update(secretValue, 'utf8').digest();
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64url(value) {
  return Buffer.from(value, 'base64url');
}

function seal(prefix, secretValue, payload) {
  if (!secretValue) throw new Error('secure envelope is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secretValue), iv);
  cipher.setAAD(Buffer.from(prefix, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return [prefix, b64url(iv), b64url(encrypted), b64url(cipher.getAuthTag())].join('.');
}

function open(prefix, secretValue, envelope) {
  if (!secretValue || typeof envelope !== 'string') return null;
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== prefix) return null;
  try {
    const iv = unb64url(parts[1]);
    const encrypted = unb64url(parts[2]);
    const tag = unb64url(parts[3]);
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secretValue), iv);
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

function ticketReady() {
  return Boolean(secret('SUPER_TICKET_SECRET'));
}

function sessionReady() {
  return Boolean(secret('SUPER_SESSION_SECRET'));
}

function createSuperTicket({ troopId, backend }) {
  const issuedAt = now();
  return seal(TICKET_PREFIX, secret('SUPER_TICKET_SECRET'), {
    kind: 'super-ticket',
    subject: superAdminId(),
    troopId,
    backendHash: backendHash(backend),
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
    nonce: b64url(crypto.randomBytes(18))
  });
}

function verifySuperTicket(ticket, troopId, expectedBackendHash) {
  const payload = open(TICKET_PREFIX, secret('SUPER_TICKET_SECRET'), ticket);
  if (!payload || payload.kind !== 'super-ticket') return false;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < now()) return false;
  if (!equalText(payload.subject || '', superAdminId())) return false;
  if (!equalText(payload.troopId || '', String(troopId || ''))) return false;
  return equalText(payload.backendHash || '', String(expectedBackendHash || ''));
}

function createBrowserSession({ gasToken, troopId, backend }) {
  const issuedAt = now();
  return seal(SESSION_PREFIX, secret('SUPER_SESSION_SECRET'), {
    kind: 'super-session',
    gasToken,
    troopId,
    backendHash: backendHash(backend),
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_MS
  });
}

function unwrapBrowserSession(token, { troopId, backend }) {
  if (typeof token !== 'string' || !token.startsWith(`${SESSION_PREFIX}.`)) {
    return { wrapped: false, valid: true, gasToken: token };
  }
  const payload = open(SESSION_PREFIX, secret('SUPER_SESSION_SECRET'), token);
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
  superAdminId,
  isCentralLoginAttempt,
  passwordMatches,
  ticketReady,
  sessionReady,
  createSuperTicket,
  verifySuperTicket,
  createBrowserSession,
  unwrapBrowserSession,
  backendHash
};
