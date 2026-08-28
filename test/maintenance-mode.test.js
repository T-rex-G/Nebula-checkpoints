'use strict';

/*
 * NV_MAINTENANCE_MODE has to actually take the service out of use.
 *
 * render.yaml has set NV_MAINTENANCE_MODE=0 since the blueprint was written,
 * and test/render-public-alpha-contract.test.js asserts it is set -- but no
 * application code ever read it. Turning it on did nothing at all. An operator
 * flipping it to 1 during an incident would have watched a passing test, a
 * documented switch and a fully serving application.
 *
 * What maintenance has to mean:
 *   - the application answers 503 and says so, in a form both a person and a
 *     script can read;
 *   - the platform's health check keeps passing, or the host recycles the
 *     instance and the operator loses the very control they just reached for;
 *   - static assets still load, so the maintenance response is not a bare
 *     error page;
 *   - readiness reports not-ready, because the service is deliberately not.
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 27000 + Math.floor(Math.random() * 2000);
const secret = ['maintenance-test', '0123456789abcdef', '0123456789abcdef'].join('-');
/* Distinct from the session secret: the server refuses to reuse one for both. */
const snapshotSecret = ['maintenance-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: secret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'maintenance-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapshotSecret,
    NV_MAINTENANCE_MODE: '1',
    DATABASE_URL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

const get = (pathname, options) => fetch(`http://127.0.0.1:${port}${pathname}`, options);

async function waitForBoot() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await get('/healthz');
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start in maintenance mode:\n${logs}`);
}

(async () => {
  try {
    await waitForBoot();

    /* The health check stays green: the host must not recycle the instance. */
    const health = await get('/healthz');
    assert.strictEqual(health.status, 200, 'health must stay up during maintenance');
    const healthBody = await health.json();
    assert.strictEqual(healthBody.maintenance, true, 'health must disclose maintenance');

    /* Readiness says no, because the service is deliberately not serving. */
    const ready = await get('/readyz');
    assert.strictEqual(ready.status, 503, 'readiness must report not-ready during maintenance');

    /* The API is closed, and says why in a form a script can act on. */
    const api = await get('/api/capabilities');
    assert.strictEqual(api.status, 503, 'API must be closed during maintenance');
    assert.strictEqual(api.headers.get('retry-after'), '120', 'a closed API must say when to retry');
    const apiBody = await api.json();
    assert.strictEqual(apiBody.error, 'SERVICE_IN_MAINTENANCE');
    assert(typeof apiBody.message === 'string' && apiBody.message.length > 10,
      'the maintenance response needs a message a person can read');

    /*
     * The whole API surface, not one lucky route.
     *
     * Asserted with reads. A bare PUT never reaches maintenance at all: the
     * cross-site origin guard refuses it first with 403, which is the correct
     * order -- the security boundary belongs ahead of an operational switch,
     * and a maintenance window is no reason to start accepting cross-site
     * writes. So the coverage claim is made where it can be made honestly.
     */
    for (const route of ['/api/capabilities', '/api/safety', '/api/repos', '/api/github-app/status']) {
      const response = await get(route);
      assert.strictEqual(response.status, 503, `${route} must be closed during maintenance`);
    }

    /* Static assets still load, so the page can render the notice. */
    const asset = await get('/style.css');
    assert.strictEqual(asset.status, 200, 'static assets must survive maintenance');

    /* And the document itself is served, carrying the notice rather than an error. */
    const page = await get('/');
    assert.strictEqual(page.status, 200, 'the application shell must still be served');

    console.log('maintenance mode tests passed');
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n${logs}\n`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
