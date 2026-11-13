'use strict';

const { serverEntry, serverIdentity } = require('./helpers/server-entry');
const { freePort } = require('./helpers/free-port');
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const port = freePort();
const root = path.resolve(__dirname, '..');
const { APP_VERSION } = require('../apps/api/src/platform/release/version.ts');
const { servedAssetsDigest } = require('../apps/api/src/platform/release/web-build.ts');
const { computeReleaseFingerprint } = require('../apps/api/src/platform/release/release-fingerprint.ts');
const releaseTreeSha256 = computeReleaseFingerprint(root);
const sessionSecret = ['smoke-test', '0123456789abcdef', '0123456789abcdef'].join('-');
const snapKey = ['smoke-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
const child = spawn(process.execPath, [serverEntry()], {
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
    const healthBody = await health.json();
    assert.match(String(healthBody.bootId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'each process names its start, so a restart can be observed');
    assert.deepStrictEqual(healthBody, {
      ok: true,
      service: 'alive',
      maintenance: false,
      bootId: healthBody.bootId
    });
    assert.strictEqual((await (await request('/healthz')).json()).bootId, healthBody.bootId, 'and keeps it for the life of the process');
    assert.match(health.headers.get('strict-transport-security') || '', /max-age=/);
    const csp = health.headers.get('content-security-policy') || '';
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /frame-src 'none'/);
    /* The same refusals for the browsers that predate CSP, and the isolation modern ones offer. */
    assert.strictEqual(health.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(health.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.strictEqual(health.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.strictEqual(health.headers.get('x-permitted-cross-domain-policies'), 'none');
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'browsing-topics=()']) {
      assert((health.headers.get('permissions-policy') || '').includes(feature), `${feature} is switched off`);
    }

    /* Where to report a vulnerability, and what crawlers may index. */
    const securityTxt = await request('/.well-known/security.txt');
    assert.strictEqual(securityTxt.status, 200);
    assert.match(securityTxt.headers.get('content-type') || '', /^text\/plain/);
    const securityBody = await securityTxt.text();
    assert.match(securityBody, /^Contact: https:\/\//m);
    const expires = /^Expires: (.+)$/m.exec(securityBody);
    assert(expires && Date.parse(expires[1]) > Date.now() + 90 * 86400000, 'security.txt never lapses');
    assert.match(securityBody, /^Canonical: .+\/\.well-known\/security\.txt$/m);
    const robots = await request('/robots.txt');
    assert.strictEqual(robots.status, 200);
    assert.match(await robots.text(), /^Disallow: \/api\/$/m);

    /* The maintainers' commentary stays in the source: the page, scripts and stylesheet are served without it. */
    const page = await (await request('/')).text();
    assert(!page.includes('<!--'), 'the page is served without comments');
    /* Built, so named by content: the page links its entry and stylesheet by those names. */
    const entryPath = (/<script type="module" crossorigin src="(\/build\/[^"]+\.js)"><\/script>/.exec(page) || [])[1];
    const sheetPath = (/<link rel="stylesheet" crossorigin href="(\/build\/[^"]+\.css)">/.exec(page) || [])[1];
    assert(entryPath && sheetPath, 'the page must link its built entry and stylesheet');
    const script = await request(entryPath);
    assert.strictEqual(script.status, 200);
    assert.match(script.headers.get('content-type'), /^application\/javascript/);
    assert.strictEqual(script.headers.get('cache-control'), 'public, max-age=31536000, immutable',
      'a file named by its content never changes under that name');
    const scriptBody = await script.text();
    /* A bundled library's licence notice is the one comment that ships; a shader's comments are string content. */
    const acorn = require(require.resolve('acorn', { paths: [path.dirname(require.resolve('eslint'))] }));
    const scriptComments = [];
    acorn.parse(scriptBody, { ecmaVersion: 'latest', sourceType: 'module', onComment: scriptComments });
    assert.deepStrictEqual(scriptComments.filter(comment => !/^!|@license|@preserve/.test(comment.value.trim())), [],
      'no comment in the served script');
    /* Recognised by what each says, which survives the build, not by a global name the page no longer publishes. */
    assert.match(scriptBody, /Unsafe archive file path traversal/, 'the archive validator is part of the entry');
    assert.match(scriptBody, /sha_or_tag/, 'the export helper is part of the entry');
    const etag = script.headers.get('etag');
    assert(etag, 'the served script has a validator');
    /*
     * As a browser revalidates. fetch() adds Cache-Control: no-cache to a request
     * that carries a validator unless one is given, and no-cache rightly forbids
     * answering from the validator alone.
     */
    const revalidate = tag => request(entryPath, { headers: { 'If-None-Match': tag, 'Cache-Control': 'max-age=0' } });
    assert.strictEqual((await revalidate(etag)).status, 304);
    /* Render's proxy compresses and weakens the tag; If-None-Match compares weakly either way. */
    const strong = etag.replace(/^W\//, '');
    assert.strictEqual((await revalidate(`W/${strong}`)).status, 304);
    assert.strictEqual((await revalidate(strong)).status, 304);
    const sheet = await (await request(sheetPath)).text();
    assert(!sheet.includes('/*'), 'the stylesheet is served without comments');
    const boot = await request('/theme-boot.js');
    assert.strictEqual(boot.headers.get('cache-control'), 'no-cache', 'a file whose name does not change is revalidated');
    assert(!/\/\*|^\s*\/\//m.test(await boot.text()), 'the classic script is served without comments');
    const worker = await (await request('/sw.js')).text();
    assert(!/^\s*\/\*(?!!)|^\s*\/\//m.test(worker), 'the service worker is served without comments');

    /* A file that is not there is not there: no shell page at 200 for a dotfile or a file name. */
    for (const missing of ['/.env', '/.git/HEAD', '/.git/config', '/package.json', '/server.js', '/apps/api/src/main.ts', '/backup.zip']) {
      const response = await request(missing);
      assert.strictEqual(response.status, 404, `${missing} must be a 404`);
      assert(!/html/i.test(response.headers.get('content-type') || ''), `${missing} must not answer with the app`);
    }
    /* A route is still the app. */
    const route = await request('/workspace/anything');
    assert.strictEqual(route.status, 200);
    assert.match(route.headers.get('content-type') || '', /html/);

    const ready = await request('/readyz');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual((await ready.json()).database, 'optional-not-configured');

    const version = await request('/api/version');
    assert.strictEqual(version.status, 200);
    assert.deepStrictEqual(await version.json(), {
      product: 'Nebulaverse-X',
      releaseTreeSha256,
      servedAssetsSha256: servedAssetsDigest(path.join(root, 'dist', 'web')),
      ...serverIdentity(root)
    });

    /*
     * The rule, rather than one route's shape: nothing a caller can reach
     * without a session names the release.
     *
     * Each of these is deliberately anonymous -- the hosted validator and the
     * operator checklist probe them, the landing page is the front door, and
     * /sw.js is fetched by the browser before anyone signs in. Any one of them
     * carrying the version puts it back within reach of a single curl, so the
     * guard sweeps all of them rather than trusting the four edits that made
     * it true today.
     */
    const anonymous = ['/', '/readyz', '/api/version', '/api/config',
      '/api/alpha/status', '/sw.js'];
    /*
     * Decoded, not only matched.
     *
     * A plain search for the version string missed the way it actually
     * escaped: the asset stamp rendered each byte of "5.3.0-alpha.17.0" as
     * three decimal digits, so the build travelled on every asset URL as
     * 053046051046048... and no assertion looking for the literal saw it. Any
     * run of three-digit groups long enough to be a stamp is read back as
     * bytes here, which is exactly what an attacker would do.
     */
    const decodedLeak = body => {
      for (const run of body.match(/\d{18,}/g) || []) {
        const groups = run.slice(0, run.length - (run.length % 3)).match(/.{3}/g) || [];
        if (groups.some(group => Number(group) > 255)) continue;
        if (Buffer.from(groups.map(Number)).toString('latin1').includes(APP_VERSION)) return true;
      }
      return false;
    };
    const leaking = [];
    for (const pathname of anonymous) {
      const response = await request(pathname);
      if (!response.ok) continue;
      const body = await response.text();
      if (body.includes(APP_VERSION) || decodedLeak(body)) leaking.push(pathname);
    }
    assert.deepStrictEqual(leaking, [],
      `these routes name the release to callers with no session: ${leaking.join(', ')}`);

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

    /*
     * A refused callback returns to the application carrying the reason rather
     * than ending on a bare page the reader can only leave by retyping the
     * address. What is asserted is the refusal, not the status code: that the
     * response is a redirect back into the app, that it names the reason, that
     * it never reaches the sign-in, and that it clears the state cookie so a
     * retry starts a fresh exchange instead of replaying a spent code.
     */
    const refusedOAuth = async (query, headers) => {
      const response = await request(`/api/oauth/callback?${query}`, { redirect: 'manual', headers });
      assert.ok(response.status >= 300 && response.status < 400,
        `a refused OAuth callback must not be served as a page (got ${response.status})`);
      const location = response.headers.get('location') || '';
      assert.match(location, /^\/\?oauth=/, 'a refused OAuth callback must return to the application with a reason');
      assert.doesNotMatch(location, /access_token|code=/, 'a refused OAuth callback must not carry credentials back');
      assert.ok(response.headers.getSetCookie().some(value => /^nv_oauth=;/.test(value) && /Max-Age=0/.test(value)),
        'a refused OAuth callback must clear the state cookie so a retry is a fresh exchange');
      return location;
    };
    assert.strictEqual(await refusedOAuth('code=not-exchanged'), '/?oauth=state_mismatch',
      'an OAuth callback without a state cookie must fail before exchange');
    await refusedOAuth('code=not-exchanged&state=obsolete', { cookie: 'nv_workspace_oauth_intent=obsolete' });

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
       * The removal shows as the absence of font or stylesheet bytes: a file
       * path is a 404 and an extensionless one falls through to the shell.
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
