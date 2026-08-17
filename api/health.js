// Health check endpoint - helps diagnose "找不到82的SHEET" issues
const { getRegistry, getTroopConfig, normalizeToPadded4 } = require('./_registry');

module.exports = function handler(req, res) {
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

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const query = req.query || {};
  const troopId = query.troopId || query.u || '0082';

  const registry = getRegistry();
  const config = getTroopConfig(troopId);
  const normalized = normalizeToPadded4(troopId);

  const health = {
    success: true,
    timestamp: new Date().toISOString(),
    requestedTroopId: troopId,
    normalizedTroopId: normalized,
    troopFound: !!config,
    config: config ? {
      name: config.name,
      backendHost: (() => { try { return new URL(config.backend).hostname; } catch(e){ return 'invalid'; } })(),
      hasApikey: !!config.apikey,
      backendPreview: config.backend.substring(0, 60) + '...'
    } : null,
    registry: {
      totalKeys: Object.keys(registry).length,
      uniqueTroops: Object.keys(registry).filter(k => /^\d{4}$/.test(k)).length,
      availableTroops: Object.keys(registry).filter(k => /^\d{4}$/.test(k)).sort()
    },
    checks: {
      troop_0082_exists: !!getTroopConfig('0082'),
      troop_82_exists: !!getTroopConfig('82'),
      normalization_works: getTroopConfig('0082') && getTroopConfig('82') && getTroopConfig('0082').backend === getTroopConfig('82').backend
    },
    troubleshooting: {
      hint: '若你遇到「找不到82的SHEET」：',
      steps: [
        '1. 檢查 /api/troops 是否包含 0082',
        '2. 檢查 /api/health?troopId=0082 的 troopFound 是否 true',
        '3. 檢查 Vercel 環境變數 TROOP_0082_BACKEND 是否正確 (https://script.google.com/.../exec)',
        '4. 在 Google Apps Script 編輯器執行 initializeSheets() 重建缺失工作表',
        '5. 重新部署 Apps Script 為新版本，確保「任何人可存取」',
        '6. 檢查 Google Sheet 是否被誤刪除或改名'
      ]
    }
  };

  if (!config) {
    res.status(404).json({
      ...health,
      success: false,
      error: `Troop ${troopId} not found. 可能是 data/troops.json 缺少 0082，或環境變數未設定。`
    });
  } else {
    res.status(200).json(health);
  }
};
