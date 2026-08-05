// Vercel Serverless Function - 旅團配置 API v2.0
const { getRegistry } = require('./_registry');

module.exports = function handler(req, res) {
  // Helper for status and json if running in raw Node.js
  if (!res.status) {
    res.status = function(code) {
      res.statusCode = code;
      return res;
    };
  }
  if (!res.json) {
    res.json = function(data) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return res;
    };
  }

  const registry = getRegistry();
  const troops = {};

  // Build unique troop mapping
  Object.keys(registry).forEach(id => {
    if (!troops[id]) {
      troops[id] = {
        name: registry[id].name,
        backend: registry[id].backend
      };
    }
  });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    troops,
    _note: 'backend URL is public configuration; business API requests go through same-origin /api/proxy'
  });
};
