// ScoutBadge Apps Script 後端
// 旅系統（旅 > 團 > 進度）：上游登記下游 URL 及 SHEET KEY，經 sig 讀寫下游；
//   下游 ALLOW_LOCAL_LOGIN 閂口後只收 sig；選單「🔗 旅系統」提供匯出 JSON（含 hash）／
//   匯入 JSON（upsertUser）／登記下游／測連線／為下游開戶／兩個直接入口掣。
// 中央登入（A）：Vercel 驗 SUPER_KEY → 封一張短效票 → GAS 回打固定端點 SUPER_VERIFY_URL 驗票 → 先發 token；
//   舊版單向 superLogin（只憑本團 API_KEY）已停用，回打失敗一律 fail closed。
// 初始化：只有全新後端或缺少工作表才執行 initializeSheets()；升級既有部署不要重跑。
// 版號只記錄在 operations/TROOP_LINK_UPGRADE.md，程式內不留版號註解。

const ADMIN_YMIS = '1111111111';
const SUPER_ADMIN_ID = 'sheep';
function isSuperAdminId(id){
  return String(id||'').trim().toLowerCase()===SUPER_ADMIN_ID;
}
function isSuperAdminReserved(ymis){
  return isSuperAdminId(ymis);
}

function normalizeYmis(v){
  if(v===null || v===undefined || v==='') return '';
  if(typeof v==='number' && isFinite(v)) return String(Math.round(v));
  let s=String(v).trim();
  if(/^\d+\.0+$/.test(s)) s=s.replace(/\.0+$/,'');
  if(/e/i.test(s) && isFinite(Number(s))) s=String(Math.round(Number(s)));
  return s;
}
function normalizeEmail(v){
  return String(v||'').trim().toLowerCase();
}
function isActiveStatus(v){
  const s=String(v==null?'':v).trim().toLowerCase();
  return s==='' || s==='active' || s==='true';
}
function findUsersAccountByYmis(ymis){
  ymis=normalizeYmis(ymis);
  if(!ymis) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeYmis(data[i][0])===ymis){
      return {source:'Users', row:i+1, ymis:normalizeYmis(data[i][0]), name:data[i][1]?String(data[i][1]):'', email:data[i][2]?String(data[i][2]):'', role:data[i][3]?String(data[i][3]):'member', status:data[i][11]?String(data[i][11]):'', squad:data[i][13]?String(data[i][13]):'', squad_role:data[i][14]?String(data[i][14]):'member'};
    }
  }
  return null;
}
function findUsersAccountByEmail(email){
  email=normalizeEmail(email);
  if(!email) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeEmail(data[i][2])===email){
      return {source:'Users', row:i+1, ymis:normalizeYmis(data[i][0]), name:data[i][1]?String(data[i][1]):'', email:String(data[i][2]||''), role:data[i][3]?String(data[i][3]):'member', status:data[i][11]?String(data[i][11]):''};
    }
  }
  return null;
}
function findRosterAccountByYmis(ymis){
  ymis=normalizeYmis(ymis);
  if(!ymis) return null;
  const sheet=getSheet().getSheetByName('成員名單'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeYmis(data[i][0])===ymis){
      return {source:'成員名單', row:i+1, ymis:ymis, name:data[i][1]?String(data[i][1]):'', email:data[i][4]?String(data[i][4]):'', role:'member', squad:data[i][5]?String(data[i][5]):''};
    }
  }
  return null;
}
function findRosterAccountByEmail(email){
  email=normalizeEmail(email);
  if(!email) return null;
  const sheet=getSheet().getSheetByName('成員名單'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeEmail(data[i][4])===email){
      return {source:'成員名單', row:i+1, ymis:normalizeYmis(data[i][0]), name:data[i][1]?String(data[i][1]):'', email:String(data[i][4]||''), role:'member'};
    }
  }
  return null;
}
// 開新帳號前檢查：Users（含停用）＋成員名單＋待審批申請 的 YMIS／Email 均不可重覆
function uniquenessError(ymis, email, opts){
  opts=opts||{};
  const exclude=normalizeYmis(opts.excludeYmis||'');
  if(isSuperAdminReserved(ymis,email)) return '此帳號已被保留，請使用其他帳號';
  const ny=normalizeYmis(ymis);
  const ne=normalizeEmail(email);
  if(ny){
    const u=findUsersAccountByYmis(ny);
    if(u && normalizeYmis(u.ymis)!==exclude) return 'YMIS 已註冊，不能重覆開戶';
    if(opts.checkRoster!==false){
      const r=findRosterAccountByYmis(ny);
      if(r && normalizeYmis(r.ymis)!==exclude) return 'YMIS 已在成員名單，不能重覆開戶';
    }
  }
  if(ne){
    const u=findUsersAccountByEmail(ne);
    if(u && normalizeYmis(u.ymis)!==exclude) return 'Email 已註冊，不能重覆開戶';
    const r=findRosterAccountByEmail(ne);
    // 同一人（相同 YMIS）在成員名單有此電郵可接受；其他人則不可重覆
    if(r && normalizeYmis(r.ymis)!==exclude && normalizeYmis(r.ymis)!==ny) return 'Email 已在成員名單，不能重覆開戶';
  }
  if(opts.checkPending!==false){
    const aSheet=getSheet().getSheetByName('Applications');
    if(aSheet){
      const data=aSheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][6])!=='pending') continue;
        if(opts.excludeAppId && String(data[i][0])===String(opts.excludeAppId)) continue;
        if(ny && normalizeYmis(data[i][1])===ny) return '此 YMIS 已有待審批申請';
        if(ne && normalizeEmail(data[i][3])===ne) return '此 Email 已有待審批申請';
      }
    }
  }
  return '';
}
function ensureUsersHeaders(uSheet){
  let headers=uSheet.getRange(1,1,1,Math.max(uSheet.getLastColumn(),1)).getValues()[0].map(function(h){return String(h).trim();});
  ['allowed_badges','squad','squad_role','force_change_password'].forEach(function(h){
    if(headers.indexOf(h)<0){ uSheet.getRange(1,headers.length+1).setValue(h); headers.push(h); }
  });
  return headers;
}
function appendUserRow(fields){
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return false;
  const headers=ensureUsersHeaders(uSheet);
  const row=new Array(headers.length).fill('');
  function set(n,v){ const c=headers.indexOf(n); if(c>=0) row[c]=v; }
  const keys=Object.keys(fields||{});
  for(let i=0;i<keys.length;i++) set(keys[i], fields[keys[i]]);
  uSheet.appendRow(row);
  return true;
}
function ensureRosterRow(ymis,name,email,squad){
  ymis=normalizeYmis(ymis);
  if(!ymis) return;
  let mSheet=getSheet().getSheetByName('成員名單');
  if(!mSheet){ mSheet=getSheet().insertSheet('成員名單'); mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','小隊']); }
  if(findRosterAccountByYmis(ymis)) return;
  mSheet.appendRow([ymis, name||'', new Date(), '', email||'', squad||'']);
}
function syncRosterRow(ymis, fields){
  const mSheet=getSheet().getSheetByName('成員名單'); if(!mSheet) return;
  const ny=normalizeYmis(ymis);
  const data=mSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeYmis(data[i][0])!==ny) continue;
    if(fields.name!==undefined) mSheet.getRange(i+1,2).setValue(fields.name);
    if(fields.email!==undefined && mSheet.getLastColumn()>=5) mSheet.getRange(i+1,5).setValue(fields.email);
    if(fields.squad!==undefined && mSheet.getLastColumn()>=6) mSheet.getRange(i+1,6).setValue(fields.squad);
    return;
  }
}
const ADMIN_NAME = '管理員';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASS = 'changeme';
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 128;
const DEFAULT_TEMP_PASSWORD = '1234';

function getSheet() { return SpreadsheetApp.getActiveSpreadsheet(); }
function getApiKey() {
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');
  if (!apiKey) {
    apiKey = 'sc_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', apiKey);
  }
  return apiKey;
}
function showApiKey() {
  return getApiKey();
}

const LOG_SHEET_NAME = '活動履歷';
const LOG_HEADERS = ['record_id','type','ymis','name','date','title','role','hours','cert_no','detail','recorder','recorded_at','updated_at'];
const LOG_TYPES = ['service','activity','training'];
const LOG_REQ_SHEET_NAME = '待批履歷';
const LOG_REQ_HEADERS = ['request_id','kind','target_record_id','type','ymis','name','date','title','role','hours','cert_no','detail','status','created_at','reviewed_by','reviewed_at','review_note'];

const REQUIRED_SHEETS = [
  {name:'進度追蹤', headers:['YMIS','項目 ID','完成日期','更新時間','確認者','備註']},
  {name:'成員名單', headers:['YMIS','姓名','加入日期','支部','聯絡','小隊']},
  {name:'Users', headers:['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password']},
  {name:'Applications', headers:['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note']},
  {name:'Tokens', headers:['token','ymis','created_at','expires_at']},
  {name:'SystemConfig', headers:['key','value','updated_at','updated_by']},
  {name:'待批完成', headers:['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date']},
  {name:'其他獎章', headers:['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間']},
  {name:'服務紀錄', headers:['record_id','YMIS','姓名','活動名稱','日期','時數','機構／地點','內容','核實領袖','狀態','備註']},
  {name:'操作紀錄', headers:['時間','操作者','操作','對象','詳情']},
  {name:'活動履歷', headers: LOG_HEADERS},
  {name:'待批履歷', headers: LOG_REQ_HEADERS}
];

function diagnoseSheets() {
  const ss = getSheet();
  if(!ss) return {success:false, error:'找不到試算表，請在 Google Sheet 內開啟 Apps Script 再執行'};
  const sheets = ss.getSheets();
  const existing = sheets.map(s=>s.getName());
  const missing = [];
  const present = [];
  const counts = {};
  sheets.forEach(s=>{
    try{
      counts[s.getName()] = {rows: s.getLastRow(), cols: s.getLastColumn()};
    }catch(e){
      counts[s.getName()] = {error: e.toString()};
    }
  });
  REQUIRED_SHEETS.forEach(req=>{
    if(existing.indexOf(req.name)>=0) present.push(req.name);
    else missing.push(req.name);
  });
  let usersCount = 0;
  let membersCount = 0;
  try{
    const u = ss.getSheetByName('Users');
    if(u) usersCount = Math.max(0, u.getLastRow()-1);
  }catch(e){}
  try{
    const m = ss.getSheetByName('成員名單');
    if(m) membersCount = Math.max(0, m.getLastRow()-1);
  }catch(e){}
  return {
    success: true,
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    existing,
    missing,
    present,
    counts,
    usersCount,
    membersCount,
    allOk: missing.length===0,
    isEmpty: usersCount<=1 && membersCount<=1,
    message: missing.length===0 ? ( (usersCount<=1 ? '⚠️ 工作表齊全但 Users 只有 '+usersCount+' 人，可能是空表/被重置，請檢查是否連錯試算表' : '✅ 所有必要工作表齊全，82 系統正常') ) : '⚠️ 缺少工作表：' + missing.join('、') + '，請執行 initializeSheets() 修復'
  };
}

function getSpreadsheetInfo(){
  const ss = getSheet();
  if(!ss) return {error:'No spreadsheet'};
  return {
    name: ss.getName(),
    id: ss.getId(),
    url: ss.getUrl(),
    sheets: ss.getSheets().map(s=>({name:s.getName(), rows:s.getLastRow()}))
  };
}

function repairSheets() {
  const diag = diagnoseSheets();
  if(diag.allOk) return jsonResponse({success:true, message:'所有工作表已齊全，無需修復', diagnose:diag});
  const result = initializeSheets();
  const after = diagnoseSheets();
  return jsonResponse({success:true, before:diag, after:after, apiKey: result.apiKey, repaired: true});
}

function hashPassword(p) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, p, Utilities.Charset.UTF_8);
  return raw.map(function(b){return ('0' + (b & 0xFF).toString(16)).slice(-2);}).join('');
}
function generateToken(){ return Utilities.getUuid().replace(/-/g,'') + Date.now().toString(36); }
function now(){ return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss'); }
function formatDate(d){ if(!d) return ''; if(d instanceof Date) return Utilities.formatDate(d,'Asia/Hong_Kong','yyyy-MM-dd'); return d.toString().split(' ')[0]; }
function jsonResponse(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function safeSheetText(v,maxLen){
  let text=String(v||'').trim().substring(0,maxLen||200);
  if(/^[=+\-@]/.test(text)) text="'"+text;
  return text;
}

const ROLE_HIERARCHY = { 'super_admin':100,'admin':80,'group_leader':60,'branch_leader':40,'member':0 };
const CAN_TICK_ROLES = ['admin','group_leader','branch_leader','super_admin'];
const CAN_MANAGE_ROLES = {
  'super_admin': ['admin','group_leader','branch_leader','member'],
  'admin': ['group_leader','branch_leader','member'],
  'group_leader': ['branch_leader','member'],
  'branch_leader': ['member']
};
function canUserTick(r){ return CAN_TICK_ROLES.indexOf(r)>=0; }
function getRoleLevel(r){ return ROLE_HIERARCHY[r]||0; }
function canManageRole(m,t){ return (CAN_MANAGE_ROLES[m]||[]).indexOf(t)>=0; }
function canManageUser(manager,targetRole){ return manager && (manager.role==='super_admin' || canManageRole(manager.role,targetRole)); }
// 領袖以電郵登入；L 編號只作內部 Users 鍵值。
function generateLeaderId(){ return getNextLeaderId(); }
function getNextLeaderId(){
  let maxNum=0;
  const uSheet=getSheet().getSheetByName('Users');
  if(uSheet){
    const data=uSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const y=String(data[i][0]||'').trim();
      const m=y.match(/^L(\d+)$/i);
      if(m){ const n=parseInt(m[1],10); if(n>maxNum) maxNum=n; }
    }
  }
  const aSheet=getSheet().getSheetByName('Applications');
  if(aSheet){
    const data=aSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const y=String(data[i][1]||'').trim();
      const m=y.match(/^L(\d+)$/i);
      if(m){ const n=parseInt(m[1],10); if(n>maxNum) maxNum=n; }
    }
  }
  return 'L'+String(maxNum+1).padStart(4,'0');
}
function gslLockMsg(name){
  return '團長只能有一位，全團已有現任團長（'+(name||'現任')+'）。如需更換，請先將現任團長轉為其他角色。';
}
// 團長只可一位；換人須先將現任轉為其他角色。
function findActiveGroupLeader(excludeYmis){
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return null;
  const data=uSheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0] && normalizeYmis(data[i][0])!==normalizeYmis(excludeYmis) && data[i][3] && String(data[i][3])==='group_leader' && isActiveStatus(data[i][11])){
      return {ymis:normalizeYmis(data[i][0]), name:data[i][1]?String(data[i][1]):''};
    }
  }
  return null;
}
function getActiveGroupLeader(){ return findActiveGroupLeader(''); }

// 自助申請只接受 member / branch_leader；團長／管理員由管理層開立。
const VALID_ROLES = ['admin','group_leader','branch_leader','member'];
const APPLY_ROLES = ['member','branch_leader'];
function generateTemporaryPassword(){ return DEFAULT_TEMP_PASSWORD; }

function initializeSheets() {
  const ss = getSheet();
  let pSheet = ss.getSheetByName('進度追蹤');
  if(!pSheet){
    pSheet = ss.insertSheet('進度追蹤');
    pSheet.appendRow(['YMIS','項目 ID','完成日期','更新時間','確認者','備註']);
    pSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    pSheet.setFrozenRows(1);
  } else {
    if(pSheet.getLastColumn()<6){
      pSheet.getRange(1,5).setValue('確認者'); pSheet.getRange(1,6).setValue('備註');
    }
  }
  let mSheet = ss.getSheetByName('成員名單');
  if(!mSheet){
    mSheet = ss.insertSheet('成員名單');
    mSheet.appendRow(['YMIS','姓名','加入日期','支部','聯絡','小隊']);
    mSheet.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    mSheet.setFrozenRows(1);
  }
  let uSheet = ss.getSheetByName('Users');
  if(!uSheet){
    uSheet = ss.insertSheet('Users');
    uSheet.appendRow(['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role']);
    uSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    uSheet.setFrozenRows(1);
    uSheet.getRange(2,1).setValue(ADMIN_YMIS);
    uSheet.getRange(2,2).setValue(ADMIN_NAME);
    uSheet.getRange(2,3).setValue(ADMIN_EMAIL);
    uSheet.getRange(2,4).setValue('admin');
    uSheet.getRange(2,5).setValue(hashPassword(ADMIN_PASS));
    uSheet.getRange(2,6).setValue('b4');
    uSheet.getRange(2,7).setValue(true);
    uSheet.getRange(2,8).setValue('system');
    uSheet.getRange(2,9).setValue(now());
    uSheet.getRange(2,10).setValue(now());
    uSheet.getRange(2,12).setValue('active');
    uSheet.getRange(2,13).setValue('*'); // 管理員默認全部
    uSheet.getRange(1,16).setValue('force_change_password');
    uSheet.getRange(2,16).setValue(true); // 首次登入強制改密

  } else {
    if(uSheet.getLastColumn()<13) uSheet.getRange(1,13).setValue('allowed_badges');
    if(uSheet.getLastColumn()<14) uSheet.getRange(1,14).setValue('squad');
    if(uSheet.getLastColumn()<15) uSheet.getRange(1,15).setValue('squad_role');
    if(uSheet.getLastColumn()<16) uSheet.getRange(1,16).setValue('force_change_password');
  }
  let aSheet = ss.getSheetByName('Applications');
  if(!aSheet){
    aSheet = ss.insertSheet('Applications');
    aSheet.appendRow(['app_id','ymis','name','email','role','branch','status','applied_at','reviewed_by','reviewed_at','note']);
    aSheet.getRange(1,1,1,11).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    aSheet.setFrozenRows(1);
  }
  let tSheet = ss.getSheetByName('Tokens');
  if(!tSheet){
    tSheet = ss.insertSheet('Tokens');
    tSheet.appendRow(['token','ymis','created_at','expires_at']);
    tSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    tSheet.setFrozenRows(1);
  }
  let cSheet = ss.getSheetByName('SystemConfig');
  if(!cSheet){
    cSheet = ss.insertSheet('SystemConfig');
    cSheet.appendRow(['key','value','updated_at','updated_by']);
    cSheet.getRange(1,1,1,4).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    cSheet.setFrozenRows(1);
    cSheet.appendRow(['login_mode','standalone',now(),'system']);
    cSheet.appendRow(['admin_email',ADMIN_EMAIL,now(),'system']);
  }
  let prSheet = ss.getSheetByName('待批完成');
  if(!prSheet){
    prSheet = ss.insertSheet('待批完成');
    prSheet.appendRow(['request_id','ymis','name','item_id','item_name','requested_date','evidence','status','created_at','reviewed_by','reviewed_at','review_note','confirmed_date']);
    prSheet.getRange(1,1,1,13).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    prSheet.setFrozenRows(1);
  }
  let oSheet = ss.getSheetByName('其他獎章');
  if(!oSheet){
    oSheet = ss.insertSheet('其他獎章');
    oSheet.appendRow(['YMIS','獎章 ID','獎章名稱','完成日期','證書編號','備註','更新時間']);
    oSheet.getRange(1,1,1,7).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    oSheet.setFrozenRows(1);
  }
  let cfgSheet = ss.getSheetByName('SystemConfig');
  if(cfgSheet){
    const cfgData=cfgSheet.getDataRange().getValues();
    let hasAllow=false;
    for(let i=1;i<cfgData.length;i++){ if(cfgData[i][0]==='allow_member_view_others'){ hasAllow=true; break; } }
    if(!hasAllow){
      cfgSheet.appendRow(['allow_member_view_others','false',now(),'system']);
      cfgSheet.appendRow(['member_progress_scope','private',now(),'system']);
      cfgSheet.appendRow(['allow_squad_comparison','false',now(),'system']);
    }
  }

  let sh=ss.getSheetByName('服務紀錄'); if(!sh){ sh=ss.insertSheet('服務紀錄'); sh.appendRow(['record_id','YMIS','姓名','活動名稱','日期','時數','機構／地點','內容','核實領袖','狀態','備註']); sh.getRange(1,1,1,11).setFontWeight('bold').setBackground('#2E7D32').setFontColor('#FFFFFF'); sh.setFrozenRows(1); }
  let ah=ss.getSheetByName('操作紀錄'); if(!ah){ ah=ss.insertSheet('操作紀錄'); ah.appendRow(['時間','操作者','操作','對象','詳情']); ah.getRange(1,1,1,5).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF'); ah.setFrozenRows(1); }

  let lSheet2 = ss.getSheetByName(LOG_SHEET_NAME);
  if(!lSheet2){
    lSheet2 = ss.insertSheet(LOG_SHEET_NAME);
    lSheet2.appendRow(LOG_HEADERS);
    lSheet2.getRange(1,1,1,LOG_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lSheet2.setFrozenRows(1);
  }
  let lrSheet = ss.getSheetByName(LOG_REQ_SHEET_NAME);
  if(!lrSheet){
    lrSheet = ss.insertSheet(LOG_REQ_SHEET_NAME);
    lrSheet.appendRow(LOG_REQ_HEADERS);
    lrSheet.getRange(1,1,1,LOG_REQ_HEADERS.length).setFontWeight('bold').setBackground('#8B0000').setFontColor('#FFFFFF');
    lrSheet.setFrozenRows(1);
  }

  const apiKey = getApiKey();
  let scriptUrl=''; try{ scriptUrl=ScriptApp.getService().getUrl(); }catch(e){ scriptUrl='請部署為網頁應用程式後查看';}
  try{
    const ui=SpreadsheetApp.getUi();
    if(ui){
      ui.alert('✅ 初始化完成！\n\nSheets：進度追蹤、成員名單、Users、Applications、Tokens、SystemConfig、待批完成、其他獎章、服務紀錄、操作紀錄、活動履歷、待批履歷\n\n🔑 API Key:\n'+apiKey+'\n\n👤 管理員 YMIS: '+ADMIN_YMIS+' 密碼: '+ADMIN_PASS+'\n\n🌐 URL:\n'+scriptUrl+'\n\n🔗 旅系統：本節點 BACKEND／APIKEY 見選單「🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY（交 ADMIN）」；登記資料不寫入工作表');
    }
  }catch(e){}
  return {success:true,apiKey:apiKey,scriptUrl:scriptUrl};
}

function getUser(ymis){
  if(isSuperAdminId(ymis)){
    return {ymis:SUPER_ADMIN_ID,name:'系統管理員',email:'',role:'super_admin',can_tick:true,branch:'',allowed_badges:'*',squad:'',squad_role:'',status:'active',force_change_password:false};
  }
  if(typeof ymis === 'string' && (ymis.includes('@') || ymis.indexOf('SIG_LEADER_') === 0)){
    const email = ymis.replace(/^SIG_LEADER_/, '');
    return {ymis: ymis, name: email, email: email, role: 'branch_leader', can_tick: true, branch: '', allowed_badges: '*', squad: '', squad_role: '', status: 'active', force_change_password: false};
  }
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowedCol = sheet.getLastColumn()>=13;
  const target=normalizeYmis(ymis);
  for(let i=1;i<data.length;i++){
    if(normalizeYmis(data[i][0])===target && isActiveStatus(data[i][11])){
      return {
        ymis:normalizeYmis(data[i][0]),
        name:data[i][1]?data[i][1].toString():'',
        email:data[i][2]?data[i][2].toString():'',
        role:data[i][3]?data[i][3].toString():'member',
        can_tick:data[i][6]===true||data[i][6]==='TRUE',
        branch:data[i][5]?data[i][5].toString():'',
        allowed_badges: hasAllowedCol ? (data[i][12]?data[i][12].toString():'') : '',
        squad: data[i][13]?data[i][13].toString():'',
        squad_role: data[i][14]?data[i][14].toString():'member',
        status:'active',
        force_change_password: sheet.getLastColumn()>=16 && (data[i][15]===true || String(data[i][15]).toUpperCase()==='TRUE')
      };
    }
  }
  return null;
}
function getUserByEmail(email){
  if(!email) return null;
  const target=normalizeEmail(email);
  if(!target) return null;
  const sheet=getSheet().getSheetByName('Users'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  const hasAllowed = sheet.getLastColumn()>=13;
  for(let i=1;i<data.length;i++){
    if(normalizeEmail(data[i][2])===target && isActiveStatus(data[i][11])){
      return {ymis:normalizeYmis(data[i][0]),name:data[i][1]?data[i][1].toString():'',email:String(data[i][2]||''),role:data[i][3]?data[i][3].toString():'member',can_tick:data[i][6]===true||data[i][6]==='TRUE',allowed_badges: hasAllowed ? (data[i][12]?data[i][12].toString():'') : '',squad:data[i][13]?data[i][13].toString():'',squad_role:data[i][14]?data[i][14].toString():'member'};
    }
  }
  return null;
}
function getAllUsers(){
  // 合併 Users 與成員名單，包含未開登入帳號的團員。
  const users=[]; const seen={};
  const sheet=getSheet().getSheetByName('Users');
  if(sheet){
    const data=sheet.getDataRange().getValues();
    const hasAllowed = sheet.getLastColumn()>=13;
    for(let i=1;i<data.length;i++){
      const y=normalizeYmis(data[i][0]);
      if(!y) continue;
      if(isSuperAdminReserved(data[i][0])) continue;
      if(!isActiveStatus(data[i][11])) continue;
      seen[y]=true;
      users.push({
        ymis:y,
        name:data[i][1]?String(data[i][1]):'',
        email:data[i][2]?String(data[i][2]):'',
        role:data[i][3]?String(data[i][3]):'member',
        can_tick:data[i][6]===true||data[i][6]==='TRUE',
        branch:data[i][5]?String(data[i][5]):'',
        allowed_badges: hasAllowed ? (data[i][12]?String(data[i][12]):'') : '',
        squad: data[i][13]?String(data[i][13]):'',
        squad_role: data[i][14]?String(data[i][14]):'member',
        status:'active',
        roster_only:false
      });
    }
  }
  const mSheet=getSheet().getSheetByName('成員名單');
  if(mSheet){
    const data=mSheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      const y=normalizeYmis(data[i][0]);
      if(!y || isSuperAdminId(y) || seen[y]) continue;
      seen[y]=true;
      users.push({
        ymis:y,
        name:data[i][1]?String(data[i][1]):'',
        email:data[i][4]?String(data[i][4]):'',
        role:'member',
        can_tick:false,
        branch:data[i][3]?String(data[i][3]):'',
        allowed_badges:'',
        squad:data[i][5]?String(data[i][5]):'',
        squad_role:'member',
        status:'active',
        roster_only:true
      });
    }
  }
  return users;
}

function validateToken(token){
  if(!token) return null;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0]===token){
      if(new Date()>new Date(data[i][3])){ sheet.deleteRow(i+1); return null; }
      const ymis=data[i][1].toString();
      // Invalidate sessions issued by the retired direct-password path.
      if(isSuperAdminId(ymis) && String(token).indexOf('sa_')!==0){ sheet.deleteRow(i+1); return null; }
      return ymis;
    }
  }
  return null;
}
function createToken(ymis){
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return null;
  const token=(isSuperAdminId(ymis)?'sa_':'')+generateToken(); const exp=new Date(); exp.setHours(exp.getHours()+24*30);
  sheet.appendRow([token,ymis,now(),Utilities.formatDate(exp,'Asia/Hong_Kong','yyyy-MM-dd HH:mm:ss')]);
  return token;
}
function destroyToken(token){
  if(!token) return;
  const sheet=getSheet().getSheetByName('Tokens'); if(!sheet) return;
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===token){ sheet.deleteRow(i+1); return; } }
}

const PORTAL_SIG_MAX_TTL = 3600;
// 中央登入（A）回打驗票端點：固定常數（VS／RS 同款）。
// 自架部署要改成自己個正式 Vercel 域名；唔可以由請求／前端指定，只准 loopback 覆寫做本地測試。
const SUPER_VERIFY_URL = 'https://scoutbadge.vercel.app/api/verify-super-ticket';
// 同一張票只可以換一次 token：SHA-256(ticket) → CacheService，秒數要長過票本身嘅壽命（60 秒）。
const CENTRAL_TICKET_CACHE_SEC = 120;
function normId(s){
  const v=String(s||'').trim().toUpperCase();
  const m=v.match(/^(\d+)([A-Z]?)$/);
  return m ? (m[1].padStart(4,'0')+m[2]) : v;
}
function bytesToHex(bytes){
  let h='';
  for(let i=0;i<bytes.length;i++){ h+=('0'+(bytes[i]&255).toString(16)).slice(-2); }
  return h;
}
// GAS HMAC API 參數順序為 (value, key, charset)，沒有算法參數。
function hmacHex(key,msg){
  return bytesToHex(Utilities.computeHmacSha256Signature(msg, key, Utilities.Charset.UTF_8));
}
function childIdToYmis(raw){
  const v=String(raw||'').trim();
  if(/^\d{10}$/.test(v)) return v;
  const m=v.match(/_(\d{10})$/); // SCOUT_童_1234567890 / TROOP_0082_1234567890 / ...
  return m ? m[1] : null;
}
function resolveChildrenToYmis(ids){
  const roster={};
  getMembers().forEach(function(m){ roster[m.ymis]=true; });
  const out=[];
  (ids||[]).forEach(function(raw){
    const y=childIdToYmis(raw);
    if(y && roster[y] && out.indexOf(y)<0) out.push(y);
  });
  return out;
}
function verifyPortalSig(p){
  p=p||{};
  const childId=String(p.childId||'').trim();
  const sub=String(p.sub||'').trim();
  const scope=typeof p.scope==='string'?p.scope:'';
  const exp=Number(p.exp);
  const sig=String(p.sig||'').trim().toLowerCase();
  if(!childId || !sub || !scope || !Number.isFinite(exp) || !sig || sig.length>512) return {ok:false};
  const nowS=Math.floor(Date.now()/1000);
  if(exp < nowS-60 || exp > nowS+PORTAL_SIG_MAX_TTL) return {ok:false}; // 過期或遙遠未來
  let parsed=null;
  try{ parsed=JSON.parse(scope); }catch(e){ return {ok:false}; }
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) return {ok:false};
  const expectedGlobal=normId(String(PropertiesService.getScriptProperties().getProperty('PORTAL_GLOBAL_ID')||'').trim());
  if(expectedGlobal && normId(childId)!==expectedGlobal) return {ok:false};
  const expect=hmacHex(getApiKey(), childId+'|'+sub+'|'+scope+'|'+exp);
  if(expect.length!==sig.length) return {ok:false};
  let diff=0;
  for(let i=0;i<sig.length;i++){ diff |= (expect.charCodeAt(i)^sig.charCodeAt(i)); }
  if(diff!==0) return {ok:false};
  if(isSuperAdminId(sub) || /^L\d+$/i.test(sub)) return {ok:false}; // SUPER 行主系統層
  const role=String(parsed.role||'');
  const children=resolveChildrenToYmis(Array.isArray(parsed.children_ids)?parsed.children_ids:[]);
  const targetYmis=String(parsed.targetYmis||'').trim();
  if(/^\d{10}$/.test(sub)){
    const user=getUser(sub);
    if(!user) return {ok:false};
    return {ok:true, identity:{kind:'member', ymis:user.ymis, email:user.email, role:user.role, can_tick:user.can_tick, children:children, targetYmis:targetYmis, sub:sub}};
  }
  const leader=getUserByEmail(sub);
  if(leader){
    return {ok:true, identity:{kind:'leader', ymis:leader.ymis, email:leader.email, role:leader.role, can_tick:leader.can_tick, children:children, targetYmis:targetYmis, sub:sub}};
  }
  // 家長：本團無帳號；「有旅才有超然」—— children_ids 要有本團成員先放行
  if(role==='parent' || (!role && children.length>0)){
    if(!children.length) return {ok:false};
    return {ok:true, identity:{kind:'parent', ymis:'', email:sub, role:'parent', can_tick:false, children:children, targetYmis:targetYmis, sub:sub}};
  }
  // 領袖經有效 sig 登入不要求本地 Users 紀錄。
  return {ok:true, identity:{kind:'leader', ymis:sub, email:sub, role:role||'branch_leader', can_tick:true, children:children, targetYmis:targetYmis, sub:sub}};
}
// 接受本團 apikey、有效 sig 或有效本地 token。
function requireAuthBody(body){
  body=body||{};
  let ok=body.apikey && String(body.apikey)===getApiKey();
  const s=verifyPortalSig(body);
  if(s.ok) ok=true;
  if(!ok && body.token && validateToken(String(body.token))) ok=true;
  if(!ok) return {ok:false};
  return {ok:true, identity:s.ok?s.identity:null};
}
function requireAuthParams(params){
  const p={};
  for(const k in (params||{})) p[k]=String(params[k]);
  let ok=p.apikey && p.apikey===getApiKey();
  const s=verifyPortalSig(p);
  if(s.ok) ok=true;
  if(!ok && p.token && validateToken(p.token)) ok=true;
  if(!ok) return {ok:false};
  return {ok:true, identity:s.ok?s.identity:null};
}
// 家長（sig bearer）可用操作：只限自己子女（聯集），無寫入／審批。
function handleParentAction(action, body, ident){
  const canSee=function(ymis){ return ident.children.indexOf(String(ymis))>=0; };
  if(action==='load'){
    return handleLoad({ymis:null, role:'parent', can_tick:false, children:ident.children});
  }
  if(action==='getOtherBadges'){
    const t=String(body.target_ymis||'');
    if(!canSee(t)) return jsonResponse({success:false,error:'家長帳號只能查看自己子女',code:403});
    return handleGetOtherBadges(t);
  }
  if(action==='getServiceRecords'){
    const t=String(body.target_ymis||'');
    if(!canSee(t)) return jsonResponse({success:false,error:'家長帳號只能查看自己子女',code:403});
    return handleGetServiceRecords(t);
  }
  if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
  if(action==='logout'){ return jsonResponse({success:true}); }
  return jsonResponse({success:false,error:'家長帳號不支援此操作',code:403});
}
// ===== 旅系統：上下游接駁（旅 > 團 > 進度）=====
// 同一份 Code.gs 部署在每一層，每層都是一個節點：
//   上游在自己 Script Properties 登記下游的 1) GAS /exec URL  2) 下游 SHEET KEY（下游的 API_KEY），
//   登記後上游可讀可寫下游（進了上游就等於進了下游）。
//   下游 Script Properties 的 ALLOW_LOCAL_LOGIN 係「直接入口」掣：未設定＝開啟（現有旅團零影響）；
//   寫成其他任何值（包括 false／0／no／串錯字）＝閂口，之後下游只接受帶有效 sig 的上游請求。
// 接入完全自願：唔登記下游、或者登記咗但唔閂口，現有旅團一切照舊。
// 登記資料、sig、nonce 全部只存 Script Properties / Cache，一律不寫入任何工作表。
const LINK_FLAG = 'ALLOW_LOCAL_LOGIN';
const LINK_DOWNSTREAM_PREFIX = 'DOWNSTREAM_';
const LINK_SIG_PURPOSE = 'scoutbadge-troop-sig-v1';
const LINK_SIG_WINDOW_MS = 5 * 60 * 1000;
const LINK_SIG_NONCE_TTL = 600;
const LINK_MAX_SIGNED_BYTES = 900000;
const LINK_EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;
const LINK_SIG_HEX_RE = /^[0-9a-f]{64}$/i;
const LINK_NONCE_RE = /^[0-9A-Za-z_-]{8,64}$/;
const LINK_HASH_RE = /^[0-9a-f]{64}$/i;
const LINK_RESERVED_BODY_KEYS = ['sig','sig_ts','sig_nonce'];
// 上游以 sig 可以在下游執行的 action（本 repo 自己的 action set）。
const LINK_SIG_READ_ACTIONS = ['load','getLoginMode','getLinkState','getMembers','getConfig','getAllUsers','getOtherBadges','getPendingRequests','getApplications','getLogRecords','getLogRequests','getAuditLog'];
const LINK_SIG_WRITE_ACTIONS = ['save','saveOtherBadge','requestComplete','reviewRequest','addMember','addUser','bulkAddUsers','upsertUser','importUsers','importAll','resetPassword','setPw','setStatus','updateUserRole','updatePermissions','saveLogRecord','deleteLogRecord','reviewLogRequest','setLocalLogin'];
// 即使簽名有效都永不接受：本地憑證與設定入口只可由本節點自己開。
const LINK_NEVER_ACTIONS = ['login','apply','logout','changePassword','updateConfig','requestLogRecord','cancelLogRequest','portalLogin'];
const USER_EXPORT_FORMAT = 'scoutbadge-users-export';
const LINK_USERS_HEADERS = ['ymis','name','email','role','password_hash','branch','can_tick','auth_by','auth_date','created_at','last_login','status','allowed_badges','squad','squad_role','force_change_password'];

function linkProps(){ return PropertiesService.getScriptProperties(); }
function toHex(bytes){ let out=''; for(let i=0;i<bytes.length;i++) out+=('0'+(bytes[i]&0xFF).toString(16)).slice(-2); return out; }
function sha256Hex(text){ return hashPassword(String(text===undefined||text===null?'':text)); }
function hmacSha256Hex(message,key){ return toHex(Utilities.computeHmacSha256Signature(String(message),String(key))); }
// sig 密鑰以用途分隔方式由「該節點的 SHEET KEY」推導：
//   驗證入站 → 用本機 API_KEY（上游登記的就是這條）；簽署出站 → 用已登記的下游 SHEET KEY。
// 推導結果唔另外儲存、唔寫入工作表。
function linkSigKeyFor(key){ return hmacSha256Hex(LINK_SIG_PURPOSE,String(key||'')); }
function linkSigKey(){ return linkSigKeyFor(getApiKey()); }
function linkNonce(){ return Utilities.getUuid().replace(/-/g,''); }
// 常數時間比較：兩邊先各自 SHA-256 再比對，避免逐字元短路洩漏。
function safeEqualText(a,b){ return sha256Hex(String(a||''))===sha256Hex(String(b||'')); }
function linkCanonical(action,ts,nonce,digest){ return [String(action||''),String(ts||''),String(nonce||''),String(digest||'')].join('\n'); }
function linkIsTrue(v){ return v===true || String(v).toUpperCase()==='TRUE' || String(v)==='1'; }
function maskSecret(v){ v=String(v||''); return v.length<=12?'****':v.substring(0,8)+'…'+v.substring(v.length-4); }
// 上游傳來的操作者標籤：只留安全字元，避免經 auth_by／操作紀錄寫入工作表時變成算式。
function linkActorLabel(v){
  const cleaned=String(v||'').trim().replace(/[^0-9A-Za-z_.@-]/g,'').substring(0,40);
  return cleaned||'upstream';
}
function getLinkNodeId(){ try{ return safeSheetText(getSheet().getName(),80)||'node'; }catch(e){ return 'node'; } }

// ---- 直接入口掣（寫在下游 Script Properties）----
// 未設定＝開啟（現有旅團零影響）；只有 1/true/yes/on/open 視為開啟，其餘任何值＝閂口（fail closed）。
function localLoginAllowed(){
  const v=String(linkProps().getProperty(LINK_FLAG)||'').trim().toLowerCase();
  if(!v) return true;
  return ['1','true','yes','on','open'].indexOf(v)>=0;
}
// 舊名相容：ecportal 整合文件及舊選單仍用這個名稱查掣值。
function getDownstreamAccessConfig(){ return localLoginAllowed(); }
function setLocalLoginAllowed(allow,actor){
  linkProps().setProperty(LINK_FLAG,allow?'true':'false');
  writeAudit(linkActorLabel(actor||'system'),allow?'link_local_login_on':'link_local_login_off',getLinkNodeId(),allow?'直接入口開啟':'直接入口已閂，只收上游 sig');
  return allow?'true':'false';
}
function linkClosedResponse(action){
  return {
    success:false, local_login:false, upstream_only:true,
    error:'此進度追蹤後端的直接入口已閂（'+LINK_FLAG+' 已設為閂口值），只接受上游簽名（sig）請求；請由上游（旅／團／支部）入口使用。'+(action?'（已拒絕：'+action+'）':'')
  };
}
// 閂口後仍然放行的本地 action，只有兩類：
//   1) 中央登入（A，與旅系統閘門脫鉤）；
//   2) 舊 Portal 入口掣（setDownstreamAccess 本身會再驗 portal sig，唔會因為閂口而開唔返；
//      getDownstreamAccess 亦要讀得返掣值，否則舊上游會失去重開路徑）。
// 兩者都要先通過 requireAuthBody（API Key／portal sig／本地 token），唔係匿名入口。
function isLinkExemptLocalAction(action){
  return action==='superLogin' || action==='setDownstreamAccess' || action==='getDownstreamAccess';
}
function getLinkState(){
  const raw=String(linkProps().getProperty(LINK_FLAG)||'');
  return {
    success:true, node:getLinkNodeId(),
    allow_local_login:localLoginAllowed(),
    link_flag_set:raw?String(raw):'（未設定＝開啟）',
    downstreams:listDownstreams(),
    api_key_masked:maskSecret(getApiKey()),
    export_format:USER_EXPORT_FORMAT
  };
}

// ---- sig 產生／驗證 ----
function stripLinkSigFields(body){
  const out={};
  for(const k in (body||{})){ if(LINK_RESERVED_BODY_KEYS.indexOf(k)>=0) continue; out[k]=(body||{})[k]; }
  return out;
}
// 兩種傳送方式共用同一套驗證：
//   query：?sig=&sts=&snonce=     digest = SHA-256(原始 body 字串)
//   body ：{...,sig,sig_ts,sig_nonce}  digest = SHA-256(JSON.stringify(去掉三個 sig 欄位後的 body))
// 上游一次送齊兩種，GAS 302 轉址即使遺失其中一種仍可驗證。
function readLinkSig(e,body,rawBody){
  const params=(e&&e.parameter)||{};
  const qSig=String(params.sig||''),qTs=String(params.sts||''),qNonce=String(params.snonce||'');
  if(qSig&&qTs&&qNonce) return {sig:qSig,ts:qTs,nonce:qNonce,digest:sha256Hex(String(rawBody||'')),transport:'query'};
  const bSig=String((body&&body.sig)||''),bTs=String((body&&body.sig_ts)||''),bNonce=String((body&&body.sig_nonce)||'');
  if(bSig&&bTs&&bNonce){
    let canonicalPayload='';
    try{ canonicalPayload=JSON.stringify(stripLinkSigFields(body)); }catch(err){ return null; }
    return {sig:bSig,ts:bTs,nonce:bNonce,digest:sha256Hex(canonicalPayload),transport:'body'};
  }
  return null;
}
function makeLinkSig(action,rawPayload,key){
  const ts=String(Date.now()),nonce=linkNonce();
  return {sig:hmacSha256Hex(linkCanonical(action,ts,nonce,sha256Hex(String(rawPayload||''))),linkSigKeyFor(key)),ts:ts,nonce:nonce};
}
function verifyLinkSig(e,body,rawBody){
  try{
    const s=readLinkSig(e,body,rawBody);
    if(!s) return false;
    if(String(rawBody||'').length>LINK_MAX_SIGNED_BYTES) return false;
    if(!LINK_SIG_HEX_RE.test(String(s.sig))) return false;
    if(!LINK_NONCE_RE.test(String(s.nonce))) return false;
    const ts=parseInt(s.ts,10);
    if(!isFinite(ts)||Math.abs(Date.now()-ts)>LINK_SIG_WINDOW_MS) return false;
    const action=String((body&&body.action)||'');
    if(!safeEqualText(hmacSha256Hex(linkCanonical(action,s.ts,s.nonce,s.digest),linkSigKey()),s.sig)) return false;
    // 防重放：同一 nonce 只可用一次（CacheService，不入工作表）。
    // 一次請求可能同時帶 query 及 body 兩組 sig；兩組 nonce 都要消耗，
    // 否則「第一次只驗到其中一組」時，重放可用另一組 nonce 再入一次。
    const cache=CacheService.getScriptCache();
    const nonces=[String(s.nonce)];
    const queryNonce=String(((e&&e.parameter)||{}).snonce||'');
    const bodyNonce=String((body&&body.sig_nonce)||'');
    [queryNonce,bodyNonce].forEach(function(n){
      if(LINK_NONCE_RE.test(n)&&nonces.indexOf(n)<0) nonces.push(n);
    });
    const keys=nonces.map(function(n){ return 'link-nonce:'+sha256Hex(n).substring(0,40); });
    for(let i=0;i<keys.length;i++){ if(cache.get(keys[i])) return false; }
    for(let i=0;i<keys.length;i++){ cache.put(keys[i],'1',LINK_SIG_NONCE_TTL); }
    return true;
  }catch(err){ return false; }
}

// ---- 上游：登記下游（只存 Script Properties，不寫入 SHEET）----
function normalizeLinkId(id){ return String(id||'').trim().replace(/[^0-9A-Za-z_-]/g,'').substring(0,32); }
function isTrustedDownstreamUrl(url){ return LINK_EXEC_URL_RE.test(String(url||'').trim()); }
function registerDownstream(id,url,key,name){
  id=normalizeLinkId(id);
  if(!id) return {success:false,error:'下游編號不可留空（只可用英文、數字、底線、連字號）'};
  if(!isTrustedDownstreamUrl(url)) return {success:false,error:'下游 URL 必須是正式 GAS /exec（https://script.google.com/macros/s/.../exec）'};
  key=String(key||'').trim();
  if(key.length<8) return {success:false,error:'下游 SHEET KEY 太短；請抄下游 Script Properties 的 API_KEY'};
  const props=linkProps();
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_URL',String(url).trim().replace(/\/$/,''));
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_KEY',key);
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_NAME',String(name||'').trim().substring(0,80));
  props.setProperty(LINK_DOWNSTREAM_PREFIX+id+'_AT',now());
  writeAudit('system','link_register_downstream',id,'已登記下游 URL 及 SHEET KEY（只存 Script Properties）');
  return {success:true,id:id,message:'已登記下游 '+id};
}
function getDownstream(id){
  id=normalizeLinkId(id);
  if(!id) return null;
  const props=linkProps();
  const url=String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_URL')||'').trim();
  const key=String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_KEY')||'').trim();
  if(!url||!key) return null;
  return {id:id,url:url,key:key,name:String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_NAME')||''),registered_at:String(props.getProperty(LINK_DOWNSTREAM_PREFIX+id+'_AT')||'')};
}
function listDownstreams(){
  const props=linkProps(),ids={},all=props.getProperties();
  for(const k in all){
    const m=String(k).match(/^DOWNSTREAM_(.+)_URL$/);
    if(m) ids[m[1]]=true;
  }
  const out=[];
  for(const id in ids){
    const d=getDownstream(id);
    if(!d) continue;
    out.push({id:d.id,name:d.name,registered_at:d.registered_at,url_masked:maskSecret(d.url),has_key:true});
  }
  out.sort(function(a,b){ return String(a.id).localeCompare(String(b.id)); });
  return out;
}
function removeDownstream(id){
  id=normalizeLinkId(id);
  if(!id) return {success:false,error:'下游編號不正確'};
  const props=linkProps();
  ['_URL','_KEY','_NAME','_AT'].forEach(function(s){ props.deleteProperty(LINK_DOWNSTREAM_PREFIX+id+s); });
  writeAudit('system','link_remove_downstream',id,'已移除下游登記');
  return {success:true,message:'已移除下游 '+id};
}
// 上游打下游：body 內含 sig（digest 綁去掉 sig 欄位後的 body），query 再帶一組 sig（digest 綁完整 body）。
function callDownstream(downstreamId,action,payload){
  const d=getDownstream(downstreamId);
  if(!d) return {success:false,error:'未登記下游 '+downstreamId+'：請先登記下游 URL 及 SHEET KEY'};
  if(String(action||'')==='') return {success:false,error:'缺少 action'};
  try{
    const body=stripLinkSigFields(payload||{});
    body.action=action;
    const rawPayload=JSON.stringify(body);
    const inner=makeLinkSig(action,rawPayload,d.key);
    body.sig=inner.sig; body.sig_ts=inner.ts; body.sig_nonce=inner.nonce;
    const rawOutgoing=JSON.stringify(body);
    const outer=makeLinkSig(action,rawOutgoing,d.key);
    const url=d.url+'?sig='+encodeURIComponent(outer.sig)+'&sts='+encodeURIComponent(outer.ts)+'&snonce='+encodeURIComponent(outer.nonce);
    const response=UrlFetchApp.fetch(url,{
      method:'post', contentType:'application/json', payload:rawOutgoing,
      muteHttpExceptions:true, followRedirects:true, validateHttpsCertificates:true
    });
    const code=response.getResponseCode();
    const text=response.getContentText();
    let json=null; try{ json=JSON.parse(text); }catch(err){ json=null; }
    if(!json) return {success:false,error:'下游回應異常（HTTP '+code+'）：請檢查下游部署版本、存取權（任何人）及登記的 SHEET KEY'};
    return json;
  }catch(err){
    return {success:false,error:'無法連接下游：'+(err&&err.message?err.message:String(err))};
  }
}
function pingDownstream(downstreamId){ return callDownstream(downstreamId,'getLinkState',{}); }
// 掣在上游：由上游閂／開下游的直接入口。
function setDownstreamLocalLogin(downstreamId,allow){
  const r=callDownstream(downstreamId,'setLocalLogin',{allow:allow?'true':'false'});
  if(r&&r.success) writeAudit('system','link_set_downstream_gate',normalizeLinkId(downstreamId),allow?'下游直接入口開啟':'下游直接入口已閂（只收 sig）');
  return r;
}

// ---- 下游：簽名請求路由 ----
// 上游簽名請求的操作者身份（唔要求下游有 row）；標籤先消毒，寫入工作表時亦經 safeSheetText。
function linkManager(body){
  const onBehalf=linkActorLabel(body&&body.on_behalf);
  const role=VALID_ROLES.indexOf(String((body&&body.on_behalf_role)||''))>=0?String(body.on_behalf_role):'admin';
  return {ymis:onBehalf,name:'上游同步（'+onBehalf+'）',email:'',role:role,can_tick:true};
}
// 少數管理 handler（重設密碼／改角色／改權限）會用 getUser(managerYmis) 再核對本地權限；
// 上游操作者不一定有本地帳戶，所以只在真的找不到時才退回本機管理員，
// 而審計紀錄照樣記 'upstream' 及 on_behalf（見 handleSignedRequest）。
function linkManagerYmisFor(body){
  const onBehalf=linkActorLabel(body&&body.on_behalf);
  return getUser(onBehalf)?onBehalf:ADMIN_YMIS;
}
function handleSignedRequest(action,body){
  if(LINK_NEVER_ACTIONS.indexOf(action)>=0){
    return jsonResponse({success:false,error:'此操作永不可經上游簽名（sig）執行：'+action});
  }
  if(LINK_SIG_READ_ACTIONS.indexOf(action)<0&&LINK_SIG_WRITE_ACTIONS.indexOf(action)<0){
    return jsonResponse({success:false,error:'上游簽名請求不接受此操作：'+action});
  }
  const manager=linkManager(body);
  const actor=manager.ymis;
  if(LINK_SIG_WRITE_ACTIONS.indexOf(action)>=0){
    writeAudit('upstream','link_signed_'+action,actor,safeSheetText(body.on_behalf_name,80)+'（sig 已驗證）');
  }
  if(action==='getLinkState') return jsonResponse(getLinkState());
  if(action==='setLocalLogin'){
    const allow=['1','true','yes','on','open'].indexOf(String(body.allow||'').trim().toLowerCase())>=0;
    setLocalLoginAllowed(allow,'upstream:'+actor);
    return jsonResponse({success:true,allow_local_login:allow,message:allow?'直接入口已開啟':'直接入口已閂，只收上游 sig'});
  }
  if(action==='load') return handleLoad();
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
  if(action==='getMembers') return jsonResponse({success:true,members:getMembers()});
  if(action==='getConfig') return handleGetConfig();
  if(action==='getAllUsers') return jsonResponse({success:true,users:getAllUsers()});
  if(action==='getOtherBadges') return handleGetOtherBadges(String(body.target_ymis||''));
  if(action==='getPendingRequests') return handleGetPendingRequests();
  if(action==='getApplications') return handleGetApplications();
  if(action==='getLogRecords') return handleGetLogRecords(manager);
  if(action==='getLogRequests') return handleGetLogRequests(manager);
  if(action==='getAuditLog') return handleGetAuditLog();
  if(action==='save') return handleSave(body.changes||[],String(body.confirmer||actor));
  if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records||[]);
  if(action==='requestComplete'){
    // body 內嘅姓名會寫入工作表，先消毒（防上游傳來嘅文字變成算式）。
    const req=stripLinkSigFields(body);
    req.name=safeSheetText(body.name,60);
    return handleRequestComplete(req,actor);
  }
  if(action==='reviewRequest') return handleReviewRequest(body.request_id,body.decision,body.review_note,actor,body.confirmed_date);
  if(action==='addMember') return handleAddMember(body.ymis,safeSheetText(body.name,60),body.squad||body.branch||'',body.squad_role||'member');
  if(action==='addUser') return handleAddUser(body,manager);
  if(action==='bulkAddUsers') return handleBulkAddUsers(body.users||[],manager);
  if(action==='upsertUser') return jsonResponse(linkUpsertUser(body.user||body,actor));
  if(action==='importUsers') return handleSignedImport(body,actor);
  if(action==='importAll') return handleImportAll(body);
  if(action==='resetPassword') return handleResetPassword(body.target_ymis,linkManagerYmisFor(body),body.new_password);
  if(action==='setPw') return handleSetPw(body.ymis||body.target_ymis||body.sub,body.password_hash||body.new_password);
  if(action==='setStatus') return handleSetStatus(body.ymis||body.target_ymis||body.sub,body.status);
  if(action==='updateUserRole'||action==='updatePermissions') return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,linkManagerYmisFor(body),body.allowed_badges,body.squad,body.squad_role);
  if(action==='saveLogRecord') return handleSaveLogRecord(body.records||(body.record?[body.record]:[]),actor,safeSheetText(body.recorder_name,60));
  if(action==='deleteLogRecord') return handleDeleteLogRecord(body.record_id,actor);
  if(action==='reviewLogRequest') return handleReviewLogRequest(body.request_id,body.decision,body.review_note,manager);
  return jsonResponse({success:false,error:'上游簽名請求不接受此操作：'+action});
}

// ---- 開戶：上游揀團開戶，經 sig 落下游寫 ----
function linkHeaderIndex(sheet){
  const map={};
  if(!sheet||sheet.getLastColumn()<1) return map;
  sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].forEach(function(h,i){ map[String(h).trim()]=i; });
  return map;
}
function linkReadUserRow(ymis){
  const sheet=getSheet().getSheetByName('Users');
  if(!sheet) return null;
  const map=linkHeaderIndex(sheet);
  const data=sheet.getDataRange().getValues();
  const target=normalizeYmis(ymis);
  for(let i=1;i<data.length;i++){
    if(normalizeYmis(map.ymis===undefined?'':data[i][map.ymis])===target) return {row:i+1,map:map,data:data[i]};
  }
  return null;
}
function linkCell(row,map,name){ return map[name]===undefined?'':row[map[name]]; }
// ① 上游本地開戶（角色權限、YMIS／Email 唯一性照舊）→ ② 讀回 password_hash → ③ sig 打下游 upsertUser。
// 兩邊同一個 hash，所以同一個臨時密碼兩邊都啱用；首登仍然強制改密碼。
function createAccountForDownstream(downstreamId,rawUser,manager){
  const d=getDownstream(downstreamId);
  if(!d) return {success:false,error:'未登記下游 '+downstreamId+'：請先登記下游 URL 及 SHEET KEY'};
  let local=null;
  try{ local=JSON.parse(handleAddUser(rawUser||{},manager||{role:'admin',can_tick:true}).getContent()); }
  catch(e){ return {success:false,error:'上游開戶失敗：'+((e&&e.message)||e)}; }
  if(!local||local.success!==true) return {success:false,error:(local&&local.error)||'上游開戶失敗'};
  const ymis=normalizeYmis(local.ymis||(rawUser&&rawUser.ymis));
  const rec=linkReadUserRow(ymis);
  if(!rec) return {success:false,error:'上游已開戶但讀不回帳戶，未能同步下游'};
  const mirror={
    ymis:normalizeYmis(linkCell(rec.data,rec.map,'ymis')),
    name:String(linkCell(rec.data,rec.map,'name')||''),
    email:String(linkCell(rec.data,rec.map,'email')||''),
    role:String(linkCell(rec.data,rec.map,'role')||'member'),
    branch:String(linkCell(rec.data,rec.map,'branch')||''),
    squad:String(linkCell(rec.data,rec.map,'squad')||''),
    can_tick:linkIsTrue(linkCell(rec.data,rec.map,'can_tick')),
    status:'active',
    force_change_password:true,
    password_hash:String(linkCell(rec.data,rec.map,'password_hash')||'')
  };
  const pushed=callDownstream(downstreamId,'upsertUser',{user:mirror,on_behalf:linkActorLabel(manager&&manager.ymis)});
  if(!pushed||pushed.success!==true){
    return {success:false,error:'上游已開戶，但下游寫入失敗：'+((pushed&&pushed.error)||'下游無回應'),ymis:mirror.ymis,downstream:normalizeLinkId(downstreamId)};
  }
  writeAudit(linkActorLabel(manager&&manager.ymis),'link_push_user',safeSheetText(mirror.ymis,40),'帳戶已同步至下游 '+normalizeLinkId(downstreamId));
  return {success:true,ymis:mirror.ymis,name:mirror.name,downstream:normalizeLinkId(downstreamId),message:'上游已開戶並經 sig 同步下游'};
}

// ---- 吐 JSON（搬舊數）：匯出含 hash，只寫去私人 Drive 檔，绝不寫入工作表 ----
function collectUsersForExport(){
  const sheet=getSheet().getSheetByName('Users');
  const out=[];
  if(!sheet) return out;
  const map=linkHeaderIndex(sheet);
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    const ymis=normalizeYmis(linkCell(data[i],map,'ymis'));
    if(!ymis||isSuperAdminReserved(ymis)) continue;
    out.push({
      ymis:ymis,
      name:String(linkCell(data[i],map,'name')||''),
      email:String(linkCell(data[i],map,'email')||''),
      role:String(linkCell(data[i],map,'role')||'member'),
      branch:String(linkCell(data[i],map,'branch')||''),
      squad:String(linkCell(data[i],map,'squad')||''),
      can_tick:linkIsTrue(linkCell(data[i],map,'can_tick')),
      allowed_badges:String(linkCell(data[i],map,'allowed_badges')||''),
      status:String(linkCell(data[i],map,'status')||'active')||'active',
      force_change_password:linkIsTrue(linkCell(data[i],map,'force_change_password')),
      password_hash:String(linkCell(data[i],map,'password_hash')||''),
      auth_by:String(linkCell(data[i],map,'auth_by')||''),
      created_at:linkCell(data[i],map,'created_at')?String(linkCell(data[i],map,'created_at')):'',
      last_login:linkCell(data[i],map,'last_login')?String(linkCell(data[i],map,'last_login')):''
    });
  }
  return out;
}
function buildUsersExport(){
  const users=collectUsersForExport();
  return {format:USER_EXPORT_FORMAT,schema:1,exported_at:now(),node:getLinkNodeId(),count:users.length,users:users};
}
function exportUsersJsonText(){ return JSON.stringify(buildUsersExport(),null,2); }
function exportUsersJson(){
  const payload=buildUsersExport();
  const count=payload.count;
  const stamp=Utilities.formatDate(new Date(),'Asia/Hong_Kong','yyyyMMdd-HHmmss');
  let fileId='',fileUrl='',driveError='';
  try{
    const ssFile=DriveApp.getFileById(getSheet().getId());
    const folder=ssFile.getParents().hasNext()?ssFile.getParents().next():DriveApp.getRootFolder();
    const file=folder.createFile('scoutbadge-users-'+stamp+'.json',JSON.stringify(payload,null,2),'application/json');
    try{ file.setSharingAccess(DriveApp.Access.PRIVATE); file.setSharingPermission(DriveApp.Permission.NONE); }catch(e){}
    fileId=file.getId(); fileUrl=file.getUrl();
  }catch(e){ driveError=(e&&e.message)?e.message:String(e); }
  writeAudit('system','export_users_json',count+' accounts',fileId?('Drive 檔 '+fileId+'（含 hash，匯入後請刪除）'):('Drive 寫入失敗：'+driveError+'；JSON 已輸出到執行紀錄'));
  try{ Logger.log(JSON.stringify(payload,null,2)); }catch(e){}
  return {success:true,count:count,file_id:fileId,file_url:fileUrl,drive_error:driveError};
}

// ---- 匯入：逐個 upsertUser 直插 hash（保留舊密碼）----
// 鏡像／匯入專用寫入。只接受 64 位 SHA-256 password_hash，不接受明文密碼；
// 既有帳戶（同 YMIS，或同 Email 認回同一身份）→ 更新；冇提供 hash 就保留原密碼；冪等。
function linkUpsertUser(raw,actor){
  raw=raw||{};
  actor=linkActorLabel(actor);
  const ymis=normalizeYmis(raw.ymis||raw.scout_id);
  const email=String(raw.email||'').trim().substring(0,160);
  const hash=String(raw.password_hash||'').trim().toLowerCase();
  if(!ymis) return {success:false,ymis:'',error:'缺少 YMIS'};
  if(isSuperAdminReserved(ymis)) return {success:false,ymis:ymis,error:'此帳號已被保留，不可操作'};
  if(raw.password!==undefined&&raw.password!==null&&String(raw.password)!=='') return {success:false,ymis:ymis,error:'匯入不可帶明文 password；請只用 password_hash'};
  if(hash&&!LINK_HASH_RE.test(hash)) return {success:false,ymis:ymis,error:'password_hash 必須是 64 位 SHA-256 hex'};
  if(!/^\d{10}$/.test(ymis)&&!/^L\d+$/i.test(ymis)) return {success:false,ymis:ymis,error:'YMIS 須為 10 位數字或 L 編號'};
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {success:false,ymis:ymis,error:'Email 格式不正確'};
  const role=VALID_ROLES.indexOf(String(raw.role||''))>=0?String(raw.role):'member';
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(20000)) return {success:false,ymis:ymis,error:'系統正處理另一項寫入，請稍後重試'};
  try{
    let sheet=getSheet().getSheetByName('Users');
    if(!sheet){ sheet=getSheet().insertSheet('Users'); sheet.appendRow(LINK_USERS_HEADERS); }
    ensureUsersHeaders(sheet);
    const map=linkHeaderIndex(sheet);
    const data=sheet.getDataRange().getValues();
    let row=-1;
    for(let i=1;i<data.length;i++){ if(normalizeYmis(linkCell(data[i],map,'ymis'))===ymis){ row=i+1; break; } }
    if(row<0&&email){
      for(let i=1;i<data.length;i++){ if(normalizeEmail(linkCell(data[i],map,'email'))===normalizeEmail(email)){ row=i+1; break; } }
    }
    if(row<0&&!hash) return {success:false,ymis:ymis,error:'新增帳戶必須帶 password_hash（匯入只接受 hash）'};
    // YMIS／Email 唯一性：同 YMIS 認回同一身份係更新，撞到其他帳戶就拒。
    const conflict=uniquenessError(ymis,email,{excludeYmis:ymis,checkRoster:false,checkPending:false});
    if(conflict) return {success:false,ymis:ymis,error:conflict};
    const name=safeSheetText(raw.name,100)||(row>0?String(linkCell(data[row-1],map,'name')||''):'');
    const branch=safeSheetText(raw.branch,100);
    const squad=safeSheetText(raw.squad,100);
    const status=['active','inactive','transferred_out','disabled','deleted'].indexOf(String(raw.status||''))>=0?String(raw.status):'active';
    const canTick=canUserTick(role)&&(raw.can_tick===undefined?role!=='member':linkIsTrue(raw.can_tick));
    const allowed=String(raw.allowed_badges===undefined||raw.allowed_badges===null?'':raw.allowed_badges);
    const force=raw.force_change_password===undefined?(row>0?linkIsTrue(linkCell(data[row-1],map,'force_change_password')):false):linkIsTrue(raw.force_change_password);
    if(!name) return {success:false,ymis:ymis,error:'姓名不可留空'};
    if(row>0){
      const setCol=function(colName,val){ if(map[colName]!==undefined) sheet.getRange(row,map[colName]+1).setValue(val); };
      setCol('name',name);
      if(email) setCol('email',email);
      setCol('role',role);
      if(branch) setCol('branch',branch);   // 冇帶 branch 就唔洗走下游既有支部
      if(squad) setCol('squad',squad);
      setCol('can_tick',canTick);
      setCol('status',status);
      setCol('force_change_password',force);
      if(hash) setCol('password_hash',hash);
      if(allowed!=='') setCol('allowed_badges',allowed);
      else if(!String(linkCell(data[row-1],map,'allowed_badges')||'')) setCol('allowed_badges',role==='member'?'':'*');
      setCol('auth_by',actor);
      setCol('auth_date',now());
      syncRosterRow(ymis,{name:name,email:email,squad:squad});
      writeAudit(actor,'link_upsert_update',ymis,'上游／匯入更新帳戶'+(hash?'（直插 hash）':'（保留原密碼）'));
      return {success:true,ymis:ymis,action:'updated',password_kept:!hash};
    }
    const width=Math.max(sheet.getLastColumn(),1);
    const newRow=new Array(width).fill('');
    const setNew=function(colName,val){ if(map[colName]!==undefined) newRow[map[colName]]=val; };
    setNew('ymis',ymis); setNew('name',name); setNew('email',email); setNew('role',role);
    setNew('password_hash',hash); setNew('branch',branch); setNew('squad',squad);
    setNew('can_tick',canTick); setNew('auth_by',actor); setNew('auth_date',now());
    setNew('created_at',String(raw.created_at||'')||now());
    setNew('last_login',String(raw.last_login||''));
    setNew('status',status);
    setNew('allowed_badges',allowed!==''?allowed:(role==='member'?'':'*'));
    setNew('force_change_password',force);
    sheet.appendRow(newRow);
    ensureRosterRow(ymis,name,email,squad);
    writeAudit(actor,'link_upsert_create',ymis,'上游／匯入新增帳戶（直插 hash，保留舊密碼）');
    return {success:true,ymis:ymis,action:'created',password_kept:false};
  } finally { lock.releaseLock(); }
}
function handleUpsertUserLink(raw,actor){ return jsonResponse(linkUpsertUser(raw,actor)); }
function importUsersFromText(text,actor){
  actor=linkActorLabel(actor);
  let parsed=null;
  try{ parsed=JSON.parse(String(text||'')); }catch(e){ return {success:false,error:'JSON 格式不正確：'+((e&&e.message)||e)}; }
  const list=Array.isArray(parsed)?parsed:((parsed&&Array.isArray(parsed.users))?parsed.users:null);
  if(!list) return {success:false,error:'找不到 users 陣列；請使用「匯出 JSON（含 hash）」產生的檔案'};
  if(!list.length) return {success:true,count:0,created:0,updated:0,failed:0,results:[],message:'檔案內沒有帳戶'};
  if(list.length>2000) return {success:false,error:'一次最多匯入 2000 筆，請分批'};
  const results=[];
  let created=0,updated=0,failed=0;
  for(let i=0;i<list.length;i++){
    const r=linkUpsertUser(list[i],actor);
    if(r&&r.success){ if(r.action==='created') created++; else updated++; }
    else failed++;
    results.push({ymis:String((list[i]&&list[i].ymis)||''),success:!!(r&&r.success),action:(r&&r.action)||'',error:(r&&r.error)||''});
  }
  writeAudit(actor,'link_import_users','新增 '+created+'／更新 '+updated,'失敗 '+failed+'（共 '+list.length+' 筆）');
  return {success:failed===0,count:list.length,created:created,updated:updated,failed:failed,results:results,message:'匯入完成：新增 '+created+'、更新 '+updated+'、失敗 '+failed};
}
function importUsersFromDrive(fileIdOrUrl,actor){
  const input=String(fileIdOrUrl||'').trim();
  if(!input) return {success:false,error:'請貼上 Drive 檔案 ID 或連結'};
  const matched=input.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  const fileId=matched?matched[1]:input.replace(/\?.*$/,'');
  let text='';
  try{ text=DriveApp.getFileById(fileId).getBlob().getDataAsString(); }
  catch(e){ return {success:false,error:'讀不到 Drive 檔案：'+((e&&e.message)||e)}; }
  return importUsersFromText(text,actor);
}
function handleSignedImport(body,actor){
  if(Array.isArray(body.users)) return jsonResponse(importUsersFromText(JSON.stringify({users:body.users}),actor));
  if(typeof body.json==='string') return jsonResponse(importUsersFromText(body.json,actor));
  if(typeof body.drive_file_id==='string') return jsonResponse(importUsersFromDrive(body.drive_file_id,actor));
  return jsonResponse({success:false,error:'importUsers 需要 users[]、json 字串或 drive_file_id'});
}

// ===== API =====
function doGet(e){
  const action=String((e&&e.parameter&&e.parameter.action)||'');
  // 旅系統：閂口後直接入口一律拒絕（簽名請求一律走 doPost，唔收 GET 帶 sig）。
  if(!localLoginAllowed()) return jsonResponse(linkClosedResponse(action));
  const auth=requireAuthParams(e.parameter);
  if(!auth.ok) return jsonResponse({success:false,error:'未授權：缺少 API Key 或有效簽名',code:403});
  if(action==='load'){
    const reqKey=e.parameter.apikey;
    const reqToken=e.parameter.token;
    if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key',code:403});
    if(reqToken && !validateToken(reqToken)) return jsonResponse({success:false,error:'Token 無效或過期',code:401});
    let loadUser=null;
    if(reqToken){ const ly=validateToken(reqToken); if(ly) loadUser=getUser(ly); }
    if(!loadUser && auth.identity && auth.identity.kind==='parent'){
      loadUser={ymis:null, role:'parent', can_tick:false, children:auth.identity.children};
    }
    return handleLoad(loadUser);
  }
  if(action==='health' || action==='diagnose' || action==='checkSheets'){
    return jsonResponse({success:false,error:'此檢查不可公開使用'});
  }
  if(action==='getLoginMode') return jsonResponse({success:true,login_mode:'standalone',local_login:localLoginAllowed(),upstream_only:!localLoginAllowed()});
  return jsonResponse({success:false,error:'Unknown action: ' + action});
}
function doPost(e){
  try{
    const rawBody=String((e&&e.postData&&e.postData.contents)||'{}');
    const body=JSON.parse(rawBody||'{}');
    const action=body.action;

    // 旅系統：上游簽名（sig）請求優先路由（簽名綁定 action 及原始 body，一律 POST）。
    if(verifyLinkSig(e,body,rawBody)) return handleSignedRequest(action,body);

    // 旅系統：直接入口掣。閂口後本地入口一律拒絕，只回「只接受上游簽名（sig）」；
    // 例外只有中央登入（A，與旅系統閘門脫鉤）及舊 Portal 入口掣（自身會再驗 portal sig）。
    if(!localLoginAllowed() && !isLinkExemptLocalAction(action)) return jsonResponse(linkClosedResponse(action));

    const auth=requireAuthBody(body);
    if(!auth.ok) return jsonResponse({success:false,error:'未授權：缺少 API Key 或有效簽名',code:403});

    const isSig = auth.identity !== null;

    if(action==='setDownstreamAccess') return handleSetDownstreamAccess(body, isSig);
    if(action==='getDownstreamAccess') return jsonResponse({success:true, allowLocal: localLoginAllowed()});
    if(action==='superLogin') return handleSuperLogin(body.login_id,body.super_ticket);
    if(action==='login') return handleLogin(body.login_id,body.password);
    if(action==='logout'){ destroyToken(body.token); return jsonResponse({success:true}); }
    if(action==='apply') return handleApply(body.ymis,body.name,body.email,body.requested_role||'member',body.branch);

    if(action==='portalLogin'){
      const s=verifyPortalSig(body);
      if(!s.ok) return jsonResponse({success:false,error:'簽名驗證失敗',code:403});
      const id=s.identity;
      if(id.kind==='parent'){
        return jsonResponse({success:true,auth_mode:'sig',user:{ymis:'',name:id.email,role:'parent',email:id.email},visible_children:id.children});
      }
      let u=id.kind==='member'?getUser(id.ymis):getUserByEmail(id.email);
      if(!u && id.kind==='leader'){
        u = {
          ymis: id.ymis || id.email,
          name: id.email,
          email: id.email,
          role: id.role || 'branch_leader',
          can_tick: true,
          status: 'active'
        };
      }
      if(!u) return jsonResponse({success:false,error:'找不到此帳號',code:404});
      const token=createToken(u.ymis);
      if(!token) return jsonResponse({success:false,error:'登入服務暫時無法使用'});
      return jsonResponse({success:true,auth_mode:'token',token:token,user:u});
    }
    if(action==='getRegistrySafe'){
      if(!body.apikey || String(body.apikey)!==getApiKey()) return jsonResponse({success:false,error:'未授權：getRegistrySafe 只接受 API Key',code:403});
      return jsonResponse({success:true,members:getMembers()});
    }

    if(action==='exportAll'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed && body.token){
        const tkYmis = validateToken(body.token);
        const tkUser = tkYmis ? getUser(tkYmis) : null;
        if(tkUser && getRoleLevel(tkUser.role) >= 40) allowed = true;
      }
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleExportAll(body.include_hash === true || body.include_hash === 'true');
    }

    if(action==='upsertUser'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed && body.token){
        const tkYmis = validateToken(body.token);
        const tkUser = tkYmis ? getUser(tkYmis) : null;
        if(tkUser && getRoleLevel(tkUser.role) >= 40) allowed = true;
      }
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleUpsertUser(body);
    }

    if(action==='setPw'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleSetPw(body.ymis || body.sub, body.password_hash || body.new_password);
    }

    if(action==='setStatus'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleSetStatus(body.ymis || body.sub, body.status);
    }

    if(action==='verifyPw'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleVerifyPw(body.ymis || body.sub, body.password_hash || body.password);
    }

    if(action==='importAll'){
      let allowed = false;
      if(body.apikey && String(body.apikey) === getApiKey()) allowed = true;
      if(!allowed && auth.identity && auth.identity.kind === 'leader') allowed = true;
      if(!allowed && body.token){
        const tkYmis = validateToken(body.token);
        const tkUser = tkYmis ? getUser(tkYmis) : null;
        if(tkUser && getRoleLevel(tkUser.role) >= 40) allowed = true;
      }
      if(!allowed) return jsonResponse({success:false, error:'未授權：需要領袖權限或 API Key', code:403});
      return handleImportAll(body);
    }

    // 家長 sig bearer：在 save／addMember 等寬鬆 apikey 檢查之前先分派，
    // 家長只可行 handleParentAction 列出的只讀操作（防繞過）。
    if(auth.identity && auth.identity.kind==='parent'){
      return handleParentAction(action, body, auth.identity);
    }

    // 舊管理介面的相容入口：線上端點已經係常數，呢個 action 只剩「本地測試覆寫」用途。
    if(action==='configureTrustedTicketVerifier'){
      const my=body.token?validateToken(body.token):null;
      const mgr=my?getUser(my):null;
      if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'未授權設定端點（需領袖權限）',code:403});
      const verifyUrl=String(body.verifyUrl||'').trim();
      const troopId=String(body.troopId||'').trim();
      try{
        const saved=configureTrustedTicketVerifier(verifyUrl,troopId);
        return jsonResponse({success:true,troopId:String(saved.troopId||troopId||''),verify_url_in_use:superVerifyUrl(),loopback_override:saved.loopback});
      }catch(e){
        return jsonResponse({success:false,error:'設定失敗：'+String(e&&e.message||e)});
      }
    }
    if(action==='testTrustedTicketVerifier'){
      let my=body.token?validateToken(body.token):null;
      let mgr=my?getUser(my):null;
      if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return jsonResponse(testTrustedTicketVerifier());
    }

    if(action==='save' || action==='addMember' || action==='addUser' || action==='bulkAddUsers' || action==='saveOtherBadge'){
      const reqKey=body.apikey;
      if(reqKey && reqKey!==getApiKey()) return jsonResponse({success:false,error:'Invalid API Key'});
      if(!reqKey && body.token){
        const tk=validateToken(body.token);
        if(!tk && action!=='addMember') return jsonResponse({success:false,error:'未授權 - 需 API Key 或有效 Token'});
      }
      if(action==='save') return handleSave(body.changes, body.confirmer||'');
      if(action==='addMember'){ let my=body.token?validateToken(body.token):null; let mgr=my?getUser(my):null; if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'}; if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以新增成員'}); return handleAddMember(body.ymis,body.name,body.squad||'',body.squad_role||'member'); }
      if(action==='addUser'){ let my=body.token?validateToken(body.token):null; let mgr=my?getUser(my):null; if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'}; if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以新增帳號'}); return handleAddUser(body,mgr); }
      if(action==='bulkAddUsers'){ let my=body.token?validateToken(body.token):null; let mgr=my?getUser(my):null; if(!mgr && body.apikey && body.apikey===getApiKey()) mgr={role:'admin'}; if(!mgr || getRoleLevel(mgr.role)<40) return jsonResponse({success:false,error:'只有領袖可以批量開戶'}); return handleBulkAddUsers(body.users||[],mgr); }
      if(action==='saveOtherBadge') return handleSaveOtherBadge(body.records, body.apikey);
    }
    if(action==='requestComplete'){
      let ymis=null; if(body.token){ ymis=validateToken(body.token); }
      if(!ymis && auth.identity && auth.identity.kind!=='parent'){
        if(auth.identity.kind==='member') ymis=auth.identity.ymis;
      }
      if(!ymis && body.apikey && body.apikey===getApiKey()){ ymis=body.ymis; } // standalone mode
      if(!ymis) return jsonResponse({success:false,error:'未授權',code:401});
      return handleRequestComplete(body, ymis);
    }

    let ymis=body.token?validateToken(body.token):null;
    let user=ymis?getUser(ymis):null;
    if(!user && auth.identity && auth.identity.kind!=='parent'){
      user=(auth.identity.kind==='member')?getUser(auth.identity.ymis):getUserByEmail(auth.identity.email);
      if(!user && auth.identity.kind==='leader'){
        user = {
          ymis: auth.identity.ymis || auth.identity.email,
          name: auth.identity.email,
          email: auth.identity.email,
          role: auth.identity.role || 'branch_leader',
          can_tick: true,
          status: 'active'
        };
      }
      if(user) ymis=user.ymis;
    }
    if(!user) return jsonResponse({success:false,error:'Token 無效或過期',code:401});

    if(action==='getAllUsers') {
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，只有領袖可管理用戶'});
      return jsonResponse({success:true,users:getAllUsers()});
    }
    if(action==='getMembers'){ return jsonResponse({success:true,members:getMembers()}); }
    if(action==='getPendingRequests'){ if(getRoleLevel(user.role)<0) return jsonResponse({success:false,error:'權限不足'}); return handleGetPendingRequests(); }
    if(action==='reviewRequest'){ if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'}); return handleReviewRequest(body.request_id, body.decision, body.review_note, ymis, body.confirmed_date); }
    if(action==='getOtherBadges'){ return handleGetOtherBadges(body.target_ymis||ymis); }
    if(action==='getApplications'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足，需團長/支部領袖'}); return handleGetApplications(); }
    if(action==='reviewApplication'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleReviewApplication(body.app_id,body.decision,body.review_note,user,body.temp_password); }
    if(action==='getConfig'){
      return handleGetConfig();
    }

    if(action==='changePassword') return handleChangePassword(ymis,body.old_password,body.new_password);
    if(action==='resetPassword'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleResetPassword(body.target_ymis,ymis,body.new_password); }
    if(action==='addServiceRecord'){
  if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足'});
  return handleAddServiceRecord(body.record,ymis);
}
    if(action==='getServiceRecords'){ return handleGetServiceRecords(body.target_ymis||ymis); }
    if(action==='getAuditLog'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleGetAuditLog(); }
    if(action==='getApprovalHistory'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleGetApprovalHistory(); }
    if(action==='updateUserRole'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role,body.can_tick,ymis, body.allowed_badges, body.squad, body.squad_role);
    }
    if(action==='updatePermissions'){
      if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'});
      return handleUpdateUserRole(body.target_ymis,body.new_role||null,body.can_tick,ymis, body.allowed_badges);
    }
    if(action==='updateConfig'){
      // allow_member_view_others 可由團長以上設定，其他設定需管理員
      const key=body.key;
      if(key==='allow_member_view_others' || key==='member_progress_scope' || key==='allow_squad_comparison' || key==='allow_member_requests'){
        if(getRoleLevel(user.role)<60) return jsonResponse({success:false,error:'需團長以上權限'});
      }else{
        if(getRoleLevel(user.role)<80) return jsonResponse({success:false,error:'需管理員權限'});
      }
      return handleUpdateConfig(body.key,body.value,ymis);
    }
    if(action==='deactivateUser'){ if(getRoleLevel(user.role)<40) return jsonResponse({success:false,error:'權限不足'}); return handleDeactivateUser(body); }
    if(action==='getLogRecords') return handleGetLogRecords(user);
    if(action==='saveLogRecord'){
      if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleSaveLogRecord(body.records||(body.record?[body.record]:[]), ymis, body.recorder_name||'');
    }
    if(action==='deleteLogRecord'){
      if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleDeleteLogRecord(body.record_id, ymis);
    }
    if(action==='requestLogRecord') return handleRequestLogRecord(body, user);
    if(action==='getLogRequests') return handleGetLogRequests(user);
    if(action==='reviewLogRequest'){
      if(!canUserTick(user.role)) return jsonResponse({success:false,error:'權限不足，需領袖權限'});
      return handleReviewLogRequest(body.request_id, body.decision, body.review_note, user);
    }
    if(action==='cancelLogRequest') return handleCancelLogRequest(body.request_id, user);
    if(action==='healthCheck' || action==='diagnoseSheets'){
      return jsonResponse({success:false,error:'此檢查不可公開使用'});
    }
    if(action==='repairSheets'){
      if(getRoleLevel(user.role)<80) return jsonResponse({success:false,error:'需管理員權限執行修復'});
      const before = diagnoseSheets();
      initializeSheets();
      const after = diagnoseSheets();
      return jsonResponse({success:true, before:before, after:after, repaired:true});
    }
    return jsonResponse({success:false,error:'Unknown action: ' + action});
  }catch(err){ Logger.log('Request failed: '+String(err&&err.message||'unknown')); return jsonResponse({success:false,error:'服務暫時無法使用'}); }
}

// 直接入口掣：未設定＝開啟（單用時零影響）；其餘任何值＝閂口（fail closed）。
// 詳細語義及上游控制見「旅系統：上下游接駁」一節的 localLoginAllowed()。

function handleSetDownstreamAccess(body, isSig){
  // 只有上游 sig 可更改入口開關。
  if(!isSig){
    return jsonResponse({success:false, error:'未授權：只接受上游簽名驗證', code:403});
  }
  const allow = body.allowLocal === true || body.allowLocal === 'true' || body.allow_local === true || body.allow_local === 'true';
  PropertiesService.getScriptProperties().setProperty('ALLOW_LOCAL_LOGIN', allow ? 'true' : 'false');
  return jsonResponse({success:true, allowLocal: allow});
}

function handleExportAll(includeHash){
  const sheet = getSheet().getSheetByName('Users');
  const users = [];
  if(sheet && sheet.getLastRow() > 1){
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(function(h){ return String(h).trim(); });
    const ymisCol = headers.indexOf('ymis');
    const nameCol = headers.indexOf('name');
    const emailCol = headers.indexOf('email');
    const roleCol = headers.indexOf('role');
    const pwHashCol = headers.indexOf('password_hash');
    const branchCol = headers.indexOf('branch');
    const canTickCol = headers.indexOf('can_tick');
    const statusCol = headers.indexOf('status');
    const allowedBadgesCol = headers.indexOf('allowed_badges');
    const squadCol = headers.indexOf('squad');
    const squadRoleCol = headers.indexOf('squad_role');
    const forcePwCol = headers.indexOf('force_change_password');

    for(let i=1; i<data.length; i++){
      const row = data[i];
      const ymis = ymisCol >= 0 ? normalizeYmis(row[ymisCol]) : '';
      if(!ymis || isSuperAdminId(ymis)) continue;
      const u = {
        ymis: ymis,
        name: nameCol >= 0 && row[nameCol] !== undefined ? String(row[nameCol]).trim() : '',
        email: emailCol >= 0 && row[emailCol] !== undefined ? String(row[emailCol]).trim() : '',
        role: roleCol >= 0 && row[roleCol] ? String(row[roleCol]).trim() : 'member',
        branch: branchCol >= 0 && row[branchCol] ? String(row[branchCol]).trim() : '',
        can_tick: canTickCol >= 0 && (row[canTickCol] === true || String(row[canTickCol]).toUpperCase() === 'TRUE'),
        status: statusCol >= 0 && row[statusCol] ? String(row[statusCol]).trim() : 'active',
        allowed_badges: allowedBadgesCol >= 0 && row[allowedBadgesCol] ? String(row[allowedBadgesCol]).trim() : '',
        squad: squadCol >= 0 && row[squadCol] ? String(row[squadCol]).trim() : '',
        squad_role: squadRoleCol >= 0 && row[squadRoleCol] ? String(row[squadRoleCol]).trim() : 'member',
        force_change_password: forcePwCol >= 0 && (row[forcePwCol] === true || String(row[forcePwCol]).toUpperCase() === 'TRUE')
      };
      if(includeHash && pwHashCol >= 0 && row[pwHashCol]){
        u.password_hash = String(row[pwHashCol]).trim();
      }
      users.push(u);
    }
  }

  const membersList = getMembers();
  const exportedAt = new Date().toISOString();
  const unit = PropertiesService.getScriptProperties().getProperty('PORTAL_GLOBAL_ID') || 'UNIT';
  const dataPayload = {
    users: users,
    members: membersList
  };
  const dataStr = JSON.stringify(dataPayload);
  const sha256 = bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, dataStr, Utilities.Charset.UTF_8));

  return jsonResponse({
    success: true,
    meta: {
      unit: unit,
      exportedAt: exportedAt,
      version: '1.0',
      sha256: sha256,
      include_hash: Boolean(includeHash)
    },
    data: dataPayload
  });
}

function recordTransferId(transferId){
  if(!transferId) return;
  const props = PropertiesService.getScriptProperties();
  const seen = String(props.getProperty('SEEN_TRANSFER_IDS') || '');
  const list = seen ? seen.split(',') : [];
  if(list.indexOf(transferId) < 0){
    list.push(transferId);
    if(list.length > 200) list.shift();
    props.setProperty('SEEN_TRANSFER_IDS', list.join(','));
  }
}

function handleUpsertUser(body){
  body = body || {};
  const user = body.user || body;
  let ymis = normalizeYmis(user.ymis || user.scout_id);
  const name = String(user.name || '').trim();
  const email = String(user.email || '').trim();
  const role = String(user.role || 'member').trim();
  const squad = String(user.squad || '').trim();
  const squadRole = String(user.squad_role || 'member').trim();
  const branch = String(user.branch || squad).trim();
  const canTick = user.can_tick === true || user.can_tick === 'true' || user.can_tick === 'TRUE';
  const status = String(user.status || 'active').trim();
  const passwordHash = user.password_hash ? String(user.password_hash).trim() : '';
  const password = user.password ? String(user.password).trim() : '';
  const transferId = String(body.transferId || user.transferId || '').trim();

  if(transferId){
    const props = PropertiesService.getScriptProperties();
    const seenTransfers = String(props.getProperty('SEEN_TRANSFER_IDS') || '');
    if(seenTransfers.split(',').indexOf(transferId) >= 0){
      return jsonResponse({success: true, action: 'skipped', idempotent: true, ymis: ymis});
    }
  }

  if(!ymis && role !== 'member' && email){
    ymis = generateLeaderId();
  }
  if(!ymis) return jsonResponse({success: false, error: '缺少 YMIS 編號', code: 400});

  const uSheet = getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success: false, error: '找不到 Users 工作表'});

  const data = uSheet.getDataRange().getValues();
  const headers = data[0].map(function(h){ return String(h).trim(); });
  const ymisCol = headers.indexOf('ymis');
  const nameCol = headers.indexOf('name');
  const emailCol = headers.indexOf('email');
  const roleCol = headers.indexOf('role');
  const pwHashCol = headers.indexOf('password_hash');
  const branchCol = headers.indexOf('branch');
  const canTickCol = headers.indexOf('can_tick');
  const statusCol = headers.indexOf('status');
  const allowedBadgesCol = headers.indexOf('allowed_badges');
  const squadCol = headers.indexOf('squad');
  const squadRoleCol = headers.indexOf('squad_role');
  const forcePwCol = headers.indexOf('force_change_password');

  let rowIndex = -1;
  const targetY = normalizeYmis(ymis);
  const targetE = normalizeEmail(email);

  for(let i=1; i<data.length; i++){
    const rowY = ymisCol >= 0 ? normalizeYmis(data[i][ymisCol]) : '';
    const rowE = emailCol >= 0 ? normalizeEmail(data[i][emailCol]) : '';
    if(rowY === targetY){
      rowIndex = i + 1;
      break;
    }
    if(targetE && rowE === targetE && rowY !== targetY && isActiveStatus(data[i][statusCol])){
      return jsonResponse({success: false, error: '此電郵已被其他帳戶使用 (' + rowY + ')', code: 409});
    }
  }

  const nowStr = now();
  if(rowIndex > 1){
    if(name && nameCol >= 0) uSheet.getRange(rowIndex, nameCol + 1).setValue(name);
    if(email && emailCol >= 0) uSheet.getRange(rowIndex, emailCol + 1).setValue(email);
    if(role && roleCol >= 0) uSheet.getRange(rowIndex, roleCol + 1).setValue(role);
    if(branch && branchCol >= 0) uSheet.getRange(rowIndex, branchCol + 1).setValue(branch);
    if(squad && squadCol >= 0) uSheet.getRange(rowIndex, squadCol + 1).setValue(squad);
    if(squadRole && squadRoleCol >= 0) uSheet.getRange(rowIndex, squadRoleCol + 1).setValue(squadRole);
    if(canTickCol >= 0 && user.can_tick !== undefined) uSheet.getRange(rowIndex, canTickCol + 1).setValue(canTick);
    if(status && statusCol >= 0) uSheet.getRange(rowIndex, statusCol + 1).setValue(status);

    if(passwordHash && pwHashCol >= 0){
      uSheet.getRange(rowIndex, pwHashCol + 1).setValue(passwordHash);
      if(forcePwCol >= 0){
        const force = user.force_change_password === true;
        uSheet.getRange(rowIndex, forcePwCol + 1).setValue(force);
      }
    } else if(password && pwHashCol >= 0){
      uSheet.getRange(rowIndex, pwHashCol + 1).setValue(hashPassword(password));
    }
    ensureRosterRow(ymis, name, email, squad);
    syncRosterRow(ymis, {name: name, email: email, squad: squad});

    if(transferId){
      recordTransferId(transferId);
    }
    return jsonResponse({success: true, action: 'updated', ymis: ymis});
  } else {
    const newRow = new Array(headers.length).fill('');
    function setCell(n, v){ const c = headers.indexOf(n); if(c >= 0) newRow[c] = v; }
    setCell('ymis', ymis);
    setCell('name', name || ymis);
    setCell('email', email);
    setCell('role', role);
    setCell('branch', branch || squad);
    setCell('squad', squad);
    setCell('squad_role', squadRole);
    setCell('can_tick', canTick);
    setCell('status', status || 'active');
    setCell('allowed_badges', role === 'member' ? '' : '*');

    if(passwordHash){
      setCell('password_hash', passwordHash);
      setCell('force_change_password', user.force_change_password === true);
    } else if(password){
      setCell('password_hash', hashPassword(password));
      setCell('force_change_password', user.force_change_password === true);
    } else {
      setCell('password_hash', hashPassword(DEFAULT_TEMP_PASSWORD));
      setCell('force_change_password', true);
    }
    setCell('auth_by', 'upsertUser');
    setCell('auth_date', nowStr);
    setCell('created_at', nowStr);
    uSheet.appendRow(newRow);
    ensureRosterRow(ymis, name, email, squad);

    if(transferId){
      recordTransferId(transferId);
    }
    return jsonResponse({success: true, action: 'created', ymis: ymis});
  }
}

function handleSetPw(targetYmis, newPwOrHash){
  if(!targetYmis || !newPwOrHash) return jsonResponse({success: false, error: '缺少帳號或密碼資料'});
  const targetY = normalizeYmis(targetYmis);
  const targetE = normalizeEmail(targetYmis);

  const uSheet = getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success: false, error: '找不到 Users 工作表'});

  const data = uSheet.getDataRange().getValues();
  const headers = data[0].map(function(h){ return String(h).trim(); });
  const ymisCol = headers.indexOf('ymis');
  const emailCol = headers.indexOf('email');
  const pwHashCol = headers.indexOf('password_hash');
  const forcePwCol = headers.indexOf('force_change_password');

  for(let i=1; i<data.length; i++){
    const rowY = ymisCol >= 0 ? normalizeYmis(data[i][ymisCol]) : '';
    const rowE = emailCol >= 0 ? normalizeEmail(data[i][emailCol]) : '';
    if(rowY === targetY || (targetE && rowE === targetE)){
      const hash = (/^[a-f0-9]{64}$/i.test(String(newPwOrHash))) ? String(newPwOrHash) : hashPassword(String(newPwOrHash));
      if(pwHashCol >= 0) uSheet.getRange(i+1, pwHashCol+1).setValue(hash);
      if(forcePwCol >= 0) uSheet.getRange(i+1, forcePwCol+1).setValue(false);
      return jsonResponse({success: true});
    }
  }
  return jsonResponse({success: false, error: '找不到此帳號', code: 404});
}

function handleSetStatus(targetYmis, newStatus){
  if(!targetYmis || !newStatus) return jsonResponse({success: false, error: '缺少帳號或狀態資料'});
  const targetY = normalizeYmis(targetYmis);
  const targetE = normalizeEmail(targetYmis);

  const uSheet = getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success: false, error: '找不到 Users 工作表'});

  const data = uSheet.getDataRange().getValues();
  const headers = data[0].map(function(h){ return String(h).trim(); });
  const ymisCol = headers.indexOf('ymis');
  const emailCol = headers.indexOf('email');
  const statusCol = headers.indexOf('status');

  for(let i=1; i<data.length; i++){
    const rowY = ymisCol >= 0 ? normalizeYmis(data[i][ymisCol]) : '';
    const rowE = emailCol >= 0 ? normalizeEmail(data[i][emailCol]) : '';
    if(rowY === targetY || (targetE && rowE === targetE)){
      if(statusCol >= 0) uSheet.getRange(i+1, statusCol+1).setValue(String(newStatus).trim());
      return jsonResponse({success: true});
    }
  }
  return jsonResponse({success: false, error: '找不到此帳號', code: 404});
}

function handleVerifyPw(targetYmis, pwOrHash){
  if(!targetYmis || !pwOrHash) return jsonResponse({success: false, error: '缺少帳號或密碼資料'});
  const targetY = normalizeYmis(targetYmis);
  const targetE = normalizeEmail(targetYmis);

  const uSheet = getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success: false, error: '找不到 Users 工作表'});

  const data = uSheet.getDataRange().getValues();
  const headers = data[0].map(function(h){ return String(h).trim(); });
  const ymisCol = headers.indexOf('ymis');
  const emailCol = headers.indexOf('email');
  const pwHashCol = headers.indexOf('password_hash');

  for(let i=1; i<data.length; i++){
    const rowY = ymisCol >= 0 ? normalizeYmis(data[i][ymisCol]) : '';
    const rowE = emailCol >= 0 ? normalizeEmail(data[i][emailCol]) : '';
    if(rowY === targetY || (targetE && rowE === targetE)){
      const currentHash = pwHashCol >= 0 ? String(data[i][pwHashCol] || '') : '';
      const expectHash = (/^[a-f0-9]{64}$/i.test(String(pwOrHash))) ? String(pwOrHash) : hashPassword(String(pwOrHash));
      const match = currentHash.toLowerCase() === expectHash.toLowerCase();
      return jsonResponse({success: true, match: match});
    }
  }
  return jsonResponse({success: false, error: '找不到此帳號', code: 404});
}

function handleImportAll(body){
  body = body || {};
  const data = body.data;
  if(!data || !Array.isArray(data.users)){
    return jsonResponse({success: false, error: '匯入資料結構無效'});
  }
  if(body.meta && body.meta.sha256){
    const dataStr = JSON.stringify(data);
    const expected = bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, dataStr, Utilities.Charset.UTF_8));
    if(expected.toLowerCase() !== String(body.meta.sha256).toLowerCase()){
      return jsonResponse({success: false, error: '資料完整性校驗失敗 (sha256 mismatch)', code: 400});
    }
  }
  let imported = 0, skipped = 0;
  for(let i=0; i<data.users.length; i++){
    const res = handleUpsertUser({user: data.users[i], transferId: body.transferId});
    let parsed = null;
    try{ parsed = JSON.parse(res.getContent()); }catch(e){ parsed = res; }
    if(parsed && parsed.success) imported++; else skipped++;
  }
  return jsonResponse({success: true, imported: imported, skipped: skipped, total: data.users.length});
}

// ---- 中央登入（A）：回打驗票（VS／RS 同款）----
// GAS 收到 action=superLogin 帶 super_ticket → 回打固定端點驗票 → 驗過先發 token。
// 驗票端點用常數，永不接受請求／前端指定：否則有人可以叫本後端把票連本團 API Key 送去自己部機，
// 再拿住張有效票去開中央 session。票由 Vercel 用 SUPER_KEY 封（AES-GCM），綁旅團編號、
// 後端 /exec 雜湊同身份；同一張票只可換一次 token（CacheService，長過票嘅壽命）。
function isLoopbackVerifyUrl(u){
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(String(u||'').trim());
}
function superVerifyUrl(){
  // 線上一定用常數；只接受 loopback 覆寫（本地 e2e／開發）。
  const props=PropertiesService.getScriptProperties();
  const override=String(props.getProperty('CENTRAL_AUTH_VERIFY_URL')||'').trim();
  return isLoopbackVerifyUrl(override)?override:SUPER_VERIFY_URL;
}
function centralVerifyHint(){
  return '請確認 Code.gs 嘅 SUPER_VERIFY_URL 常數係本部署域名、Vercel 已部署，以及 Apps Script 已授權「外部請求（script.external_request）」。';
}
function verifyCentralTicket(ticket,loginId){
  if(typeof ticket!=='string' || ticket.length<8 || ticket.length>4096) return {ok:false,reason:'ticket_format'};
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) return {ok:false,reason:'busy'};
  try{
    const cache=CacheService.getScriptCache();
    const cacheKey='super-ticket:'+sha256Hex(ticket);
    if(cache.get(cacheKey)) return {ok:false,reason:'replayed'};
    let serviceUrl='';
    try{ serviceUrl=String(ScriptApp.getService().getUrl()||''); }catch(e){ serviceUrl=''; }
    const response=UrlFetchApp.fetch(superVerifyUrl(),{
      method:'post', contentType:'application/json', muteHttpExceptions:true, followRedirects:true,
      payload:JSON.stringify({
        ticket:ticket,
        apikey:getApiKey(),
        backendHash:sha256Hex(serviceUrl),
        loginId:String(loginId||'').trim()
      })
    });
    const code=response.getResponseCode();
    if(code!==200) return {ok:false,reason:'verify_http',infra:true,detail:'驗票端點回應 HTTP '+code};
    let parsed=null;
    try{ parsed=JSON.parse(response.getContentText()); }catch(e){ parsed=null; }
    if(!parsed || typeof parsed!=='object') return {ok:false,reason:'verify_bad_json',infra:true,detail:'驗票端點回應唔係 JSON'};
    if(parsed.valid!==true) return {ok:false,reason:'verify_invalid'};
    cache.put(cacheKey,'1',CENTRAL_TICKET_CACHE_SEC);
    return {ok:true};
  }catch(e){
    return {ok:false,reason:'verify_unreachable',infra:true,detail:String((e&&e.message)||e)};
  }finally{
    try{ lock.releaseLock(); }catch(e){}
  }
}
// 領袖選單／舊管理介面嘅「測試連線」：真係探測一次，唔再回假 200。
// 1) GET 端點應該回 405（只收 POST）＝端點在生；2) 用本機 API Key 探測旅團登記及後端一致性。
function testTrustedTicketVerifier(){
  const url=superVerifyUrl();
  let serviceUrl='';
  try{ serviceUrl=String(ScriptApp.getService().getUrl()||''); }catch(e){ serviceUrl=''; }
  const out={success:false,mode:'callback',verify_url_in_use:url,verify_url_tail:String(url).slice(-28),service_url_tail:serviceUrl.slice(-14),steps:[]};
  let code=0;
  try{
    const ping=UrlFetchApp.fetch(url,{method:'get',muteHttpExceptions:true,followRedirects:true});
    code=ping.getResponseCode();
    out.status=code;
    out.steps.push('GET '+code);
  }catch(e){
    out.error='連唔到驗票端點：'+String((e&&e.message)||e)+'（'+centralVerifyHint()+'）';
    return out;
  }
  if(code!==405){
    out.error='驗票端點回應異常（HTTP '+code+'）：'+centralVerifyHint();
    return out;
  }
  try{
    const probe=UrlFetchApp.fetch(url,{
      method:'post', contentType:'application/json', muteHttpExceptions:true, followRedirects:true,
      payload:JSON.stringify({ticket:'test',apikey:getApiKey(),backendHash:sha256Hex(serviceUrl)})
    });
    let parsed=null;
    try{ parsed=JSON.parse(probe.getContentText()); }catch(e){ parsed=null; }
    if(!parsed){ out.error='探測回應唔係 JSON：'+centralVerifyHint(); return out; }
    out.probe={troop_known:parsed.troop_known===true,troop_id:String(parsed.troop_id||''),key_ok:parsed.key_ok===true,backend_matches:parsed.backend_matches===true};
    out.steps.push('probe troop_known='+out.probe.troop_known+'、key_ok='+out.probe.key_ok+'、backend_matches='+out.probe.backend_matches);
    out.success=out.probe.troop_known && out.probe.key_ok && out.probe.backend_matches;
    out.detail=out.success
      ? '旅團已登記、後端一致，中央登入回打驗票可用。'
      : (out.probe.troop_known
        ? '本機 API Key 唔等於 Vercel 嘅 TROOP_{編號}_APIKEY（key_ok=false）。'
        : 'Vercel 未見本機 API Key：請檢查 TROOP_{編號}_NAME／_BACKEND／_APIKEY 三項。');
    if(!out.success && out.probe.troop_known && out.probe.key_ok && !out.probe.backend_matches){
      out.detail='後端唔一致：Vercel 嘅 TROOP_{編號}_BACKEND 要同本 Sheet「部署 → 管理部署作業」嗰條 /exec URL 完全一樣。';
    }
  }catch(e){
    out.error='探測失敗：'+String((e&&e.message)||e);
  }
  return out;
}
// 編輯器診斷只讀（唔對外發請求）；getUrl() 可能回傳 /dev，要核對部署 URL 尾段。
function diagnoseCentralLogin(){
  let serviceUrl='';
  try{ serviceUrl=String(ScriptApp.getService().getUrl()||''); }catch(e){ serviceUrl=''; }
  const verifyUrl=superVerifyUrl();
  const out={
    mode:'callback',
    verifyUrlTail:verifyUrl.slice(-28),
    verifyUrlIsConstant:verifyUrl===SUPER_VERIFY_URL,
    serviceUrlTail:serviceUrl.slice(-14),
    backendHashTail:sha256Hex(serviceUrl).slice(0,8),
    hint:'中央登入靠回打驗票：GAS（本 Sheet）→ '+verifyUrl+'。'
      +'Vercel 嘅 TROOP_{編號}_BACKEND 條尾要同 serviceUrlTail 一樣（同一個 /exec）；'
      +'第一次用之前要在 Apps Script 執行一次 testTrustedTicketVerifier 授權外部請求。'
  };
  Logger.log('中央登入診斷：'+JSON.stringify(out));
  return out;
}
// 相容舊管理介面：線上端點已固定為常數，只准寫 loopback 覆寫（本地測試）。
function configureTrustedTicketVerifier(verifyUrl,troopId){
  verifyUrl=String(verifyUrl||'').trim();
  troopId=String(troopId||'').trim();
  const props=PropertiesService.getScriptProperties();
  if(isLoopbackVerifyUrl(verifyUrl)){
    props.setProperty('CENTRAL_AUTH_VERIFY_URL',verifyUrl);
    if(troopId) props.setProperty('CENTRAL_AUTH_TROOP_ID',troopId);
    return {success:true,troopId:troopId,loopback:true};
  }
  if(verifyUrl===SUPER_VERIFY_URL || verifyUrl===''){
    props.deleteProperty('CENTRAL_AUTH_VERIFY_URL');
    if(troopId) props.setProperty('CENTRAL_AUTH_TROOP_ID',troopId);
    return {success:true,troopId:troopId,loopback:false};
  }
  throw new Error('線上驗票端點已經係 Code.gs 常數（'+SUPER_VERIFY_URL+'），唔可以由前端改；只有 127.0.0.1／localhost 可以做本地測試覆寫');
}
// 中央身份最後登入時間只存 Script Properties（唔寫入工作表，唔影響任何 Schema）。
function setSuperAdminLastLogin(){
  try{ PropertiesService.getScriptProperties().setProperty('SUPER_ADMIN_LAST_LOGIN',now()); }catch(e){}
}
// 中央登入一定要有 Vercel 封嘅短效票（回打驗票）；API Key 同 isSuperAdmin 旗標已經唔再足夠。
function handleSuperLogin(loginId,superTicket){
  if(!isSuperAdminId(loginId)){
    return jsonResponse({success:false,error:'登入失敗',code:401,central:'callback'});
  }
  const checked=verifyCentralTicket(superTicket,loginId);
  if(!checked.ok){
    if(checked.infra){
      return jsonResponse({success:false,error:'中央登入驗票失敗：'+String(checked.detail||'')+'（'+centralVerifyHint()+'）',code:503,reason:'central_verify_unreachable',central:'callback'});
    }
    return jsonResponse({success:false,error:'登入失敗',code:401,central:'callback'});
  }
  const token=createToken(SUPER_ADMIN_ID);
  if(!token) return jsonResponse({success:false,error:'登入服務暫時無法使用',central:'callback'});
  setSuperAdminLastLogin();
  return jsonResponse({success:true,token:token,user:getUser(SUPER_ADMIN_ID),central:'callback'});
}
function handleLogin(loginId,password){
  if(!loginId||!password) return jsonResponse({success:false,error:'請填寫帳號和密碼'});
  
  // 中央身份只接受已核對 API_KEY 的 superLogin 入口。
  if(isSuperAdminId(loginId)) return jsonResponse({success:false,error:'登入失敗'});
  let user=(/^\d{10}$/.test(loginId)||/^L\d+/.test(loginId))? getUser(loginId): getUserByEmail(loginId);
  if(!user){
    user=getUser(loginId)||getUserByEmail(loginId);
  }
  if(!user) return jsonResponse({success:false,error:'找不到此帳號'});
  if(user.role==='super_admin') return jsonResponse({success:false,error:'登入失敗'});
  const hash=hashPassword(password);
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(isActiveStatus(data[i][11]) && String(data[i][4]||'')===hash){
      const rowY=normalizeYmis(data[i][0]); const rowE=normalizeEmail(data[i][2]);
      if(rowY===normalizeYmis(user.ymis) || (rowE && rowE===normalizeEmail(user.email)) || rowY===normalizeYmis(loginId)){
        const token=createToken(user.ymis);
        sheet.getRange(i+1,11).setValue(now());
        const force=sheet.getLastColumn()>=16 && (data[i][15]===true || String(data[i][15]).toUpperCase()==='TRUE');
        return jsonResponse({success:true,token:token,user:user,force_change_password:force});
      }
    }
  }
  return jsonResponse({success:false,error:'密碼錯誤'});
}
function handleResetPassword(targetYmis,managerYmis,newPassword){
  if(isSuperAdminId(targetYmis)) return jsonResponse({success:false,error:'此為系統保留帳號，不能重設密碼'});
  targetYmis=normalizeYmis(targetYmis);
  if(!targetYmis) return jsonResponse({success:false,error:'請提供 YMIS'});
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'未授權'});
  const target=getUser(targetYmis) || findUsersAccountByYmis(targetYmis) || findRosterAccountByYmis(targetYmis);
  if(!target) return jsonResponse({success:false,error:'找不到成員'});
  const targetRole=target.role||'member';
  if(manager.role!=='super_admin' && !canManageRole(manager.role, targetRole)) return jsonResponse({success:false,error:'權限不足，不能修改該角色密碼'});
  const temp=String(newPassword||'').trim() || DEFAULT_TEMP_PASSWORD;
  if(temp.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(temp.length>32) return jsonResponse({success:false,error:'新密碼不可超過32位'});
  const sh=getSheet().getSheetByName('Users');
  if(sh){
    const data=sh.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(normalizeYmis(data[i][0])===targetYmis){
        sh.getRange(i+1,5).setValue(hashPassword(temp));
        if(sh.getLastColumn()>=16) sh.getRange(i+1,16).setValue(true);
        if(sh.getLastColumn()>=12) sh.getRange(i+1,12).setValue('active');
        try{
          const tSheet=getSheet().getSheetByName('Tokens');
          if(tSheet){
            const td=tSheet.getDataRange().getValues();
            for(let j=td.length-1;j>=1;j--){ if(td[j][1] && normalizeYmis(td[j][1])===targetYmis) tSheet.deleteRow(j+1); }
          }
        }catch(e){}
        writeAudit(managerYmis,'reset_password',targetYmis,'領袖設定新密碼');
        return jsonResponse({success:true,temp_password:temp,message:'密碼已更新，請親自告知該成員'});
      }
    }
  }
  const roster=findRosterAccountByYmis(targetYmis);
  if(!roster) return jsonResponse({success:false,error:'找不到成員'});
  const nowStr=now();
  appendUserRow({
    ymis:targetYmis, name:roster.name, email:roster.email||'', role:'member',
    password_hash:hashPassword(temp), branch:roster.squad||'', can_tick:false,
    auth_by:managerYmis, auth_date:nowStr, created_at:nowStr, last_login:'',
    status:'active', allowed_badges:'', squad:roster.squad||'', squad_role:'member',
    force_change_password:true
  });
  writeAudit(managerYmis,'reset_password',targetYmis,'為成員名單補開登入並設定密碼');
  return jsonResponse({success:true,temp_password:temp,message:'已開登入並設定密碼，請親自告知該成員'});
}
function writeAudit(actor,action,target,detail){ const sh=getSheet().getSheetByName('操作紀錄'); if(sh) sh.appendRow([now(),actor,action,target,detail||'']); }
function handleAddServiceRecord(r,actor){ const sh=getSheet().getSheetByName('服務紀錄'); if(!sh)return jsonResponse({success:false,error:'Sheet not found'}); const id='SRV_'+Date.now(); sh.appendRow([id,r.ymis,r.name||'',r.activity||'',r.date||'',Number(r.hours||0),r.place||'',r.detail||'',actor,'approved',r.note||'']); writeAudit(actor,'add_service',r.ymis,r.activity||''); return jsonResponse({success:true,record_id:id}); }
function handleGetServiceRecords(ymis){ const sh=getSheet().getSheetByName('服務紀錄'); const out=[]; if(sh){const d=sh.getDataRange().getValues();for(let i=1;i<d.length;i++)if(String(d[i][1])===String(ymis))out.push({id:d[i][0],activity:d[i][3],date:formatDate(d[i][4]),hours:d[i][5],place:d[i][6],detail:d[i][7],status:d[i][9],note:d[i][10]});} return jsonResponse({success:true,records:out,totalHours:out.reduce((a,x)=>a+Number(x.hours||0),0)}); }
function handleGetApprovalHistory(){ const out=[]; ['Applications','待批完成'].forEach(n=>{const sh=getSheet().getSheetByName(n);if(!sh)return;const d=sh.getDataRange().getValues();for(let i=1;i<d.length;i++){if(n==='Applications' && d[i][6] && d[i][6].toString()!=='pending')out.push({type:'帳戶申請',id:d[i][0],ymis:d[i][1],name:d[i][2],status:d[i][6],reviewer:d[i][8],date:d[i][9]});if(n==='待批完成' && d[i][7] && d[i][7].toString()!=='pending')out.push({type:'進度申請',id:d[i][0],ymis:d[i][1],name:d[i][2],status:d[i][7],reviewer:d[i][9],date:d[i][10],item:d[i][4]});}});return jsonResponse({success:true,records:out}); }
function handleGetAuditLog(){ const sh=getSheet().getSheetByName('操作紀錄'); const out=[]; if(sh){const d=sh.getDataRange().getValues();for(let i=Math.max(1,d.length-200);i<d.length;i++)out.push(d[i]);} return jsonResponse({success:true,records:out}); }
function handleChangePassword(ymis,oldP,newP){
  if(newP.length<MIN_PASSWORD_LEN) return jsonResponse({success:false,error:'新密碼至少 '+MIN_PASSWORD_LEN+' 位'});
  if(newP.length>32) return jsonResponse({success:false,error:'新密碼不可超過32位'});
  if(newP===String(oldP||'')) return jsonResponse({success:false,error:'新密碼不可與原密碼相同'});
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'此帳號不可在此更改密碼'});
  const sheet=getSheet().getSheetByName('Users'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(data[i][0].toString()===ymis && data[i][11].toString()==='active'){
      if(data[i][4].toString()===hashPassword(oldP)){
        sheet.getRange(i+1,5).setValue(hashPassword(newP));
        if(sheet.getLastColumn()>=16) sheet.getRange(i+1,16).setValue(false);
        return jsonResponse({success:true});
      }
    }
  }
  return jsonResponse({success:false,error:'原密碼錯誤'});
}
function handleApply(ymis,name,email,role,branch){
  ymis=normalizeYmis(ymis); name=safeSheetText(name,100);
  email=String(email||'').trim().substring(0,160); branch=safeSheetText(branch,100);
  role=String(role||'member').trim()||'member';
  if(APPLY_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效的申請角色'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(role==='member'){
    if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'成員需 10位 YMIS'});
  }else{
    // 領袖申請忽略傳入 YMIS，批准時編配內部 L 編號。
    ymis='';
    if(!email) return jsonResponse({success:false,error:'領袖申請必須填寫聯絡電郵'});
  }
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({success:false,error:'Email 格式不正確'});
  const uniqApply=uniquenessError(ymis,email,{});
  if(uniqApply) return jsonResponse({success:false,error:uniqApply});
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'Applications 工作表不存在，請先執行 initializeSheets()'});
  sheet.appendRow(['APP_'+Date.now(),ymis,name,email,role,branch||'','pending',now(),'','','']);
  return jsonResponse({success:true,message:'申請已提交，請等待領袖在前端審批'});
}
function handleGetApplications(){
  const sheet=getSheet().getSheetByName('Applications'); const apps=[];
  if(!sheet) return jsonResponse({success:true,applications:apps});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][6].toString()==='pending'){ apps.push({app_id:data[i][0].toString(),ymis:data[i][1]?data[i][1].toString():'',name:data[i][2].toString(),email:data[i][3]?data[i][3].toString():'',requested_role:(data[i][4]||'member').toString()||'member',branch:data[i][5]?data[i][5].toString():'',applied_at:data[i][7]?formatDate(data[i][7]):''}); } }
  return jsonResponse({success:true,applications:apps});
}
function handleReviewApplication(appId,decision,note,manager,tempPassword){
  // 審批者不能設定要求的角色時退回 member。
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName('Applications');
  if(!sheet) return jsonResponse({success:false,error:'找不到 Applications 工作表'});
  const data=sheet.getDataRange().getValues();
  let rowIndex=-1, appData=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(appId)){ rowIndex=i+1; appData=data[i]; break; } }
  if(!appData || String(appData[6])!=='pending') return jsonResponse({success:false,error:'找不到待審批申請'});
  const reviewerYmis=(manager && manager.ymis)?String(manager.ymis):String(manager||'');
  if(decision==='rejected'){
    sheet.getRange(rowIndex,7).setValue('rejected');
    sheet.getRange(rowIndex,9).setValue(reviewerYmis);
    sheet.getRange(rowIndex,10).setValue(now());
    sheet.getRange(rowIndex,11).setValue(note||'');
    writeAudit(reviewerYmis,'reject_application',String(appData[1]),String(appId));
    return jsonResponse({success:true,message:'已拒絕申請'});
  }
  const requestedRole=String(appData[4]||'member');
  const finalRole=(APPLY_ROLES.indexOf(requestedRole)>=0 && canManageUser(manager,requestedRole))?requestedRole:'member';
  let ymis=String(appData[1]||'').trim();
  const appName=String(appData[2]||'');
  const appEmail=String(appData[3]||'').trim();
  const branchVal=safeSheetText(appData[5],100);
  // 領袖申請即使退回 member 仍須編配 L 編號，避免空 YMIS 卡住批准。
  if(!ymis){ ymis=generateLeaderId(); }
  // 批准時：Users 表（含停用）不可重覆；若只在成員名單則掛上登入帳號，不重開另一戶
  const uniq=uniquenessError(ymis,appEmail,{checkRoster:false, checkPending:true, excludeAppId:appId});
  if(uniq) return jsonResponse({success:false,error:uniq});
  const password=String(tempPassword||generateTemporaryPassword());
  const isLeaderFinal=(finalRole!=='member');
  // member：branch 欄沿用小隊（向後兼容舊申請）；leader：squad 留空，branch 存旅團／分支名稱
  const userBranch=branchVal;
  const userSquad=isLeaderFinal?'':branchVal;
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success:false,error:'找不到 Users 工作表'});
  // 按表頭寫入（兼容 15／16 欄舊表；缺欄自動補上，確保首次登入強制更改密碼生效）
  let headers=uSheet.getRange(1,1,1,Math.max(uSheet.getLastColumn(),1)).getValues()[0].map(function(h){return String(h).trim();});
  ['allowed_badges','squad','squad_role','force_change_password'].forEach(function(h){
    if(headers.indexOf(h)<0){ uSheet.getRange(1,headers.length+1).setValue(h); headers.push(h); }
  });
  const row=new Array(headers.length).fill('');
  function set(n,v){ const c=headers.indexOf(n); if(c>=0) row[c]=v; }
  const nowStr=now();
  set('ymis',ymis); set('name',appName); set('email',appEmail); set('role',finalRole);
  set('password_hash',hashPassword(password)); set('branch',userBranch);
  set('can_tick',isLeaderFinal); set('auth_by',reviewerYmis); set('auth_date',nowStr);
  set('created_at',nowStr); set('last_login',''); set('status','active');
  set('allowed_badges',isLeaderFinal?'*':''); set('squad',userSquad); set('squad_role','member');
  set('force_change_password',true);
  uSheet.appendRow(row);
  ensureRosterRow(ymis,appName,appEmail,userSquad);
  sheet.getRange(rowIndex,7).setValue('approved');
  sheet.getRange(rowIndex,9).setValue(reviewerYmis);
  sheet.getRange(rowIndex,10).setValue(nowStr);
  sheet.getRange(rowIndex,11).setValue(note||'');
  writeAudit(reviewerYmis,'approve_application',ymis,String(appId)+' → '+finalRole);
  return jsonResponse({success:true,message:'已批准並建立帳戶',temp_password:password,final_role:finalRole,ymis:ymis});
}
function handleUpdateUserRole(targetYmis,newRole,canTick,managerYmis, allowedBadges, squad, squadRole){
  const manager=getUser(managerYmis);
  if(!manager) return jsonResponse({success:false,error:'找不到管理員'});
  if(manager.role!=='super_admin' && !canManageRole(manager.role,newRole) && manager.role!=='admin') return jsonResponse({success:false,error:'權限不足，你的等級不可設定此角色'});
  if(newRole==='group_leader'){
    const cur=findActiveGroupLeader(targetYmis);
    if(cur) return jsonResponse({success:false,error:gslLockMsg(cur.name)});
  }
  targetYmis=normalizeYmis(targetYmis);
  const sheet=getSheet().getSheetByName('Users');
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(normalizeYmis(data[i][0])===targetYmis && isActiveStatus(data[i][11])){
        if(newRole) sheet.getRange(i+1,4).setValue(newRole);
        if(canTick!==undefined && canTick!==null) sheet.getRange(i+1,7).setValue(canTick);
        sheet.getRange(i+1,8).setValue(managerYmis);
        sheet.getRange(i+1,9).setValue(now());
        if(sheet.getLastColumn()>=14 && squad!==undefined) sheet.getRange(i+1,14).setValue(squad||'');
        if(sheet.getLastColumn()>=15 && squadRole!==undefined) sheet.getRange(i+1,15).setValue(squadRole||'member');
        if(sheet.getLastColumn()>=13){
          if(allowedBadges!==undefined && allowedBadges!==null){
            sheet.getRange(i+1,13).setValue(allowedBadges);
          } else if(!data[i][12]){
            sheet.getRange(i+1,13).setValue(newRole==='member'?'':'*');
          }
        }
        if(squad!==undefined) syncRosterRow(targetYmis,{squad:squad||''});
        return jsonResponse({success:true});
      }
    }
  }
  const roster=findRosterAccountByYmis(targetYmis);
  if(!roster) return jsonResponse({success:false,error:'找不到用戶'});
  const nowStr=now();
  const finalRole=newRole||'member';
  appendUserRow({
    ymis:targetYmis, name:roster.name, email:roster.email||'', role:finalRole,
    password_hash:'', branch:squad!==undefined?squad:(roster.squad||''),
    can_tick:canTick===true||canTick==='TRUE'||finalRole!=='member',
    auth_by:managerYmis, auth_date:nowStr, created_at:nowStr, last_login:'',
    status:'active', allowed_badges:allowedBadges!=null?allowedBadges:(finalRole==='member'?'':'*'),
    squad:squad!==undefined?squad:(roster.squad||''), squad_role:squadRole||'member',
    force_change_password:true
  });
  if(squad!==undefined) syncRosterRow(targetYmis,{squad:squad||''});
  return jsonResponse({success:true});
}
function handleUpdateConfig(key,value,ymis){
  const sheet=getSheet().getSheetByName('SystemConfig'); const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){ if(data[i][0]===key){ sheet.getRange(i+1,2).setValue(value); sheet.getRange(i+1,3).setValue(now()); sheet.getRange(i+1,4).setValue(ymis); return jsonResponse({success:true}); } }
  sheet.appendRow([key,value,now(),ymis]); return jsonResponse({success:true});
}
function handleGetConfig(){
  const sheet=getSheet().getSheetByName('SystemConfig');
  const cfg={};
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(data[i][0]) cfg[data[i][0].toString()]=data[i][1]?data[i][1].toString():'';
    }
  }
  if(!cfg['allow_member_view_others']) cfg['allow_member_view_others']='false';
  if(!cfg['member_progress_scope']) cfg['member_progress_scope']='private';
  if(!cfg['allow_squad_comparison']) cfg['allow_squad_comparison']='false';
  return jsonResponse({success:true,config:cfg});
}
function getMembers(){
  const mSheet=getSheet().getSheetByName('成員名單'); const members=[]; const seen={};
  if(mSheet){ const data=mSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0]){ const y=normalizeYmis(data[i][0]); if(!y || isSuperAdminId(y)) continue; seen[y]=true; members.push({ymis:y,name:data[i][1]?data[i][1].toString():'',email:data[i][4]?String(data[i][4]):'',squad:data[i][5]?data[i][5].toString():''}); } } }
  const uSheet=getSheet().getSheetByName('Users'); if(uSheet){ const data=uSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=normalizeYmis(data[i][0]); if(isActiveStatus(data[i][11]) && y && !isSuperAdminReserved(y)){ if(!seen[y]){ seen[y]=true; members.push({ymis:y,name:data[i][1]?data[i][1].toString():'',email:data[i][2]?String(data[i][2]):'',squad:data[i][13]?data[i][13].toString():''}); } } } }
  return members;
}
function handleLoad(loadUser){
  const ss=getSheet();
  const pSheet=ss.getSheetByName('進度追蹤'); const progress={};
  if(pSheet){ const data=pSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const ymis=data[i][0].toString(); if(!ymis) continue; if(!progress[ymis]) progress[ymis]={}; progress[ymis][data[i][1].toString()]={date:data[i][2]?formatDate(data[i][2]):'',confirmer:data[i][4]?data[i][4].toString():''}; } }
  const flat={}; for(const y in progress){ flat[y]={}; for(const k in progress[y]){ flat[y][k]=progress[y][k].date; } }
  let members=getMembers();
  const prSheet=ss.getSheetByName('待批完成'); const pending=[];
  if(prSheet){ const data=prSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ pending.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  const oSheet=ss.getSheetByName('其他獎章'); const other={};
  if(oSheet){ const data=oSheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ const y=data[i][0].toString(); if(!y) continue; if(!other[y]) other[y]={}; other[y][data[i][1].toString()]={name:data[i][2]?data[i][2].toString():'',date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}; } }
  const lSheet=ss.getSheetByName(LOG_SHEET_NAME);
  const lrSheet=ss.getSheetByName(LOG_REQ_SHEET_NAME);
  const isLogReviewer=!!(loadUser && canUserTick(loadUser.role));
  const isParent=!!(loadUser && loadUser.role==='parent');
  let parentSet=null;
  if(isParent){
    parentSet={};
    (loadUser.children||[]).forEach(function(y){ parentSet[String(y)]=true; });
    const inSet=function(y){ return !!parentSet[String(y)]; };
    members=members.filter(function(m){ return inSet(m.ymis); });
    for(const y in progress){ if(!inSet(y)) delete progress[y]; }
    for(const y in flat){ if(!inSet(y)) delete flat[y]; }
    for(let i=pending.length-1;i>=0;i--){ if(!inSet(pending[i].ymis)) pending.splice(i,1); }
    for(const y in other){ if(!inSet(y)) delete other[y]; }
  }
  // 未登入（apikey 載入）→ 不回傳待批申報；領袖 → 全部；團員 → 只見自己；家長 → 只見子女
  const logReqList=(lrSheet && loadUser) ? getLogRequestsList(isParent?null:(isLogReviewer?null:loadUser.ymis), parentSet) : [];
  const logsViewerYmis=loadUser?(isParent?null:(canUserTick(loadUser.role)?null:loadUser.ymis)):null;
  return jsonResponse({success:true,members:members,progress:progress,flatProgress:flat,pendingRequests:pending,otherBadges:other,logs:getLogRecordsList(logsViewerYmis, !!loadUser&&canUserTick(loadUser.role), parentSet),logsSupported:!!lSheet,logRequests:logReqList,logRequestsSupported:!!lrSheet,view_as:isParent?'parent':(loadUser?loadUser.role:'anonymous')});
}
function handleSave(changes, confirmer){
  const sheet=getSheet().getSheetByName('進度追蹤'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  let processed=0;
  changes.forEach(function(c){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){
      if(data[i][0].toString()===c.ymis && data[i][1].toString()===c.itemId){
        if(c.uncomplete){ sheet.deleteRow(i+1); } else { sheet.getRange(i+1,3).setValue(c.date); sheet.getRange(i+1,4).setValue(new Date()); sheet.getRange(i+1,5).setValue(confirmer||c.confirmer||''); sheet.getRange(i+1,6).setValue(c.note||''); }
        found=true; processed++; break;
      }
    }
    if(!found && !c.uncomplete){
      sheet.appendRow([c.ymis,c.itemId,c.date,new Date(),confirmer||c.confirmer||'',c.note||'']);
      processed++;
    }
  });
  return jsonResponse({success:true,processed:processed});
}
function handleAddMember(ymis,name,squad,squadRole){
  ymis=normalizeYmis(ymis); name=String(name||'').trim(); squad=String(squad||'').trim();
  if(!/^\d{10}$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  const uniqMem=uniquenessError(ymis,'',{});
  if(uniqMem) return jsonResponse({success:false,error:uniqMem});
  ensureRosterRow(ymis,name,'',squad);
  const nowStr=now();
  appendUserRow({
    ymis:ymis, name:name, email:'', role:'member', password_hash:'',
    branch:squad, can_tick:false, auth_by:'add_member', auth_date:nowStr,
    created_at:nowStr, last_login:'', status:'active', allowed_badges:'',
    squad:squad, squad_role:squadRole||'member', force_change_password:true
  });
  return jsonResponse({success:true,ymis:ymis});
}

function handleAddUser(body,mgr){
  let ymis=normalizeYmis(body.ymis);
  const name=(body.name||'').toString().trim();
  const role=(body.role||'member').toString().trim();
  const email=(body.email||'').toString().trim();
  const password=(body.password||DEFAULT_TEMP_PASSWORD).toString();
  const squad=(body.squad||'').toString().trim();
  const squadRole=(body.squad_role||'member').toString().trim();
  const canTick=body.can_tick===true||body.can_tick==='true'||body.can_tick==='TRUE';
  if(VALID_ROLES.indexOf(role)<0) return jsonResponse({success:false,error:'無效角色：'+role});
  if(!canManageUser(mgr,role)) return jsonResponse({success:false,error:'權限不足，你的等級不可開立此角色'});
  if(!ymis && role!=='member'){
    if(!email) return jsonResponse({success:false,error:'領袖開戶必須填寫 Email（用作登入帳號）'});
    ymis=generateLeaderId();
  }
  if(!/^(\d{10}|L\d+)$/.test(ymis)) return jsonResponse({success:false,error:'YMIS 須為 10 位數字（領袖可留空，會自動編配）'});
  if(!name) return jsonResponse({success:false,error:'請填寫姓名'});
  if(password && !role) return jsonResponse({success:false,error:'開立帳號需指定 role'});
  const uniqAdd=uniquenessError(ymis,email,{checkRoster:false});
  if(uniqAdd) return jsonResponse({success:false,error:uniqAdd});
  if(role==='group_leader'){
    const cur=findActiveGroupLeader('');
    if(cur) return jsonResponse({success:false,error:gslLockMsg(cur.name)});
  }
  const nowStr=now();
  const uSheet=getSheet().getSheetByName('Users');
  if(!uSheet) return jsonResponse({success:false,error:'找不到 Users 工作表'});
  const row=new Array(uSheet.getLastColumn()).fill('');
  const headers=uSheet.getRange(1,1,1,uSheet.getLastColumn()).getValues()[0].map(h=>String(h).trim());
  function set(n,v){ const c=headers.indexOf(n); if(c>=0) row[c]=v; }
  set('ymis',ymis); set('name',name); set('email',(body.email||'').toString().trim());
  set('role',role); set('branch',squad); set('squad',squad); set('squad_role',squadRole);
  set('can_tick',canTick);
  if(password){ set('password_hash',hashPassword(password)); set('auth_by','bulk_onboard'); set('auth_date',nowStr); set('status','active'); set('allowed_badges', role==='member'?'':'*'); set('force_change_password',true); }
  else { set('status','active'); }
  set('created_at',nowStr);
  uSheet.appendRow(row);
  ensureRosterRow(ymis,name,email,squad);
  return jsonResponse({success:true,message:'帳號已建立，首次登入必須更改密碼',ymis:ymis});
}
function handleBulkAddUsers(users,mgr){
  if(!Array.isArray(users) || !users.length) return jsonResponse({success:false,error:'沒有開戶資料',created:0,failed:0,results:[]});
  if(users.length>200) return jsonResponse({success:false,error:'每批最多 200 個帳號',created:0,failed:users.length,results:[]});
  const results=[]; let created=0;
  users.forEach(function(raw){
    const body=Object.assign({}, raw);
    if(!body.password) body.password=DEFAULT_TEMP_PASSWORD;
    const res=handleAddUser(body,mgr);
    let obj={};
    try{ obj=JSON.parse(res.getContent()); }catch(e){ obj={success:false,error:String(e)}; }
    if(obj.success){ created++; results.push({success:true,ymis:obj.ymis||body.ymis,name:body.name,email:body.email,role:body.role}); }
    else results.push({success:false,ymis:body.ymis,name:body.name,email:body.email,role:body.role,error:obj.error||'建立帳號失敗'});
  });
  return jsonResponse({success:true,created:created,failed:users.length-created,results:results});
}
function handleDeactivateUser(body){
  const ymis=normalizeYmis(body.target_ymis);
  if(!ymis) return jsonResponse({success:false,error:'請提供 YMIS'});
  if(isSuperAdminId(ymis)) return jsonResponse({success:false,error:'不能停用系統維護帳號'});
  const manager=getUser(validateToken(body.token));
  if(!manager) return jsonResponse({success:false,error:'未授權'});
  if(normalizeYmis(manager.ymis)===ymis) return jsonResponse({success:false,error:'不能停用自己'});
  const target=getUser(ymis) || findUsersAccountByYmis(ymis) || findRosterAccountByYmis(ymis);
  if(!target) return jsonResponse({success:false,error:'找不到用戶'});
  const targetRole=target.role||'member';
  if(manager.role!=='super_admin' && !canManageRole(manager.role, targetRole)) return jsonResponse({success:false,error:'權限不足，不能停用該角色'});
  let deactivated=false;
  const sheet=getSheet().getSheetByName('Users');
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(normalizeYmis(data[i][0])===ymis && isActiveStatus(data[i][11])){
        sheet.getRange(i+1,12).setValue('inactive');
        deactivated=true;
        break;
      }
    }
  }
  try{
    const tSheet=getSheet().getSheetByName('Tokens');
    if(tSheet){
      const td=tSheet.getDataRange().getValues();
      for(let j=td.length-1;j>=1;j--){ if(td[j][1] && normalizeYmis(td[j][1])===ymis) tSheet.deleteRow(j+1); }
    }
  }catch(e){}
  try{
    const mSheet=getSheet().getSheetByName('成員名單');
    if(mSheet){ const md=mSheet.getDataRange().getValues(); for(let k=md.length-1;k>=1;k--){ if(md[k][0] && normalizeYmis(md[k][0])===ymis){ mSheet.deleteRow(k+1); deactivated=true; } } }
  }catch(e){}
  if(!deactivated) return jsonResponse({success:false,error:'找不到活躍用戶'});
  writeAudit(manager.ymis,'deactivate_user',ymis,'帳號停用');
  return jsonResponse({success:true,message:'已停用'});
}

function handleRequestComplete(body, requesterYmis){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const reqId='REQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  const user=getUser(requesterYmis)||{name:body.name||requesterYmis};
  sheet.appendRow([reqId,requesterYmis,user.name||body.name,body.itemId,body.itemName||body.itemId,body.requested_date||formatDate(new Date()),body.evidence||'','pending',now(),'','','', '']);
  return jsonResponse({success:true,request_id:reqId});
}
function handleGetPendingRequests(){
  const sheet=getSheet().getSheetByName('待批完成'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][7].toString()==='pending'){ list.push({request_id:data[i][0].toString(),ymis:data[i][1].toString(),name:data[i][2].toString(),item_id:data[i][3].toString(),item_name:data[i][4].toString(),requested_date:data[i][5]?formatDate(data[i][5]):'',evidence:data[i][6]?data[i][6].toString():'',status:'pending',created_at:data[i][8]?formatDate(data[i][8]):''}); } } }
  return jsonResponse({success:true,requests:list});
}
function handleReviewRequest(reqId,decision,note,reviewer,confirmed_date){
  const sheet=getSheet().getSheetByName('待批完成'); if(!sheet) return jsonResponse({success:false,error:'Sheet not found'});
  const data=sheet.getDataRange().getValues(); let row=null;
  for(let i=1;i<data.length;i++){ if(data[i][0].toString()===reqId){ row=data[i]; sheet.getRange(i+1,8).setValue(decision); sheet.getRange(i+1,10).setValue(reviewer); sheet.getRange(i+1,11).setValue(now()); sheet.getRange(i+1,12).setValue(note||''); sheet.getRange(i+1,13).setValue(confirmed_date||formatDate(new Date())); break; } }
  if(!row) return jsonResponse({success:false,error:'找不到申請'});
  if(decision==='approved'){
    const pSheet=getSheet().getSheetByName('進度追蹤');
    pSheet.appendRow([row[1],row[3],confirmed_date||row[5],new Date(),reviewer, '由申請轉入：'+(note||'')]);
    return jsonResponse({success:true,message:'已批准並寫入進度'});
  }
  return jsonResponse({success:true,message:'已拒絕'});
}
function handleGetOtherBadges(ymis){
  const sheet=getSheet().getSheetByName('其他獎章'); const list=[];
  if(sheet){ const data=sheet.getDataRange().getValues(); for(let i=1;i<data.length;i++){ if(data[i][0].toString()===ymis){ list.push({id:data[i][1].toString(),name:data[i][2].toString(),date:data[i][3]?formatDate(data[i][3]):'',cert:data[i][4]?data[i][4].toString():''}); } } }
  return jsonResponse({success:true,other:list});
}
function getLogRecordsList(viewerYmis,isReviewer,allowedSet){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME); const logs=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0]) continue;
      // allowedSet 將家長讀取範圍限制為本團子女聯集。
      if(allowedSet && !allowedSet[String(data[i][2])]) continue;
      // 非領袖（團員）只可讀自己的履歷；領袖／無登入（apikey 載入）讀全部
      if(!isReviewer && viewerYmis && String(data[i][2]||'')!==String(viewerYmis)) continue;
      logs.push({
        record_id:String(data[i][0]), type:String(data[i][1]||'activity'),
        ymis:String(data[i][2]||''), name:String(data[i][3]||''),
        date:data[i][4]?formatDate(data[i][4]):'', title:String(data[i][5]||''),
        role:String(data[i][6]||''), hours:String(data[i][7]||''),
        cert_no:String(data[i][8]||''), detail:String(data[i][9]||''),
        recorder:String(data[i][10]||''),
        recorded_at:data[i][11]?String(data[i][11]):''
      });
    }
  }
  return logs;
}
function handleGetLogRecords(user){
  if(!getSheet().getSheetByName(LOG_SHEET_NAME)) return jsonResponse({success:false,error:'\u300c'+LOG_SHEET_NAME+'\u300d工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const isReviewer=!user || canUserTick(user.role);
  return jsonResponse({success:true,logs:getLogRecordsList(user&&!isReviewer?user.ymis:null, isReviewer)});
}
function sanitizeLogRecord(r){
  r=r||{};
  return {
    type: LOG_TYPES.indexOf(r.type)>=0 ? r.type : 'activity',
    ymis: String(r.ymis||'').trim().substring(0,20),
    name: safeSheetText(r.name,60),
    date: String(r.date||'').substring(0,20),
    title: safeSheetText(r.title,120),
    role: safeSheetText(r.role,60),
    hours: String(r.hours==null?'':r.hours).substring(0,20),
    cert_no: safeSheetText(r.cert_no,60),
    detail: safeSheetText(r.detail,500)
  };
}
function handleSaveLogRecord(records, recorderYmis, recorderName){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'\u300c'+LOG_SHEET_NAME+'\u300d工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  if(!Array.isArray(records)||records.length===0) return jsonResponse({success:false,error:'沒有可儲存的紀錄'});
  if(records.length>200) return jsonResponse({success:false,error:'一次最多 200 筆，請分批'});
  const results=[]; let processed=0;
  records.forEach(function(r){
    const rec=sanitizeLogRecord(r);
    if(!rec.ymis||!rec.title||!rec.date){ results.push({success:false,ymis:rec.ymis,title:rec.title,error:'YMIS、名稱及日期必填'}); return; }
    const rid=String((r&&r.record_id)||'');
    if(rid){
      const data=sheet.getDataRange().getValues();
      for(let i=1;i<data.length;i++){
        if(String(data[i][0])===rid){
          // 更新第 2–13 欄，共 12 欄；須與 setValues 長度一致。
          sheet.getRange(i+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,sheet.getRange(i+1,11).getValue()||recorderName||recorderYmis,String(data[i][11]||''),now()]]);
          results.push({success:true,record_id:rid}); processed++;
          writeAudit(recorderYmis,'update_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
          return;
        }
      }
      results.push({success:false,record_id:rid,error:'找不到紀錄'}); return;
    }
    const newId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    sheet.appendRow([newId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorderName||recorderYmis,now(),'']);
    results.push({success:true,record_id:newId}); processed++;
    writeAudit(recorderYmis,'add_log',rec.ymis,rec.type+': '+rec.title+' '+rec.date);
  });
  const failed=results.filter(function(x){return !x.success;}).length;
  return jsonResponse({success:(results.length>0&&failed===0),processed:processed,results:results,message:processed+' 筆已儲存'+(failed?'，'+failed+' 筆失敗':'')});
}
function handleDeleteLogRecord(recordId, recorderYmis){
  const sheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'\u300c'+LOG_SHEET_NAME+'\u300d工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  recordId=String(recordId||'');
  if(!recordId) return jsonResponse({success:false,error:'缺少 record_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===recordId){
      const label=String(data[i][1]||'')+': '+String(data[i][5]||'')+' '+String(data[i][4]||'');
      const target=String(data[i][2]||'');
      sheet.deleteRow(i+1);
      writeAudit(recorderYmis,'delete_log',target,label);
      return jsonResponse({success:true,message:'已刪除紀錄'});
    }
  }
  return jsonResponse({success:false,error:'找不到紀錄'});
}

function handleSaveOtherBadge(records){
  const sheet=getSheet().getSheetByName('其他獎章'); if(!sheet) return jsonResponse({success:false,error:'Sheet missing'});
  let c=0;
  records.forEach(function(r){
    const data=sheet.getDataRange().getValues(); let found=false;
    for(let i=1;i<data.length;i++){ if(data[i][0].toString()===r.ymis && data[i][1].toString()===r.badgeId){ sheet.getRange(i+1,3).setValue(r.date); sheet.getRange(i+1,4).setValue(r.cert||''); sheet.getRange(i+1,5).setValue(r.note||''); sheet.getRange(i+1,6).setValue(new Date()); found=true; c++; break; } }
    if(!found){ sheet.appendRow([r.ymis,r.badgeId,r.name||r.badgeId,r.date,r.cert||'',r.note||'',new Date()]); c++; }
  });
  return jsonResponse({success:true,processed:c});
}

function getLogRequestsList(onlyYmis,allowedSet){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME); const list=[];
  if(sheet){
    const data=sheet.getDataRange().getValues();
    for(let i=1;i<data.length;i++){
      if(!data[i][0] || String(data[i][12])!=='pending') continue;
      if(allowedSet && !allowedSet[String(data[i][4])]) continue;
      if(onlyYmis!==null && onlyYmis!==undefined && onlyYmis!=='' && String(data[i][4])!==String(onlyYmis)) continue;
      list.push({
        request_id:String(data[i][0]), kind:String(data[i][1]||'new'),
        target_record_id:String(data[i][2]||''), type:String(data[i][3]||'activity'),
        ymis:String(data[i][4]||''), name:String(data[i][5]||''),
        date:data[i][6]?formatDate(data[i][6]):'', title:String(data[i][7]||''),
        role:String(data[i][8]||''), hours:String(data[i][9]||''),
        cert_no:String(data[i][10]||''), detail:String(data[i][11]||''),
        status:'pending', created_at:data[i][13]?String(data[i][13]):''
      });
    }
  }
  return list;
}
function handleRequestLogRecord(body, user){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const rec=sanitizeLogRecord(body.record||{});
  // 只能為自己申報：ymis／姓名一律以登入者為準，不接受偽冒他人
  rec.ymis=String(user.ymis); rec.name=safeSheetText(user.name||rec.name,60);
  if(!rec.title||!rec.date) return jsonResponse({success:false,error:'名稱及日期必填'});
  const kind=body.kind==='edit'?'edit':'new';
  let targetId='';
  if(kind==='edit'){
    targetId=String(body.target_record_id||'');
    if(!targetId) return jsonResponse({success:false,error:'缺少 target_record_id'});
    const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
    if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
    const ld=lSheet.getDataRange().getValues(); let found=null;
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===targetId){ found=ld[i]; break; } }
    if(!found) return jsonResponse({success:false,error:'找不到原紀錄，可能已被刪除，請重新載入'});
    if(String(found[2])!==String(user.ymis)) return jsonResponse({success:false,error:'只可申請修改自己的紀錄'});
    // 修改申報不可變更原紀錄類型。
    if(LOG_TYPES.indexOf(String(found[1]))>=0) rec.type=String(found[1]);
    // 同一紀錄同時只可有一個待批修改申報。
    const rd=sheet.getDataRange().getValues();
    for(let i=1;i<rd.length;i++){ if(String(rd[i][2])===targetId && String(rd[i][12])==='pending') return jsonResponse({success:false,error:'此紀錄已有待批修改申報，請等待領袖審批或先取消'}); }
  }
  const reqId='LREQ_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
  sheet.appendRow([reqId,kind,targetId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,'pending',now(),'','','']);
  writeAudit(user.ymis, kind==='edit'?'request_log_edit':'request_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date+(targetId?'（原紀錄 '+targetId+'）':''));
  return jsonResponse({success:true,request_id:reqId,message:'申報已提交，待領袖審批'});
}
function handleGetLogRequests(user){
  if(!getSheet().getSheetByName(LOG_REQ_SHEET_NAME)) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const isReviewer=canUserTick(user.role); // 與進度審批一致：領袖角色即可
  return jsonResponse({success:true,requests:getLogRequestsList(isReviewer?null:user.ymis)});
}
function handleReviewLogRequest(requestId, decision, note, reviewer){
  if(decision!=='approved' && decision!=='rejected') return jsonResponse({success:false,error:'無效決定'});
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  const data=sheet.getDataRange().getValues(); let rowIndex=-1,row=null;
  for(let i=1;i<data.length;i++){ if(String(data[i][0])===String(requestId)){ rowIndex=i+1; row=data[i]; break; } }
  if(!row || String(row[12])!=='pending') return jsonResponse({success:false,error:'找不到待批申報'});
  const kind=String(row[1]||'new');
  const rec={
    type:String(row[3]||'activity'), ymis:String(row[4]||''), name:String(row[5]||''),
    date:row[6]?formatDate(row[6]):'', title:String(row[7]||''), role:String(row[8]||''),
    hours:String(row[9]||''), cert_no:String(row[10]||''), detail:String(row[11]||'')
  };
  if(decision==='rejected'){
    sheet.getRange(rowIndex,13).setValue('rejected'); sheet.getRange(rowIndex,15).setValue(reviewer.ymis); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
    writeAudit(reviewer.ymis, kind==='edit'?'reject_log_edit':'reject_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date);
    return jsonResponse({success:true,message:'已拒絕申報'});
  }
  const lSheet=getSheet().getSheetByName(LOG_SHEET_NAME);
  if(!lSheet) return jsonResponse({success:false,error:'「'+LOG_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  let recordId=''; let recorder='';
  if(kind==='edit'){
    // 批准修改沿用原 record_id。
    const targetId=String(row[2]||'');
    const ld=lSheet.getDataRange().getValues(); let li=-1;
    for(let i=1;i<ld.length;i++){ if(String(ld[i][0])===targetId){ li=i; break; } }
    if(li<0) return jsonResponse({success:false,error:'找不到原紀錄（可能已被刪除），無法批准修改'});
    recorder=String(ld[li][10]||'');
    lSheet.getRange(li+1,2,1,12).setValues([[rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorder,String(ld[li][11]||''),now()]]);
    recordId=targetId;
  }else{
    recordId='LOG_'+Date.now()+'_'+Math.random().toString(36).substr(2,5);
    recorder=rec.name+'（自行申報 / self-reported）';
    lSheet.appendRow([recordId,rec.type,rec.ymis,rec.name,rec.date,rec.title,rec.role,rec.hours,rec.cert_no,rec.detail,recorder,now(),'']);
  }
  sheet.getRange(rowIndex,13).setValue('approved'); sheet.getRange(rowIndex,15).setValue(reviewer.ymis); sheet.getRange(rowIndex,16).setValue(now()); sheet.getRange(rowIndex,17).setValue(note||'');
  writeAudit(reviewer.ymis, kind==='edit'?'approve_log_edit':'approve_log_new', rec.ymis, rec.type+': '+rec.title+' '+rec.date+'（'+recordId+'）');
  return jsonResponse({success:true,message:kind==='edit'?'已批准修改並更新紀錄':'已批准並寫入活動履歷',record_id:recordId,record:{record_id:recordId,type:rec.type,ymis:rec.ymis,name:rec.name,date:rec.date,title:rec.title,role:rec.role,hours:rec.hours,cert_no:rec.cert_no,detail:rec.detail,recorder:recorder}});
}
function handleCancelLogRequest(requestId, user){
  const sheet=getSheet().getSheetByName(LOG_REQ_SHEET_NAME);
  if(!sheet) return jsonResponse({success:false,error:'「'+LOG_REQ_SHEET_NAME+'」工作表不存在：請在 Apps Script 執行 initializeSheets() 補建'});
  requestId=String(requestId||'');
  if(!requestId) return jsonResponse({success:false,error:'缺少 request_id'});
  const data=sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0])===requestId){
      if(String(data[i][12])!=='pending') return jsonResponse({success:false,error:'此申報已被審批，不能取消'});
      const isReviewer=canUserTick(user.role); // 與進度審批一致：領袖角色即可
      if(!isReviewer && String(data[i][4])!==String(user.ymis)) return jsonResponse({success:false,error:'只可取消自己的申報'});
      const label=String(data[i][3]||'')+': '+String(data[i][7]||'')+' '+String(data[i][6]||'');
      sheet.deleteRow(i+1);
      writeAudit(user.ymis,'cancel_log_request',String(data[i][4]||''),label);
      return jsonResponse({success:true,message:'已取消申報'});
    }
  }
  return jsonResponse({success:false,error:'找不到申報'});
}

// ===== 旅系統：Sheet 選單（匯出／匯入／登記下游／直接入口掣）=====
// 選單只在 Sheet 內給擁有者按；匯出的 JSON 含 password_hash，只寫去 Drive（私人），绝不寫入工作表。
function onOpen(){
  try{
    const ui=SpreadsheetApp.getUi();
    ui.createMenu('🔗 旅系統')
      .addItem('📤 匯出 JSON（含 hash）','menuExportUsersJson')
      .addItem('📥 匯入 JSON（upsertUser 直插 hash）','menuImportUsersJson')
      .addSeparator()
      .addItem('🧭 本機接駁狀態','menuShowLinkState')
      .addItem('🔑 顯示 BACKEND／APIKEY（交 ADMIN）','menuShowLinkCredentials')
      .addSeparator()
      .addItem('➕ 登記下游（URL + SHEET KEY）','menuRegisterDownstream')
      .addItem('📡 測試下游連線（sig）','menuPingDownstream')
      .addItem('👤 為下游開戶（揀團）','menuCreateDownstreamUser')
      .addSubMenu(ui.createMenu('🚪 下游直接入口')
        .addItem('🔒 閂口（只收 sig）','menuCloseDownstreamGate')
        .addItem('🔓 開啟（容許本地登入）','menuOpenDownstreamGate'))
      .addItem('🗑️ 移除下游登記','menuRemoveDownstream')
      .addSeparator()
      .addSubMenu(ui.createMenu('🚪 本機直接入口')
        .addItem('🔒 閂口（只收 sig）','menuLocalLoginOff')
        .addItem('🔓 開啟（容許本地登入）','menuLocalLoginOn'))
      .addToUi();
  }catch(e){}
}
function linkUi(){ return SpreadsheetApp.getUi(); }
function linkAlert(title,message){
  const text=String(message||'');
  try{ const ui=linkUi(); if(ui) ui.alert(String(title||'旅系統'),text,ui.ButtonSet.OK); }catch(e){}
  try{ Logger.log(String(title||'旅系統')+': '+text); }catch(e){}
  return text;
}
function linkPrompt(title,message){
  const ui=linkUi();
  if(!ui) return null;
  const res=ui.prompt(String(title||'旅系統'),String(message||''),ui.ButtonSet.OK_CANCEL);
  if(res.getSelectedButton()!==ui.Button.OK) return null;
  return String(res.getResponseText()||'').trim();
}
function linkConfirm(title,message){
  const ui=linkUi();
  if(!ui) return false;
  return ui.alert(String(title||'旅系統'),String(message||''),ui.ButtonSet.YES_NO)===ui.Button.YES;
}
function linkSummarizeResults(results,limit){
  const bad=(results||[]).filter(function(r){ return !r.success; });
  if(!bad.length) return '';
  return '\n\n首 '+Math.min(bad.length,limit||8)+' 筆失敗：\n'+bad.slice(0,limit||8).map(function(r){
    return '・'+String(r.ymis||'?')+'：'+String(r.error||'');
  }).join('\n');
}
function menuExportUsersJson(){
  const r=exportUsersJson();
  if(!r.success) return linkAlert('匯出 JSON','匯出失敗：'+String(r.error||''));
  const lines=['已匯出 '+r.count+' 個帳戶（含 password_hash）。'];
  if(r.file_url) lines.push('\nDrive 檔（已設為私人，匯入後請刪除）：\n'+r.file_url+'\n\n檔案 ID：'+r.file_id);
  else lines.push('\nDrive 寫入失敗（'+String(r.drive_error||'')+'）；完整 JSON 已寫入「檢視 → 執行紀錄（Logger）」，可在那裡複製。');
  lines.push('\n⚠️ 檔案含密碼 hash，只用於搬到上游／新支部，切勿公開分享或留在共用資料夾。');
  return linkAlert('匯出 JSON（含 hash）',lines.join(''));
}
function menuImportUsersJson(){
  const input=linkPrompt('匯入 JSON（upsertUser）','貼上「匯出 JSON（含 hash）」檔案的 Drive 連結或檔案 ID：\n\n（匯入會逐個 upsertUser 直插 hash，保留舊密碼；既有帳戶只更新，不會重複開戶）');
  if(input===null) return '';
  const r=importUsersFromDrive(input,'menu-import');
  if(!r.success) return linkAlert('匯入 JSON','匯入失敗：'+String(r.error||''));
  return linkAlert('匯入 JSON','匯入完成：共 '+r.count+' 筆\n新增 '+r.created+'、更新 '+r.updated+'、失敗 '+r.failed+linkSummarizeResults(r.results)+'\n\n確認無誤後，可閂下游直接入口（只收 sig）。');
}
function menuShowLinkState(){
  const s=getLinkState();
  const lines=[
    '節點：'+s.node,
    '本機直接入口（'+LINK_FLAG+'）：'+(s.allow_local_login?'開啟（未閂）':'已閂 — 只收上游 sig'),
    '設定值：'+s.link_flag_set,
    '本機 API KEY（遮罩）：'+s.api_key_masked,
    '已登記下游：'+s.downstreams.length+' 個'
  ];
  s.downstreams.forEach(function(d){ lines.push('・'+d.id+(d.name?'（'+d.name+'）':'')+' '+d.url_masked+' 登記於 '+d.registered_at); });
  lines.push('\n匯出格式：'+s.export_format);
  return linkAlert('本機接駁狀態',lines.join('\n'));
}
function menuShowLinkCredentials(){
  let url='';
  try{ url=ScriptApp.getService().getUrl()||''; }catch(e){ url=''; }
  const lines=[
    '以下兩項由本節點 GS 產生，經收件匣交 ADMIN 登記；四項一律不寫入工作表。',
    '',
    'B　BACKEND（部署後抄此 URL）：',
    url||'（尚未部署為網頁應用程式：部署 → 新增部署 → 網頁應用程式，再按一次本選單）',
    '',
    'D　APIKEY（SHEET KEY）：',
    getApiKey(),
    '',
    'C　NAME：由你自行填寫（交 ADMIN 時一併提供）',
    'A　隱藏管理鍵：與旅系統無關，不改動、不在此顯示'
  ];
  return linkAlert('BACKEND／APIKEY（交 ADMIN）',lines.join('\n'));
}
function menuRegisterDownstream(){
  const id=linkPrompt('登記下游 1/4','下游編號（例：progress、vs0082、branch-a；只可用英文、數字、底線、連字號）：');
  if(id===null) return '';
  const url=linkPrompt('登記下游 2/4','下游 GAS 正式 /exec URL（B）：');
  if(url===null) return '';
  const key=linkPrompt('登記下游 3/4','下游 SHEET KEY（下游 Script Properties 的 API_KEY，即 D）：');
  if(key===null) return '';
  const name=linkPrompt('登記下游 4/4','下游名稱（可留空；按「取消」亦視為留空）：');
  const r=registerDownstream(id,url,key,name||'');
  return linkAlert('登記下游',r.success?('已登記下游 '+r.id+'\n\n（URL 及 SHEET KEY 只存 Script Properties，不寫入工作表）\n下一步：按「📡 測試下游連線（sig）」確認可讀可寫。'):('登記失敗：'+String(r.error||'')));
}
function menuRemoveDownstream(){
  const id=linkPrompt('移除下游登記','要移除的下游編號：\n\n'+listDownstreams().map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  const r=removeDownstream(id);
  return linkAlert('移除下游登記',r.success?String(r.message):('移除失敗：'+String(r.error||'')));
}
function menuPingDownstream(){
  const id=linkPrompt('測試下游連線','下游編號：');
  if(id===null) return '';
  const r=pingDownstream(id);
  if(!r||!r.success) return linkAlert('測試下游連線','連線失敗：'+String((r&&r.error)||'下游無回應'));
  return linkAlert('測試下游連線','✅ sig 驗證通過，可讀可寫。\n\n下游節點：'+String(r.node||'')+'\n下游直接入口：'+(r.allow_local_login?'開啟（未閂）':'已閂 — 只收上游 sig')+'\n下游已登記的再下一層：'+((r.downstreams&&r.downstreams.length)||0)+' 個');
}
function menuCreateDownstreamUser(){
  const list=listDownstreams();
  if(!list.length) return linkAlert('為下游開戶','尚未登記任何下游；請先按「➕ 登記下游（URL + SHEET KEY）」。');
  const id=linkPrompt('為下游開戶 1/6','揀團（下游編號）：\n\n'+list.map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  const ymis=linkPrompt('為下游開戶 2/6','YMIS（10 位數字；領袖可留空自動編 L 號）：');
  if(ymis===null) return '';
  const name=linkPrompt('為下游開戶 3/6','姓名：');
  if(name===null) return '';
  const email=linkPrompt('為下游開戶 4/6','Email（領袖必填，團員可留空）：');
  if(email===null) return '';
  const role=linkPrompt('為下游開戶 5/6','角色：member / branch_leader / group_leader / admin');
  if(role===null) return '';
  const password=linkPrompt('為下游開戶 6/6','臨時密碼（最少 '+MIN_PASSWORD_LEN+' 位；預設 '+DEFAULT_TEMP_PASSWORD+'）：');
  const tempPassword=(password===null||!password)?DEFAULT_TEMP_PASSWORD:password;
  const r=createAccountForDownstream(id,{
    ymis:ymis,name:name,email:email,role:String(role||'member').trim(),
    password:tempPassword,can_tick:true,squad:''
  },{ymis:ADMIN_YMIS,name:ADMIN_NAME,role:'admin',can_tick:true});
  if(!r.success) return linkAlert('為下游開戶','開戶失敗：'+String(r.error||'')+linkSummarizeResults(r.results));
  return linkAlert('為下游開戶','✅ 已在上游開戶並經 sig 寫入下游 '+r.downstream+'\n\nYMIS：'+r.ymis+'\n姓名：'+r.name+'\n臨時密碼：'+tempPassword+'\n（首次登入必須更改）');
}
function menuCloseDownstreamGate(){
  const id=linkPrompt('閂下游直接入口','下游編號：\n\n'+listDownstreams().map(function(d){ return '・'+d.id+(d.name?'（'+d.name+'）':''); }).join('\n'));
  if(id===null) return '';
  if(!linkConfirm('閂下游直接入口','確定閂口？\n\n下游 '+id+' 之後只接受本上游的 sig 請求：\n・下游直接登入／申請帳戶會被拒\n・進度、帳戶、履歷一律由上游讀寫\n\n請先確認已完成匯入（upsertUser）及測試連線。')) return '';
  const r=setDownstreamLocalLogin(id,false);
  return linkAlert('閂下游直接入口',(r&&r.success)?('✅ 下游 '+id+' 直接入口已閂，只收 sig。'):('閂口失敗：'+String((r&&r.error)||'下游無回應')));
}
function menuOpenDownstreamGate(){
  const id=linkPrompt('開下游直接入口','下游編號：');
  if(id===null) return '';
  const r=setDownstreamLocalLogin(id,true);
  return linkAlert('開下游直接入口',(r&&r.success)?('下游 '+id+' 直接入口已重開（本地登入恢復）。'):('開啟失敗：'+String((r&&r.error)||'下游無回應')));
}
function menuLocalLoginOff(){
  if(!linkConfirm('閂本機直接入口','確定閂口？\n\n本節點之後只接受上游 sig 請求：\n・前端直接登入／申請帳戶會被拒\n・資料只由上游讀寫\n\n請先確認上游已登記本節點的 URL 及 SHEET KEY，並已通過「測試下游連線」。')) return '';
  setLocalLoginAllowed(false,'menu');
  return linkAlert('閂本機直接入口','✅ '+LINK_FLAG+'=false：本節點只收上游 sig。如需重開，按「🔓 開啟（容許本地登入）」。');
}
function menuLocalLoginOn(){
  setLocalLoginAllowed(true,'menu');
  return linkAlert('開本機直接入口','✅ '+LINK_FLAG+'=true：本節點直接入口已重開。');
}
