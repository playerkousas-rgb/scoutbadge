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

const appScriptFiles = ['apps-script/Code.gs', 'assets/batch-onboard/Code.gs'];
for (const file of appScriptFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  try {
    new Function(source); // Syntax check only; GAS globals are not executed.
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

console.log(`Static syntax check passed (${scripts.length} browser script block(s) + ${appScriptFiles.length} Apps Script files)`);
