'use strict';

/*
 * Server-only troop registry. A troop exists only when its three Vercel
 * variables are complete. IDs are used exactly as written in the variable
 * name: no zero stripping, padding, aliases, files, or defaults.
 */
const TROOP_ENV = /^TROOP_([A-Z0-9]+)_(NAME|BACKEND|APIKEY)$/;
const VALID_PORTAL_ROLES = new Set(['member', 'branch_leader', 'group_leader', 'admin', 'super_admin']);

// Local development only: when explicitly enabled AND not running on Vercel,
// a backend may also point at a loopback mock (e.g. http://127.0.0.1:3901/exec)
// so the full HTTP pipeline can be exercised in tests.
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

function testBackendsAllowed() {
  return process.env.SCOUTBADGE_PROXY_TEST === '1' && process.env.VERCEL !== '1';
}

function value(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function isTrustedBackend(backend) {
  if (testBackendsAllowed() && TEST_LOCAL_RE.test(String(backend || '').trim())) return true;
  try {
    const target = new URL(backend);
    return target.protocol === 'https:' &&
      target.hostname === 'script.google.com' &&
      target.pathname.endsWith('/exec');
  } catch (_) {
    return false;
  }
}

function configuredIds() {
  const ids = new Set();
  for (const key of Object.keys(process.env)) {
    const match = key.match(TROOP_ENV);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function getRegistry() {
  const registry = {};
  for (const id of configuredIds()) {
    const name = value(`TROOP_${id}_NAME`);
    const backend = value(`TROOP_${id}_BACKEND`);
    const apikey = value(`TROOP_${id}_APIKEY`);

    // Do not publish or route incomplete / unsafe entries. This deliberately
    // avoids turning a partially configured variable set into a fallback.
    if (!name || !apikey || !isTrustedBackend(backend)) continue;
    registry[id] = { id, name, backend, apikey };
  }
  return registry;
}

function getTroopConfig(troopId) {
  if (typeof troopId !== 'string' && typeof troopId !== 'number') return null;
  const id = String(troopId).trim().toUpperCase();
  if (!id || !/^[A-Z0-9]+$/.test(id)) return null;
  const config = getRegistry()[id];
  return config ? { ...config } : null;
}

function listPublicTroops() {
  const troops = {};
  for (const [id, config] of Object.entries(getRegistry())) {
    troops[id] = { name: config.name };
  }
  return troops;
}

function parseOrigin(raw) {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.origin !== raw.replace(/\/$/, '')) return '';
    return parsed.origin;
  } catch (_) {
    return '';
  }
}

function parseRoles(raw) {
  const roles = String(raw || '')
    .split(/[\s,]+/)
    .map((role) => role.trim())
    .filter((role) => VALID_PORTAL_ROLES.has(role));
  return [...new Set(roles)];
}

function truthy(raw) {
  return /^(1|true|yes|on)$/i.test(String(raw || '').trim());
}

// Kept server-side for Portal integration. These values are not part of the
// public troop catalogue and are never accepted from a browser request.
function getPortalConfig(troopId) {
  const troop = getTroopConfig(troopId);
  if (!troop) return null;
  const prefix = `TROOP_${troop.id}_`;
  const configuredOrigin = value(`${prefix}PORTALORIGIN`) || value('PORTAL_DEFAULT_ORIGIN');
  const configuredRoles = value(`${prefix}PORTALROLES`) || value('PORTAL_DEFAULT_ROLES');
  return {
    disabled: truthy(value(`${prefix}PORTALDISABLED`)),
    origin: parseOrigin(configuredOrigin),
    roles: parseRoles(configuredRoles)
  };
}

module.exports = {
  getRegistry,
  getTroopConfig,
  listPublicTroops,
  getPortalConfig,
  isTrustedBackend
};
