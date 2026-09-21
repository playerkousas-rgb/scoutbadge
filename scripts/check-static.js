'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim());

if (!scripts.length) throw new Error('No inline browser script found');
scripts.forEach((source, index) => {
  try {
    new Function(source); // Syntax check only; it does not execute browser code.
  } catch (error) {
    throw new Error(`index.html inline script ${index + 1}: ${error.message}`);
  }
});

const appScript = fs.readFileSync(path.join(root, 'apps-script', 'Code.gs'), 'utf8');
new Function(appScript); // Syntax check only; GAS globals are not executed.

console.log(`Static syntax check passed (${scripts.length} browser script block(s) + Apps Script)`);
