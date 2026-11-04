// 批量開戶：先設定 CONFIG；操作說明見 docs/BULK_ONBOARD.md。
var CONFIG = {
  BACKEND_URL: 'https://script.google.com/macros/s/你的部署ID/exec', // app 的 doPost 網址（用推送後端時需要）
  APIKEY: '你的TROOP_APIKEY',          // 與 app 登入使用的 apikey 相同
  MAIN_SHEET_ID: '你的主資料表ID',     // 直接寫入主資料表時使用（我們的 Sheet）
  USERS_SHEET: 'Users'                // 主資料表內存放成員的工作表名稱（需與 app 後端相同：Users）
};

var USERS_HEADER = ['scout_id','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('批量開戶')
    .addItem('✍️ 直接寫入主資料表', 'writeToMainSheet')
    .addItem('📤 轉JSON並推送後端', 'pushToBackend')
    .addItem('📝 預覽JSON', 'previewJson')
    .addToUi();
}

// 2026-11-04：120,000 → 10,000。Apps Script 每次 computeHmacSha256Signature 都要過
// JS↔Java 邊界（約 0.1–0.3 ms），120,000 次要 20–40 秒，登入核對會逾時。
// 主系統 apps-script/Code.gs（GS 6.4.0）同步改為 10,000，兩邊雜湊仍然互通。
var PBKDF2_ITERATIONS = 10000;

function utf8SignedBytes_(str) {
  var s = String(str === undefined || str === null ? '' : str);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        i++;
      } else {
        out.push(0xEF, 0xBF, 0xBD);
      }
    } else {
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
  }
  for (var j = 0; j < out.length; j++) if (out[j] > 127) out[j] -= 256;
  return out;
}

function hexToSignedBytes_(hex) {
  var h = String(hex || '');
  var out = new Array(h.length >> 1);
  for (var i = 0, j = 0; i < h.length; i += 2, j++) {
    var v = parseInt(h.substr(i, 2), 16) & 0xFF;
    out[j] = v > 127 ? v - 256 : v;
  }
  return out;
}

function hashPassword(p) {
  var rawUuid = String(Utilities.getUuid() || '').replace(/-/g, '').toLowerCase();
  var saltHex = /^[0-9a-f]{32}$/.test(rawUuid)
    ? rawUuid
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawUuid + ':' + Date.now() + ':' + Math.random(), Utilities.Charset.UTF_8)
        .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('').substring(0, 32);
  var keyBytes = utf8SignedBytes_(p);
  var saltBytes = hexToSignedBytes_(saltHex);
  var msg = saltBytes.concat([0, 0, 0, 1]);
  var u = Utilities.computeHmacSha256Signature(msg, keyBytes);
  var t = u.slice();
  for (var c = 2; c <= PBKDF2_ITERATIONS; c++) {
    u = Utilities.computeHmacSha256Signature(u, keyBytes);
    for (var k = 0; k < 32; k++) t[k] ^= u[k];
  }
  var dkHex = '';
  for (var i = 0; i < 32; i++) dkHex += ('0' + (t[i] & 0xFF).toString(16)).slice(-2);
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + saltHex + '$' + dkHex;
}

function readRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = data[i][idx]; });
    if (obj.scoutId) rows.push(obj);
  }
  return rows;
}

function toJson(rows) {
  return rows.map(function (r) {
    return {
      scoutId: String(r.scoutId).trim(),
      name: String(r.name || '').trim(),
      email: String(r.email || '').trim(),
      squad: String(r.squad || '').trim(),
      squad_role: String(r.squad_role || 'member').trim(),
      role: String(r.role || 'member').trim(),
      can_tick: ['true', '1', 'yes', 'y'].indexOf(String(r.can_tick || '').trim().toLowerCase()) >= 0,
      password: String(r.password || '').trim()
    };
  });
}

function previewJson() {
  var json = toJson(readRows());
  SpreadsheetApp.getUi().alert('將轉換 ' + json.length + ' 筆：\n\n' + JSON.stringify(json, null, 2).slice(0, 4000));
}

function pushToBackend() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ok = 0, fail = 0, fails = [];
  json.forEach(function (m) {
    var payload = {
      action: m.password ? 'addUser' : 'addMember',
      apikey: CONFIG.APIKEY,
      token: '',
      scoutId: m.scoutId,
      name: m.name,
      email: m.email,
      squad: m.squad,
      squad_role: m.squad_role,
      role: m.role,
      can_tick: m.can_tick,
      password: m.password
    };
    try {
      var res = UrlFetchApp.fetch(CONFIG.BACKEND_URL, {
        method: 'post',
        contentType: 'text/plain',
        payload: JSON.stringify(payload)
      });
      var d = JSON.parse(res.getContentText());
      if (d.success) ok++; else { fail++; fails.push(m.scoutId + ': ' + (d.error || '失敗')); }
    } catch (e) { fail++; fails.push(m.scoutId + ': ' + e.message); }
  });
  SpreadsheetApp.getUi().alert('推送完成：成功 ' + ok + ' 筆，失敗 ' + fail + ' 筆' + (fails.length ? '\n\n' + fails.join('\n') : ''));
}

// SCOUT ID 欄位名相容（2026-11-04 改名）：主表可能仍然用舊表頭 ymis／YMIS
function isScoutIdHeader_(name) {
  var k = String(name === undefined || name === null ? '' : name).trim().toLowerCase().replace(/[\s_]/g, '');
  return k === 'scoutid' || k === 'ymis';
}
function scoutIdColumnIndex_(headers) {
  for (var i = 0; i < headers.length; i++) { if (isScoutIdHeader_(headers[i])) return i; }
  return -1;
}
function ensureUsersSheet(ss) {
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
  }
  var needsHeader = true;
  if (sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) {
    var firstRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    if (scoutIdColumnIndex_(firstRow) >= 0) needsHeader = false;
  }
  if (needsHeader) {
    sh.clearContents();
    sh.getRange(1, 1, 1, USERS_HEADER.length).setValues([USERS_HEADER]);
    sh.getRange(1, 1, 1, USERS_HEADER.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return { sh: sh, needsHeader: needsHeader };
}

function writeToMainSheet() {
  var json = toJson(readRows());
  if (!json.length) { SpreadsheetApp.getUi().alert('沒有資料'); return; }
  var ss = SpreadsheetApp.openById(CONFIG.MAIN_SHEET_ID);
  var info = ensureUsersSheet(ss);
  var sh = info.sh;

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var scoutIdCol = scoutIdColumnIndex_(headers);
  if (scoutIdCol < 0) { SpreadsheetApp.getUi().alert('主資料表找不到 SCOUT ID 欄位（scout_id／scoutId／ymis 任何一個都可以）'); return; }

  var lastRow = sh.getLastRow();
  var existing = lastRow > 1
    ? sh.getRange(2, scoutIdCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); })
    : [];

  var mSheet = null, mExisting = {};
  try {
    mSheet = ss.getSheetByName('成員名單');
    if (mSheet && mSheet.getLastRow() > 1) {
      var mData = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 1).getValues();
      mData.forEach(function (r) { mExisting[String(r[0]).trim()] = true; });
    }
  } catch (e) { mSheet = null; }

  var nowStr = Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss');
  var added = 0, dup = 0, skipped = 0;
  json.forEach(function (m) {
    if (existing.indexOf(m.scoutId) >= 0) { dup++; return; }
    if (!/^\d{10}$/.test(m.scoutId)) { skipped++; return; } // 防呆：SCOUT ID 須 10 位數字
    var row = new Array(headers.length).fill('');
    function set(name, val) { var c = name === 'scoutId' ? scoutIdColumnIndex_(headers) : headers.indexOf(name); if (c >= 0) row[c] = (val === undefined ? '' : val); }
    set('scoutId', m.scoutId);
    set('name', m.name);
    set('email', m.email);
    set('role', m.role);
    set('branch', m.squad);            // app 後端 convention：branch 取自 squad
    set('squad', m.squad);
    set('squad_role', m.squad_role);
    set('can_tick', m.can_tick ? 'TRUE' : 'FALSE');
    if (m.password) {
      set('password_hash', hashPassword(m.password));
      set('auth_by', 'bulk_onboard');
      set('auth_date', nowStr);
      set('status', 'active');
      set('allowed_badges', m.role === 'member' ? '' : '*');
      set('force_change_password', 'TRUE'); // 建議首次登入修改密碼
    } else {
      set('status', 'active'); // 只加入成員（不可登入）
    }
    set('created_at', nowStr);
    sh.appendRow(row);
    added++;
    if (mSheet && !mExisting[m.scoutId]) {
      mSheet.appendRow([m.scoutId, m.name, new Date(), '', '', m.squad]);
      mExisting[m.scoutId] = true;
    }
  });
  SpreadsheetApp.getUi().alert('寫入主資料表完成：新增 ' + added + ' 筆，略過重複 ' + dup + ' 筆' + (skipped ? '，跳過無效 ' + skipped + ' 筆' : '') + (info.needsHeader ? '（已自動建立 Users 表頭）' : ''));
}
