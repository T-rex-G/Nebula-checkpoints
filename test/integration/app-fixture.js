'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { test: base, expect } = require('@playwright/test');
const { startGithubBoundary } = require('./github-boundary');
const { loadMigrations } = require('../../src/migrations');
const { computeReleaseFingerprint } = require('../../src/release-fingerprint');
const { checkDeployment } = require('../../scripts/check-deployment-readiness');

const root = path.resolve(__dirname, '../..');

async function withDatabase(connectionString, fn) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000, query_timeout: 10000 });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

/*
 * The landing's WebGL artwork, withheld from WebKit here and nowhere else.
 *
 * This suite proves the journey across the real server and PostgreSQL; the
 * artwork has its own suite. On a runner without a GPU every WebGL frame is
 * drawn on the CPU. Chromium names its software rasteriser, so the scene
 * takes its lite path. WebKit reports a generic renderer, so the scene cannot
 * tell. Twice, on 9c42da9 and c9410a3, the page then drew no frame for the
 * whole fifteen seconds the first click waits for its button to hold still,
 * while the other run of the same commit passed.
 *
 * A browser that hands the page no WebGL context is one the product already
 * serves completely: the vortex declines, the stage keeps its ground, and the
 * other pieces never mount. That is the page this journey crosses in WebKit.
 */
function withholdWebGL() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return /^(experimental-)?webgl/i.test(String(type)) ? null : getContext.call(this, type, ...rest);
  };
}

/*
 * Whether the page kept drawing, recorded so a stall that comes back is
 * evidence rather than a timeout. Every half second the page asks for one
 * frame: a frame that comes late, or a timer that fires late because the main
 * thread was held, is logged. Quiet on a page that keeps up.
 */
function recordFrameLag() {
  const origin = performance.now();
  let previous = origin;
  setInterval(() => {
    const asked = performance.now();
    const held = asked - previous - 500;
    previous = asked;
    if (held > 750) console.debug(`[nv-frames] main thread held ${Math.round(held)}ms before ${Math.round(asked - origin)}ms`);
    requestAnimationFrame(() => {
      const lag = performance.now() - asked;
      if (lag > 250) console.debug(`[nv-frames] frame ${Math.round(lag)}ms late at ${Math.round(asked - origin)}ms`);
    });
  }, 500);
}

const test = base.extend({
  page: async ({ page, browserName }, use, testInfo) => {
    const lines = [];
    page.on('console', message => { if (message.text().startsWith('[nv-frames]')) lines.push(message.text()); });
    if (browserName === 'webkit') await page.addInitScript(withholdWebGL);
    await page.addInitScript(recordFrameLag);
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && lines.length) {
      const body = lines.slice(-80).join('\n');
      console.log(`Rendering evidence (${browserName}):\n${body}`);
      await testInfo.attach('rendering-evidence', { body, contentType: 'text/plain' });
    }
  },
  application: async ({}, use, testInfo) => {
    const adminUrl = String(process.env.NV_TEST_DATABASE_URL || '').trim();
    if (!adminUrl) throw new Error('NV_TEST_DATABASE_URL is required; this integration gate must use real PostgreSQL');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(adminUrl).hostname)) {
      throw new Error('Browser integration requires a disposable loopback PostgreSQL server');
    }
    // Only a freshly generated database is mutated or dropped. The supplied
    // connection is an administrator connection, never the application DB.
    const name = `nvx_browser_${crypto.randomBytes(8).toString('hex')}`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${name}`;
    databaseUrl.searchParams.set('sslmode', 'disable');
    let provider;
    let child;
    let created = false;
    let logs = '';
    try {
      await withDatabase(adminUrl, client => client.query(`CREATE DATABASE ${name}`));
      created = true;
      provider = await startGithubBoundary();
      const port = await unusedPort();
      const origin = `http://127.0.0.1:${port}`;
      const expectedFingerprint = computeReleaseFingerprint(root);
      child = spawn(process.execPath, ['-r', path.join(__dirname, 'provider-preload.js'), 'server.js'], {
        cwd: root,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          NODE_ENV: 'test', PORT: String(port), DATABASE_URL: databaseUrl.toString(),
          SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
          NV_SNAPSHOT_SIGNING_KEY_ID: 'integration-only-snapshot',
          NV_SNAPSHOT_SIGNING_SECRET: crypto.randomBytes(48).toString('hex'),
          NV_INTEGRATION_PROVIDER_ORIGIN: provider.origin,
          NV_DATABASE_MIGRATION_MODE: 'apply'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-100000); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-100000); });
      const expectedMigration = loadMigrations(path.join(root, 'db/migrations')).at(-1).id;
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(`Integration server exited (${child.exitCode}): ${logs}`);
        try {
          const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2000) });
          const body = await response.json();
          return response.ok && body.ok === true && body.database !== 'optional-not-configured' && body.migration === expectedMigration;
        } catch { return false; }
      }, { timeout: 30000, message: 'Real server must apply the current migrations and become ready' }).toBe(true);
      // Exercise the operator command against actual server payloads, with a
      // fingerprint computed from the controlled source before server start.
      expect((await checkDeployment({ baseUrl: origin, expectedFingerprint, purpose: 'operator-verification' })).ok).toBe(true);
      expect((await checkDeployment({ baseUrl: origin, expectedFingerprint })).ok).toBe(false);
      await use({
        origin, provider,
        query: (sql, values) => withDatabase(databaseUrl.toString(), client => client.query(sql, values))
      });
    } finally {
      await stop(child);
      if (provider) await provider.close();
      if (created) await withDatabase(adminUrl, client => client.query(`DROP DATABASE ${name} WITH (FORCE)`));
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('application-log', { body: logs, contentType: 'text/plain' });
      }
      if (provider) await testInfo.attach('provider-requests', { body: JSON.stringify(provider.requests, null, 2), contentType: 'application/json' });
    }
  }
});

module.exports = { test, expect };
