'use strict';
/*
 * The provider transport: the timed fetch (platform/network/timed-fetch.ts),
 * GitHub's REST client and the archive transport
 * (github-provider/client/github-rest.ts), and the failure answer
 * (http/errors.ts). The network is a fake the test answers itself, and the
 * deadline's timer is the test's to fire.
 */
const assert = require('assert');
const { fetchWithDeadline } = require('../apps/api/src/platform/network/timed-fetch.ts');
const {
  createGithubRestClient, providerFailureCode, providerRateLimit, GITHUB_API, GITHUB_API_VERSION
} = require('../apps/api/src/modules/github-provider/index.ts');
const { sendFailure } = require('../apps/api/src/http/errors.ts');

const timers = [];
const saved = { fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
let answer = null;
const requests = [];
global.fetch = (url, options) => {
  requests.push({ url: String(url), options });
  /* A fixed answer is handed out as a copy, so it can answer more than once (a copy's body cannot be cancelled alone; a test that cancels answers with a function). */
  const next = typeof answer === 'function' ? answer(url, options) : answer instanceof Response ? answer.clone() : answer;
  return next instanceof Promise ? next : Promise.resolve(next);
};
global.setTimeout = (callback, ms) => { const timer = { callback, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } }; timers.push(timer); return timer; };
global.clearTimeout = timer => { if (timer) timer.cleared = true; };
const restore = () => { global.fetch = saved.fetch; global.setTimeout = saved.setTimeout; global.clearTimeout = saved.clearTimeout; };
const respond = (status, body, headers = {}) => new Response(body === null ? null : body, { status, headers });
const stalled = signal => new Response(new ReadableStream({
  pull: controller => new Promise(resolve => signal.addEventListener('abort', () => { controller.error(signal.reason); resolve(); }, { once: true }))
}), { status: 200 });

async function main() {
  /* The timed fetch: the deadline runs until the body is read, and never holds the process. */
  {
    answer = respond(200, 'hello');
    const response = await fetchWithDeadline('https://example.test/a', { method: 'GET' }, 1234);
    const timer = timers.at(-1);
    assert.deepStrictEqual([timer.ms, timer.unrefed, timer.cleared], [1234, true, false], 'still running while the body is unread');
    assert(requests.at(-1).options.signal instanceof AbortSignal);
    assert.strictEqual(await response.text(), 'hello');
    assert.strictEqual(timer.cleared, true, 'cleared once the body is read');
    assert.strictEqual(response.status, 200);
    answer = () => new Response('x', { status: 202, statusText: 'Accepted', headers: { etag: '"t"' } });
    const relayed = await fetchWithDeadline('https://example.test/f');
    assert.deepStrictEqual([relayed.status, relayed.statusText, relayed.headers.get('etag')], [202, 'Accepted', '"t"'], 'the answer is relayed whole');

    answer = respond(204, null);
    await fetchWithDeadline('https://example.test/b');
    assert.deepStrictEqual([timers.at(-1).ms, timers.at(-1).cleared], [20000, true], 'twenty seconds by default; a bodiless answer clears it at once');

    answer = (url, options) => stalled(options.signal);
    const slow = await fetchWithDeadline('https://example.test/c', {}, 50);
    const reading = slow.text();
    /* The read is under way, waiting on a body that sends nothing, when the deadline passes. */
    for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve));
    timers.at(-1).callback();
    await assert.rejects(reading, /Upstream timeout after 0.05s/, 'a body that stalls past the deadline fails');

    answer = Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(fetchWithDeadline('https://example.test/d'), /fetch failed/);
    assert.strictEqual(timers.at(-1).cleared, true, 'a request that fails clears its deadline');

    /* Two chunks: the first is taken up front, so the cancel finds no read of its own in flight to end the deadline for it. */
    answer = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('a')); controller.enqueue(new TextEncoder().encode('b')); } }));
    const cancelled = await fetchWithDeadline('https://example.test/e');
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(timers.at(-1).cleared, false);
    await cancelled.body.cancel('done');
    assert.strictEqual(timers.at(-1).cleared, true, 'cancelling the body clears it too');

    answer = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('connection reset')); } }));
    const broken = await fetchWithDeadline('https://example.test/g');
    await assert.rejects(broken.text(), /connection reset/);
    assert.strictEqual(timers.at(-1).cleared, true, 'a body that fails clears it');
  }

  /* Refusal codes and the rate limits GitHub hides in a 403. */
  {
    assert.deepStrictEqual([401, 403, 404, 409, 422, 429, 500, 503, 400, '404', 'x'].map(providerFailureCode), [
      'PROVIDER_FORBIDDEN', 'PROVIDER_FORBIDDEN', 'PROVIDER_NOT_FOUND', 'PROVIDER_CONFLICT', 'PROVIDER_REJECTED', 'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_NOT_FOUND', 'PROVIDER_REQUEST_FAILED'
    ]);
    const headers = values => new Headers(values);
    const now = 1_700_000_000_000;
    assert.strictEqual(providerRateLimit(403, headers({}), { message: 'Resource not accessible' }, now), null, 'a plain 403 is a refusal');
    assert.strictEqual(providerRateLimit(404, headers({ 'retry-after': '5' }), null, now), null);
    assert.deepStrictEqual(providerRateLimit(429, headers({}), null, now), { retryAfterSeconds: 60 }, 'a minute when GitHub says nothing');
    assert.deepStrictEqual(providerRateLimit(403, headers({ 'retry-after': '30' }), null, now), { retryAfterSeconds: 30 });
    assert.deepStrictEqual(providerRateLimit(403, headers({ 'retry-after': ' 12 ' }), null, now), { retryAfterSeconds: 12 });
    assert.deepStrictEqual(providerRateLimit(403, headers({ 'retry-after': 'soon' }), null, now), { retryAfterSeconds: 60 });
    assert.deepStrictEqual(providerRateLimit(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 90) }), null, now), { retryAfterSeconds: 90 }, 'until the reset');
    assert.deepStrictEqual(providerRateLimit(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }), null, now), { retryAfterSeconds: 60 });
    assert.deepStrictEqual(providerRateLimit(403, headers({}), { message: 'API rate limit exceeded for user' }, now), { retryAfterSeconds: 60 }, 'its own words');
    assert.deepStrictEqual(providerRateLimit(403, headers({}), { message: 'You have exceeded a secondary Rate Limit' }, now), { retryAfterSeconds: 60 }, 'in any case');
    assert.deepStrictEqual(providerRateLimit(429, headers({ 'retry-after': '99999' }), null, now), { retryAfterSeconds: 3600 }, 'an hour at most');
    assert.deepStrictEqual(providerRateLimit(429, headers({ 'retry-after': '0' }), null, now), { retryAfterSeconds: 1 }, 'a second at least');
    assert(Object.isFrozen(providerRateLimit(429, headers({}), null, now)));
  }

  /* The REST client. */
  {
    const gateway = [];
    const invalidated = [];
    const calls = [];
    const make = ({ alphaEnabled = false, broker = true } = {}) => createGithubRestClient({
      fetch: (url, options, ms) => { calls.push({ url: String(url), options, ms }); return global.fetch(url, options); },
      assertProviderMutation: descriptor => { gateway.push(descriptor); if (descriptor.apiPath === '/forbidden') throw new Error('gateway refused'); },
      userAgent: 'Nebulaverse-X/test', transferTimeoutMs: 600000,
      appBroker: broker ? { invalidate: id => invalidated.push(id) } : null, alphaEnabled
    });
    const { gh, githubArchiveResponse } = make();
    assert.strictEqual(GITHUB_API, 'https://api.github.com');
    assert.strictEqual(GITHUB_API_VERSION, '2022-11-28');

    answer = respond(200, '{"login":"alice"}', { etag: '"v1"' });
    assert.deepStrictEqual(await gh({ provider: 'github', token: 'tok' }, '/user'), { login: 'alice' });
    const first = calls.at(-1);
    assert.strictEqual(first.url, 'https://api.github.com/user');
    assert.deepStrictEqual(first.options.headers, {
      Authorization: 'Bearer tok', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nebulaverse-X/test'
    });
    assert.deepStrictEqual([first.options.method, first.options.redirect, first.options.body, first.ms], ['GET', 'error', undefined, 20000]);
    assert.strictEqual(gateway.length, 0, 'a read is not a mutation');

    answer = respond(304, null);
    assert.deepStrictEqual(await gh('tok', '/user'), { login: 'alice' }, 'a 304 answers from the last body, and a bare token is a GitHub account');
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], '"v1"');
    answer = respond(200, 'raw bytes');
    await gh({ provider: 'github', token: 'tok' }, '/user', { raw: true });
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], undefined, 'a raw read of a cached path is not conditional');
    answer = respond(200, '{"login":"bob"}');
    await gh({ token: 'other' }, '/user');
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], undefined, 'one account never reads another\'s cached answer');
    await gh({ token: 'tok' }, '/user', { accept: 'application/vnd.github.raw' });
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], undefined, 'nor is a raw or custom read conditional');
    assert.strictEqual(calls.at(-1).options.headers.Accept, 'application/vnd.github.raw');

    answer = respond(201, '{"ok":true}');
    await gh({ token: 'tok' }, '/repos/acme/demo/issues', { method: 'POST', body: { title: 't' }, headers: { 'X-Extra': '1' } });
    assert.deepStrictEqual(gateway.at(-1), { provider: 'github', baseUrl: undefined, method: 'POST', apiPath: '/repos/acme/demo/issues', body: { title: 't' } },
      'every change is asked of the gateway first');
    assert.deepStrictEqual([calls.at(-1).options.body, calls.at(-1).options.headers['Content-Type'], calls.at(-1).options.headers['X-Extra']], ['{"title":"t"}', 'application/json', '1']);
    const reads = gateway.length;
    await gh({ token: 'tok' }, '/x', { method: 'HEAD' });
    assert.strictEqual(gateway.length, reads, 'a HEAD changes nothing and is not asked');
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      await gh({ token: 'tok' }, '/x', { method });
      assert.strictEqual(gateway.at(-1).method, method);
    }
    const before = calls.length;
    await assert.rejects(gh({ token: 'tok' }, '/forbidden', { method: 'DELETE' }), /gateway refused/);
    assert.strictEqual(calls.length, before, 'nothing is sent that the gateway refused');

    answer = respond(200, 'not json');
    assert.deepStrictEqual(await gh({ token: 'tok' }, '/text'), { raw: 'not json' });
    answer = respond(200, '');
    assert.strictEqual(await gh({ token: 'tok' }, '/empty'), null);
    answer = respond(200, 'stream');
    const raw = await gh({ token: 'tok' }, '/raw', { raw: true, redirect: 'manual' });
    assert(raw instanceof Response);
    assert.deepStrictEqual([calls.at(-1).ms, calls.at(-1).options.redirect], [600000, 'manual'], 'a raw transfer has the transfer\'s time');
    await gh({ token: 'tok' }, '/slow', { timeoutMs: 5000 });
    assert.strictEqual(calls.at(-1).ms, 5000);

    answer = respond(422, '{"message":"Validation Failed"}');
    await assert.rejects(gh({ token: 'tok' }, '/bad'), error => error.message === 'Validation Failed' && error.status === 422
      && error.code === 'PROVIDER_REJECTED' && error.body.message === 'Validation Failed' && error.retryAfterSeconds === undefined);
    answer = respond(403, '{"message":"API rate limit exceeded"}', { 'retry-after': '42' });
    await assert.rejects(gh({ token: 'tok' }, '/limited'), error => error.status === 429 && error.code === 'PROVIDER_RATE_LIMITED' && error.retryAfterSeconds === 42,
      'a rate limit in a 403 is a 429 with its wait');
    answer = respond(500, '');
    await assert.rejects(gh({ token: 'tok' }, '/down'), error => error.message === 'GitHub error 500' && error.code === 'PROVIDER_UNAVAILABLE');

    answer = respond(401, '{"message":"Bad credentials"}');
    const app = { provider: 'github', token: 'inst', authMethod: 'github-app', installationId: 7 };
    await assert.rejects(gh(app, '/user'), error => error.status === 401);
    assert.deepStrictEqual(invalidated, [7], 'a refused installation token is dropped');
    await assert.rejects(make({ alphaEnabled: true }).gh(app, '/user'));
    await assert.rejects(make({ broker: false }).gh(app, '/user'));
    await assert.rejects(gh({ token: 'tok' }, '/user'));
    assert.deepStrictEqual(invalidated, [7], 'but not in the alpha, not without a broker, and not for a token');

    for (const account of [{ provider: 'gitea', token: 'x' }, { token: 'x', baseUrl: 'https://ghe.example' }, null]) {
      await assert.rejects(gh(account, '/user'), error => error.status === 401);
    }

    /* The cache keeps a bounded number of answers, the oldest leaving first. */
    const cacheClient = make();
    answer = (url) => respond(200, `{"path":"${new URL(url).pathname}"}`, { etag: `"${new URL(url).pathname}"` });
    for (let i = 0; i <= 401; i += 1) await cacheClient.gh({ token: 'many' }, `/r${i}`);
    answer = respond(304, null);
    await cacheClient.gh({ token: 'many' }, '/r0').catch(() => null);
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], undefined, 'the oldest answer has left the cache');
    assert.deepStrictEqual(await cacheClient.gh({ token: 'many' }, '/r401'), { path: '/r401' });
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], '"/r401"');
    assert.deepStrictEqual(await cacheClient.gh({ token: 'many' }, '/r200'), { path: '/r200' });
    assert.strictEqual(calls.at(-1).options.headers['If-None-Match'], '"/r200"', 'only the oldest leaves; the rest stay');

    /* The archive: a redirect followed only to codeload, for the same repository, without the token. */
    const archiveCalls = () => calls.slice(-2);
    const released = [];
    answer = url => (String(url).startsWith(GITHUB_API)
      ? new Response(new ReadableStream({ pull() {}, cancel(reason) { released.push(String(reason)); } }), { status: 302, headers: { location: 'https://codeload.github.com/ACME/Demo/legacy.zip/refs/heads/main' } })
      : respond(200, 'zip bytes'));
    const archive = await githubArchiveResponse({ provider: 'github', token: 'tok' }, 'acme', 'demo', 'refs/heads/x y');
    assert.strictEqual(released.length, 1, 'the authenticated answer is released before codeload is asked');
    assert.strictEqual(await archive.text(), 'zip bytes');
    const [zipball, codeload] = archiveCalls();
    assert.strictEqual(zipball.url, 'https://api.github.com/repos/acme/demo/zipball/refs%2Fheads%2Fx%20y');
    assert.deepStrictEqual([zipball.options.redirect, zipball.ms], ['manual', 600000]);
    assert.strictEqual(codeload.url, 'https://codeload.github.com/ACME/Demo/legacy.zip/refs/heads/main');
    assert.deepStrictEqual([codeload.options.headers, codeload.options.redirect, codeload.ms], [{ Accept: 'application/zip', 'User-Agent': 'Nebulaverse-X/test' }, 'error', 600000],
      'codeload is asked without the token');
    answer = respond(200, 'direct');
    assert.strictEqual(await (await githubArchiveResponse({ token: 'tok' }, 'acme', 'demo', 'main')).text(), 'direct', 'an answer that is not a redirect is the archive');
    for (const location of [
      'https://codeload.github.com/other/demo/legacy.zip/x', 'https://codeload.github.com/acme/other/legacy.zip/x', 'https://evil.example/acme/demo/legacy.zip',
      'https://u:p@codeload.github.com/acme/demo/legacy.zip', 'https://codeload.github.com/acme/demo/legacy.zip#x', 'https://codeload.github.com/acme/demo/tarball/x',
      'http://codeload.github.com/acme/demo/legacy.zip'
    ]) {
      answer = respond(302, null, { location });
      await assert.rejects(githubArchiveResponse({ token: 'tok' }, 'acme', 'demo', 'main'), error => error.status === 502 && error.message === 'GitHub archive redirect target is not trusted', location);
    }
    for (const location of ['not a url', 'https://codeload.github.com/%E0%A4%A/demo/legacy.zip']) {
      answer = respond(302, null, { location });
      await assert.rejects(githubArchiveResponse({ token: 'tok' }, 'acme', 'demo', 'main'), error => error.status === 502 && error.message === 'GitHub archive redirect is invalid', location);
    }
    answer = respond(307, null, {});
    await assert.rejects(githubArchiveResponse({ token: 'tok' }, 'acme', 'demo', 'main'), error => error.message === 'GitHub archive redirect is invalid', 'a redirect without a location');
    await assert.rejects(githubArchiveResponse({ provider: 'gitea', token: 'tok' }, 'acme', 'demo', 'main'),
      error => error.status === 400 && error.message === 'GitHub archive transport requires a GitHub account');
  }

  /* The failure answer. */
  {
    const response = ({ sent = false, destroyed = false, correlationId = 'nvx-0123456789abcdef' } = {}) => ({
      headersSent: sent, destroyed, locals: correlationId ? { correlationId } : {}, headers: [], destroyCalls: 0, code: null, body: null,
      destroy() { this.destroyCalls += 1; }, setHeader(name, value) { this.headers.push([name, value]); },
      status(code) { this.code = code; return { json: body => { this.body = body; return this; } }; }
    });
    const res = response();
    sendFailure(res, Object.assign(new Error('GitHub said no'), { status: 403, code: 'PROVIDER_FORBIDDEN' }));
    assert.deepStrictEqual([res.code, res.body.error, res.body.code, res.body.correlationId], [403, 'GitHub said no', 'PROVIDER_FORBIDDEN', 'nvx-0123456789abcdef']);
    for (const [error, status] of [[new Error('plain'), 500], [Object.assign(new Error('x'), { status: 302 }), 500], [Object.assign(new Error('x'), { status: 600 }), 500], [null, 500], [Object.assign(new Error('x'), { status: 418 }), 418]]) {
      const answered = response();
      sendFailure(answered, error);
      assert.strictEqual(answered.code, status, String(error && error.status));
    }
    const limited = response();
    sendFailure(limited, Object.assign(new Error('slow'), { status: 429, code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: 30 }));
    assert.deepStrictEqual(limited.headers, [['Retry-After', '30']]);
    for (const retryAfterSeconds of [0, 1.5, undefined]) {
      const quiet = response();
      sendFailure(quiet, Object.assign(new Error('slow'), { status: 429, code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds }));
      assert.deepStrictEqual(quiet.headers, [], String(retryAfterSeconds));
    }
    const passage = response();
    sendFailure(passage, Object.assign(new Error('needs approval'), { status: 409, code: 'POLICY_APPROVAL_REQUIRED', safePassage: { route: '/api/x' } }));
    assert.deepStrictEqual(passage.body.safePassage, { route: '/api/x' });
    const leaky = response();
    sendFailure(leaky, Object.assign(new Error('token=ghp_examplevalue'), { status: 400, code: 'BAD_REQUEST' }));
    assert.strictEqual(leaky.body.error, 'Operation could not be completed', 'the public body still redacts');
    for (const state of [{ sent: true }, { destroyed: true }]) {
      const late = response(state);
      assert.strictEqual(sendFailure(late, new Error('x')), undefined);
      assert.deepStrictEqual([late.code, late.destroyCalls], [null, state.sent ? 1 : 0], 'a transfer already under way is ended, not answered twice');
    }
    const minted = response({ correlationId: '' });
    sendFailure(minted, new Error('x'));
    assert.match(minted.body.correlationId, /^nvx-[0-9a-f]{16}$/, 'a reference is minted when the request has none');
  }

  finished = true;
  console.log('provider transport tests passed');
}

let finished = false;
process.on('exit', () => {
  if (finished) return;
  restore();
  console.error('provider transport tests did not finish');
  process.exitCode = 1;
});
main().then(restore, error => { restore(); console.error(error); process.exit(1); });
