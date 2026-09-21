'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const portalStart = html.indexOf('async function handlePortalParams(){');
const portalEnd = html.indexOf('/* ================== Welcome ================== */', portalStart);
const portal = html.slice(portalStart, portalEnd);

assert(portalStart >= 0 && portalEnd > portalStart, 'portal handler must exist');
assert(portal.includes('selectTroop(troopId'), 'portal link must select the registered troop');
assert(!portal.includes('currentToken='), 'URL parameters must not establish a browser session');
assert(!portal.includes('currentUser='), 'URL parameters must not grant a browser role');
assert(html.includes("fetch('/api/troops'"), 'troop catalogue must use same-origin API');
assert(html.includes("fetch('/api/proxy'"), 'business requests must use same-origin proxy');
assert(!html.includes('troops.json'), 'frontend must not read troop JSON');
assert(!html.includes('currentBackend') && !html.includes('currentApikey'), 'frontend must not retain backend credentials');
assert(!html.includes('backend=') && !html.includes('apikey='), 'portal URLs must not document backend credentials');

console.log('Frontend routing and Portal safety checks passed');
