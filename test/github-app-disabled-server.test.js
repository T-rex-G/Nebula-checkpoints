'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 29600 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: 'github-app-disabled-test-secret-0123456789abcdef-0123456789abcdef',
    DATABASE_URL: '',
    GITHUB_APP_ID: '', GITHUB_APP_SLUG: '', GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '',
    GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_PRIVATE_KEY_BASE64: '', GITHUB_APP_CALLBACK_URL: '', GITHUB_APP_WEBHOOK_SECRET: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${logs}`);
}

(async () => {
  try {
    await waitForServer();
    const config = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.strictEqual(config.status, 200);
    const data = await config.json();
    assert.deepStrictEqual(data.githubApp, { enabled: false, webhookConfigured: false });
    assert.strictEqual(JSON.stringify(data).includes('secret'), false);

    const connect = await fetch(`http://127.0.0.1:${port}/api/github-app/connect`, {
      method: 'POST', headers: { 'x-nv': '1', 'content-type': 'application/json' }, body: '{}'
    });
    assert.strictEqual(connect.status, 404);
    assert.strictEqual((await connect.json()).code, 'GITHUB_APP_DISABLED');
    console.log('github app disabled server tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref();
    });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
