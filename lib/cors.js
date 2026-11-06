'use strict';

/*
 * Browser origins allowed to read /api/troops and /api/proxy.
 * SCOUTBOOK's production origin is https://scoutbook-five.vercel.app
 * (see their docs/partner-scoutbadge.md). https://scoutbook.vercel.app is
 * also allowed: that name was used in earlier handoffs and must not  break
 * a book that still calls it. Extra https origins go in SCOUTBOOK_ORIGINS
 * (comma-separated). Never reflect Access-Control-Allow-Origin: *.
 * BOOK does not send cookies; do not set Allow-Credentials.
 */

const DEFAULT_ORIGINS = Object.freeze([
  'https://scoutbook-five.vercel.app',
  'https://scoutbook.vercel.app'
]);

const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function extraOrigins() {
  return String(process.env.SCOUTBOOK_ORIGINS || '')
    .split(/[\s,]+/)
    .map((part) => part.trim().replace(/\/$/, ''))
    .filter((part) => HTTPS_ORIGIN.test(part) || LOOPBACK_ORIGIN.test(part));
}

function allowedOrigins() {
  return new Set([...DEFAULT_ORIGINS, ...extraOrigins()]);
}

function requestOrigin(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.origin || headers.Origin || '';
  return String(raw).trim().replace(/\/$/, '');
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (allowedOrigins().has(origin)) return true;
  // Local BOOK (Vite) calling this API. No cookies, so a loopback page
  // cannot ride an existing browser session.
  return LOOPBACK_ORIGIN.test(origin);
}

function applyCors(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

// Partner contract: OPTIONS is 204, with CORS headers only for an allowed origin.
function handlePreflight(req, res) {
  if (!req || String(req.method || '').toUpperCase() !== 'OPTIONS') return false;
  applyCors(req, res);
  res.statusCode = 204;
  if (typeof res.end === 'function') res.end();
  return true;
}

module.exports = {
  DEFAULT_ORIGINS,
  allowedOrigins,
  requestOrigin,
  isAllowedOrigin,
  applyCors,
  handlePreflight
};
