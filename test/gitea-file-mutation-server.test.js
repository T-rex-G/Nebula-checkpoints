'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'gitea-provider-fetch.js');
const port = 27000 + Math.floor(Math.random() * 1000);
const sessionSecret = ['gitea-server-test', '0123456789abcdef', '0123456789abcdef'].join('-');
const snapKey = `${sessionSecret}:snapshot`;
const child = spawn(process.execPath, ['-r', fixture, 'server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: sessionSecret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'gitea-test-snapshot-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapKey,
    DATABASE_URL: '',
    NV_GIT_HOST_ALLOWLIST: 'gitea.example',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function appRequest(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await appRequest('/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

function cookieFrom(response, fallback = '') {
  const value = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)nv_session=([^;]*)/i.exec(value);
  if (!match) {
    assert(fallback, 'login must create a session cookie');
    return fallback;
  }
  return `nv_session=${match[1]}`;
}

async function csrf(session) {
  const response = await appRequest('/api/security/csrf', { headers: { Cookie: session.cookie } });
  assert.strictEqual(response.status, 200);
  session.cookie = cookieFrom(response, session.cookie);
  return (await response.json()).token;
}

async function mutate(session, method, body) {
  const token = await csrf(session);
  return appRequest('/api/repo/Acme/Demo/file', {
    method,
    headers: {
      'content-type': 'application/json',
      'x-nv': '1',
      'x-nv-csrf': token,
      Cookie: session.cookie
    },
    body: JSON.stringify(body)
  });
}

(async () => {
  try {
    await waitForServer();
    const login = await appRequest('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv': '1' },
      body: JSON.stringify({
        provider: 'gitea',
        token: 'fixture-write-token',
        baseUrl: 'https://gitea.example'
      })
    });
    assert.strictEqual(login.status, 200);
    const session = { cookie: cookieFrom(login) };

    const created = await mutate(session, 'PUT', {
      path: 'folder/a.txt',
      content: 'hello\n',
      message: 'Create fixture',
      branch: 'main',
      expectedHeadSha: '1'.repeat(40)
    });
    const createdText = await created.text();
    assert.strictEqual(created.status, 200, createdText);
    assert.deepStrictEqual(JSON.parse(createdText), {
      ok: true,
      sha: '3'.repeat(40),
      commit: '2'.repeat(40)
    });

    const stale = await mutate(session, 'PUT', {
      path: 'folder/stale.txt',
      content: 'must not commit\n',
      branch: 'main',
      expectedHeadSha: '1'.repeat(40)
    });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual((await stale.json()).code, 'BRANCH_CHANGED');

    const deleted = await mutate(session, 'DELETE', {
      path: 'folder/a.txt',
      message: 'Delete fixture',
      branch: 'main',
      expectedHeadSha: '2'.repeat(40)
    });
    const deletedText = await deleted.text();
    assert.strictEqual(deleted.status, 200, deletedText);
    assert.deepStrictEqual(JSON.parse(deletedText), {
      ok: true,
      commit: '4'.repeat(40)
    });

    console.log('Gitea server mutation regression passed');
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
  console.error(logs);
  process.exitCode = 1;
});
