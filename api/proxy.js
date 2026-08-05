// Vercel Serverless Function - Same-origin Proxy for Google Apps Script
const { getTroopConfig } = require('./_registry');

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

    const troopId = payload.troopId || payload.troopKey || (req.query && (req.query.troopId || req.query.u)) || '0082';
    const action = payload.action || (req.query && req.query.action);

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: action'
      });
    }

    // 3. SSRF Check & Registry Lookup (never accept arbitrary client backend URL)
    const troopConfig = getTroopConfig(String(troopId));
    if (!troopConfig) {
      return res.status(404).json({
        success: false,
        error: `Unregistered or invalid troop ID: ${troopId}`
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
    if (action === 'load' && req.method === 'GET') {
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
      console.error(`[PROXY] Upstream non-JSON response for troop=${troopId}, action=${action}, status=${gasResponse.status}`);
      return res.status(502).json({
        success: false,
        error: '後端服務響應異常 (GAS Upstream Error)',
        details: rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText
      });
    }

    // 7. Security Logging: NEVER log sensitive fields (password, old_password, new_password, token, apikey)
    const duration = Date.now() - startTime;
    console.log(`[PROXY] troop=${troopId} action=${action} status=${gasResponse.status} duration=${duration}ms success=${jsonResult?.success !== false}`);

    return res.status(200).json(jsonResult);

  } catch (err) {
    const duration = Date.now() - startTime;
    if (err.name === 'AbortError') {
      console.error(`[PROXY] Timeout calling GAS after ${duration}ms`);
      return res.status(504).json({
        success: false,
        error: '後端服務連線逾時 (GAS Request Timeout)'
      });
    }

    console.error(`[PROXY] Exception:`, err.message);
    return res.status(500).json({
      success: false,
      error: `代理伺服器錯誤: ${err.message}`
    });
  }
};
