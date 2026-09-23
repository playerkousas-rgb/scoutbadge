'use strict';

/*
 * Coarse request budget for the public ticket verifier (/api/verify-super-ticket).
 *
 * The endpoint is reachable by anyone on the internet and answers a boolean, so
 * the only thing worth defending is raw volume: a flood of forged tickets must
 * not turn into unbounded AES-GCM open attempts. This is best effort per
 * serverless instance (Vercel keeps no shared memory), exactly like the login
 * limiter — it damps abuse, it is not an authentication control.
 */
const crypto = require('crypto');

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 60;
const hits = new Map();

function clientKey(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',')[0]
    .trim();
  const address = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  // Only a one-way identifier is kept; no ticket, key, or request body.
  return crypto.createHash('sha256').update(address).digest('hex');
}

function prune(now) {
  for (const [key, state] of hits.entries()) {
    if (state.resetAt <= now) hits.delete(key);
  }
}

function allowed(req) {
  const now = Date.now();
  prune(now);
  const key = clientKey(req);
  const state = hits.get(key) || { count: 0, resetAt: now + WINDOW_MS };
  state.count += 1;
  hits.set(key, state);
  return state.count <= MAX_REQUESTS;
}

function resetForTests() {
  hits.clear();
}

module.exports = { allowed, resetForTests, MAX_REQUESTS, WINDOW_MS };
