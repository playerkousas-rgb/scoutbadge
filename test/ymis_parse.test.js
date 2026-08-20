const assert = require('assert');
const Y = require('../assets/ymis-parse.js');

function run() {
  console.log('=== YMIS PDF / 文字解析測試 ===\n');

  // Test 1: pdf.js text items（3 欄：編號 / 中文姓名 / 電郵）
  console.log('Test 1: pdf.js items → 成員');
  const items = [
    { str: '童軍成員編號', x: 50, y: 700, width: 60 },
    { str: '中文姓名', x: 200, y: 700, width: 40 },
    { str: '電郵地址', x: 350, y: 700, width: 40 },
    { str: '1234560001', x: 50, y: 680, width: 55 },
    { str: '陳大文', x: 200, y: 680, width: 30 },
    { str: 'chan@example.org', x: 350, y: 680, width: 80 },
    { str: '1234560002', x: 50, y: 660, width: 55 },
    { str: '李小明', x: 200, y: 660, width: 30 },
    { str: 'lee@example.org', x: 350, y: 660, width: 80 },
    { str: '第 1 頁', x: 50, y: 40, width: 30 }
  ];
  const r1 = Y.parseItems(items);
  assert.strictEqual(r1.members.length, 2, '應解析出 2 名成員');
  assert.deepStrictEqual(r1.members[0], {
    ymis: '1234560001', name: '陳大文', email: 'chan@example.org', warn: [], raw: r1.members[0].raw
  });
  assert.strictEqual(r1.members[1].name, '李小明');
  console.log('  [PASS] 抬頭/頁尾略過，3 欄對應正確');

  // Test 2: 同一欄被 pdf.js 拆成多個 item（字距小 → 應合併成一個儲存格）
  console.log('\nTest 2: 拆碎的中文姓名要合併');
  const split = [
    { str: '1234560003', x: 50, y: 600, width: 55 },
    { str: '張', x: 200, y: 600, width: 10 },
    { str: '美', x: 210, y: 600, width: 10 },
    { str: '玲', x: 220, y: 600, width: 10 },
    { str: 'cheung@example.org', x: 350, y: 600, width: 80 }
  ];
  const r2 = Y.parseItems(split);
  assert.strictEqual(r2.members[0].name, '張美玲');
  console.log('  [PASS] 合併為「張美玲」');

  // Test 3: 純文字貼上（多空格 / TAB 分隔）
  console.log('\nTest 3: 貼上文字解析');
  const text = [
    '童軍成員編號  中文姓名  電郵地址',
    '1234560004\t王志強\twong@example.org',
    '1234560005   黃淑儀   ',
    'rubbish line without number'
  ].join('\n');
  const r3 = Y.parseText(text);
  assert.strictEqual(r3.members.length, 2);
  assert.strictEqual(r3.members[1].email, '');
  assert.ok(r3.members[1].warn.includes('no_email'));
  assert.ok(r3.skipped.some(s => s.reason === 'no_ymis'));
  console.log('  [PASS] 缺電郵有 warn，無編號的行被略過');

  // Test 4: 重複 YMIS 只取一次
  console.log('\nTest 4: 重複編號');
  const r4 = Y.parseText('1234560006 林俊傑 lam@example.org\n1234560006 林俊傑 lam@example.org');
  assert.strictEqual(r4.members.length, 1);
  assert.strictEqual(r4.skipped[0].reason, 'duplicate');
  console.log('  [PASS] 重複列被略過');

  // Test 5: 非 10 位編號 → warn，可選補零
  console.log('\nTest 5: 編號長度');
  const r5 = Y.parseText('2885846 陳小強 keung@example.org');
  assert.ok(r5.members[0].warn.includes('ymis_len'));
  const r5b = Y.parseText('2885846 陳小強 keung@example.org', { padTo10: true });
  assert.strictEqual(r5b.members[0].ymis, '0002885846');
  assert.deepStrictEqual(r5b.members[0].warn, []);
  assert.strictEqual(Y.padTo10('M28858467'.replace(/\D/g, '')), '0028858467');
  console.log('  [PASS] 長度不足會提示，亦可自動補零至 10 位');

  // Test 6: 整列被合併成單一 item 的備援解析
  console.log('\nTest 6: 單一 item 備援');
  const r6 = Y.parseItems([{ str: '1234560007 何詩敏 ho@example.org', x: 50, y: 500, width: 200 }]);
  assert.strictEqual(r6.members.length, 1);
  assert.strictEqual(r6.members[0].name, '何詩敏');
  assert.strictEqual(r6.members[0].email, 'ho@example.org');
  console.log('  [PASS] 單 item 亦可還原 3 欄');

  console.log('\n=== 全部通過 ===');
}

run();
