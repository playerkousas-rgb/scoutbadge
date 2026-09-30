'use strict';

/*
 * 回報／意見「傳送狀態」守護測試：確保用戶在填回報／意見時知道進度及完成
 * 傳送了沒有。抽出 index.html 的狀態層函式區塊，在 vm 內以 mock DOM／fetch
 * 驗證：傳送中防重複點擊、確認後保留內容、送達不明時警示兼要求確認重送、
 * 收件系統明確拒絕時可修正後重試。
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const functionsStart = html.indexOf("let feedbackSubmitState='idle'");
const functionsEnd = html.indexOf("if(typeof document!=='undefined'){", functionsStart);
assert.notEqual(functionsStart, -1, 'feedback state block exists');
assert.notEqual(functionsEnd, -1, 'feedback state block end marker exists');
const feedbackFunctions = html.slice(functionsStart, functionsEnd);
assert.ok(feedbackFunctions.includes('function submitScoutReport('), 'submitScoutReport is in the block');
assert.ok(feedbackFunctions.includes('function renderScoutwStatus('), 'renderScoutwStatus is in the block');
assert.ok(feedbackFunctions.includes('function hookScoutwSubmit('), 'widget buttons are hooked');

function makeContext(fetchImpl) {
  const elements = {
    'scoutw-overlay': { classList: { contains: () => true, add() {}, remove() {} } },
    'scoutw-msg': { textContent: '', className: '' },
    'scoutw_i_submit': { disabled: false, textContent: '提交問題回報', dataset: {}, parentNode: null },
    'scoutw_f_submit': { disabled: false, textContent: '提交意見回饋', dataset: {}, parentNode: null },
    'scoutw_i_title': { value: '打卡紀錄無法儲存', disabled: false },
    'scoutw_i_desc': { value: '按儲存後沒有反應，重現方法：進入進度頁按儲存。', disabled: false },
    'scoutw_i_sev': { value: '中', disabled: false },
    'scoutw_i_troop': { value: '0082', disabled: false },
    'scoutw_i_name': { value: '測試成員', disabled: false },
    'scoutw_i_contact': { value: 'leader@example.org', disabled: false },
    'scoutw_f_content': { value: '希望加入夜間模式。', disabled: false },
    'scoutw_f_troop': { value: '', disabled: false },
    'scoutw_f_name': { value: '', disabled: false },
    'scoutw_f_contact': { value: '', disabled: false }
  };
  const context = vm.createContext({
    console,
    document: {
      getElementById: id => elements[id] || null,
      querySelector: sel => (sel === 'input[name="scoutw_fb_type"]:checked' ? { value: '建議' } : null),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: {},
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    t: key => key,
    currentTroopId: '0082'
  });
  vm.runInContext(feedbackFunctions, context);
  context.__elements = elements;
  return context;
}

async function testSendingThenConfirmed() {
  let calls = 0;
  let resolveFetch;
  const context = makeContext((url, options) => {
    calls++;
    assert.equal(url, '/api/proxy');
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'submitFeedback');
    assert.equal(body.type, 'issue');
    assert.equal(body.troopId, '0082');
    return new Promise(resolve => { resolveFetch = resolve; });
  });
  const els = context.__elements;

  const first = context.submitScoutReport('issue');
  const repeat = context.submitScoutReport('issue');
  assert.equal(calls, 1, 'a second click while sending is ignored');
  assert.equal(els['scoutw-msg'].className, 'pending');
  assert.equal(els['scoutw-msg'].textContent, 'fb_sending_hint');
  assert.equal(els['scoutw_i_submit'].disabled, true);
  assert.equal(els['scoutw_i_submit'].textContent, 'fb_sending');
  assert.equal(els['scoutw_i_title'].disabled, true, 'fields locked while sending');

  resolveFetch({ ok: true, json: async () => ({ success: true, deliveryStatus: 'confirmed' }) });
  await Promise.all([first, repeat]);
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'sent');
  assert.equal(els['scoutw-msg'].className, 'success');
  assert.equal(els['scoutw-msg'].textContent, 'fb_confirmed');
  assert.equal(els['scoutw_i_desc'].value, '按儲存後沒有反應，重現方法：進入進度頁按儲存。', 'the sent text stays visible for confirmation');
  assert.equal(els['scoutw_i_submit'].disabled, true);
  assert.equal(els['scoutw_i_submit'].textContent, 'fb_sent_btn');

  await context.submitScoutReport('issue');
  assert.equal(calls, 1, 'a confirmed report cannot be submitted again from the same form');
  console.log('  ✓ sending state blocks duplicates; confirmed state is persistent and keeps the text');
}

async function testUnknownThenExplicitResend() {
  let calls = 0; let confirmations = 0; let allowResend = false;
  const context = makeContext(async () => {
    calls++;
    if (calls === 1) throw new Error('network timeout');
    return { ok: true, json: async () => ({ success: true, deliveryStatus: 'confirmed' }) };
  });
  context.confirm = () => { confirmations++; return allowResend; };
  const els = context.__elements;

  await context.submitScoutReport('issue');
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'unknown');
  assert.equal(els['scoutw-msg'].className, 'warning');
  assert.equal(els['scoutw-msg'].textContent, 'fb_unknown');
  assert.equal(els['scoutw_i_submit'].textContent, 'fb_retry');
  assert.equal(els['scoutw_i_title'].disabled, false, 'the report can be reviewed after a network problem');

  await context.submitScoutReport('issue');
  assert.equal(confirmations, 1);
  assert.equal(calls, 1, 'declining the duplicate-risk confirmation does not resend');
  allowResend = true;
  await context.submitScoutReport('issue');
  assert.equal(confirmations, 2);
  assert.equal(calls, 2);
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'sent');
  assert.equal(els['scoutw-msg'].textContent, 'fb_confirmed');
  console.log('  ✓ ambiguous delivery warns, retains the report and requires explicit resend confirmation');
}

async function testLegacyProxyErrorIsUnknown() {
  const context = makeContext(async () => ({ ok: false, json: async () => ({ success: false, error: 'proxy exploded' }) }));
  const els = context.__elements;
  await context.submitScoutReport('feedback');
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'unknown', 'a failure without delivery metadata stays ambiguous');
  assert.equal(els['scoutw-msg'].className, 'warning');
  assert.equal(els['scoutw-msg'].textContent, 'fb_unknown');
  console.log('  ✓ a proxy error without delivery metadata is treated as ambiguous, not as lost');
}

async function testRejectedIsRetryable() {
  const context = makeContext(async () => ({
    ok: false,
    json: async () => ({ success: false, deliveryStatus: 'rejected', error: 'rejected' })
  }));
  const els = context.__elements;
  await context.submitScoutReport('feedback');
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'failed');
  assert.equal(els['scoutw-msg'].className, 'error');
  assert.equal(els['scoutw-msg'].textContent, 'fb_not_accepted');
  assert.equal(els['scoutw_f_submit'].disabled, false, 'a rejected report can be retried');
  assert.equal(els['scoutw_f_content'].value, '希望加入夜間模式。', 'the text is kept after a rejection');
  console.log('  ✓ an explicit rejection is presented as not accepted and can be retried');
}

async function testNotSentShowsBackendError() {
  const context = makeContext(async () => ({
    ok: true,
    json: async () => ({ success: false, deliveryStatus: 'not_sent', error: '請簡單寫下問題及需要的協助' })
  }));
  const els = context.__elements;
  await context.submitScoutReport('issue');
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'failed');
  assert.equal(els['scoutw-msg'].textContent, '請簡單寫下問題及需要的協助');
  console.log('  ✓ a definite not_sent outcome shows the server reason and can be retried');
}

async function run() {
  console.log('=== Feedback / report delivery-status tests ===');
  await testSendingThenConfirmed();
  await testUnknownThenExplicitResend();
  await testLegacyProxyErrorIsUnknown();
  await testRejectedIsRetryable();
  await testNotSentShowsBackendError();
  console.log('All feedback delivery-status tests passed.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
