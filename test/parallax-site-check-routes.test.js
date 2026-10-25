'use strict';
/*
 * The site check's two routes, over HTTP (D12): the check behind them is
 * handed in, and the clock is held, so what the routes decide -- who may
 * start a check, how often, of what, and what a poll is told -- is read
 * without a network. The check itself is tested on its own
 * (test/site-check.test.js), and the rendered audit's routes beside these
 * in test/rendered-audit.test.js.
 */
const assert = require('node:assert/strict');
const express = require('express');
const { registerParallaxRoutes } = require('../apps/api/src/modules/parallax/index.ts');

(async () => {
  let clock = 1_000_000_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  const checks = [];
  const pending = [];
  const app = express();
  const identity = (req, res, next) => {
    if (!req.headers['x-test-identity']) return res.status(401).json({ code: 'AUTH_REQUIRED' });
    req.gh = req.headers['x-test-identity'];
    return next();
  };
  const { site, rendered } = registerParallaxRoutes(app, {
    providerSessionAccess: identity,
    alphaRepositoryAccess: (req, res, next) => req.params.repo === 'private' ? res.status(403).json({ code: 'ALPHA_REPOSITORY_DENIED' }) : next(),
    capabilityAccess: name => {
      assert.equal(name, 'site-check');
      return (req, res, next) => req.headers['x-test-deny'] ? res.status(403).json({ code: 'CAPABILITY_DENIED' }) : next();
    },
    auth: (_req, _res, next) => next(),
    viewer: req => req.gh,
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code, error: error.message }),
    renderedEnabled: false,
    siteCheck: input => {
      checks.push({ url: input.url, signal: input.signal instanceof AbortSignal });
      if (String(input.url).includes('slow')) return new Promise(resolve => pending.push(resolve));
      return Promise.resolve({ origin: input.url, findings: [] });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (route, identityName, extra = {}) => {
    const response = await fetch(base + route, { headers: { ...(identityName ? { 'x-test-identity': identityName } : {}), ...extra } });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), cache: response.headers.get('cache-control'), body: await response.json() };
  };
  const check = (url, run) => `/api/site-check?${new URLSearchParams({ url, ...(run ? { run } : {}) })}`;
  try {
    /* Who may ask. */
    assert.equal((await ask(check('https://example.com'))).status, 401);
    assert.equal((await ask(check('https://example.com'), 'a', { 'x-test-deny': '1' })).status, 403);
    assert.equal((await ask('/api/repo/acme/private/site-check?url=https://example.com', 'a')).status, 403);
    assert.equal(checks.length, 0, 'a refused caller starts nothing');

    /* An address that is not an HTTPS origin on the default port is refused before anything runs. (A
       private address is refused by the guarded transport when the check connects, not here.) */
    for (const url of ['not a url', 'ftp://example.com', 'http://example.com', 'https://user:pw@example.com', 'https://example.com:8443', '']) {
      const refused = await ask(check(url), 'a');
      assert.equal(refused.status, 400, url);
      assert.equal(refused.cache, 'no-store');
    }
    assert.equal(checks.length, 0);

    /* A check is a job: started with 202 and a run, and read back by that run. */
    const started = await ask(check('https://example.com/some/page?q=1'), 'a');
    assert.equal(started.status, 202);
    assert.equal(started.retryAfter, '1');
    assert.equal(started.cache, 'no-store');
    assert.deepEqual(checks, [{ url: 'https://example.com', signal: true }], 'only the origin is checked, under a cancellable signal');
    const done = await ask(check('https://example.com', started.body.run), 'a');
    assert.equal(done.status, 200);
    assert.equal(done.body.origin, 'https://example.com');
    assert(!Number.isNaN(Date.parse(done.body.checkedAt)), 'the report says when it was taken');
    assert.equal((await ask(check('https://example.com', started.body.run), 'b')).status, 404, 'a run belongs to the viewer who started it');

    /* One new check a viewer every fifteen seconds. */
    clock += 14_999;
    const soon = await ask(check('https://another.example'), 'a');
    assert.equal(soon.status, 429);
    assert.equal(soon.body.code, 'SITE_CHECK_THROTTLED');
    assert.equal(soon.body.error, 'A site check ran moments ago. Wait a few seconds and try again.');
    assert.equal(soon.retryAfter, '1', 'never less than a second');

    /* And any one site at most once every thirty seconds, whoever asks. */
    const theirs = await ask(check('https://example.com'), 'b');
    assert.equal(theirs.status, 429);
    assert.equal(theirs.body.error, 'This site was checked moments ago. Wait a few seconds and try again.',
      'b has never checked, but the site was checked moments ago');
    assert.equal(theirs.retryAfter, '16', 'until the site may be checked again');
    clock += 2;
    const sameSite = await ask(check('https://example.com'), 'c');
    assert.equal(sameSite.body.error, 'This site was checked moments ago. Wait a few seconds and try again.');
    assert.equal(sameSite.retryAfter, '15');
    assert.equal(checks.length, 1, 'a throttled request starts nothing');
    clock += 15_000;
    assert.equal((await ask(check('https://example.com'), 'c')).status, 202);
    assert.equal(checks.length, 2);

    /* One check per viewer at a time. */
    clock += 30_001;
    const slow = await ask(check('https://slow.example'), 'd');
    assert.equal(slow.status, 202);
    clock += 15_001;
    const another = await ask(check('https://quick.example'), 'd');
    assert.equal(another.status, 429);
    assert.equal(another.body.code, 'SITE_CHECK_IN_PROGRESS');
    assert.equal((await ask(check('https://slow.example', slow.body.run), 'd')).status, 202, 'a poll is told it is still running');
    pending.shift()({ origin: 'https://slow.example', findings: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await ask(check('https://slow.example', slow.body.run), 'd')).status, 200);

    /* The repository's Audit tab asks the same check. */
    clock += 30_001;
    const fromRepository = await ask('/api/repo/acme/demo/site-check?url=https://repo.example', 'e');
    assert.equal(fromRepository.status, 202);
    console.log('Parallax site-check route tests passed');
  } finally {
    Date.now = realNow;
    site.close();
    rendered.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
