'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const port = 22000 + Math.floor(Math.random() * 5000);
const root = path.resolve(__dirname, '..');
const { ASSET_VERSION } = require('../src/version');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const releaseTreeSha256 = computeReleaseFingerprint(root);
const sessionSecret = ['smoke-test', '0123456789abcdef', '0123456789abcdef'].join('-');
const snapKey = ['smoke-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: sessionSecret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'smoke-snapshot-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapKey,
    DATABASE_URL: '',
    /* Leftover owner settings must neither enable the retired API nor prevent
       ordinary startup. A live owner foundation would require PostgreSQL. */
    NV_WORKSPACE_FOUNDATION_ENABLED: '1',
    NV_WORKSPACE_SETUP_SHA256: 'retired-setting',
    NV_WORKSPACE_SETUP_EXPIRES_AT: 'retired-setting'
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
    /* maintenance is always reported, not only when it is on, so a monitor can
       read one field rather than infer the state from its absence. */
    assert.deepStrictEqual(await health.json(), {
      ok: true,
      service: 'alive',
      maintenance: false,
      version: '5.3.0-alpha.17.0'
    });
    assert.match(health.headers.get('strict-transport-security') || '', /max-age=/);
    const csp = health.headers.get('content-security-policy') || '';
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);

    const ready = await request('/readyz');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual((await ready.json()).database, 'optional-not-configured');

    const version = await request('/api/version');
    assert.strictEqual(version.status, 200);
    assert.deepStrictEqual(await version.json(), {
      version: '5.3.0-alpha.17.0',
      product: 'Nebulaverse-X',
      releaseTreeSha256
    });

    const config = await request('/api/config');
    assert.strictEqual(config.status, 200);
    const publicConfig = await config.json();
    assert.strictEqual(publicConfig.profile, 'local');
    assert.strictEqual(publicConfig.alphaMode, 'off');
    assert(!JSON.stringify(publicConfig).includes('SESSION_SECRET'));
    assert(!JSON.stringify(publicConfig).includes('DATABASE_URL'));

    const shell = await request('/');
    assert.strictEqual(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /Neural/i);
    assert(!html.includes('workspaceCard'), 'retired owner entry must not be rendered');
    assert(!html.includes('/workspace-ui.js'), 'retired owner transport must not be loaded');
    for (const pathname of ['/api/workspace/session', '/api/workspace/repositories', '/api/workspace/oauth/start']) {
      const retired = await request(pathname, { headers: {
        cookie: 'nv_workspace_session=obsolete; nv_workspace_oauth_intent=obsolete'
      } });
      assert.strictEqual(retired.status, 404, `${pathname} must remain unavailable even with old owner cookies/settings`);
      const expired = retired.headers.getSetCookie();
      assert(expired.some(value => value.startsWith('nv_workspace_session=;') && value.includes('Path=/api/workspace')));
      assert(expired.some(value => value.startsWith('nv_workspace_oauth_intent=;') && value.includes('Path=/;')));
      assert(expired.every(value => /Expires=Thu, 01 Jan 1970/.test(value)));
    }

    const archiveValidator = await request(`/archive-safety.js?v=${ASSET_VERSION}`);
    const missingOAuthState = await request('/api/oauth/callback?code=not-exchanged');
    assert.strictEqual(missingOAuthState.status, 400, 'an OAuth callback without a state cookie must fail before exchange');
    const retiredOAuthState = await request('/api/oauth/callback?code=not-exchanged&state=obsolete', {
      headers: { cookie: 'nv_workspace_oauth_intent=obsolete' }
    });
    assert.strictEqual(retiredOAuthState.status, 400, 'an old owner flow must not authorize ordinary OAuth');
    assert.strictEqual(archiveValidator.status, 200);
    assert.match(await archiveValidator.text(), /NebulaArchiveSafety/);

    const exportSafety = await request(`/export-safety.js?v=${ASSET_VERSION}`);
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

    /*
     * Typefaces are served from this origin. The former Google Fonts proxy
     * routes are gone, so a request for one must not resolve at all, and the
     * vendored faces must be reachable without leaving the origin.
     */
    for (const removed of [
      '/gstatic/s/dmsans/v11/abcdef.woff2',
      '/gfonts/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap'
    ]) {
      /*
       * Unmatched paths fall through to the application shell, so the removal
       * shows as the absence of font or stylesheet bytes rather than as a 404.
       * The second path is the exact query the old allowlist accepted, so this
       * fails if the proxy is ever restored.
       */
      const response = await request(removed);
      const type = String(response.headers.get('content-type') || '');
      assert(
        !/font|css/i.test(type),
        `${removed} must not resolve to font or stylesheet bytes, got ${type}`
      );
    }

    const servedFont = await request('/vendor/fonts/public-sans-variable-latin.woff2');
    assert.strictEqual(servedFont.status, 200, 'the interface must serve its own body face');

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
