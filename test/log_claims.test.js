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
        setValue(v){ for (let k = 0; k < rows; k++) for (let m = 0; m < cols; m++) owner._data[r - 1 + k][c - 1 + m] = v; },
        setValues(vv){ for (let k = 0; k < rows; k++) for (let m = 0; m < cols; m++) owner._data[r - 1 + k][c - 1 + m] = vv[k][m]; },
        getValue(){ return owner._data[r - 1][c - 1]; },
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
  global.ContentService = { createTextOutput: o => { global.__lastOut = JSON.parse(o); return { setMimeType(){ return this; } }; }, MimeType: { JSON: 'JSON' } };
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
const fn = new Function('global', code + '\n;return {handleLogin, handleRequestLogRecord, handleGetLogRequests, handleReviewLogRequest, handleCancelLogRequest, handleGetLogRecords, handleSaveLogRecord, getMembers, getAllUsers, getUser, validateToken, canUserTick, initializeSheets, handleChangePassword, handleResetPassword, handleApply, handleAddUser, doPost, doGet, getLogRequestsList: typeof getLogRequestsList!=="undefined"?getLogRequestsList:null};');
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

console.log(`\n=== 結果：${passed} 通過，${failed} 失敗 ===`);
process.exit(failed ? 1 : 0);
