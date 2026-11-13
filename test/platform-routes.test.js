'use strict';
/*
 * The platform's own routes, over HTTP (D12), on their registrations in
 * apps/api/src/http/routes: the probes, the public files and the page, the
 * vendor libraries, the webhook intake, the configuration and capabilities,
 * the account's API budget, the build's identity and the shell fallback.
 *
 * What each must hold: the chain and the place among the pipeline's steps
 * that the route policy records; health that names no release and readiness
 * that drains for maintenance and a hosted deployment without its database;
 * a security.txt whose canonical origin is the configured HTTPS one and whose
 * expiry never lapses; vendor files served only from the allowlist, from
 * disk when bundled, and from the CDN bounded to 2 MB and cached; a webhook
 * body handed over as the exact bytes; the configuration publishing the
 * server's own ceilings; and a 404, not the page, for an API path or a file
 * that is not there.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const routes = require('../apps/api/src/http/routes/index.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const MB = 1024 * 1024;

/* ---- The chains and positions, as the baseline inventory recorded them and the route policy reads them now ---- */
const MOVED = [
  'GET /healthz', 'GET /readyz', 'GET /.well-known/security.txt', 'GET /robots.txt', 'GET /apple-touch-icon.png', 'GET /apple-touch-icon-precomposed.png',
  'GET /vendor/*', 'POST /hooks/github/:hookId', 'GET /', 'GET /index.html', 'GET /sw.js', 'GET /api/config', 'GET /api/capabilities',
  'GET /api/account/capabilities', 'GET /api/rate', 'GET /api/version', 'GET *'
];
{
  const entries = locations(root);
  const now = new Map(entries.filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const baseline = new Map(inventory.routes.map(route => [`${route.method} ${route.path}`, route]));
  assert.equal(MOVED.length, 17);
  for (const key of MOVED) {
    const route = baseline.get(key);
    assert(route && route.owner === 'platform', `${key} is the platform's`);
    const entry = now.get(key);
    assert(entry, `${key} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${key} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/http/routes/'), `${key} is registered by the platform (${entry.at})`);
  }
  /* The webhook reads its raw body before the JSON parser; the page is served before the API's maintenance gate; the fallback is last. */
  const order = entries.map(entry => (entry.kind === 'route' ? `${entry.method} ${entry.path}` : `use ${entry.label}`));
  assert(order.indexOf('POST /hooks/github/:hookId') < order.indexOf('use json-body'), 'the webhook is read before the JSON parser');
  assert(order.indexOf('GET /sw.js') < order.indexOf('use api-maintenance'), 'the page is served before the API is gated for maintenance');
  assert.equal(order.at(-1), 'GET *', 'the shell fallback is the last route');
}

const files = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-routes-'));
const webRoot = path.join(files, 'web');
fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
fs.writeFileSync(path.join(webRoot, 'assets', 'apple-touch-icon.png'), Buffer.from('PNGicon'));
const vendorRoot = path.join(files, 'vendor');
fs.mkdirSync(path.join(vendorRoot, 'marked', '15.0.12'), { recursive: true });
fs.writeFileSync(path.join(vendorRoot, 'marked', '15.0.12', 'marked.min.js'), 'bundled marked');
const WEB_BUILD = { index: '<!doctype html><title>N</title>', serviceWorker: 'self.x = 1;', servedAssetsSha256: 'f'.repeat(64) };

function harness(settings = {}) {
  const calls = [];
  const state = { ready: true, readiness: { ok: true, state: 'ready' }, poolFails: false, cdn: new Map(), rate: { resources: { core: { remaining: 9, limit: 60, reset: 99 } } } };
  const app = express();
  routes.registerProbeRoutes(app, {
    maintenance: !!settings.maintenance, bootId: 'boot-1', hostedAlpha: settings.profile !== 'local',
    databaseConfigured: () => settings.database !== false,
    databaseReady: async () => state.ready,
    selectOne: async () => { calls.push(['select']); if (state.poolFails) throw new Error('connection reset'); },
    readiness: () => state.readiness, migration: () => '20261026_latest',
    invalidateDatabaseReady: reason => { calls.push(['invalidate', reason]); state.readiness = { ok: false, state: reason }; }
  });
  routes.registerPublicFileRoutes(app, {
    securityContact: () => 'mailto:security@nebula.example', configuredOrigin: () => settings.origin || '', webRoot
  });
  routes.registerVendorRoute(app, {
    vendorRoot,
    fetch: async (url, init) => {
      calls.push(['cdn', url, init.headers['User-Agent']]);
      const answer = state.cdn.get(url) || { size: 10 };
      if (answer.status) return new Response('gone', { status: answer.status });
      return new Response(Buffer.alloc(answer.size, 'v'), { status: 200, headers: { 'content-type': 'text/css' } });
    }
  });
  routes.registerWebhookIntakeRoute(app, {
    receiveGithubWebhook: (req, res) => { calls.push(['webhook', req.params.hookId, Buffer.isBuffer(req.body) ? req.body.toString() : req.body]); res.status(202).end(); }
  });
  app.use(express.json());
  routes.registerWebShellRoutes(app, { webBuild: WEB_BUILD });
  const pass = (_req, _res, next) => next();
  const session = (req, _res, next) => { req.gh = { login: 'alice', provider: 'github', authMethod: 'oauth' }; next(); };
  routes.registerConfigRoutes(app, {
    providerSessionAccess: session,
    hostedConfig: () => ({ profile: 'hosted-alpha', alphaMode: 'invite', termsVersion: '2026-07-30', limits: { uploadMaxMb: 25 }, database: state.readiness }),
    oauth: true, githubApp: { enabled: false, webhookConfigured: false },
    uploads: { uploadMaxMb: 25, gitDataMaxMb: 64, nativePushMaxMb: 64, contentsMaxMb: 40 },
    qualificationCapabilities: settings.qualification || [],
    projectCapabilities: context => ({ projected: context }), deployment: 'hosted-alpha',
    accountCapabilityContext: account => ({ provider: account.provider, authMethod: account.authMethod }), account: req => req.gh
  });
  routes.registerProviderRateRoute(app, {
    auth: session, capabilityAccess: () => pass, account: req => req.gh,
    fail: (res, error) => res.status(500).json({ error: error.message }),
    gh: async (account, apiPath) => { calls.push(['gh', account.login, apiPath]); return state.rate; }
  });
  routes.registerVersionRoute(app, { product: 'Nebulaverse-X', releaseTreeSha256: 'a'.repeat(64), servedAssetsSha256: WEB_BUILD.servedAssetsSha256, serverRuntime: settings.runtime || { mode: 'native' } });
  routes.registerShellFallback(app, { webBuild: WEB_BUILD });
  /* A refused body answers its status, without express printing the refusal. */
  app.use((error, _req, res, _next) => res.status(error.status || 500).end());
  return { app, calls, state };
}

async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const call = (method, route, { body, type, host } = {}) => new Promise((resolve, reject) => {
    const headers = { host: host || `127.0.0.1:${port}` };
    if (body !== undefined) { headers['content-type'] = type || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const outgoing = http.request({ host: '127.0.0.1', port, method, path: route, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  try { await run(call); } finally { await new Promise(resolve => server.close(resolve)); }
}

(async () => {
  /* ---- Health and readiness ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      const health = await call('GET', '/healthz');
      assert.deepEqual(health.json, { ok: true, service: 'alive', maintenance: false, bootId: 'boot-1' }, 'health names no release');
      assert.deepEqual((await call('GET', '/readyz')).json, { ok: true, database: 'ready', migration: '20261026_latest' });
      state.ready = false;
      state.readiness = { ok: false, state: 'migration-pending' };
      assert.deepEqual([(await call('GET', '/readyz')).status, calls.filter(entry => entry[0] === 'select').length], [503, 1], 'a database not ready is not asked again');
      state.ready = true;
      state.poolFails = true;
      const failed = await call('GET', '/readyz');
      assert.deepEqual([failed.status, failed.json.database], [503, 'unavailable']);
      assert.deepEqual(calls.at(-1), ['invalidate', 'unavailable'], 'a failed round trip sends readiness back to be checked');
    });
  }
  {
    const { app } = harness({ maintenance: true });
    await serve(app, async call => {
      assert.equal((await call('GET', '/healthz')).json.service, 'maintenance', 'health stays green in maintenance');
      const ready = await call('GET', '/readyz');
      assert.deepEqual([ready.status, ready.headers['retry-after']], [503, '120'], 'maintenance drains');
    });
  }
  for (const [profile, status] of [['hosted-alpha', 503], ['local', 200]]) {
    const { app } = harness({ database: false, profile });
    await serve(app, async call => assert.equal((await call('GET', '/readyz')).status, status, `${profile} without a database`));
  }

  /* ---- The public files and the page ---- */
  {
    const { app } = harness({ origin: 'https://nebula.example///' });
    await serve(app, async call => {
      const security = await call('GET', '/.well-known/security.txt', { host: 'evil.example' });
      assert.match(security.text, /^Contact: mailto:security@nebula\.example\nExpires: \d{4}-\d{2}-\d{2}T00:00:00\.000Z\nPreferred-Languages: en\nCanonical: https:\/\/nebula\.example\/\.well-known\/security\.txt\n$/);
      const expires = Date.parse(/Expires: (\S+)/.exec(security.text)[1]);
      assert(expires > Date.now() + 181 * 86400000 && expires < Date.now() + 183 * 86400000, 'security.txt expires six months out');
      assert.equal((await call('GET', '/robots.txt')).text, 'User-agent: *\nAllow: /$\nDisallow: /api/\n');
      for (const icon of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) assert.equal((await call('GET', icon)).text, 'PNGicon');
      const worker = await call('GET', '/sw.js');
      assert.deepEqual([worker.headers['cache-control'], worker.headers['service-worker-allowed']], ['no-cache, no-store, must-revalidate', '/']);
      assert.equal((await call('GET', '/index.html')).headers['cache-control'], 'no-cache');
      assert.equal((await call('GET', '/settings/profile')).text, WEB_BUILD.index, 'a route the browser owns gets the page');
      for (const missing of ['/api/nope', '/.env', '/.git/HEAD', '/package.json']) {
        const answer = await call('GET', missing);
        assert.equal(answer.status, 404, `${missing} is not there`);
        assert.notEqual(answer.text, WEB_BUILD.index);
      }
    });
  }
  {
    const { app } = harness({ origin: 'http://plain.example' });
    await serve(app, async call => {
      assert.match((await call('GET', '/.well-known/security.txt', { host: 'nebula.example' })).text, /Canonical: http:\/\/nebula\.example\//, 'an origin not over HTTPS is not trusted as canonical');
    });
  }

  /* ---- Vendor files ---- */
  {
    const { app, calls, state } = harness();
    await serve(app, async call => {
      assert.equal((await call('GET', '/vendor/marked/15.0.12/marked.min.js')).text, 'bundled marked', 'a bundled file is read from disk');
      assert.equal(calls.filter(entry => entry[0] === 'cdn').length, 0);
      for (const refused of ['/vendor/not/allowed.js', '/vendor/marked/15.0.12/../15.0.12/marked.min.js']) assert.equal((await call('GET', refused)).status, 404);
      const fetched = await call('GET', '/vendor/codemirror/5.65.16/codemirror.min.css');
      assert.deepEqual([fetched.status, fetched.headers['cache-control']], [200, 'public, max-age=31536000, immutable']);
      assert.deepEqual(calls.at(-1), ['cdn', 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36']);
      await call('GET', '/vendor/codemirror/5.65.16/codemirror.min.css');
      assert.equal(calls.filter(entry => entry[0] === 'cdn').length, 1, 'a fetched file is cached');
      state.cdn.set('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/nord.min.css', { size: 2 * MB + 1 });
      assert.deepEqual((await call('GET', '/vendor/codemirror/5.65.16/theme/nord.min.css')).json, { error: 'Vendor asset exceeds the response limit' });
      state.cdn.set('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/monokai.min.css', { status: 404 });
      assert.deepEqual((await call('GET', '/vendor/codemirror/5.65.16/theme/monokai.min.css')).json, { error: 'Vendor upstream 404' });
      /* Thirteen files just under 2 MB fill the 24 MB cache; the oldest goes first. */
      const big = ['mode/meta.min.js', 'mode/javascript/javascript.min.js', 'mode/xml/xml.min.js', 'mode/css/css.min.js', 'mode/htmlmixed/htmlmixed.min.js',
        'mode/markdown/markdown.min.js', 'mode/python/python.min.js', 'mode/shell/shell.min.js', 'mode/yaml/yaml.min.js', 'addon/search/searchcursor.min.js',
        'theme/ayu-mirage.min.css', 'theme/base16-light.min.css', 'theme/dracula.min.css'].map(file => `codemirror/5.65.16/${file}`);
      for (const file of big) {
        state.cdn.set(`https://cdnjs.cloudflare.com/ajax/libs/${file}`, { size: 2 * MB - 1 });
        await call('GET', `/vendor/${file}`);
      }
      const before = calls.filter(entry => entry[0] === 'cdn').length;
      await call('GET', '/vendor/codemirror/5.65.16/codemirror.min.css');
      await call('GET', `/vendor/${big.at(-1)}`);
      assert.equal(calls.filter(entry => entry[0] === 'cdn').length, before + 1, 'the oldest entry was evicted and the newest kept');
    });
  }

  /* ---- The webhook intake ---- */
  {
    const { app, calls } = harness();
    await serve(app, async call => {
      const payload = '{"zen": "Keep it logically awesome.",  "hook_id": 1}';
      assert.equal((await call('POST', '/hooks/github/h1', { body: payload })).status, 202);
      assert.deepEqual(calls.at(-1), ['webhook', 'h1', payload], 'the receiver gets the exact bytes GitHub signed');
      assert.equal((await call('POST', '/hooks/github/h1', { body: 'x'.repeat(2 * MB + 1) })).status, 413, 'a body over 2 MB is refused');
    });
  }

  /* ---- Configuration, capabilities, the API budget and the build ---- */
  {
    const { app, calls } = harness({ qualification: ['lfs'], runtime: { mode: 'compiled', buildSha256: 'b'.repeat(64) } });
    await serve(app, async call => {
      const config = await call('GET', '/api/config');
      assert.deepEqual(config.json, {
        profile: 'hosted-alpha', alphaMode: 'invite', termsVersion: '2026-07-30', limits: { uploadMaxMb: 25 }, database: { state: 'ready' },
        oauth: true, githubApp: { enabled: false, webhookConfigured: false },
        uploadMaxMb: 25, gitDataMaxMb: 64, nativePushMaxMb: 64, contentsMaxMb: 40, qualification: { capabilities: ['lfs'] }
      });
      assert.equal((await call('GET', '/api/capabilities?provider=gitlab')).json.code, 'PROVIDER_UNSUPPORTED');
      assert.equal((await call('GET', '/api/capabilities?authority=ghe.example')).json.code, 'PROVIDER_AUTHORITY_UNSUPPORTED');
      const capabilities = await call('GET', '/api/capabilities?provider=github');
      assert.deepEqual([capabilities.json, capabilities.headers['cache-control']], [{ projected: { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha' } }, 'public, max-age=300']);
      const account = await call('GET', '/api/account/capabilities');
      assert.deepEqual([account.json, account.headers['cache-control'], account.headers.vary], [{ projected: { provider: 'github', authMethod: 'oauth' } }, 'private, no-store', 'Cookie']);
      assert.deepEqual((await call('GET', '/api/rate')).json, { remaining: 9, limit: 60, reset: 99 });
      assert.deepEqual(calls.at(-1), ['gh', 'alice', '/rate_limit']);
      assert.deepEqual((await call('GET', '/api/version')).json, {
        product: 'Nebulaverse-X', releaseTreeSha256: 'a'.repeat(64), servedAssetsSha256: 'f'.repeat(64), serverRuntime: 'compiled', serverBuildSha256: 'b'.repeat(64)
      }, 'the build is named by digest, never by version');
    });
  }

  fs.rmSync(files, { recursive: true, force: true });
  console.log('platform routes passed');
})().catch(error => { console.error(error); process.exit(1); });
