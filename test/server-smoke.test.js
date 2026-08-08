'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const port = 22000 + Math.floor(Math.random() * 5000);
const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: 'smoke-test-secret-0123456789abcdef-0123456789abcdef',
    DATABASE_URL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function request(pathname, options) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode})\n${logs}`);
    try {
      const response = await request('/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

(async () => {
  try {
    await waitForServer();

    const health = await request('/healthz');
    assert.strictEqual(health.status, 200);
    assert.strictEqual((await health.json()).ok, true);
    assert.match(health.headers.get('strict-transport-security') || '', /max-age=/);
    const csp = health.headers.get('content-security-policy') || '';
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);

    const ready = await request('/readyz');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual((await ready.json()).database, 'optional-not-configured');

    const version = await request('/api/version');
    assert.strictEqual(version.status, 200);
    assert.deepStrictEqual(await version.json(), { version: '5.3.0-alpha.17.0', product: 'Nebulaverse-X' });

    const shell = await request('/');
    assert.strictEqual(shell.status, 200);
    assert.match(await shell.text(), /Neural/i);

    const archiveValidator = await request('/archive-safety.js?v=530');
    assert.strictEqual(archiveValidator.status, 200);
    assert.match(await archiveValidator.text(), /NebulaArchiveSafety/);

    const exportSafety = await request('/export-safety.js?v=530');
    assert.strictEqual(exportSafety.status, 200);
    assert.match(await exportSafety.text(), /NebulaExportSafety/);

    const missingAppHeader = await request('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-used' })
    });
    assert.strictEqual(missingAppHeader.status, 403);
    assert.strictEqual((await missingAppHeader.json()).code, 'APP_HEADER_REQUIRED');

    const crossSiteLogin = await request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv': '1', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ token: 'not-used' })
    });
    assert.strictEqual(crossSiteLogin.status, 403);
    assert.strictEqual((await crossSiteLogin.json()).code, 'CROSS_SITE_REQUEST');

    for (const [pathname, options] of [
      ['/api/security/csrf', undefined],
      ['/api/security/scanner-status', undefined],
      ['/api/repo/acme/demo/access-surface', undefined],
      ['/api/repo/acme/demo/emergency-manifest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NV': '1' }, body: JSON.stringify({ confirm: 'FREEZE' }) }]
    ]) {
      const protectedResponse = await request(pathname, options);
      assert.strictEqual(protectedResponse.status, 401, `${pathname} must require authentication`);
    }

    const invalidHook = await request('/hooks/github/not-a-hook', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.strictEqual(invalidHook.status, 404);

    const validShapeWithoutDb = await request(`/hooks/github/${'a'.repeat(48)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.strictEqual(validShapeWithoutDb.status, 503);

    const unknownVendor = await request('/vendor/arbitrary/1.0.0/file.js');
    assert.strictEqual(unknownVendor.status, 404);

    const unknownFont = await request('/gstatic/not/an-allowlisted-font.js');
    assert.strictEqual(unknownFont.status, 404);

    console.log('server smoke tests passed');
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
