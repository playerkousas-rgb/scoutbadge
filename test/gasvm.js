'use strict';

/*
 * Mini Google Apps Script simulator (pattern borrowed from ecportal's
 * tests/_gasvm.mjs): executes the REAL apps-script/Code.gs inside a vm
 * context with in-memory Sheets / Script Properties, so the e2e suite hits
 * the exact source that leaders deploy — not a rewritten fake backend.
 *
 * Gas APIs implemented (the set scoutbadge Code.gs uses):
 *   SpreadsheetApp (getActiveSpreadsheet, insertSheet, getSheetByName, flush)
 *   PropertiesService.getScriptProperties
 *   Utilities (getUuid, formatDate, computeDigest, computeHmacSha256Signature, sleep)
 *   DigestAlgorithm / Charset, Logger, LockService, ScriptApp.getService
 *   UrlFetchApp.fetch (delegates to global fetch)
 *   ContentService.createTextOutput / MimeType
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function makeSheet(name, headers) {
  const rows = headers ? [headers.slice()] : [];
  const chain = {};
  const range = (row, col, nr = 1, nc = 1) => ({
    setValues: (vals) => {
      vals.forEach((v, i) => {
        const ri = row - 1 + i;
        while (rows.length <= ri) rows.push([]);
        v.forEach((cell, j) => { rows[ri][col - 1 + j] = cell; });
      });
      return chain;
    },
    setValue: (v) => {
      const ri = row - 1;
      while (rows.length <= ri) rows.push([]);
      rows[ri][col - 1] = v;
      return chain;
    },
    getValues: () => {
      const out = [];
      for (let i = 0; i < nr; i++) {
        const r = rows[row - 1 + i] || [];
        out.push(r.slice(col - 1, col - 1 + nc));
      }
      return out;
    },
    getValue: () => (rows[row - 1] || [])[col - 1],
    clearContent: () => chain,
    setFontWeight: () => chain, setBackground: () => chain, setFontColor: () => chain,
    setNumberFormat: () => chain, setWrap: () => chain, setHorizontalAlignment: () => chain,
    setFontSize: () => chain, setBorder: () => chain, setFontFamily: () => chain
  });
  Object.assign(chain, range(1, 1));
  const sheet = {
    _rows: rows,
    getName: () => name,
    appendRow: (r) => { rows.push(r.slice()); return sheet; },
    getDataRange: () => ({
      getValues: () => rows.map((r) => r.slice()),
      clearContent: () => { rows.length = 0; }
    }),
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: range,
    deleteRow: (i) => { rows.splice(i - 1, 1); },
    deleteRows: (i, n) => { rows.splice(i - 1, n); },
    setFrozenRows: () => {}, setColumnWidth: () => {}, autoResizeColumn: () => {},
    clear: () => { rows.length = 0; }, clearContents: () => { rows.length = 0; },
    getSheetId: () => 1, hideSheet: () => {}, showSheet: () => {},
    setTabColor: () => {}, getFilter: () => null
  };
  return sheet;
}

function makeGas({ apiKey = null, execUrl = 'http://127.0.0.1:0/exec' } = {}) {
  const sheets = new Map();
  const props = new Map();
  if (apiKey) props.set('API_KEY', apiKey);

  const ss = {
    getName: () => '測試試算表',
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s) => sheets.delete(s.getName()),
    getId: () => 'fake',
    setSpreadsheetTimeZone: () => {},
    getSpreadsheetTimeZone: () => 'Asia/Hong_Kong'
  };

  const realFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      flush: () => {},
      getUi: () => { throw new Error('headless'); }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        setProperties: (obj) => { for (const k of Object.keys(obj)) props.set(k, String(obj[k])); },
        deleteProperty: (k) => { props.delete(k); }
      })
    },
    Utilities: {
      getUuid: () => (crypto.randomUUID ? crypto.randomUUID() : 'aaaa-bbbb-cccc-dddd-eeee'),
      formatDate: (d) => {
        try { return new Date(d).toISOString(); } catch (_) { return String(d); }
      },
      computeDigest: (algo, input, charset) => {
        const h = crypto.createHash('sha256').update(String(input), 'utf8').digest();
        return Array.from(h);
      },
      // 真實 Apps Script API 係 computeHmacSha256Signature(value, key[, charset])。
      // shim 只提供呢個真名＋真參數次序；Code.gs 若果叫錯名／傳錯次序，
      // 測試要即刻衰，唔可以再靜靜雞「夾啱」（之前自動開通因此必敗）。
      computeHmacSha256Signature: (value, key) => {
        const h = crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest();
        return Array.from(h);
      },
      sleep: () => {},
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' }
    },
    DigestAlgorithm: { SHA_256: 'SHA-256' },
    Charset: { UTF_8: 'UTF-8' },
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => execUrl }) },
    UrlFetchApp: {
      // GAS 語義：同步回傳 {getResponseCode, getContentText}。
      // 測試環境用子程序 fetch（獨立事件循環）＋ execFileSync 阻塞等待模擬同步；
      // muteHttpExceptions 下非 2xx 唔 throw，只 network 失敗 throw。
      fetch: (url, options) => {
        options = options || {};
        const init = { method: String(options.method || 'get').toUpperCase(), headers: {} };
        if (options.contentType) init.headers['Content-Type'] = String(options.contentType);
        if (options.payload !== undefined) init.body = String(options.payload);
        const script = [
          'fetch(process.argv[1],JSON.parse(process.argv[2]))',
          '.then(async (r)=>{const t=await r.text();console.log(JSON.stringify({status:r.status,text:t}));})',
          '.catch((e)=>{console.log(JSON.stringify({status:0,error:String(e&&e.message||e)}));});'
        ].join('');
        let out = '';
        try {
          out = execFileSync(process.execPath, ['-e', script, String(url), JSON.stringify(init)], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
          throw new Error('HttpFailure: ' + (e && e.message || 'timeout'));
        }
        const line = String(out).trim().split('\n').pop() || '';
        let parsed = null;
        try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
        if (!parsed || parsed.status === 0) {
          throw new Error('HttpFailure: ' + (parsed && parsed.error ? parsed.error : 'unreachable ' + url));
        }
        return {
          getResponseCode: () => parsed.status,
          getContentText: () => parsed.text,
          getText: () => parsed.text
        };
      }
    },
    ContentService: {
      createTextOutput: (t) => ({
        _t: t,
        setMimeType() { return this; },
        getContent() { return this._t; }
      }),
      MimeType: { JSON: 'application/json' }
    },
    console,
    JSON, Date, Math, String, Number, Boolean, Object, Array, Set, Map, RegExp,
    Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Promise, Uint8Array
  };

  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'),
    sandbox,
    { filename: 'Code.gs' }
  );

  const post = (body, params = {}) => {
    const out = sandbox.doPost({ postData: { contents: JSON.stringify(body) }, parameter: params });
    try { return JSON.parse(out.getContent()); } catch (_) { return { _raw: out.getContent() }; }
  };
  const get = (params = {}) => {
    const out = sandbox.doGet({ parameter: params });
    try { return JSON.parse(out.getContent()); } catch (_) { return { _raw: out.getContent() }; }
  };
  return { sandbox, post, get, props, sheets, ss };
}

module.exports = { makeGas, makeSheet };
