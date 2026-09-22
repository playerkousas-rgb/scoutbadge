// 批量開戶：先設定 CONFIG；操作說明見 docs/BULK_ONBOARD.md。
var CONFIG = {
  BACKEND_URL: 'https://script.google.com/macros/s/你的部署ID/exec', // app 的 doPost 網址（用推送後端時需要）
  APIKEY: '你的TROOP_APIKEY',          // 與 app 登入使用的 apikey 相同
  MAIN_SHEET_ID: '你的主資料表ID',     // 直接寫入主資料表時使用（我們的 Sheet）
  USERS_SHEET: 'Users'                // 主資料表內存放成員的工作表名稱（需與 app 後端相同：Users）
};

var USERS_HEADER = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('批量開戶')
    .addItem('✍️ 直接寫入主資料表', 'writeToMainSheet')
    .addItem('📤 轉JSON並推送後端', 'pushToBackend')
    .addItem('📝 預覽JSON', 'previewJson')
    .addToUi();
}

function hashPassword(p) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
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
    if (obj.ymis) rows.push(obj);
  }
  return rows;
}

function toJson(rows) {
  return rows.map(function (r) {
    return {
      ymis: String(r.ymis).trim(),
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
      ymis: m.ymis,
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
      if (d.success) ok++; else { fail++; fails.push(m.ymis + ': ' + (d.error || '失敗')); }
    } catch (e) { fail++; fails.push(m.ymis + ': ' + e.message); }
  });
  SpreadsheetApp.getUi().alert('推送完成：成功 ' + ok + ' 筆，失敗 ' + fail + ' 筆' + (fails.length ? '\n\n' + fails.join('\n') : ''));
}

function ensureUsersSheet(ss) {
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
  }
  var needsHeader = true;
  if (sh.getLastRow() >= 1 && sh.getLastColumn() >= 1) {
    var firstRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    if (firstRow.indexOf('ymis') >= 0) needsHeader = false;
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
  var ymisCol = headers.indexOf('ymis');
  if (ymisCol < 0) { SpreadsheetApp.getUi().alert('主資料表找不到 ymis 欄位'); return; }

  var lastRow = sh.getLastRow();
  var existing = lastRow > 1
    ? sh.getRange(2, ymisCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); })
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
    if (existing.indexOf(m.ymis) >= 0) { dup++; return; }
    if (!/^\d{10}$/.test(m.ymis)) { skipped++; return; } // 防呆：YMIS 須 10 位數字
    var row = new Array(headers.length).fill('');
    function set(name, val) { var c = headers.indexOf(name); if (c >= 0) row[c] = (val === undefined ? '' : val); }
    set('ymis', m.ymis);
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
    if (mSheet && !mExisting[m.ymis]) {
      mSheet.appendRow([m.ymis, m.name, new Date(), '', '', m.squad]);
      mExisting[m.ymis] = true;
    }
  });
  SpreadsheetApp.getUi().alert('寫入主資料表完成：新增 ' + added + ' 筆，略過重複 ' + dup + ' 筆' + (skipped ? '，跳過無效 ' + skipped + ' 筆' : '') + (info.needsHeader ? '（已自動建立 Users 表頭）' : ''));
}
