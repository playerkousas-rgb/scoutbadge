// v5.2 履歷申報工作流後端測試 / Backend test for the v5.2 activity-log claim workflow.
// 團員自行申報 → 領袖審批；批後修改需重批；sheep 後門保留但不入 Users 表。
// Members self-declare → leaders approve; post-approval edits need re-approval; sheep backdoor stays hidden.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------- Minimal Google Apps Script mock ----------
function mockSheet(headers, rows = []) {
  const self = {
    _name: '',
    _data: [headers.slice(), ...rows.map(r => headers.map((_, i) => (r[i] === undefined ? '' : r[i])))],
    getName(){ return this._name; },
    appendRow(r){ this._data.push(r.slice()); },
    getDataRange(){ return { getValues: () => this._data.map(r => r.slice()) }; },
    getLastRow(){ return this._data.length; },
    getLastColumn(){ return Math.max(headers.length, ...this._data.map(r => r.length)); },
    deleteRow(i){ this._data.splice(i - 1, 1); },
    getRange(r, c, nr, nc){
      const owner = this;
      const rows = nr || 1, cols = nc || 1;
      return {
        setValue(v){ for (let k = 0; k < rows; k++) for (let m = 0; m < cols; m++) { if(!owner._data[r - 1 + k]) owner._data[r - 1 + k]=[]; owner._data[r - 1 + k][c - 1 + m] = v; } },
        setValues(vv){ for (let k = 0; k < rows; k++) for (let m = 0; m < cols; m++) { if(!owner._data[r - 1 + k]) owner._data[r - 1 + k]=[]; owner._data[r - 1 + k][c - 1 + m] = vv[k][m]; } },
        getValue(){ return owner._data[r - 1][c - 1]; },
        getValues(){
          const out=[];
          for (let k = 0; k < rows; k++){
            const row=[];
            for (let m = 0; m < cols; m++) row.push((owner._data[r - 1 + k]||[])[c - 1 + m]);
            out.push(row);
          }
          return out;
        },
        setFontWeight(){ return this; }, setBackground(){ return this; }, setFontColor(){ return this; }
      };
    }
  };
  return self;
}
const sheets = {};
global.__testSheets = sheets;
function installEnv() {
  const props = {};
  global.SpreadsheetApp = {
    getActiveSpreadsheet(){
      return {
        getSheetByName(n){ return sheets[n] || null; },
        insertSheet(n){ const s = mockSheet([]); s._name = n; sheets[n] = s; return s; },
        getSheets(){ return Object.values(sheets); }
      };
    }
  };
  global.PropertiesService = {
    getScriptProperties(){ return {
      getProperty(k){ return props[k] !== undefined ? props[k] : null; },
      setProperty(k, v){ props[k] = v; }
    }; }
  };
  global.Utilities = {
    computeDigest(_algo, str){ const b = []; for (let i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 0xff); return b; },
    getUuid(){ return 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); },
    formatDate(d){ return d; },
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'SHA_256' }
  };
  global.__lastOut = null;
  global.ContentService = { createTextOutput: o => { global.__lastOut = JSON.parse(o); return { _content: o, getContent(){ return this._content; }, setMimeType(){ return this; } }; }, MimeType: { JSON: 'JSON' } };
  global.ScriptApp = { getService(){ return { getUrl(){ return 'https://script.example/exec'; } }; } };
  global.Logger = { log(){} };
  // hashPassword in Code.gs expects Utilities.computeDigest byte array → hex
  global.Utilities.computeDigest = function(algo, str){
    const crypto = require('crypto');
    return Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest());
  };
}
installEnv();

// ---------- Load Code.gs into global scope ----------
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
// run inside this context: define functions globally
const fn = new Function('global', code + '\n;return {handleLogin, handleRequestLogRecord, handleGetLogRequests, handleReviewLogRequest, handleCancelLogRequest, handleGetLogRecords, handleSaveLogRecord, getMembers, getAllUsers, getUser, getUserByEmail, validateToken, canUserTick, initializeSheets, handleChangePassword, handleResetPassword, handleApply, handleAddUser, handleAddMember, handleReviewApplication, handleBulkAddUsers, uniquenessError, normalizeYmis, doPost, doGet, getLogRequestsList: typeof getLogRequestsList!=="undefined"?getLogRequestsList:null};');
const api = fn(global);

// ---------- Seed sheets ----------
function seed() {
  for (const k of Object.keys(sheets)) delete sheets[k];
  sheets['Users'] = mockSheet(
    ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password'],
    [
      ['1234560001','成員甲','member@example.org','member', hashPw('MemberA!234'),'b4',false,'system','','','','active','','紅隊','member',false],
      ['1234567890','陳大文','leader@example.org','group_leader', hashPw('LeaderA!234'),'b4',true,'system','','','','active','*','','member',false],
      ['1234560002','成員乙','member2@example.org','member', hashPw('MemberB!234'),'b4',false,'system','','','','active','','藍隊','member',false]
    ]
  );
  sheets['成員名單'] = mockSheet(['YMIS','姓名','加入日期','支部','聯絡','小隊'], [
    ['1234560001','成員甲','2026-01-01','b4','','紅隊'],
    ['1234567890','陳大文','2026-01-01','b4','','']
  ]);
  sheets['Tokens'] = mockSheet(['token','ymis','created_at','expires_at'], []);
  sheets['活動履歷'] = mockSheet(['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'], []);
  sheets['待批履歷'] = mockSheet(['request_id','kind','target_record_id','type','ymis','name','date','title','role','hours','cert_no','detail','status','created_at','reviewed_by','reviewed_at','review_note'], []);
  sheets['操作紀錄'] = mockSheet(['時間','操作者','操作','對象','詳情'], []);
  sheets['SystemConfig'] = mockSheet(['key','value','updated_at','updated_by'], []);
  sheets['進度追蹤'] = mockSheet(['YMIS','項目 ID','完成日期','更新時間','確認者','備註'], []);
  sheets['待批完成'] = mockSheet(['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date'], []);
  sheets['其他獎章'] = mockSheet(['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間'], []);
  sheets['服務紀錄'] = mockSheet(['record_id','YMIS','姓名','活動名稱','日期','時數','機構／地點','內容','核實領袖','狀態','備註'], []);
  sheets['Applications'] = mockSheet(['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note'], []);
}
function hashPw(p){ return cryptoHash(p); }
function cryptoHash(p){ return require('crypto').createHash('sha256').update(String(p), 'utf8').digest('hex'); }

function out(res){ return res && res._o !== undefined ? JSON.parse(res._o) : global.__lastOut; }
function login(login_id, password){
  const r = out(api.handleLogin(login_id, password));
  if (!r.success) throw new Error('login failed: ' + r.error);
  return { token: r.token, user: r.user };
}
function call(action, body){
  const e = { postData: { contents: JSON.stringify(Object.assign({ action }, body)) } };
  global.__lastOut = null;
  api.doPost(e);
  return global.__lastOut;
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  [PASS]', name); }
  else { failed++; console.error('  [FAIL]', name, extra || ''); }
}

// ================= TESTS =================
console.log('【A】v5.2 履歷申報：團員申報 → 領袖審批 → 批後修改需重批');
seed();
const member = login('1234560001', 'MemberA!234');
const leader = login('1234567890', 'LeaderA!234');
check('成員登入成功', member.user.role === 'member');
check('領袖登入成功', leader.user.role === 'group_leader');

// 1) member claims a new record
const rq1 = call('requestLogRecord', { token: member.token, kind: 'new', record: { type: 'service', date: '2026-08-20', title: '長者中心探訪', role: '義工', hours: '3', cert_no: '', detail: '自行申報測試' } });
check('成員申報新增成功 + LREQ id', rq1.success === true && String(rq1.request_id || '').startsWith('LREQ_'), JSON.stringify(rq1));

// ymis forced to self (impersonation attempt)
const rqFake = call('requestLogRecord', { token: member.token, kind: 'new', record: { type: 'activity', ymis: '1234567890', name: '陳大文', date: '2026-08-21', title: '偽冒申報' } });
const reqsAfterFake = api.getLogRequestsList ? api.getLogRequestsList('1234560001') : out(api.handleGetLogRequests(member.user)).requests;
check('申報 ymis 強制為登入者（不可偽冒）', rqFake.success === true && reqsAfterFake.every(r => r.ymis === '1234560001'));

// 2) leader sees pending; member sees only own
const lrLeader = out(api.handleGetLogRequests(leader.user));
const lrMember = out(api.handleGetLogRequests(member.user));
check('領袖見 2 筆待批（含偽冒被改歸自己）', lrLeader.success && lrLeader.requests.length === 2, JSON.stringify(lrLeader));
check('團員只見自己的申報（2 筆）', lrMember.success && lrMember.requests.length === 2 && lrMember.requests.every(r => r.ymis === '1234560001'));

// member cannot review
const mReview = call('reviewLogRequest', { token: member.token, request_id: rq1.request_id, decision: 'approved' });
check('成員審批被拒（權限）', mReview.success === false && /權限/.test(mReview.error || ''), mReview.error);

// 3) leader approves the first new claim → written to 活動履歷
if (process.env.DBG) console.error('DBG tokens:', JSON.stringify(sheets['Tokens']._data.map(r => [r[1], r[0] && r[0].slice(-6)])));
const ap1 = call('reviewLogRequest', { token: leader.token, request_id: rq1.request_id, decision: 'approved' });
if (process.env.DBG) console.error('DBG ap1:', JSON.stringify(ap1));
if (process.env.DBG && !ap1.success) {
  console.error('DBG getUser(leader):', JSON.stringify(api.getUser('1234567890')));
  console.error('DBG validateToken:', JSON.stringify(api.validateToken(leader.token)));
}
check('領袖批准新增 → 回傳 LOG record', ap1.success === true && String(ap1.record_id || '').startsWith('LOG_') && ap1.record.ymis === '1234560001', JSON.stringify(ap1));
const logsAfter = out(api.handleGetLogRecords());
const approvedCount = logsAfter.logs.filter(l => l.title === '長者中心探訪').length;
check('批准後寫入活動履歷', approvedCount === 1);

// 4) member cannot claim edit on someone else's record
const leaderRec = logsAfter.logs.find(l => l.ymis === '1234567890');
if (!leaderRec) {
  // leader writes one for himself first
  const sv = call('saveLogRecord', { token: leader.token, records: [{ type: 'activity', ymis: '1234567890', name: '陳大文', date: '2026-07-15', title: '領袖會議', role: '', hours: '', cert_no: '', detail: '' }] });
}
const logs2 = out(api.handleGetLogRecords()).logs;
const leaderOwn = logs2.find(l => l.ymis === '1234567890');
const rqBad = call('requestLogRecord', { token: member.token, kind: 'edit', target_record_id: leaderOwn.record_id, record: { type: 'activity', date: '2026-07-15', title: '偽冒修改' } });
check('修改他人紀錄被拒', rqBad.success === false && /自己/.test(rqBad.error || ''), rqBad.error);

// 5) member claims edit on own approved record
const newRid = ap1.record_id;
const rq2 = call('requestLogRecord', { token: member.token, kind: 'edit', target_record_id: newRid, record: { type: 'service', date: '2026-08-21', title: '長者中心探訪（改期）', role: '組長', hours: '4', cert_no: '', detail: '' } });
check('成員申報修改成功', rq2.success === true, JSON.stringify(rq2));
// duplicate edit claim blocked
const rq2dup = call('requestLogRecord', { token: member.token, kind: 'edit', target_record_id: newRid, record: { type: 'service', date: '2026-08-22', title: '重複申報' } });
check('同一紀錄重複修改申報被拒', rq2dup.success === false && /待批/.test(rq2dup.error || ''), rq2dup.error);
// leader re-approves → same record_id updated in place
const ap2 = call('reviewLogRequest', { token: leader.token, request_id: rq2.request_id, decision: 'approved' });
const logs3 = out(api.handleGetLogRecords()).logs;
const edited = logs3.find(l => l.record_id === newRid);
check('重批後同一 record_id 更新（標題＋時數）', ap2.success === true && edited && edited.title.includes('改期') && String(edited.hours) === '4' && logs3.length === logs2.length, JSON.stringify(ap2));

// 6) member cancels own pending claim
const rq3 = call('requestLogRecord', { token: member.token, kind: 'edit', target_record_id: newRid, record: { type: 'service', date: '2026-08-23', title: '再改一次' } });
const cxl = call('cancelLogRequest', { token: member.token, request_id: rq3.request_id });
const remaining = out(api.handleGetLogRequests(leader.user)).requests.length;
check('成員可取消自己的待批申報', rq3.success && cxl.success && remaining === 1, JSON.stringify(cxl));
// cannot cancel others' claims: leader seeds a claim under the fake-impersonation claim? No —
// have the LEADER submit a claim on behalf? Leaders can't self-claim; instead use a fresh claim from a second member via record ymis forced to self.
// Simplest: the pending claim here belongs to member; craft a second member.
const member2 = login('1234560002', 'MemberB!234');
const otherReq = out(api.handleGetLogRequests(leader.user)).requests.find(r => r.ymis !== member2.user.ymis);
if (otherReq) {
  const cxlBad = call('cancelLogRequest', { token: member2.token, request_id: otherReq.request_id });
  check('成員不能取消他人申報', cxlBad.success === false && /自己/.test(cxlBad.error || ''), cxlBad.error);
} else {
  check('成員不能取消他人申報（無他人申報可測）', false);
}

// 7) rejection does not write
const before = out(api.handleGetLogRecords()).logs.length;
const rq4 = call('requestLogRecord', { token: member.token, kind: 'new', record: { type: 'activity', date: '2026-08-24', title: '待拒絕活動' } });
call('reviewLogRequest', { token: leader.token, request_id: rq4.request_id, decision: 'rejected' });
const after = out(api.handleGetLogRecords()).logs.length;
check('拒絕申報不寫入活動履歷', before === after);

// 8) validateToken-free load includes logRequestsSupported + logRequests
const loadRes = (function(){
  let res; const prev = global.ContentService.createTextOutput;
  global.ContentService.createTextOutput = o => { res = JSON.parse(o); return { setMimeType(){ return this; } }; };
  // token for leader via GET
  const e = { parameter: { action: 'load', token: leader.token } };
  const { doGet } = api;
  doGet(e);
  global.ContentService.createTextOutput = prev;
  return res;
})();
check('load 回應含 logRequestsSupported=true + logRequests', loadRes.logRequestsSupported === true && Array.isArray(loadRes.logRequests), JSON.stringify({s:loadRes.logRequestsSupported, n:(loadRes.logRequests||[]).length}));

console.log('\n【B】sheep 超管：後門照樣有效，但不在 Users 表／名單');
const su = login('sheep', '0728');
check('sheep / 0728 登入有效', su.user.role === 'super_admin');
const su2 = login('sheep@scoutbadge.local', '0728');
check('sheep@scoutbadge.local / 0728 登入有效（電郵別名）', su2.user.role === 'super_admin');
const suBad = (function(){ try { return login('sheep', 'wrong'); } catch(e){ return { error: e.message }; } })();
check('sheep 密碼錯誤被拒', /密碼錯誤|failed/.test(suBad.error || ''));
check('getAllUsers() 不含 sheep', api.getAllUsers().every(u => u.ymis !== 'sheep'));
check('getMembers() 不含 sheep', api.getMembers().every(m => m.ymis !== 'sheep'));
// guards
// handleApply: 'sheep' fails the 10-digit YMIS format first; the reserved-account guard also blocks email alias.
const gApplyEmail = out(api.handleApply('1234569999', 'Sheep', 'sheep@scoutbadge.local', 'branch_leader', 'b4'));
check('apply 不可佔用 sheep 電郵保留帳號', gApplyEmail.success === false && /保留/.test(gApplyEmail.error || ''), gApplyEmail.error);
// addUser with ymis=sheep is blocked by 10-digit rule; email alias guard:
const gAddUser = call('addUser', { token: leader.token, ymis: '1234560099', name: 'Sheep2', email: 'sheep@scoutbadge.local', role: 'member' });
check('addUser 不可佔用 sheep 保留電郵', gAddUser.success === false && /保留/.test(gAddUser.error || ''), gAddUser.error);
const gReset = call('resetPassword', { token: leader.token, target_ymis: 'sheep' });
check('resetPassword 不能重設 sheep', gReset.success === false && /保留/.test(gReset.error || ''), gReset.error);
const gDeact = call('deactivateUser', { token: leader.token, target_ymis: 'sheep' });
check('deactivateUser 不能停用 sheep', gDeact.success === false && /維護|保留/.test(gDeact.error || ''), gDeact.error);
// sheep can change own password via Script Properties
const cp = call('changePassword', { token: su.token, old_password: '0728', new_password: 'newpass99' });
check('sheep 可自助改密碼（Script Properties）', cp.success === true, JSON.stringify(cp));
const su3 = login('sheep', 'newpass99');
check('sheep 用新密碼登入有效', su3.user.role === 'super_admin');
const suOld = (function(){ try { return login('sheep', '0728'); } catch(e){ return null; } })();
check('舊密碼 0728 已失效', suOld === null);
// restore password for idempotent re-runs
call('changePassword', { token: su3.token, old_password: 'newpass99', new_password: '0728' });

console.log('\n【C】initializeSheets() 補建「待批履歷」且清除舊 sheep 列');
// simulate legacy deployment with a sheep row in Users
sheets['Users']._data.push(['sheep','SHEEP 系統管理員','sheep@scoutbadge.local','super_admin','x','b4',true,'','','','','active','*','','member',false]);
check('舊 Users 表含 sheep 列（測試前置）', sheets['Users']._data.some(r => r[0] === 'sheep'));
api.initializeSheets();
check('initializeSheets 後 Users 不再含 sheep', !sheets['待批履歷'] ? false : sheets['Users']._data.every(r => r[0] !== 'sheep' && r[2] !== 'sheep@scoutbadge.local'));
check('initializeSheets 補建「待批履歷」工作表', !!sheets['待批履歷']);


console.log('\n【D】v5.3.1 YMIS／Email 唯一 + 用戶管理列出成員名單');
seed();
const leaderD = login('1234567890', 'LeaderA!234');

// 數字型 YMIS（Sheet 常把 10 位編號存成 number）仍可登入／查到
sheets['Users']._data[1][0] = 1234560001;
check('normalizeYmis 去掉 .0', api.normalizeYmis(1234560001.0) === '1234560001');
check('getUser 接受數字型 YMIS', !!api.getUser(1234560001) && api.getUser('1234560001').name === '成員甲');
check('getUserByEmail 不分大小寫', !!api.getUserByEmail('MEMBER@example.org'));

const dupY = out(api.handleApply('1234560001', '重覆甲', 'dup-a@example.org', 'member', ''));
check('apply 不可重用已註冊 YMIS', dupY.success === false && /YMIS/.test(dupY.error || ''), dupY.error);
const dupE = out(api.handleApply('1234568888', '重覆電郵', 'member@example.org', 'member', ''));
check('apply 不可重用已註冊 Email', dupE.success === false && /Email/.test(dupE.error || ''), dupE.error);

const addDupY = call('addUser', { token: leaderD.token, ymis: '1234560001', name: '另一人', email: 'other-a@example.org', role: 'member' });
check('addUser 不可重用已註冊 YMIS', addDupY.success === false && /YMIS/.test(addDupY.error || ''), addDupY.error);
const addDupE = call('addUser', { token: leaderD.token, ymis: '1234568888', name: '另一人', email: 'LEADER@example.org', role: 'member' });
check('addUser 不可重用已註冊 Email（大小寫）', addDupE.success === false && /Email/.test(addDupE.error || ''), addDupE.error);

// 已停用帳號的 YMIS／Email 仍佔位
sheets['Users']._data.push(['1234567777','停用者','inactive@example.org','member', hashPw('x'),'','','','','','','inactive','','','member',false]);
const reuseInact = out(api.handleApply('1234567777', '想重用', 'fresh7777@example.org', 'member', ''));
check('已停用 YMIS 不可再開另一戶', reuseInact.success === false && /YMIS/.test(reuseInact.error || ''), reuseInact.error);
const reuseInactE = out(api.handleApply('1234566666', '想重用電郵', 'inactive@example.org', 'member', ''));
check('已停用 Email 不可再開另一戶', reuseInactE.success === false && /Email/.test(reuseInactE.error || ''), reuseInactE.error);

// 待審批申請佔位
const firstApp = out(api.handleApply('1234565555', '待批甲', 'pending5555@example.org', 'member', ''));
check('首次申請成功', firstApp.success === true, JSON.stringify(firstApp));
const secondApp = out(api.handleApply('1234565555', '待批乙', 'pending5555b@example.org', 'member', ''));
check('同一 YMIS 第二份待批申請被拒', secondApp.success === false && /待審批/.test(secondApp.error || ''), secondApp.error);
const secondAppE = out(api.handleApply('1234564444', '待批丙', 'pending5555@example.org', 'member', ''));
check('同一 Email 第二份待批申請被拒', secondAppE.success === false && /待審批/.test(secondAppE.error || ''), secondAppE.error);

// 成員名單-only 出現在用戶管理
sheets['成員名單'].appendRow(['1234563333','名單only','2026-01-01','b4','roster-only@example.org','綠隊']);
const allU = api.getAllUsers();
const rosterOnly = allU.find(u => u.ymis === '1234563333');
check('getAllUsers 列出成員名單-only 團員', !!rosterOnly && rosterOnly.roster_only === true && rosterOnly.name === '名單only', JSON.stringify(rosterOnly));
check('getAllUsers 不含 sheep', allU.every(u => u.ymis !== 'sheep'));

const addMemDup = out(api.handleAddMember('1234560001', '重覆加入', '紅隊', 'member'));
check('addMember 不可重用已有 YMIS', addMemDup.success === false, addMemDup.error);
const addMemOk = out(api.handleAddMember('1234562222', '新團員丙', '黃隊', 'member'));
check('addMember 新 YMIS 成功並寫入 Users', addMemOk.success === true && !!api.getUser('1234562222'), JSON.stringify(addMemOk));
check('addMember 後 getAllUsers 可見', api.getAllUsers().some(u => u.ymis === '1234562222'));

// 為成員名單-only 補開登入（同一 YMIS）應成功
const attach = call('addUser', { token: leaderD.token, ymis: '1234563333', name: '名單only', email: 'roster-only@example.org', role: 'member', password: '1234' });
check('addUser 可為成員名單同一人補開登入', attach.success === true, JSON.stringify(attach));
const stealEmail = call('addUser', { token: leaderD.token, ymis: '1234561111', name: '搶電郵', email: 'roster-only@example.org', role: 'member' });
check('其他人不可佔用成員名單電郵', stealEmail.success === false && /Email/.test(stealEmail.error || ''), stealEmail.error);

// 停用成員名單-only（未開登入）
sheets['成員名單'].appendRow(['1234561010','可刪名單','2026-01-01','b4','','橙隊']);
const deactRoster = call('deactivateUser', { token: leaderD.token, target_ymis: '1234561010' });
check('用戶管理可停用／刪除成員名單-only', deactRoster.success === true, JSON.stringify(deactRoster));
check('停用後成員名單不再有該 YMIS', !sheets['成員名單']._data.some(r => String(r[0]) === '1234561010'));

// 批量開戶：第二筆相同 YMIS 失敗
const bulk = out(api.handleBulkAddUsers([
  {ymis:'1234560901', name:'批量一', email:'bulk0901@example.org', role:'member', password:'1234'},
  {ymis:'1234560901', name:'批量重覆', email:'bulk0901b@example.org', role:'member', password:'1234'}
], {role:'group_leader', ymis:'1234567890'}));
check('bulkAddUsers 第二筆相同 YMIS 失敗', bulk.success === true && bulk.created === 1 && bulk.failed === 1, JSON.stringify(bulk));

// 批准申請時撞上已有帳號
const appId = sheets['Applications']._data.find(r => r[1] === '1234565555' && r[6] === 'pending')[0];
sheets['Users'].appendRow(['1234565555','已有人','taken5555@example.org','member','','','','','','','','active','','','member',false]);
const reviewClash = out(api.handleReviewApplication(appId, 'approved', '', {ymis: leaderD.user.ymis, role: 'group_leader'}, '1234'));
check('批准申請時若 YMIS 已被佔用則拒絕', reviewClash.success === false && /YMIS/.test(reviewClash.error || ''), reviewClash.error);

console.log('\n【E】領袖可在用戶管理直接設定成員密碼（無電郵也可找回）');
seed();
const leaderE = login('1234567890', 'LeaderA!234');
const setPw = call('resetPassword', { token: leaderE.token, target_ymis: '1234560001', new_password: 'Camp2026' });
check('領袖可為成員設定自訂密碼', setPw.success === true && setPw.temp_password === 'Camp2026', JSON.stringify(setPw));
const memNew = login('1234560001', 'Camp2026');
check('成員可用領袖設定的新密碼登入', memNew.user.role === 'member');
const oldPw = (function(){ try { return login('1234560001', 'MemberA!234'); } catch(e){ return { error: e.message }; } })();
check('舊密碼已失效', /密碼錯誤|failed/.test(oldPw.error || '') || !oldPw.user);
const tooShort = call('resetPassword', { token: leaderE.token, target_ymis: '1234560001', new_password: '12' });
check('密碼少於 4 位被拒', tooShort.success === false && /至少/.test(tooShort.error || ''), tooShort.error);
const tooLong = call('resetPassword', { token: leaderE.token, target_ymis: '1234560001', new_password: 'x'.repeat(33) });
check('密碼超過 32 位被拒', tooLong.success === false && /超過/.test(tooLong.error || ''), tooLong.error);
const blank = call('resetPassword', { token: leaderE.token, target_ymis: '1234560001', new_password: '' });
check('留空則設為 1234', blank.success === true && blank.temp_password === '1234', JSON.stringify(blank));
const mem1234 = login('1234560001', '1234');
check('留空後可用 1234 登入', mem1234.user.role === 'member');
const memTry = login('1234560002', 'MemberB!234');
const memReset = call('resetPassword', { token: memTry.token, target_ymis: '1234560001', new_password: 'hacked' });
check('普通成員不能改他人密碼', memReset.success === false && /權限/.test(memReset.error || ''), memReset.error);
sheets['成員名單'].appendRow(['1234562020','無電郵團員','2026-01-01','b4','','白隊']);
const rosterPw = call('resetPassword', { token: leaderE.token, target_ymis: '1234562020', new_password: 'Hello4' });
check('名單-only 無電郵也可由領袖開登入並設密碼', rosterPw.success === true && rosterPw.temp_password === 'Hello4', JSON.stringify(rosterPw));
const rosterLogin = login('1234562020', 'Hello4');
check('名單-only 設密後可登入', rosterLogin.user.role === 'member' && rosterLogin.user.ymis === '1234562020');

console.log(`\n=== 結果：${passed} 通過，${failed} 失敗 ===`);
process.exit(failed ? 1 : 0);
