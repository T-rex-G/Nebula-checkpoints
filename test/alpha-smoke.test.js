'use strict';

const assert = require('assert');
const http = require('http');
const { awaitReachable, buildSmokePlan, runSmoke, timedRequest, validateBaseUrl } = require('../scripts/alpha-smoke');

assert.deepStrictEqual(buildSmokePlan(), [
  ['GET', '/healthz', 200],
  ['GET', '/readyz', 200],
  ['GET', '/api/version', 200],
  ['GET', '/api/config', 200],
  ['GET', '/api/capabilities?provider=github&authority=github.com', 200]
]);
assert.strictEqual(validateBaseUrl('https://alpha.example').origin, 'https://alpha.example');
assert.strictEqual(validateBaseUrl('http://127.0.0.1:10000').origin, 'http://127.0.0.1:10000');
assert.throws(() => validateBaseUrl('http://alpha.example'), /HTTPS/);
assert.throws(() => validateBaseUrl('https://user:secret@alpha.example'), /credentials/);

/*
 * A free-plan service spins down when idle, and its first answer outlasts a
 * smoke request's twenty seconds. The hosted gate's restore smoke met exactly
 * that and stopped with "20: This operation was aborted". The smoke now wakes
 * the service first and, if a request still runs out of time, says which one.
 */
function clock() {
  let at = 0;
  return { now: () => at, sleep: async ms => { at += ms; } };
}

(async () => {
  /* Asleep, then starting, then up: woken, and the probes counted. */
  {
    const time = clock();
    const seen = [];
    const answers = [
      () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 20 }); },
      () => { throw new TypeError('fetch failed'); },
      () => new Response('starting', { status: 503 }),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ];
    const woke = await awaitReachable('https://alpha.example', {
      ...time,
      fetchImpl: async (url, init) => {
        seen.push([String(url), init.method, init.redirect, Boolean(init.signal)]);
        return answers.shift()();
      }
    });
    assert.deepStrictEqual(woke, { probes: 4 });
    assert(seen.every(([url, method, redirect, signal]) => url === 'https://alpha.example/healthz' && method === 'GET' && redirect === 'manual' && signal),
      'each probe asks /healthz, follows no redirect, and is bounded');
  }

  /* Never up: refused by name once the bound is spent, not hung. */
  {
    const time = clock();
    let probes = 0;
    await assert.rejects(
      awaitReachable('https://alpha.example', {
        ...time, deadlineMs: 60000, intervalMs: 5000,
        fetchImpl: async () => { probes += 1; return new Response('', { status: 502 }); }
      }),
      error => error.code === 'ALPHA_SMOKE_UNREACHABLE' && /https:\/\/alpha\.example did not answer its health check within 60s/.test(error.message)
    );
    assert(probes >= 10 && probes <= 13, `the bound is kept (${probes} probes)`);
  }

  /* A request that runs out of time names itself. */
  const silent = http.createServer(() => {});
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${silent.address().port}`;
    await assert.rejects(
      timedRequest(origin, '/readyz', { method: 'GET', timeoutMs: 150 }),
      error => error.code === 'ALPHA_SMOKE_TIMEOUT' && error.message === 'GET /readyz did not answer within 0.15s'
    );
  } finally {
    silent.closeAllConnections?.();
    await new Promise(resolve => silent.close(resolve));
  }

  /* The smoke wakes before it measures: the first plan request finds the service up. */
  const order = [];
  let awake = false;
  const service = http.createServer((request, response) => {
    order.push(request.url);
    if (request.url === '/healthz') awake = true;
    response.writeHead(awake ? 200 : 503, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runSmoke(`http://127.0.0.1:${service.address().port}`);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(order, ['/healthz', ...buildSmokePlan().map(([, pathname]) => pathname)],
      'one wake probe, then the plan in order');
  } finally {
    service.closeAllConnections?.();
    await new Promise(resolve => service.close(resolve));
  }

  console.log('alpha smoke planner tests passed');
})().catch(error => { console.error(error); process.exit(1); });
