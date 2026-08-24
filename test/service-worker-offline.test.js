'use strict';

/*
 * The worker's live-only branch, tested where it can be tested.
 *
 * A governance response must never be served from a cache, so the worker asks
 * the network every time and, when the network is gone, refuses in its own
 * words rather than reaching for anything stored. That refusal had one test: a
 * browser journey that put the page offline and expected the refusal back.
 *
 * It failed about half the time, and not because of timing. Putting a browser
 * context offline does not reliably reach requests that originate inside a
 * service worker -- the same blind spot that makes route interception miss
 * them -- so the worker kept fetching successfully and the journey kept
 * getting the server's answer instead of the worker's. Waiting longer did not
 * help, because there was nothing on the way.
 *
 * So the branch is exercised directly: the worker is loaded with its globals
 * stubbed, its fetch handler is called with a governance request, and the
 * network is made to fail. What the browser journey still covers -- that
 * nothing governance-shaped is ever written to a cache -- is deterministic and
 * stays there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const policySource = fs.readFileSync(path.join(root, 'public', 'offline-cache-policy.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

function loadWorker({ fetchImpl }) {
  const listeners = new Map();
  const self = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    location: { origin: 'https://nebulaverse.test' },
    skipWaiting() {},
    clients: { claim() {} },
    registration: {}
  };
  self.self = self;

  const context = {
    self,
    globalThis: self,
    caches: {
      async keys() { return []; },
      async open() { return { async match() { return undefined; }, async put() {}, async keys() { return []; } }; },
      async match() { return undefined; },
      async delete() { return true; }
    },
    fetch: fetchImpl,
    Response: globalThis.Response,
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    URL: globalThis.URL,
    console,
    importScripts() { vm.runInContext(policySource, contextObject); }
  };
  const contextObject = vm.createContext(context);
  vm.runInContext(workerSource, contextObject);
  return { listeners, self };
}

async function main() {
/* The refusal: no network, and nothing stored to fall back on. */
{
  let networkCalls = 0;
  const { listeners } = loadWorker({
    fetchImpl() { networkCalls += 1; return Promise.reject(new Error('offline')); }
  });
  const onFetch = listeners.get('fetch');
  assert.ok(onFetch, 'the worker registers a fetch handler');

  let answered = null;
  onFetch({
    request: new Request('https://nebulaverse.test/api/repo/acme/demo/governance/digital-twin'),
    respondWith(value) { answered = value; }
  });
  assert.ok(answered, 'a governance request is answered by the worker, not passed through');

  const response = await answered;
  assert.equal(response.status, 503, 'an unreachable network is refused, not reported as an error from the server');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.match(body.error, /live connection/i, 'the refusal says why in its own words');
  assert.equal(networkCalls, 1, 'the worker asked the network exactly once before refusing');
}

/* And with a network, the server's own answer is passed through untouched. */
{
  const { listeners } = loadWorker({
    fetchImpl() { return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })); }
  });
  let answered = null;
  listeners.get('fetch')({
    request: new Request('https://nebulaverse.test/api/repo/acme/demo/governance/digital-twin'),
    respondWith(value) { answered = value; }
  });
  const response = await answered;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
}

}

main().then(() => {
  process.stdout.write('service worker offline boundary tests passed\n');
}, error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
