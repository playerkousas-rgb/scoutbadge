'use strict';

const { verifySuperTicket } = require('../lib/super-auth');

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
  const valid = verifySuperTicket(body.ticket, body.troopId, body.backendHash);
  return json(res, 200, { valid });
};
