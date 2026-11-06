'use strict';

/*
 * SCOUTBOOK v2 keeps these awards on the device and does not upload them.
 * If a retry or a future build sends them anyway, refuse before a pending
 * row is created. Whole-badge ids already live in data/items.json as
 * SC-OTH-*; itemized OT-* / AYP-* are not catalogue ids. Do not rename
 * L1-* … L5-* or SC-*-* to absorb them. See docs/partner-scoutbook.md.
 */

const LOCAL_ONLY = Object.freeze([
  Object.freeze({ test: /^OT-LD(?:-|$)/, officialId: 'SC-OTH-002', name: '領導才獎章', verifier: '團長' }),
  Object.freeze({ test: /^OT-SF(?:-|$)/, officialId: 'SC-OTH-001', name: '服務獎章', verifier: '團長' }),
  Object.freeze({ test: /^OT-VS(?:-|$)/, officialId: 'SC-OTH-008', name: '深資童軍先修章', verifier: '團長' }),
  Object.freeze({ test: /^OT-RG(?:-|$)/, officialId: 'SC-OTH-005', name: '宗教章', verifier: '團長（可安排神職或導師考核後記錄）' }),
  Object.freeze({ test: /^OT-CM(?:-|$)/, officialId: 'SC-OTH-004', name: '社區參與章', verifier: '團長' }),
  Object.freeze({ test: /^AYP-/, officialId: 'SC-OTH-009', name: '香港青年獎勵計劃', verifier: 'AYP 評核員（不是團長在進度表按 CONFIRM）' })
]);

function localOnlyItem(itemId) {
  const id = String(itemId == null ? '' : itemId).trim();
  if (!id) return null;
  for (const row of LOCAL_ONLY) {
    if (row.test.test(id)) {
      return { itemId: id, officialId: row.officialId, name: row.name, verifier: row.verifier };
    }
  }
  return null;
}

function localOnlyError(itemId) {
  const info = localOnlyItem(itemId);
  if (!info) return null;
  return {
    success: false,
    code: 'VALIDATION',
    errorCode: 'VALIDATION',
    localOnly: true,
    officialId: info.officialId,
    error: '此項目尚未納入旅團同步，只可留在紀錄冊本機。整章官方編號是 ' +
      info.officialId + '（' + info.name + '），核實者：' + info.verifier + '。'
  };
}

module.exports = { LOCAL_ONLY, localOnlyItem, localOnlyError };
