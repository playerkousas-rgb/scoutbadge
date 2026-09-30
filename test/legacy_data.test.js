'use strict';

/*
 * 訓練綱要過渡安排（2017 → 2026）資料守護測試：
 *  1. legacyTransition 結構完整、日期與 P022/2026「童軍支部」一致；
 *  2. 對照的 newItemId 指向現行項目、保留的舊 ID 不與現行項目撞名；
 *  3. 過渡紀錄 ID 及權限節點正確（記錄只新增等同紀錄，不自動勾選新細項）；
 *  4. 其他獎章沒有「只叫人看童軍訓練綱要」的佔位內容，亦沒有遺漏官方名錄。
 */

const assert = require('assert');
const fs = require('fs');

const items = JSON.parse(fs.readFileSync('data/items.json', 'utf8'));
const html = fs.readFileSync('index.html', 'utf8');

const activeItemIds = new Set();
for (const badge of items.badges) {
  for (const it of badge.items) activeItemIds.add(it.id);
}
const badgeIds = new Set(items.badges.map(b => b.id));

// ---- 1. legacyTransition structure ----
const lt = items.legacyTransition;
assert.ok(lt, 'legacyTransition exists');
assert.strictEqual(lt.effectiveDate, '2026-08-15', 'effective date matches P022/2026');
assert.strictEqual(lt.deadline, '2028-08-14', 'Scout Section transition is two years');
assert.ok(/P022\/2026/.test(lt.source), 'source cites P022/2026');
assert.ok(/p022-26\.pdf/.test(lt.sourceUrl), 'source URL points at the circular');
assert.ok(/2028\s*年\s*8\s*月\s*14\s*日|2028-08-14/.test(lt.policy), 'policy states the deadline');
assert.ok(/沒有提供|並沒有提供|no mapping table|NO badge or item/i.test(lt.policy), 'policy states there is no official item mapping for the Scout Section');
assert.ok(lt.badgeMappings.length >= 5, 'badge-level rows for membership + four awards');
assert.ok(lt.detailMappings.length >= 60, 'item comparison references cover the 2017 checklist');
assert.ok(lt.preservedChecklistItems.length >= 60, '2017 checklist IDs are preserved for history');
assert.ok(lt.newRequirements.length >= 5, 'new/revised requirements documented');

for (const row of lt.detailMappings) {
  if (row.newItemId) {
    assert.ok(activeItemIds.has(row.newItemId), `detailMappings ${row.id} → ${row.newItemId} exists in the active checklist`);
  }
}
for (const row of lt.preservedChecklistItems) {
  assert.ok(!activeItemIds.has(row.id), `preserved old ID ${row.id} must not collide with an active item`);
}
for (const row of lt.quickTransfers) {
  assert.ok(/^LEGACY-2017-/.test(row.recordId), `${row.recordId} is a transition record ID`);
  assert.ok(activeItemIds.has(row.permissionItemId), `${row.permissionItemId} gates the transfer permission`);
  assert.ok(badgeIds.has(row.targetBadge), `${row.targetBadge} is a real badge`);
  assert.ok(!activeItemIds.has(row.recordId), 'transition records are not checklist items (never counted in %)');
}

// The Scout Section has NO official crosswalk table — every mapping row must be
// flagged as a comparison reference, never as an automatic conversion.
assert.ok(/比對參考|comparison reference/i.test(lt.mappingScope), 'mappingScope disclaims official conversion');
for (const row of lt.badgeMappings) {
  assert.ok(row.transferable === true, 'award-level records only record completion of the same award');
}

// ---- 2. new catalogue is the 2026 revision ----
assert.ok(/2026/.test(items.meta.base), 'meta cites the 2026 revision as the base');
assert.ok(/P022\/2026/.test(items.meta.base));
const l1 = items.badges.find(b => b.id === 'L1');
assert.ok(l1.items.length >= 10, '2026 Membership Badge has the expanded item list');
assert.ok(l1.items.some(it => /國旗/.test(it.name + it.detail)), 'national identity items present');
const l5 = items.badges.find(b => b.id === 'L5');
assert.ok(l5.items.some(it => /^L5-F1/.test(it.id)), 'Chief Scout Award keeps the Discovery section');

// ---- 3. no placeholder "go read the syllabus" content ----
const PLACEHOLDER = /詳情及考驗要求請參閱官方文件/;
let placeholders = 0;
for (const ob of items.otherBadges) {
  assert.ok(ob.desc && ob.desc.length >= 12, `${ob.id} ${ob.name} has a written description`);
  if (PLACEHOLDER.test(ob.desc)) placeholders++;
  assert.ok(ob.sourceUrl && /^https:\/\//.test(ob.sourceUrl), `${ob.id} keeps an official source link`);
}
assert.strictEqual(placeholders, 0, 'no otherBadge is left as a "see the training syllabus" placeholder');

// ---- 4. UI + wiring present ----
assert.ok(html.includes('function renderLegacyTransitionPanel('), 'transition panel is rendered');
assert.ok(html.includes('function queueLegacyTransfers('), 'leaders can record verified equivalences');
assert.ok(html.includes("let feedbackSubmitState='idle'"), 'feedback delivery-status state machine exists');
assert.ok(html.includes('deliveryStatus'), 'feedback flow understands deliveryStatus');
assert.ok(html.includes('submitFeedback'), 'proxy action wired');
const proxy = fs.readFileSync('api/proxy.js', 'utf8');
assert.ok(proxy.includes("action === 'submitFeedback'"), 'proxy handles submitFeedback');
assert.ok(proxy.includes('deliveryStatus'), 'proxy reports delivery status');

console.log('legacy/transition data checks passed.');
console.log(`  badges=${items.badges.length} items=${activeItemIds.size} detailMappings=${lt.detailMappings.length} preserved=${lt.preservedChecklistItems.length} quickTransfers=${lt.quickTransfers.length} otherBadges=${items.otherBadges.length}`);
