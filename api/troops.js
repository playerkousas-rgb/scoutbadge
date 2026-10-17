'use strict';

const { listPublicTroops } = require('../lib/registry');

module.exports = function handler(_req, res) {
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

  // listPublicTroops() only reads TROOP_* env vars, which change only when
  // the project is redeployed (a redeploy purges/replaces the edge cache
  // entry for the new deployment). Cache hard at the edge so repeat visits
  // do not invoke this function: browsers may reuse for 5 min, Vercel's
  // edge for 1 h, and stale content may be served for up to a day while
  // revalidating in the background.
  res.setHeader(
    'Cache-Control',
    'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
  );
  return res.status(200).json({ troops: listPublicTroops() });
};
