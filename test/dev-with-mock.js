'use strict';

/*
 * Local preview with a mock GAS troop (mirrors vsbadge's dev-with-mock.mjs):
 *   node test/dev-with-mock.js [port]
 *
 * Starts mock troop 0082 (leader 1234567890 / PassA!234567, member
 * 1234560001 / MemberA!234, super admin S1 — central key shown on startup)
 * and the dev server, so the whole flow (troop picker, login, progress,
 * approvals, central-login bootstrap) can be exercised in a browser without
 * touching any real Google Sheet.
 */

const { startMockGas } = require('./mock-gas');

const DEV_PORT = parseInt(process.argv[2] || '3000', 10);
const MOCK_PORT = 3901;
const SUPER_KEY = '1234';

async function main() {
  process.env.SCOUTBADGE_PROXY_TEST = '1';
  process.env.SUPER_KEY = SUPER_KEY;
  process.env.TROOP_0082_NAME = '第 82 旅（本機 Mock）';
  process.env.TROOP_0082_BACKEND = `http://127.0.0.1:${MOCK_PORT}/exec`;
  process.env.TROOP_0082_APIKEY = 'KEY_A';

  await startMockGas({
    port: MOCK_PORT,
    name: '旅團A(0082)',
    apikey: 'KEY_A',
    execUrl: `http://127.0.0.1:${MOCK_PORT}/exec`,
    users: [
      { ymis: '1234567890', name: '陳大文', email: 'leader@example.org', role: 'group_leader', password: 'PassA!234567' },
      { ymis: '1234560001', name: '成員甲', email: 'member@example.org', role: 'member', password: 'MemberA!234' },
      { ymis: 'S1', name: '中央管代', email: '', role: 'super_admin', password: 'irrelevant' }
    ]
  });
  console.log(`mock GAS 旅團 0082 on http://127.0.0.1:${MOCK_PORT}/exec`);
  console.log(`dev server:     http://127.0.0.1:${DEV_PORT}`);
  console.log(`central login:  id=S1  key=${SUPER_KEY} (only in this process, never written anywhere)`);
  console.log(`中央登入首次設定：登入後到「成員管理」→ 中央登入設定，端點填 http://127.0.0.1:${DEV_PORT}/api/verify-super-ticket，編號 0082。`);

  process.env.PORT = String(DEV_PORT);
  // eslint-disable-next-line global-require
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'server.js')], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
