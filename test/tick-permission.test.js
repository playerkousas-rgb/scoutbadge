'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { makeGas } = require('./gasvm');

const key='TESTKEY123';
const gas=makeGas({apiKey:key});
gas.sandbox.initializeSheets();
const users=gas.sheets.get('Users');
users.appendRow(['1234567890','成員','member@example.org','member','hash','','TRUE','','','','','active','','','member',false]);
users.appendRow(['L123','領袖','leader@example.org','branch_leader','hash','',true,'','','','','active','','','member',false]);
const tokenSheet=gas.sheets.get('Tokens');
for(const [token,id] of [['member-token','1234567890'],['leader-token','L123'],['admin-token','1111111111']]) tokenSheet.appendRow([token,id,'2026-01-01','2099-01-01']);
const post=(action,token,extra={})=>gas.post({action,apikey:key,token,...extra});
const changes=[{scoutId:'1234567890',itemId:'L1-01',date:'2026-11-20'}];
const progress=gas.sheets.get('進度追蹤');
const error='未有勾選權限，請聯絡旅長在用戶管理按「授權勾選」';
const snapshot=(name)=>JSON.stringify(gas.sheets.get(name)._rows);

assert.equal(post('save','member-token',{changes}).success,true,'授權成員可勾選');
const before=snapshot('進度追蹤');
let result=post('updatePermissions','admin-token',{targetScoutId:'1234567890',can_tick:false});
assert.equal(result.success,true); assert.equal(result.role,'member'); assert.equal(result.can_tick,false);
assert.equal(post('save','member-token',{changes}).error,error);
assert.equal(snapshot('進度追蹤'),before,'被拒不能寫進度');
assert.equal(post('save','invalid',{changes}).error,'Token 無效或過期');
assert.equal(gas.post({action:'save',token:'invalid',changes}).error,'Token 無效或過期');
assert.equal(gas.post({action:'save',apikey:key,changes:[{scoutId:'1234567890',itemId:'L1-02',date:'2026-11-20'}]}).success,true,'保留沒有 token 的 apikey 路徑');

result=post('updatePermissions','admin-token',{targetScoutId:'L123',can_tick:false});
assert.equal(result.success,true); assert.equal(result.role,'branch_leader'); assert.equal(result.can_tick,false);
assert.equal(users._rows[3][12],'','partial update must not change allowed_badges');
const request=gas.post({action:'requestComplete',apikey:key,token:'member-token',itemId:'L1-03',requested_date:'2026-11-20'});
assert.equal(request.success,true);
const pendingBefore=snapshot('待批完成');
const rejectedActions=[
  ['save',{changes},'進度追蹤'],
  ['saveOtherBadge',{records:[{scoutId:'1234567890',badgeId:'B1',name:'章',date:'2026-11-20'}]},'其他獎章'],
  ['addServiceRecord',{record:{scoutId:'1234567890',activity:'活動'}},'服務紀錄'],
  ['saveLogRecord',{records:[{scoutId:'1234567890',title:'活動',date:'2026-11-20'}]},'活動履歷'],
  ['deleteLogRecord',{record_id:'anything'},'活動履歷'],
  ['reviewRequest',{request_id:request.request_id,decision:'approved'},'待批完成'],
  ['reviewLogRequest',{request_id:'anything',decision:'approved'},'待批履歷']
];
for(const [action,body,sheet] of rejectedActions){
  const old=snapshot(sheet);
  assert.equal(post(action,'leader-token',body).error,error,action);
  assert.equal(snapshot(sheet),old,action+' must not write');
}
assert.equal(snapshot('待批完成'),pendingBefore);
for(const bad of ['super_admin','nonsense','',null]){
  const old=snapshot('Users');
  const r=post('updatePermissions','admin-token',{targetScoutId:'L123',new_role:bad});
  assert.match(r.error,/無效角色/); assert.equal(snapshot('Users'),old);
}
for(const bad of ['yes',null,1]){
  const old=snapshot('Users');
  assert.match(post('updatePermissions','admin-token',{targetScoutId:'L123',can_tick:bad}).error,/無效勾選權限/);
  assert.equal(snapshot('Users'),old);
}
assert.equal(post('updatePermissions','admin-token',{targetScoutId:'L123',allowed_badges:'L1'}).success,true);
result=post('updatePermissions','admin-token',{targetScoutId:'L123',can_tick:true});
assert.equal(result.role,'branch_leader'); assert.equal(result.can_tick,true); assert.equal(users._rows[3][12],'L1');
assert.equal(post('reviewRequest','leader-token',{request_id:request.request_id,decision:'approved'}).success,true,'regrant takes effect on existing token');
assert.equal(post('updatePermissions','admin-token',{targetScoutId:'L123',can_tick:false}).success,true);
result=gas.get({action:'load',apikey:key,token:'leader-token'});
assert.deepStrictEqual(result.me,{scoutId:'L123',name:'領袖',role:'branch_leader',can_tick:false,allowed_badges:'L1'});
assert.equal(gas.get({action:'load',apikey:key}).me,null);
assert.equal(gas.get({action:'load',apikey:key,token:'bad'}).error,'Token 無效或過期');

// Actually signed link requests: a known local actor cannot bypass revocation;
// a signed upstream actor must not claim a false flag or an invalid role.
function signed(body){
  const sig=gas.sandbox.makeLinkSig(body.action,JSON.stringify(body),key);
  return gas.post(body,{sig:sig.sig,sts:sig.ts,snonce:sig.nonce});
}
for(const [action,body,sheet] of rejectedActions.filter(([a])=>a!=='addServiceRecord')){
  const old=snapshot(sheet);
  const r=signed({action,...body,on_behalf:'L123',on_behalf_role:'branch_leader'});
  assert.equal(r.error,error,'signed '+action); assert.equal(snapshot(sheet),old);
}
assert.equal(signed({action:'save',changes,on_behalf:'external',on_behalf_role:'member',on_behalf_can_tick:false}).error,error);
assert.equal(signed({action:'save',changes,on_behalf:'external',on_behalf_role:'bogus',on_behalf_can_tick:true}).error,error);
assert.equal(signed({action:'save',changes,on_behalf:'external',on_behalf_can_tick:true}).error,error);
assert.equal(signed({action:'save',changes,on_behalf:'external',on_behalf_role:'member',on_behalf_can_tick:true}).success,true);

// Real login, email and L-number casing, and current-token preservation after password change.
const loginGas=makeGas({apiKey:key});
assert.equal(loginGas.get({action:'ecStatus'}).initRequired,true,'new installations still require initialization');
loginGas.sandbox.initializeSheets();
const passwordHash=loginGas.sandbox.hashPasswordV2('OldPass#1');
loginGas.sheets.get('Users').appendRow(['L555','測試','case@example.org','branch_leader',passwordHash,'',true,'','','','','active','*','','member',false]);
const loginByEmail=loginGas.post({action:'login',apikey:key,login_id:'CASE@EXAMPLE.ORG',password:'OldPass#1'});
const loginById=loginGas.post({action:'login',apikey:key,login_id:'l555',password:'OldPass#1'});
assert.equal(loginByEmail.success,true); assert.equal(loginById.success,true);
assert.equal(loginGas.post({action:'changePassword',apikey:key,token:loginById.token,old_password:'OldPass#1',new_password:'NewPass#1'}).success,true);
assert.equal(loginGas.get({action:'load',apikey:key,token:loginById.token}).success,true);
assert.equal(loginGas.get({action:'load',apikey:key,token:loginByEmail.token}).error,'Token 無效或過期');
assert.equal(loginGas.post({action:'login',apikey:key,login_id:'L555',password:'NewPass#1'}).success,true);

// Both login identifiers and leader ID case are accepted by the real backend.
assert.equal(gas.sandbox.normalizeScoutId('l123'),'L123');
assert.equal(gas.sandbox.getUser('l123').scoutId,'L123');
assert.equal(gas.sandbox.getUserByEmail('MEMBER@EXAMPLE.ORG').scoutId,'1234567890');

// Exercise frontend request construction and failure refresh without a browser.
const html=fs.readFileSync('index.html','utf8');
const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
assert.match(html,/id="loginId"[^>]*maxlength="100"/);
assert.match(extract('function switchLoginType(', 'function localizeAuthError('),/i\.maxLength=100/);
assert.match(html,/onclick="changeOwnPassword\(\)"/);
assert.match(extract('async function submitOwnPassword(', 'async function doLogin('),/apiRequest\('changePassword'/);
assert.match(extract('async function loadItemsAndProgress(', '/* ================== Tab Switching'),/currentUser=\{\.\.\.currentUser,\.\.\.backendData\.me\}/);
assert.match(extract('async function loadItemsAndProgress(', '/* ================== Tab Switching'),/localStorage\.setItem\(LS\.session/);
const viewContext={currentUser:{role:'member',can_tick:true,allowed_badges:''}};
vm.createContext(viewContext);
vm.runInContext(extract('function canCurrentUserTick()', 'function isMember()'),viewContext);
assert.equal(viewContext.canCurrentUserTick(),true); assert.equal(viewContext.canCurrentUserTickItem('L1-01'),true);
viewContext.currentUser.allowed_badges='NONE'; assert.equal(viewContext.canCurrentUserTickItem('L1-01'),false);
viewContext.currentUser={role:'branch_leader',can_tick:false,allowed_badges:'*'}; assert.equal(viewContext.canCurrentUserTickItem('L1-01'),false);

(async()=>{
  let calls=[],toasts=[],loads=0;
  const ctx={apiRequest:async(action,payload)=>{calls.push({action,payload}); return {success:false,error:'失敗原因'};},showToast:(...a)=>toasts.push(a),loadUsers:()=>loads++,t:x=>x,prompt:()=> '新隊'};
  vm.createContext(ctx);
  vm.runInContext(extract('async function editSquad(', 'async function loadApplications('),ctx);
  await ctx.toggleCanTick('L123',true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].payload)),{targetScoutId:'L123',can_tick:true});
  assert.match(toasts[0][0],/失敗原因/); assert.equal(loads,1);
  await ctx.editSquad('L123','','member');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[1].payload)),{targetScoutId:'L123',squad:'新隊',squad_role:'新隊'});
  assert.equal(loads,2);
  console.log('tick-permission regression tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
