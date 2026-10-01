'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { renderedUrl, auditRenderedSite } = require('../src/rendered-site-audit');
const { registerRenderedAudit } = require('../src/routes/rendered-audit');
const { runRenderedSite, killProcessTree } = require('../src/rendered-site-runner');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

(async () => {
  // Playwright launches Chromium in a separate process group. Cancellation
  // must stop a detached grandchild as well as the direct Node worker.
  if (process.platform === 'linux') {
    const parent = spawn(process.execPath, ['-e', `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const descendant = await new Promise(resolve => parent.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))));
    try {
      const exit = new Promise(resolve => parent.once('exit', resolve));
      killProcessTree(parent.pid);
      await exit;
      await new Promise(resolve => setTimeout(resolve, 50));
      let state = 'gone';
      try { const stat = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8'); state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; } catch { /* reaped */ }
      assert(['gone', 'Z'].includes(state), 'the detached browser-like grandchild must stop');
    } finally { try { process.kill(descendant, 'SIGKILL'); } catch {} try { process.kill(parent.pid, 'SIGKILL'); } catch {} }
  }
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com:444', 'https://example.com/#x', 'file:///tmp/a', 'invalid']) {
    assert.throws(() => renderedUrl(url), error => error.code === 'RENDERED_URL_INVALID');
  }
  assert.equal(renderedUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  await assert.rejects(auditRenderedSite({ url: 'https://example.com', launch: async options => {
    assert.equal(options.chromiumSandbox, true);
    assert(!options.args.includes('--no-sandbox'));
    assert.equal(options.proxy.server, 'http://127.0.0.1:9');
    throw new Error('synthetic launch failure');
  } }), error => error.code === 'RENDERED_AUDIT_UNAVAILABLE' && !error.message.includes('synthetic'));
  await assert.rejects(runRenderedSite({ url: 'https://example.com', executablePath: '/nonexistent/nv-test-browser' }), error => error.code === 'RENDERED_AUDIT_UNAVAILABLE');

  const app = express(); app.use(express.json());
  let launches = 0;
  let aborted = false;
  const report = { coverage: { complete: true }, viewports: [] };
  const access = (req, res, next) => {
    if (!req.headers['x-test-identity']) return res.status(401).json({ code: 'AUTH_REQUIRED' });
    req.gh = req.headers['x-test-identity']; next();
  };
  const jobs = registerRenderedAudit(app, { enabled: true, executablePath: process.execPath,
    providerSessionAccess: access, capabilityAccess: name => {
      assert.equal(name, 'site-check');
      return (req, res, next) => req.headers['x-test-deny'] ? res.status(403).end() : next();
    }, auth: (_req, _res, next) => next(), identityKey: who => who,
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code, error: error.message }),
    runner: ({ signal, url, onProgress }) => {
      launches++; onProgress({ stage: 'mobile' });
      if (url.endsWith('/fast')) return Promise.resolve(report);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true; reject(new Error('cancelled'));
      }, { once: true }));
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, identity, body, extra = {}) => fetch(base + route, { method,
    headers: { ...(identity ? { 'x-test-identity': identity } : {}), 'content-type': 'application/json', ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const query = (url, run) => '/api/site-rendered?' + new URLSearchParams({ url, run });
  try {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await call(method, '/api/site-rendered')).status, 401);
    assert.equal((await call('GET', '/api/site-rendered/status')).status, 401);
    assert.equal((await call('POST', '/api/site-rendered', 'denied', { url: 'https://example.com' }, { 'x-test-deny': '1' })).status, 403);
    const readiness = await call('GET', '/api/site-rendered/status', 'a');
    assert.equal(readiness.headers.get('cache-control'), 'no-store');
    assert.equal((await readiness.json()).available, true);
    assert.equal((await call('GET', '/api/site-rendered?url=https://example.com', 'a')).status, 400);
    assert.equal(launches, 0, 'polls and denied calls cannot launch a browser');
    const start = await call('POST', '/api/site-rendered', 'a', { url: 'https://example.com/slow' });
    assert.equal(start.status, 202);
    const { run } = await start.json();
    assert(run);
    assert.equal((await call('GET', query('https://example.com/slow', run), 'b')).status, 404);
    assert.equal((await call('GET', query('https://example.com/other', run), 'a')).status, 404);
    assert.equal((await call('DELETE', query('https://example.com/slow', run), 'b')).status, 404);
    assert.equal((await call('POST', '/api/site-rendered', 'b', { url: 'https://elsewhere.example/slow' })).status, 503);
    assert.equal((await call('DELETE', query('https://example.com/slow', run), 'a')).status, 200);
    assert(aborted, 'cancelling aborts the worker');
    assert.equal((await call('GET', query('https://example.com/slow', run), 'a')).status, 404);
    assert.equal((await call('POST', '/api/site-rendered', 'a', { url: 'https://example.com/fast' })).status, 429);
    const fast = await call('POST', '/api/site-rendered', 'c', { url: 'https://another.example/fast' });
    const started = await fast.json();
    const done = await call('GET', query('https://another.example/fast', started.run), 'c');
    assert.equal(done.status, 200); assert.deepEqual(await done.json(), report);
    jobs.close(); assert.equal(jobs.size(), 0);
    console.log('Rendered audit route, identity, cancellation and isolation tests passed');
  } finally { jobs.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
