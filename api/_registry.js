// Registry Lookup for Scout Badge Troops - v2.1 robust 0082/82 handling
const fs = require('fs');
const path = require('path');

// Default fallback troops if files or env vars are missing
const DEFAULT_TROOPS = {
  "0082": {
    name: "第 82 旅",
    backend: "https://script.google.com/macros/s/AKfycbz_hto9mtwazfLPFNCGFx_WtBsILf2oVKecjE2m1WBTkIkskFuFv7EGQJCgeG3aPfKf/exec"
  }
};

function normalizeToPadded4(id) {
  if (!id) return id;
  const s = String(id).trim().toUpperCase();
  // If purely numeric, pad to 4 digits
  if (/^\d+$/.test(s)) {
    return s.padStart(4, '0');
  }
  // If numeric prefix + letter (e.g. 82R), pad numeric part
  const m = s.match(/^(\d+)([A-Z]*)$/);
  if (m) {
    return m[1].padStart(4, '0') + m[2];
  }
  return s;
}

function normalizeStripped(id) {
  if (!id) return id;
  const s = String(id).trim().toUpperCase();
  // Strip leading zeros from numeric prefix
  const m = s.match(/^(0+)(\d+)([A-Z]*)$/);
  if (m) {
    return m[2] + (m[3] || '');
  }
  // Also handle pure numeric with leading zeros
  const stripped = s.replace(/^0+/, '');
  return stripped || s;
}

function getRegistry() {
  const fileTroops = {};

  const candidates = [
    path.join(process.cwd(), 'data', 'troops.json'),
    path.join(process.cwd(), 'troops.json'),
    path.join(__dirname, '..', 'data', 'troops.json'),
    path.join(__dirname, '..', 'troops.json'),
    path.join(__dirname, 'data', 'troops.json'),
    path.join(__dirname, 'troops.json')
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        if (json && json.troops) {
          Object.assign(fileTroops, json.troops);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Combine with DEFAULT_TROOPS
  const combined = { ...DEFAULT_TROOPS, ...fileTroops };

  // Env vars TROOP_<id>_BACKEND and TROOP_<id>_APIKEY
  const envKeys = Object.keys(process.env);
  const idsFromEnv = new Set();
  envKeys.forEach(k => {
    let m = k.match(/^TROOP_(\d+[A-Z]?)_BACKEND$/i);
    if (m) idsFromEnv.add(m[1].toUpperCase());
    let m2 = k.match(/^TROOP_(\d+[A-Z]?)_APIKEY$/i);
    if (m2) idsFromEnv.add(m2[1].toUpperCase());
  });

  const allIds = new Set([
    ...Object.keys(combined).map(id => id.toUpperCase()),
    ...idsFromEnv
  ]);

  const registry = {};

  allIds.forEach(idUpper => {
    const origKey = Object.keys(combined).find(k => k.toUpperCase() === idUpper) || idUpper;
    const fileEntry = combined[origKey] || combined[Object.keys(combined).find(k => normalizeToPadded4(k) === normalizeToPadded4(idUpper)) || ''] || {};

    const idNoZero = normalizeStripped(idUpper);
    const idPadded = normalizeToPadded4(idUpper);

    const backendEnv = process.env[`TROOP_${idUpper}_BACKEND`] ||
                       process.env[`TROOP_${idNoZero}_BACKEND`] ||
                       process.env[`TROOP_${idPadded}_BACKEND`];

    const apikeyEnv = process.env[`TROOP_${idUpper}_APIKEY`] ||
                      process.env[`TROOP_${idNoZero}_APIKEY`] ||
                      process.env[`TROOP_${idPadded}_APIKEY`];

    const backend = backendEnv || fileEntry.backend || '';
    const apikey = apikeyEnv || fileEntry.apikey || '';
    // Name fallback: try fileEntry name, else constructed
    const name = fileEntry.name || `第 ${origKey} 旅`;

    if (backend) {
      // Store under all known variants to ensure 82 <-> 0082 interchangeability
      const variants = new Set([
        origKey,
        idUpper,
        idNoZero,
        idPadded,
        idUpper.toLowerCase(),
        origKey.toUpperCase(),
        origKey.toLowerCase()
      ]);
      variants.forEach(v => {
        if (v) registry[v] = { name, backend, apikey };
      });
      // Also ensure both stripped and padded explicitly
      if (idNoZero) registry[idNoZero] = { name, backend, apikey };
      if (idPadded) registry[idPadded] = { name, backend, apikey };
    }
  });

  // Final safety: ensure DEFAULT_TROOPS always present under all variants even if env missed
  Object.keys(DEFAULT_TROOPS).forEach(defId => {
    const def = DEFAULT_TROOPS[defId];
    const padded = normalizeToPadded4(defId);
    const stripped = normalizeStripped(defId);
    [defId, padded, stripped, defId.toUpperCase()].forEach(k => {
      if (k && !registry[k]) {
        registry[k] = { name: def.name, backend: def.backend, apikey: def.apikey || '' };
      }
    });
  });

  return registry;
}

function getTroopConfig(troopId) {
  if (troopId === undefined || troopId === null) return null;
  const cleanId = String(troopId).trim();
  if (!cleanId) return null;

  const reg = getRegistry();

  // Try multiple normalization strategies
  const candidates = [
    cleanId,
    cleanId.toUpperCase(),
    cleanId.toLowerCase(),
    normalizeStripped(cleanId),
    normalizeToPadded4(cleanId),
    normalizeStripped(cleanId.toUpperCase()),
    normalizeToPadded4(cleanId.toUpperCase()),
    // Also try numeric string without zero padding from upper
    cleanId.replace(/^0+/, '') || cleanId,
    cleanId.toUpperCase().replace(/^0+/, '') || cleanId.toUpperCase()
  ];

  // Deduplicate candidates while preserving order
  const seen = new Set();
  const uniqCandidates = [];
  candidates.forEach(c => {
    if (c && !seen.has(c)) {
      seen.add(c);
      uniqCandidates.push(c);
    }
  });

  for (const cand of uniqCandidates) {
    const entry = reg[cand];
    if (entry) {
      // Security check: backend must be an HTTPS Google Apps Script exec URL
      if (!entry.backend || typeof entry.backend !== 'string') continue;
      try {
        const url = new URL(entry.backend);
        if (url.protocol !== 'https:') continue;
        if (url.hostname !== 'script.google.com') continue;
        if (!url.pathname.endsWith('/exec')) continue;
      } catch (e) {
        continue;
      }
      return entry;
    }
  }

  return null;
}

module.exports = {
  getRegistry,
  getTroopConfig,
  normalizeToPadded4,
  normalizeStripped
};
