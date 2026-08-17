// Health check endpoint - helps diagnose "找不到82的SHEET" issues v2.2
const { getRegistry, getTroopConfig, normalizeToPadded4 } = require('./_registry');

module.exports = async function handler(req, res) {
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
  res.setHeader('Access-Control-Allow-Origin', '*');

  const query = req.query || {};
  const troopId = query.troopId || query.u || '0082';
  const checkBackend = query.checkBackend !== '0'; // default true

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
      backendPreview: config.backend.substring(0, 100) + '...',
      fullBackend: config.backend // for debugging, frontend should not expose apikey
    } : null,
    registry: {
      totalKeys: Object.keys(registry).length,
      uniqueTroops: Object.keys(registry).filter(k => /^\d{4}$/.test(k)).length,
      availableTroops: Object.keys(registry).filter(k => /^\d{4}$/.test(k)).sort()
    },
    checks: {
      troop_0082_exists: !!getTroopConfig('0082'),
      troop_82_exists: !!getTroopConfig('82'),
      normalization_works: !!(getTroopConfig('0082') && getTroopConfig('82') && getTroopConfig('0082').backend === getTroopConfig('82').backend)
    },
    backendLiveCheck: null,
    troubleshooting: {
      hint: '若你遇到「找不到82的SHEET」：',
      steps: [
        '1. 檢查 /api/troops 是否包含 0082',
        '2. 檢查 /api/health?troopId=0082 的 troopFound 是否 true',
        '3. 檢查 Vercel 環境變數 TROOP_0082_BACKEND 是否正確 (https://script.google.com/.../exec)',
        '4. 在 Google Apps Script 編輯器執行 diagnoseSheets() 查看缺失表',
        '5. 執行 initializeSheets() 重建缺失工作表',
        '6. 重新部署 Apps Script 為新版本，確保「任何人可存取」',
        '7. 檢查 Google Sheet 是否被誤刪除或只有 admin 一人'
      ]
    }
  };

  if (!config) {
    return res.status(404).json({
      ...health,
      success: false,
      error: `Troop ${troopId} not found. 可能是 data/troops.json 缺少 0082，或環境變數未設定。`,
      receivedTroopId: troopId,
      envVarHint: `檢查是否設定 TROOP_${normalized}_BACKEND 或 TROOP_${String(troopId).replace(/^0+/,'')}_BACKEND`
    });
  }

  // Optional live check to GAS backend (to verify if URL actually points to correct SHEET)
  if (checkBackend) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      // Try health endpoint first (new Code.gs v5.1.1+), fallback to getLoginMode
      let backendUrl = config.backend;
      let healthUrl = new URL(backendUrl);
      healthUrl.searchParams.set('action', 'health');
      
      let resp = null;
      try {
        resp = await fetch(healthUrl.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
      } catch(e) {
        // fallback to getLoginMode
        const fallbackUrl = new URL(backendUrl);
        fallbackUrl.searchParams.set('action', 'getLoginMode');
        resp = await fetch(fallbackUrl.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal });
      }
      
      clearTimeout(timeoutId);
      
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch(e) { json = null; }
      
      health.backendLiveCheck = {
        reachable: true,
        httpStatus: resp.status,
        isJson: !!json,
        preview: text.substring(0, 300),
        parsed: json,
        // For load endpoint, also try to get member count
        diagnosis: null
      };

      // If health endpoint returns diagnose, use it
      if (json && json.diagnose) {
        health.backendLiveCheck.diagnosis = json.diagnose;
      }

      // Additional check: try ?action=load to see members
      if (json && json.success !== false) {
        try {
          const loadUrl = new URL(backendUrl);
          loadUrl.searchParams.set('action', 'load');
          if (config.apikey) loadUrl.searchParams.set('apikey', config.apikey);
          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 8000);
          const loadResp = await fetch(loadUrl.toString(), { method: 'GET', redirect: 'follow', signal: ctrl2.signal });
          clearTimeout(t2);
          const loadText = await loadResp.text();
          let loadJson = null;
          try { loadJson = JSON.parse(loadText); } catch(e) {}
          if (loadJson && loadJson.success) {
            health.backendLiveCheck.membersCount = (loadJson.members || []).length;
            health.backendLiveCheck.hasRealMembers = (loadJson.members || []).length > 1; // more than just admin
            health.backendLiveCheck.logsSupported = !!loadJson.logsSupported;
            health.backendLiveCheck.progressCount = Object.keys(loadJson.flatProgress || {}).length;
            
            if (!health.backendLiveCheck.hasRealMembers) {
              health.backendLiveCheck.warning = '⚠️ 後端只回傳 1 個成員 (通常是預設 admin)，表示 Spreadsheet 可能是空的或被重置，或 URL 指向測試用 Sheet，不是真正的 82 旅資料。請檢查 Google Drive 中的真實 82 Sheet ID。';
            }
            if (loadJson.logsSupported === false) {
              health.backendLiveCheck.sheetWarning = 'logsSupported=false 表示後端 Code.gs 版本過舊，缺少「活動履歷」表，請更新至 v5.1.1 並重新部署。';
            }
          }
        } catch(e) {
          health.backendLiveCheck.loadCheckError = e.message;
        }
      }

    } catch(err) {
      health.backendLiveCheck = {
        reachable: false,
        error: err.message,
        hint: '無法連到 Google Apps Script，可能是 URL 錯誤、部署未設「任何人可存取」、或網絡問題。請檢查 TROOP_0082_BACKEND 是否為正確的 /exec URL。'
      };
    }
  }

  return res.status(200).json(health);
};
