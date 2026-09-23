'use strict';

const crypto = require('crypto');

const { getTroopConfig, getRegistry } = require('../lib/registry');
const { verifySuperTicket, openSuperTicket, backendHash } = require('../lib/super-auth');
const verifyRateLimit = require('../lib/verify-rate-limit');

// The fixed value the leaf sends when the administrator presses 「測試連線」.
// A real ticket always starts with the sealed prefix, so this can never
// collide with one.
const PROBE_TICKET = 'test';
const MAX_BODY_BYTES = 8192;

function constantTimeEquals(left, right) {
  const a = String(left === undefined || left === null ? '' : left);
  const b = String(right === undefined || right === null ? '' : right);
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  const same = crypto.timingSafeEqual(ha, hb);
  return same && a.length > 0 && b.length > 0;
}

// A troop may be identified by the API key it presents (the leaf path — the
// leaf knows its own key but not its registry id) or by an explicit id (the
// operator path through the web UI).
function findTroop(body) {
  const apikey = String(body.apikey || '');
  const supplied = String(body.backendHash || '').trim().toLowerCase();
  if (apikey) {
    // Several troops can share an API key when a deployment reuses it, so the
    // key alone is not a unique handle: prefer the entry whose registered
    // /exec URL matches what the caller says it runs.
    let firstKeyMatch = null;
    for (const troop of Object.values(getRegistry())) {
      if (!constantTimeEquals(troop.apikey, apikey)) continue;
      if (backendHash(troop.backend) === supplied) return { troop, byKey: true };
      if (!firstKeyMatch) firstKeyMatch = troop;
    }
    if (firstKeyMatch) return { troop: firstKeyMatch, byKey: true };
  }
  const troopId = String(body.troopId || '').trim().toUpperCase();
  return { troop: troopId ? getTroopConfig(troopId) : null, byKey: false };
}

// Answers the question the operator actually has: 「is this troop registered on
// this deployment, and does Vercel point at this same /exec URL?」. It returns
// booleans and the (already public) troop id only — never a backend URL, an API
// key, or the expected hash. A caller that cannot present the troop's own API
// key learns nothing beyond what /api/troops already publishes.
function probeResult(body) {
  const supplied = String(body.backendHash || '').trim().toLowerCase();
  const { troop, byKey } = findTroop(body);
  const keyOk = Boolean(troop) && (byKey || constantTimeEquals(troop.apikey, body.apikey));
  return {
    valid: false,
    probe: true,
    verifier: 'scoutbadge-leaf',
    troop_known: Boolean(troop),
    troop_id: troop ? troop.id : '',
    key_ok: keyOk,
    backend_matches: keyOk && backendHash(troop.backend) === supplied
  };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
    try { return JSON.parse(body); } catch (_) { return {}; }
  }
  if (typeof body !== 'object' || Array.isArray(body)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) return null;
  } catch (_) {
    return {};
  }
  return body;
}

// This is the fixed verification service that Apps Script calls (「回打」).
// It opens the short-lived sealed ticket, checks it against the registry entry
// for the troop named inside it, and answers one boolean. It never issues a
// session, never returns a secret, and never explains why a ticket failed.
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { valid: false });
  }
  if (!verifyRateLimit.allowed(req)) return json(res, 429, { valid: false });

  const body = parseBody(req.body);
  if (body === null) return json(res, 413, { valid: false });

  const ticket = String(body.ticket || '');
  if (ticket === PROBE_TICKET) return json(res, 200, probeResult(body));
  if (!ticket || ticket.length > 4096) return json(res, 200, { valid: false });

  // The registry entry is taken from the troop id sealed inside the ticket, so
  // the leaf needs no configuration of its own; the caller must still prove it
  // holds that troop's API key and runs the registered /exec URL.
  const sealed = openSuperTicket(ticket);
  const troop = sealed ? getTroopConfig(String(sealed.troopId || '')) : null;
  const registered =
    Boolean(troop) &&
    constantTimeEquals(troop.apikey, sealed.apikey) &&
    backendHash(troop.backend) === String(sealed.backendHash || '');

  const valid = registered && verifySuperTicket(ticket, {
    apikey: body.apikey,
    backendHash: body.backendHash,
    subject: body.loginId
  });
  return json(res, 200, { valid: Boolean(valid) });
};
