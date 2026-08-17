// Vercel Serverless Function - 旅團配置 API v2.1 - deduplicate 0082/82
const { getRegistry, normalizeToPadded4, normalizeStripped } = require('./_registry');

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
  const seenNormalized = new Set();

  // Build unique troop mapping, deduplicate by padded 4-digit ID
  Object.keys(registry).forEach(id => {
    // Only consider canonical padded form to avoid duplicate cards like 82 and 0082 both showing
    const padded = normalizeToPadded4(id);
    const stripped = normalizeStripped(id);
    // Prefer padded form as key
    const canonical = /^\d{4}$/.test(padded) ? padded : id;
    
    // Skip if we already added this normalized troop
    if (seenNormalized.has(canonical)) return;
    
    if (registry[id] && registry[id].backend) {
      // Use canonical key for frontend display
      if (!troops[canonical]) {
        troops[canonical] = {
          name: registry[id].name,
          backend: registry[id].backend,
          // Provide aliases for debugging
          _aliases: [id, padded, stripped].filter((v,i,a)=>a.indexOf(v)===i)
        };
        seenNormalized.add(canonical);
      }
      // Also add stripped alias for backwards compatibility but mark as alias
      const strippedKey = stripped;
      if (strippedKey && strippedKey !== canonical && !troops[strippedKey]) {
        // Don't duplicate display, but keep mapping pointing to same backend so 82 still works
        troops[strippedKey] = {
          name: registry[id].name,
          backend: registry[id].backend,
          _aliasOf: canonical
        };
      }
    }
  });

  // Ensure at least 0082 exists even if registry empty (fallback)
  if (!troops['0082'] && !troops['82']) {
    troops['0082'] = {
      name: '第 82 旅',
      backend: 'https://script.google.com/macros/s/AKfycbz_hto9mtwazfLPFNCGFx_WtBsILf2oVKecjE2m1WBTkIkskFuFv7EGQJCgeG3aPfKf/exec',
      _fallback: true
    };
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    troops,
    _note: 'backend URL is public configuration; business API requests go through same-origin /api/proxy. 0082 and 82 are treated as same troop.',
    _debug: {
      totalRegistryKeys: Object.keys(registry).length,
      uniqueTroops: Object.keys(troops).length
    }
  });
};
