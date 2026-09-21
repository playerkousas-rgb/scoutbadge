'use strict';

const { getTroopConfig } = require('../lib/registry');
const { verifySuperTicket, backendHash } = require('../lib/super-auth');

// The fixed value Apps Script sends when the administrator presses 「測試連線」.
// A real ticket always starts with the sealed prefix, so this can never
// collide with one.
const PROBE_TICKET = 'test';

// Answers the question the operator actually has: 「is this troop registered on
// this deployment, and does Vercel point at this same /exec URL?」. It returns
// booleans only — never the backend URL, API key, or the expected hash.
function probeResult(body) {
  const troop = getTroopConfig(String(body.troopId || '').trim().toUpperCase());
  const supplied = String(body.backendHash || '').trim().toLowerCase();
  return {
    valid: false,
    probe: true,
    verifier: 'scoutbadge-leaf',
    troop_known: Boolean(troop),
    backend_matches: Boolean(troop) && backendHash(troop.backend) === supplied
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
    try { return JSON.parse(body); } catch (_) { return {}; }
  }
  return typeof body === 'object' && !Array.isArray(body) ? body : {};
}

// This is the fixed verification service that Apps Script calls. It only
// answers whether an opaque, short-lived ticket is valid for the already
// configured troop and backend audience; it never returns a secret or session.
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { valid: false });
  }

  const body = parseBody(req.body);
  if (String(body.ticket || '') === PROBE_TICKET) return json(res, 200, probeResult(body));

  const troop = getTroopConfig(String(body.troopId || '').trim().toUpperCase());
  const valid = Boolean(troop) && verifySuperTicket(
    body.ticket,
    body.troopId,
    body.backendHash,
    body.loginId,
    troop.apikey
  );
  return json(res, 200, { valid });
};
