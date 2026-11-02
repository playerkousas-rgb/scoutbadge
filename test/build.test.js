'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_PUBLIC_BYTES = 5 * 1024 * 1024; // 5 MB budget per repo health rules

function walkDir(dir) {
  let totalBytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDir(full);
      totalBytes += sub.totalBytes;
      files += sub.files;
    } else if (entry.isFile()) {
      totalBytes += fs.statSync(full).size;
      files += 1;
    }
  }
  return { totalBytes, files };
}

try {
  execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, stdio: 'inherit' });

  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'index.html')), 'public/index.html must exist');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'apps-script', 'Code.gs')), 'public/apps-script/Code.gs must exist');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'assets', 'batch-onboard', 'Code.gs')), 'public/assets/batch-onboard/Code.gs must exist');
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'docs', 'PASSWORD_RESET.md')), 'public/docs/PASSWORD_RESET.md must exist');
  assert.strictEqual(fs.existsSync(path.join(PUBLIC_DIR, 'apps-script', 'CHANGELOG.md')), false, 'CHANGELOG.md must not be deployed');

  const { totalBytes, files } = walkDir(PUBLIC_DIR);
  assert.ok(
    totalBytes < MAX_PUBLIC_BYTES,
    `public/ artifact (${(totalBytes / (1024 * 1024)).toFixed(2)} MB) must stay under 5 MB`
  );
  console.log(`[PASS] build artifact verified (${files} files, ${(totalBytes / (1024 * 1024)).toFixed(2)} MB < 5 MB)`);
} finally {
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
}
