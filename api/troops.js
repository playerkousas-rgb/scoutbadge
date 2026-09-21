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

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ troops: listPublicTroops() });
};
