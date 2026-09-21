'use strict';

/**
 * Vercel build step: assemble the deployable static surface into `public/`.
 *
 * Vercel serves everything inside the Output Directory as public static files,
 * so that directory must contain the browser-facing app only. Building it here
 * keeps `index.html`, `assets/`, `data/` and `docs/` published while server-side
 * code (`api/`, `lib/`, `server.js`, `scripts/`, `test/`) stays out of the web
 * root. `api/` is still detected at the project root and deployed as Vercel
 * Functions, and each function bundles the `lib/` helpers it requires.
 *
 * The script also fails the build when `index.html` references a local path that
 * was left out of the copy manifest, so a new asset directory can never silently
 * 404 in production.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'public');

// Single files published at the web root.
// `apps-script/Code.gs` is the troop backend source that leaders download from
// the setup steps ("⬇️ 下載 Code.gs (最新)"), so it is published on purpose.
const STATIC_FILES = ['index.html', 'apps-script/Code.gs'];

// Whole directories, so files added later are picked up automatically.
const STATIC_DIRS = ['assets', 'data', 'docs'];

// Local paths referenced by index.html that are intentionally NOT deployed.
// Removing an entry here makes the build fail until the path is really served,
// which is the prompt to delete the reason together with the exception.
// Currently empty: every path referenced by index.html is published.
const KNOWN_UNDEPLOYED = {};

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: false });
}

function listFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** Local paths index.html loads at runtime: href/src attributes, fetch(), links built in JS. */
function collectReferencedPaths(html) {
  const pattern = /["'`]((?:assets|data|docs|apps-script|lib|scripts)\/[^"'`?#\s]*)/g;
  const refs = new Set();
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (value.includes('${') || value.endsWith('/')) continue;
    refs.add(value);
  }
  return [...refs].sort();
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const file of STATIC_FILES) {
    const source = path.join(ROOT, file);
    if (!fs.existsSync(source)) throw new Error(`build.js: missing static file "${file}"`);
    copyTree(source, path.join(OUT_DIR, file));
  }

  for (const dir of STATIC_DIRS) {
    const source = path.join(ROOT, dir);
    if (!fs.existsSync(source)) throw new Error(`build.js: missing static directory "${dir}/"`);
    copyTree(source, path.join(OUT_DIR, dir));
  }

  const published = listFiles(OUT_DIR);
  const bytes = published.reduce((total, file) => total + fs.statSync(file).size, 0);

  const html = fs.readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
  const missing = [];
  const skipped = [];
  for (const ref of collectReferencedPaths(html)) {
    if (fs.existsSync(path.join(OUT_DIR, ref))) continue;
    if (KNOWN_UNDEPLOYED[ref]) skipped.push(`${ref} — ${KNOWN_UNDEPLOYED[ref]}`);
    else missing.push(ref);
  }

  if (missing.length) {
    throw new Error(
      'build.js: index.html references paths that are not published:\n' +
      missing.map((ref) => `  - ${ref}`).join('\n') +
      '\nAdd them to STATIC_FILES/STATIC_DIRS, or list them in KNOWN_UNDEPLOYED with a reason.'
    );
  }

  console.log(`public/ built: ${published.length} file(s), ${(bytes / 1024).toFixed(0)} KB`);
  for (const line of skipped) console.warn(`warning: not deployed → ${line}`);
}

main();
