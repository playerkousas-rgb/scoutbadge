// Registry Lookup for Scout Badge Troops
const fs = require('fs');
const path = require('path');

// Default fallback troops if files or env vars are missing
const DEFAULT_TROOPS = {
  "0082": {
    name: "第 82 旅",
    backend: "https://script.google.com/macros/s/AKfycbz_hto9mtwazfLPFNCGFx_WtBsILf2oVKecjE2m1WBTkIkskFuFv7EGQJCgeG3aPfKf/exec"
  }
};

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
    const fileEntry = combined[origKey] || {};

    const idNoZero = idUpper.replace(/^0+/, '') || idUpper;

    const backendEnv = process.env[`TROOP_${idUpper}_BACKEND`] ||
                       process.env[`TROOP_${idNoZero}_BACKEND`];

    const apikeyEnv = process.env[`TROOP_${idUpper}_APIKEY`] ||
                      process.env[`TROOP_${idNoZero}_APIKEY`];

    const backend = backendEnv || fileEntry.backend || '';
    const apikey = apikeyEnv || fileEntry.apikey || '';
    const name = fileEntry.name || `第 ${origKey} 旅`;

    if (backend) {
      registry[origKey] = { name, backend, apikey };
      registry[idUpper] = { name, backend, apikey };
      if (idNoZero !== idUpper) {
        registry[idNoZero] = { name, backend, apikey };
      }
    }
  });

  return registry;
}

function getTroopConfig(troopId) {
  if (!troopId || typeof troopId !== 'string') return null;
  const cleanId = troopId.trim();
  if (!cleanId) return null;

  const reg = getRegistry();
  const entry = reg[cleanId] || reg[cleanId.toUpperCase()] || reg[cleanId.padStart(4, '0')];
  if (!entry) return null;

  // Security check: backend must be an HTTPS Google Apps Script exec URL
  if (!entry.backend || typeof entry.backend !== 'string') return null;
  try {
    const url = new URL(entry.backend);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'script.google.com') return null;
    if (!url.pathname.endsWith('/exec')) return null;
  } catch (e) {
    return null;
  }

  return entry;
}

module.exports = {
  getRegistry,
  getTroopConfig
};
