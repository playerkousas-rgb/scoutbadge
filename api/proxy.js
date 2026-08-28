// Vercel Serverless Function - Same-origin Proxy for Google Apps Script v2.1
const { getTroopConfig, getRegistry, normalizeToPadded4, normalizeStripped } = require('./_registry');

module.exports = async function handler(req, res) {
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

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // 1. HTTP Method Check
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: `Method ${req.method} Not Allowed`
    });
  }

  const startTime = Date.now();

  try {
    // 2. Parse Body & Query
    let payload = {};
    if (req.method === 'POST') {
      if (typeof req.body === 'string') {
        try {
          payload = JSON.parse(req.body || '{}');
        } catch (e) {
          return res.status(400).json({ success: false, error: 'Invalid JSON request body' });
        }
      } else {
        payload = req.body || {};
      }
    } else {
      payload = req.query || {};
    }

    // 支援多種參數命名：troopId / troopKey / u / troop
    const rawTroopId = payload.troopId || payload.troopKey || payload.troop || (req.query && (req.query.troopId || req.query.u || req.query.troop)) || '0082';
    // 標準化：0082 與 82 互通
    const troopId = String(rawTroopId).trim();
    const action = payload.action || (req.query && req.query.action);

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: action'
      });
    }

    // 3. SSRF Check & Registry Lookup (never accept arbitrary client backend URL)
    const troopConfig = getTroopConfig(troopId);
    if (!troopConfig) {
      // 提供更友善的錯誤，列出可用旅團以協助診斷「找不到SHEET」問題
      let available = [];
      try {
        const reg = getRegistry();
        const uniq = new Set();
        Object.keys(reg).forEach(k => {
          const n = normalizeToPadded4(k);
          if (/^\d{4}$/.test(n) || /^\d+$/.test(k)) {
            uniq.add(n);
          }
        });
        available = Array.from(uniq).sort().slice(0, 20);
      } catch(e) {}
      return res.status(404).json({
        success: false,
        error: `Unregistered or invalid troop ID: ${troopId}. 請檢查旅團編號是否為 0082 / 82？可用旅團: ${available.join(', ') || '無'}`,
        troubleshooting: {
          requested: troopId,
          normalizedPadded: normalizeToPadded4(troopId),
          normalizedStripped: normalizeStripped(troopId),
          availableTroops: available,
          hint: '若你看到「找不到82的SHEET」，請確認 data/troops.json 或 Vercel 環境變數 TROOP_0082_BACKEND 已正確設定，並且 Apps Script 已執行 initializeSheets()'
        }
      });
    }

    const gasUrl = troopConfig.backend;

    // 4. Inject Server-Side API Key if configured for troop
    if (troopConfig.apikey && !payload.apikey) {
      payload.apikey = troopConfig.apikey;
    }

    // Prepare AbortController timeout (25 seconds)
    const controller = new AbortController();
    const timeoutMs = 25000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let gasResponse;

    // 5. Forward request to Google Apps Script
    if (action === 'load') {
      // Apps Script implements load in doGet(), while the frontend sends all
      // apiRequest calls as POST. Translate both proxy methods to the same
      // upstream GET so login and the post-login data load use compatible
      // Apps Script entry points.
      const targetUrl = new URL(gasUrl);
      targetUrl.searchParams.set('action', 'load');
      if (payload.token) targetUrl.searchParams.set('token', payload.token);
      if (payload.apikey) targetUrl.searchParams.set('apikey', payload.apikey);

      gasResponse = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
        signal: controller.signal
      });
    } else {
      // Create clean forward payload without troop identifier
      const forwardPayload = { ...payload };
      delete forwardPayload.troopId;
      delete forwardPayload.troopKey;
      delete forwardPayload.troop;

      gasResponse = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(forwardPayload),
        redirect: 'follow',
        signal: controller.signal
      });
    }

    clearTimeout(timeoutId);

    // 6. Upstream Response Parsing (handles JSON and non-JSON HTML error pages)
    const rawText = await gasResponse.text();
    let jsonResult = null;

    try {
      jsonResult = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[PROXY] Upstream non-JSON response for troop=${troopId} (normalized=${normalizeToPadded4(troopId)}), action=${action}, status=${gasResponse.status}`);
      // 嘗試判斷是否為「工作表不存在」的 GAS 錯誤，給予更明確提示
      const isSheetMissing = /Exception.*sheet/i.test(rawText) || /找不到/.test(rawText) || /工作表/.test(rawText);
      return res.status(502).json({
        success: false,
        error: isSheetMissing 
          ? `後端 Google Sheet 設定異常：${troopId} 的 Spreadsheet 可能缺少必要工作表，請在 Apps Script 執行 initializeSheets() 重建。原始錯誤：${rawText.substring(0,150)}`
          : '後端服務響應異常 (GAS Upstream Error) - 請檢查 Apps Script 是否正確部署為「任何人可存取」且 URL 為 /exec 結尾',
        details: rawText.length > 300 ? rawText.substring(0, 300) + '...' : rawText,
        troubleshooting: {
          troopIdRequested: troopId,
          troopIdNormalized: normalizeToPadded4(troopId),
          gasUrl: gasUrl.substring(0, 80) + '...',
          hint: '常見原因：1) Apps Script 未重新部署「新版本」 2) 未執行 initializeSheets() 3) Google 帳戶授權過期 4) Spreadsheet 被刪除'
        }
      });
    }

    // 7. Security Logging: NEVER log sensitive fields (password, old_password, new_password, token, apikey)
    const duration = Date.now() - startTime;
    console.log(`[PROXY] troop=${troopId} (norm=${normalizeToPadded4(troopId)}) action=${action} status=${gasResponse.status} duration=${duration}ms success=${jsonResult?.success !== false}`);

    // 若後端回傳 success=false 且包含 sheet 相關錯誤，轉為更友善訊息
    if (jsonResult && jsonResult.success === false && jsonResult.error) {
      const errLower = String(jsonResult.error).toLowerCase();
      if (errLower.includes('sheet') || errLower.includes('工作表') || errLower.includes('找不到')) {
        jsonResult.troubleshooting = {
          hint: `此錯誤通常表示 Google Sheet 缺少工作表「${jsonResult.error}」或名為 ${troopId} 的設定異常。請檢查是否已執行 initializeSheets()，並確認 TROOP_${normalizeToPadded4(troopId)}_BACKEND 指向正確的 Spreadsheet。`,
          troopId: troopId,
          normalized: normalizeToPadded4(troopId)
        };
      }
    }

    return res.status(200).json(jsonResult);

  } catch (err) {
    const duration = Date.now() - startTime;
    if (err.name === 'AbortError') {
      console.error(`[PROXY] Timeout calling GAS after ${duration}ms`);
      return res.status(504).json({
        success: false,
        error: '後端服務連線逾時 (GAS Request Timeout) - 請檢查 Google Apps Script 是否回應過慢或配額耗盡'
      });
    }

    console.error(`[PROXY] Exception:`, err.message);
    return res.status(500).json({
      success: false,
      error: `代理伺服器錯誤: ${err.message}`
    });
  }
};
