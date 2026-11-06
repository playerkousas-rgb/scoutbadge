'use strict';

const { listPublicTroops, publicLegacyIdMap } = require('../lib/registry');
const { applyCors, handlePreflight } = require('../lib/cors');

module.exports = function handler(req, res) {
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

  // SCOUTBOOK probes and reads this catalogue from the browser.
  // OPTIONS is 204; CORS headers are set only for an allowed origin.
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
  if (method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ success: false, error: '請求方法不被支援' });
  }

  // listPublicTroops() only reads TROOP_* env vars, which change only when
  // the project is redeployed (a redeploy purges/replaces the edge cache
  // entry for the new deployment). Cache hard at the edge so repeat visits
  // do not invoke this function: browsers may reuse for 5 min, Vercel's
  // edge for 1 h, and stale content may be served for up to a day while
  // revalidating in the background. Vary: Origin (set by applyCors) keeps
  // a CORS response from being reused for a different caller.
  res.setHeader(
    'Cache-Control',
    'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
  );
  // Object, not array: SCOUTBOOK's live parser does Object.entries and
  // rejects arrays. `id` is the object key and is repeated on each troop.
  // It is stable: no padding, stripping, or automatic 0082↔82 alias.
  const troops = listPublicTroops();
  return res.status(200).json({
    success: true,
    troops,
    legacyIds: publicLegacyIdMap(troops)
  });
};
