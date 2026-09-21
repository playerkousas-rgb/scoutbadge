'use strict';

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const attempts = new Map();

function clientKey(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',')[0]
    .trim();
  const address = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  // Store only a one-way identifier; no login ID, password, token, or full
  // request is retained or logged.
  return crypto.createHash('sha256').update(address).digest('hex');
}

function prune(now) {
  for (const [key, state] of attempts.entries()) {
    if (state.resetAt <= now) attempts.delete(key);
  }
}

function allowed(req) {
  const now = Date.now();
  prune(now);
  const state = attempts.get(clientKey(req));
  return !state || state.failures < MAX_FAILURES;
}

function failed(req) {
  const now = Date.now();
  prune(now);
  const key = clientKey(req);
  const state = attempts.get(key) || { failures: 0, resetAt: now + WINDOW_MS };
  state.failures += 1;
  attempts.set(key, state);
}

function succeeded(req) {
  attempts.delete(clientKey(req));
}

function resetForTests() {
  attempts.clear();
}

module.exports = { allowed, failed, succeeded, resetForTests };
