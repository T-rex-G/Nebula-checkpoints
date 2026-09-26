'use strict';

/*
 * One outbound path for everything a scan or a delivery reaches.
 *
 * The webhook worker already resolved a hostname, validated every answer
 * against a public-address policy, and pinned the connection to the address it
 * had checked, so a second DNS answer could not move it. That is the hard part
 * and it already worked. What it did not have was a total deadline, a bound on
 * a decompressed response, or any notion of a caller other than a signed POST.
 *
 * So this is an extraction plus three additions, and the test that matters
 * most is the one asserting the webhook profile did not change: a scan needs
 * GET and a query string, and neither may widen the policy the webhook path is
 * held to or alter a single byte it signs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  PROFILES, CODES, MAX_RESPONSE_BYTES, GuardedFetchError,
  normalizeTarget, validateAddresses, guardedFetch, createGuardedSession
} = require('../src/guarded-fetch');

/* ---- The code registry ------------------------------------------------ */

/*
 * CODES is what callers translate against, so it has to be the whole truth
 * about what this module can raise -- checked both ways against the source.
 * A code thrown but unregistered leaves a caller silently falling back to a
 * generic; a code registered but never thrown lets a caller believe it has
 * handled something that cannot happen. Reading the source is the only way to
 * check this without running every failure path, and the two directions
 * together mean neither list can drift.
 */
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'guarded-fetch.js'), 'utf8');
  /* The registry's own literals are the declaration, not a use of a code. */
  const withoutRegistry = source.replace(/const CODES = Object\.freeze\(\{[\s\S]*?\n\}\);/, '');
  const thrown = new Set((withoutRegistry.match(/'GUARDED_FETCH_[A-Z_]+'/g) || []).map(text => text.slice(1, -1)));
  const registered = new Set(Object.values(CODES));

  assert(thrown.size > 0, 'the source scan must find codes, or this check proves nothing');
  assert.deepStrictEqual(
    [...thrown].filter(code => !registered.has(code)), [],
    'every code this module throws must be registered in CODES for callers to translate'
  );
  assert.deepStrictEqual(
    [...registered].filter(code => !thrown.has(code)), [],
    'every registered code must actually be reachable: a code that cannot happen invites handling that never runs'
  );
  /* And the registry is frozen, since a caller builds its own table from it. */
  assert(Object.isFrozen(CODES));
}

/* ---- URL policy ------------------------------------------------------- */

/* Shared by every profile: no plaintext, no credentials in the URL, no port
   games, and no name that resolves inside somebody's network by convention. */
for (const profile of [PROFILES.WEBHOOK, PROFILES.PROVIDER_READ, PROFILES.CREDENTIAL_VERIFY]) {
  for (const bad of [
    'http://example.com/hook',
    'ftp://example.com/hook',
    'https://user:pass@example.com/hook',
    'https://example.com:8443/hook',
    'https://localhost/hook',
    'https://api.localhost/hook',
    'https://printer.local/hook',
    'https://vault.internal/hook',
    'https://example.com/hook#fragment',
    'not-a-url',
    ''
  ]) {
    assert.throws(
      () => normalizeTarget(bad, profile),
      error => error instanceof GuardedFetchError,
      `${profile} must refuse ${bad || '(empty)'}`
    );
  }
  /* A trailing dot is the same host and must not be a way around the suffix
     checks above. */
  assert.throws(() => normalizeTarget('https://vault.internal./x', profile), GuardedFetchError);
}

/* The one place the profiles differ, and the reason this module has profiles. */
assert.throws(
  () => normalizeTarget('https://example.com/hook?token=1', PROFILES.WEBHOOK),
  error => error instanceof GuardedFetchError,
  'the webhook profile takes no query string, exactly as it did before'
);
{
  const read = normalizeTarget('https://api.github.com/rate_limit?scope=core', PROFILES.PROVIDER_READ);
  assert.strictEqual(read.search, '?scope=core', 'a provider read may carry a query string');
  assert.strictEqual(read.protocol, 'https:');
  assert.strictEqual(read.port, '', 'the port is normalised away rather than left to vary');
}

/* ---- address policy --------------------------------------------------- */

const PRIVATE = [
  '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9',
  '224.0.0.1', '240.0.0.1',
  '::1', '::', 'fc00::1', 'fd12::34', 'fe80::1', 'ff02::1',
  '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'
];
for (const address of PRIVATE) {
  assert.throws(
    () => validateAddresses([{ address, family: address.includes(':') ? 6 : 4 }]),
    error => error instanceof GuardedFetchError,
    `${address} must be refused`
  );
}
assert.deepStrictEqual(
  validateAddresses([{ address: '93.184.216.34', family: 4 }]),
  [{ address: '93.184.216.34', family: 4 }],
  'a public answer is kept as given'
);

/*
 * A mixed answer is refused entirely rather than filtered down to the public
 * ones. A name that resolves to both is a name under someone else's control
 * answering differently per query, and picking the acceptable half is how a
 * rebind gets through on the next lookup.
 */
assert.throws(
  () => validateAddresses([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]),
  error => error instanceof GuardedFetchError && /public/i.test(error.message),
  'one private answer disqualifies the whole set'
);
assert.throws(() => validateAddresses([]), GuardedFetchError);
/* A family that does not match the literal is a malformed answer, not a hint. */
assert.throws(() => validateAddresses([{ address: '93.184.216.34', family: 6 }]), GuardedFetchError);
/* An answer set large enough to be a stalling tactic is refused. */
assert.throws(
  () => validateAddresses(Array.from({ length: 33 }, () => ({ address: '93.184.216.34', family: 4 }))),
  GuardedFetchError
);

/* ---- the request itself ------------------------------------------------ */

/*
 * A watchdog for the assertions that depend on the transport settling itself.
 * If the total deadline is ever removed, the request under test never settles
 * and this file stops reporting anything until the CI job is killed -- a hang
 * is the one failure mode that looks like nothing happened. The watchdog is
 * deliberately not unref'd for the same reason the transport's deadline is
 * not: an unreferenced timer lets the process exit while the await is still
 * pending, and the suite then leaves with a success code having proved
 * nothing.
 */
function failFast(promise, ms, message) {
  let timer = null;
  const watchdog = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, watchdog]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function fakeResponse({ statusCode = 200, chunks = [], headers = {} } = {}) {
  const listeners = {};
  return {
    statusCode,
    headers,
    on(event, handler) { (listeners[event] = listeners[event] || []).push(handler); return this; },
    resume() {
      setImmediate(() => {
        for (const chunk of chunks) for (const fn of listeners.data || []) fn(Buffer.from(chunk));
        for (const fn of listeners.end || []) fn();
      });
    },
    destroy() { this.destroyed = true; }
  };
}

function fakeRequestImpl(behaviour) {
  const calls = [];
  const impl = (options, onResponse) => {
    calls.push(options);
    const listeners = {};
    const request = {
      on(event, handler) { (listeners[event] = listeners[event] || []).push(handler); return request; },
      end(body) {
        request.body = body;
        setImmediate(() => behaviour({ options, onResponse, listeners, request }));
      },
      destroy(error) { request.destroyed = error || true; }
    };
    return request;
  };
  impl.calls = calls;
  return impl;
}

(async () => {
  /* The connection is pinned to the address that was validated, and the
     certificate is still checked against the hostname. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 204 })));
    const result = await guardedFetch({
      url: 'https://hooks.example.com/nebulaverse',
      profile: PROFILES.WEBHOOK,
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl
    });
    assert.strictEqual(result.statusCode, 204);

    const options = requestImpl.calls[0];
    assert.strictEqual(options.hostname, 'hooks.example.com');
    assert.strictEqual(options.servername, 'hooks.example.com', 'SNI must stay the hostname, not the pinned address');
    assert.strictEqual(options.port, 443);
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(options.path, '/nebulaverse');
    assert.strictEqual(options.agent, false, 'no shared agent may reuse a socket to a different address');

    const pinned = await new Promise(resolve =>
      options.lookup('hooks.example.com', {}, (_error, address, family) => resolve({ address, family })));
    assert.deepStrictEqual(pinned, { address: '93.184.216.34', family: 4 },
      'the connection must go to the address that was validated, not to a fresh lookup');
    const all = await new Promise(resolve =>
      options.lookup('hooks.example.com', { all: true }, (_error, addresses) => resolve(addresses)));
    assert.deepStrictEqual(all, [{ address: '93.184.216.34', family: 4 }],
      'Node 22 autoSelectFamily requests all:true; return only the pinned address in an array');
  }

  /* Exercise Node's actual HTTPS client, not just a fake invoking lookup({}).
     Stop at the lookup event, before connecting or sending any bytes. */
  for (const pinned of [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ]) {
    let observed = null;
    await assert.rejects(guardedFetch({
      url: 'https://provider.example/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
      addresses: [pinned],
      requestImpl(options, onResponse) {
        const req = https.request({ ...options,
          /* DNS callbacks are asynchronous in production too. */
          lookup: (...args) => setImmediate(() => options.lookup(...args))
        }, onResponse);
        req.on('socket', socket => socket.once('lookup', (error, address, family) => {
          observed = { error, address, family };
          req.destroy(Object.assign(new Error('Test stopped before connection'), { code: 'TEST_LOOKUP_COMPLETE' }));
        }));
        return req;
      }
    }), error => error.transportCode === 'TEST_LOOKUP_COMPLETE');
    assert.deepStrictEqual(observed, { error: null, ...pinned });
  }

  /* Larger repository trees are opt-in; other profiles keep their limits. */
  for (const [profile, requested, size, allowed] of [
    [PROFILES.PROVIDER_READ, 8 * 1024 * 1024, 300 * 1024, true],
    [PROFILES.PROVIDER_READ, 1024 * 1024, 1024 * 1024 + 1, false],
    [PROFILES.PROVIDER_READ, Number.MAX_SAFE_INTEGER, 8 * 1024 * 1024 + 1, false],
    [PROFILES.CREDENTIAL_VERIFY, 8 * 1024 * 1024, MAX_RESPONSE_BYTES + 1, false],
    [PROFILES.WEBHOOK, 8 * 1024 * 1024, MAX_RESPONSE_BYTES + 1, false]
  ]) {
    const requestImpl = fakeRequestImpl(({ onResponse }) =>
      onResponse(fakeResponse({ chunks: [Buffer.alloc(size, 120)] })));
    const result = guardedFetch({
      url: 'https://api.github.com/x', profile,
      method: profile === PROFILES.WEBHOOK ? 'POST' : 'GET',
      maxResponseBytes: requested,
      addresses: [{ address: '140.82.121.6', family: 4 }], requestImpl
    });
    if (allowed) assert.strictEqual((await result).body.length, size);
    else await assert.rejects(result, error => error.code === 'GUARDED_FETCH_RESPONSE_TOO_LARGE');
  }

  /* The signed bytes pass through untouched. */
  {
    const signed = '{"eventHash":"' + 'a'.repeat(64) + '"}';
    const requestImpl = fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200 })));
    await guardedFetch({
      url: 'https://hooks.example.com/h', profile: PROFILES.WEBHOOK, method: 'POST', body: signed,
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl
    });
    assert.strictEqual(requestImpl.calls.length, 1);
  }

  /* A redirect is returned, never followed: one request, and the caller
     decides. Following it is how a credential crosses an origin. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) =>
      onResponse(fakeResponse({ statusCode: 302, headers: { location: 'https://elsewhere.example/' } })));
    const result = await guardedFetch({
      url: 'https://hooks.example.com/h', profile: PROFILES.WEBHOOK, method: 'POST', body: '{}',
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl
    });
    assert.strictEqual(result.statusCode, 302);
    assert.strictEqual(requestImpl.calls.length, 1, 'a redirect must not produce a second request');
  }

  /* A provider read returns a bounded body; a webhook does not read one. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) =>
      onResponse(fakeResponse({ statusCode: 200, chunks: ['{"rate":'], headers: {} })));
    const read = await guardedFetch({
      url: 'https://api.github.com/rate_limit', profile: PROFILES.PROVIDER_READ, method: 'GET',
      resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
    });
    assert.strictEqual(read.body, '{"rate":');
    assert.strictEqual(requestImpl.calls[0].method, 'GET');
  }

  /* An over-size response is refused rather than buffered. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) =>
      onResponse(fakeResponse({ statusCode: 200, chunks: ['x'.repeat(MAX_RESPONSE_BYTES + 1)] })));
    await assert.rejects(
      guardedFetch({
        url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
      }),
      error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_RESPONSE_TOO_LARGE'
    );
  }

  /*
   * A compressed response is refused rather than decompressed. The bound that
   * matters is on the bytes a caller ends up holding, and a small gzip body
   * can become an enormous one -- so no encoding is requested and any that
   * arrives anyway is treated as a response this transport will not read.
   */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) =>
      onResponse(fakeResponse({ statusCode: 200, chunks: ['\u001f\u008b'], headers: { 'content-encoding': 'gzip' } })));
    await assert.rejects(
      guardedFetch({
        url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
      }),
      error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_ENCODING_REFUSED'
    );
    assert.strictEqual(
      'accept-encoding' in (requestImpl.calls[0].headers || {}), false,
      'no encoding may be requested in the first place'
    );
  }

  /*
   * A total deadline, which the socket timeout is not. A response that drips a
   * byte inside every timeout window never times out and holds the connection
   * for as long as it likes.
   */
  {
    const requestImpl = fakeRequestImpl(({ onResponse, listeners }) => {
      void listeners;
      const response = fakeResponse({ statusCode: 200, chunks: [] });
      /* Never ends. */
      response.resume = () => {};
      onResponse(response);
    });
    await assert.rejects(
      failFast(
        guardedFetch({
          url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
          deadlineMs: 60,
          resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
        }),
        5_000,
        'the transport never abandoned a response that never ends: the total deadline is gone'
      ),
      error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_DEADLINE',
      'a response that never ends must be abandoned on the total deadline'
    );
  }

  /* An unresolved or refused name never reaches a socket. */
  {
    const requestImpl = fakeRequestImpl(() => { throw new Error('must not be called'); });
    await assert.rejects(
      guardedFetch({
        url: 'https://metadata.example/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        resolveAddresses: async () => [{ address: '169.254.169.254', family: 4 }], requestImpl
      }),
      error => error instanceof GuardedFetchError
    );
    assert.strictEqual(requestImpl.calls.length, 0, 'a refused address must not open a connection');
  }

  /*
   * Nothing a caller sent may appear in an error. A verification probe carries
   * a discovered credential in a header, and an error that quotes its own
   * request writes that credential into whatever reads the error.
   */
  {
    /* Split so this file does not itself trip the repository's own secret
       gate, which scans every tracked file for exactly this shape. */
    const secret = `gh${'p'}_averyrealisticlookingsecret000000000000`;
    const requestImpl = fakeRequestImpl(({ listeners }) => {
      for (const fn of listeners.error || []) fn(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    });
    let thrown = null;
    try {
      await guardedFetch({
        url: 'https://api.github.com/user', profile: PROFILES.PROVIDER_READ, method: 'GET',
        headers: { authorization: `Bearer ${secret}` },
        body: `{"token":"${secret}"}`,
        resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
      });
    } catch (error) { thrown = error; }
    assert(thrown, 'a transport failure must reject');
    const rendered = `${thrown.message}\n${thrown.stack || ''}\n${JSON.stringify(thrown)}`;
    assert.strictEqual(rendered.includes(secret), false, 'an error must not carry the credential it was sent with');
    assert.strictEqual(rendered.includes('Bearer'), false, 'nor the scheme that framed it');
  }

  /* An over-size request body is refused before anything is opened. */
  {
    const requestImpl = fakeRequestImpl(() => { throw new Error('must not be called'); });
    await assert.rejects(
      guardedFetch({
        url: 'https://hooks.example.com/h', profile: PROFILES.WEBHOOK, method: 'POST',
        body: 'x'.repeat(MAX_RESPONSE_BYTES + 1),
        resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl
      }),
      error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_BODY_TOO_LARGE'
    );
    assert.strictEqual(requestImpl.calls.length, 0);
  }

  /* A profile may not be invented by a caller, and a method may not be
     smuggled past its profile. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse()));
    await assert.rejects(guardedFetch({
      url: 'https://api.github.com/x', profile: 'anything-goes', method: 'GET',
      resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
    }), GuardedFetchError);
    await assert.rejects(guardedFetch({
      url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'DELETE',
      resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
    }), error => error instanceof GuardedFetchError && /method/i.test(error.message));
  }

/*
 * The third profile is the one a verification probe uses, and it differs from
 * a provider read in exactly one direction each way. It may POST, because the
 * method a provider documents for its identity endpoint is not this repository's
 * choice. It may not carry a query string, because it carries a discovered
 * credential in a header and a query string is the one part of a request that
 * ends up in an access log, a referrer and a proxy trace. Neither profile can
 * borrow the other half.
 */
{
  assert.throws(
    () => normalizeTarget('https://slack.com/api/auth.test?token=xoxb-secret', PROFILES.CREDENTIAL_VERIFY),
    error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_URL_INVALID',
    'a credential-bearing probe may not put anything in a query string'
  );

  const requestImpl = fakeRequestImpl(({ onResponse }) => {
    onResponse(fakeResponse({ statusCode: 200, chunks: ['{"ok":true}'] }));
  });
  const posted = await guardedFetch({
    url: 'https://slack.com/api/auth.test', profile: PROFILES.CREDENTIAL_VERIFY, method: 'POST',
    headers: { authorization: 'Bearer xoxb-not-a-real-token' }, body: '',
    resolveAddresses: async () => [{ address: '13.107.42.14', family: 4 }], requestImpl
  });
  assert.strictEqual(posted.statusCode, 200);
  assert.strictEqual(posted.body, '{"ok":true}', 'and it reads the response, which is where the proof is');

  await assert.rejects(
    guardedFetch({
      url: 'https://slack.com/api/auth.test', profile: PROFILES.CREDENTIAL_VERIFY, method: 'DELETE',
      resolveAddresses: async () => [{ address: '13.107.42.14', family: 4 }], requestImpl
    }),
    error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_METHOD_INVALID',
    'and it is GET or POST, not an arbitrary verb'
  );

  /* The webhook profile stays POST-only and body-blind whatever the others gain. */
  await assert.rejects(
    guardedFetch({
      url: 'https://hooks.example.com/h', profile: PROFILES.WEBHOOK, method: 'GET',
      resolveAddresses: async () => [{ address: '203.0.113.7', family: 4 }], requestImpl
    }),
    error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_METHOD_INVALID',
    'the webhook profile does not acquire GET because another profile has it'
  );
  /* And a provider read still may not POST, so a credential cannot ride one. */
  await assert.rejects(
    guardedFetch({
      url: 'https://api.github.com/user', profile: PROFILES.PROVIDER_READ, method: 'POST',
      resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
    }),
    error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_METHOD_INVALID',
    'a provider read stays a read'
  );
}

/*
 * A credential never reaches a URL, on any profile.
 *
 * The query-string ban on the verification profile is one half of this. The
 * other half is the mistake it cannot prevent: a call site that interpolates a
 * token into a path or a query on a profile that permits one. A URL is the part
 * of a request that survives into an access log, a referrer header and every
 * proxy between here and the provider, so the transport refuses when what it
 * was told to send in an authorization header also appears in the address.
 *
 * It is checked rather than documented because a provider read now carries the
 * reader's own session token, so there is a profile where both a credential
 * and a query string are legitimate.
 */
{
  const requestImpl = fakeRequestImpl(({ onResponse }) => {
    onResponse(fakeResponse({ statusCode: 200, chunks: ['{}'] }));
  });
  const token = `gh${'p'}_leakedintotheurl000000000000000000000`;

  for (const [label, url] of [
    ['a query string', `https://api.github.com/repos/a/b/git/trees/x?token=${token}`],
    ['a path segment', `https://api.github.com/repos/a/b/${token}`],
    ['a repeated parameter', `https://api.github.com/x?a=1&access_token=${token}&b=2`]
  ]) {
    await assert.rejects(
      guardedFetch({
        url, profile: PROFILES.PROVIDER_READ, method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
      }),
      error => error instanceof GuardedFetchError && error.code === 'GUARDED_FETCH_URL_INVALID',
      `a credential in ${label} must be refused`
    );
  }
  assert.strictEqual(requestImpl.calls.length, 0, 'and refused before a socket exists');

  /* The same token in a header alone is exactly what a provider read is for. */
  const fine = await guardedFetch({
    url: 'https://api.github.com/repos/a/b/git/trees/x?recursive=1',
    profile: PROFILES.PROVIDER_READ, method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
  });
  assert.strictEqual(fine.statusCode, 200);
  assert.strictEqual(requestImpl.calls[0].headers.authorization, `Bearer ${token}`);

  /* A short header value is not treated as a credential: refusing every URL
     that happens to contain the word "token" would make the guard useless. */
  const shortHeader = await guardedFetch({
    url: 'https://api.github.com/repos/a/b?ref=main',
    profile: PROFILES.PROVIDER_READ, method: 'GET',
    headers: { authorization: 'Bearer main' },
    resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }], requestImpl
  });
  assert.strictEqual(shortHeader.statusCode, 200);
}

  /* ---- A session: shared connections, same guarantees ---------------- */

  /*
   * Without a session every read is a fresh DNS lookup, TCP connect and TLS
   * handshake -- which for a scan of two thousand small files is most of the
   * time the scan takes. A session shares connections. What these assert is
   * that it does so without relaxing anything the one-request path promises.
   */
  {
    const ok = () => fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, chunks: ['{}'] })));

    /* One resolution for many reads, and every read pinned to that answer. */
    let lookups = 0;
    const requestImpl = ok();
    const minted = [];
    class RecordingAgent extends https.Agent {
      constructor(options) { super(options); minted.push({ agent: this, options }); }
    }
    const session = createGuardedSession({
      profile: PROFILES.PROVIDER_READ,
      resolveAddresses: async () => { lookups += 1; return [{ address: '140.82.121.6', family: 4 }]; },
      requestImpl, Agent: RecordingAgent
    });
    for (let index = 0; index < 5; index += 1) {
      const answer = await session.request({
        url: `https://api.github.com/repos/a/b/git/blobs/${index}`, profile: PROFILES.PROVIDER_READ, method: 'GET'
      });
      assert.strictEqual(answer.statusCode, 200);
    }
    assert.strictEqual(lookups, 1, 'a session resolves once and pins, rather than once per read');
    assert.strictEqual(requestImpl.calls.length, 5);
    for (const call of requestImpl.calls) {
      /* The pin is still the validated address, whatever the pool. */
      await new Promise(resolve => call.lookup('api.github.com', {}, (error, address) => {
        assert.strictEqual(error, null);
        assert.strictEqual(address, '140.82.121.6');
        resolve();
      }));
      assert.strictEqual(call.agent, minted[0].agent, 'every read shares the one pool for that address');
    }
    assert.strictEqual(minted.length, 1);
    assert.strictEqual(minted[0].options.keepAlive, true, 'the pool keeps connections open between reads');
    assert(minted[0].options.maxSockets >= 1 && minted[0].options.maxSockets <= 16, 'and it is bounded');

    /* Closing it destroys every connection and refuses anything further. */
    let destroyed = 0;
    minted[0].agent.destroy = () => { destroyed += 1; };
    session.close();
    assert.strictEqual(destroyed, 1);
    await assert.rejects(
      session.request({ url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET' }),
      error => error.code === 'GUARDED_FETCH_REFUSED'
    );
  }

  /* An address change gets a new pool, validated again -- never a pooled
     socket carried across to a different address for the same name. */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200 })));
    let clock = 0;
    let answer = '140.82.121.6';
    const session = createGuardedSession({
      profile: PROFILES.PROVIDER_READ,
      resolveAddresses: async () => [{ address: answer, family: 4 }],
      requestImpl, now: () => clock, dnsTtlMs: 1000
    });
    await session.request({ url: 'https://api.github.com/a', profile: PROFILES.PROVIDER_READ, method: 'GET' });
    answer = '140.82.121.3';
    clock = 5000;
    await session.request({ url: 'https://api.github.com/b', profile: PROFILES.PROVIDER_READ, method: 'GET' });
    assert.notStrictEqual(requestImpl.calls[0].agent, requestImpl.calls[1].agent, 'a different address is a different pool');

    /* And a refreshed answer that turns private is refused before a socket. */
    answer = '169.254.169.254';
    clock = 10_000;
    await assert.rejects(
      session.request({ url: 'https://api.github.com/c', profile: PROFILES.PROVIDER_READ, method: 'GET' }),
      error => error.code === 'GUARDED_FETCH_SSRF_BLOCKED'
    );
    assert.strictEqual(requestImpl.calls.length, 2, 'no connection was opened to it');
    session.close();
  }

  /*
   * The boundary check. A pool is accepted only when a session minted it, and
   * only for the name and address it was minted for -- so a caller cannot hand
   * the transport an agent of its own, or one minted for another address.
   */
  {
    const requestImpl = fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200 })));
    await assert.rejects(
      guardedFetch({
        url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        addresses: [{ address: '140.82.121.6', family: 4 }], agent: new https.Agent({ keepAlive: true }), requestImpl
      }),
      error => error.code === 'GUARDED_FETCH_REFUSED',
      'an agent the transport did not mint is refused'
    );

    const minted = [];
    class RecordingAgent extends https.Agent {
      constructor(options) { super(options); minted.push(this); }
    }
    const session = createGuardedSession({
      profile: PROFILES.PROVIDER_READ,
      resolveAddresses: async () => [{ address: '140.82.121.6', family: 4 }],
      requestImpl, Agent: RecordingAgent
    });
    await session.request({ url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET' });
    await assert.rejects(
      guardedFetch({
        url: 'https://api.github.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        addresses: [{ address: '140.82.121.3', family: 4 }], agent: minted[0], requestImpl
      }),
      error => error.code === 'GUARDED_FETCH_REFUSED',
      'a pool minted for one address cannot carry a request pinned to another'
    );
    await assert.rejects(
      guardedFetch({
        url: 'https://example.com/x', profile: PROFILES.PROVIDER_READ, method: 'GET',
        addresses: [{ address: '140.82.121.6', family: 4 }], agent: minted[0], requestImpl
      }),
      error => error.code === 'GUARDED_FETCH_REFUSED',
      'nor one for another name at the same address'
    );
    session.close();
  }

  /*
   * Provider reads only. A signed webhook and a credential probe are never
   * sent in bulk, and the credential probe is the one request whose contents
   * are a secret -- both keep one connection per request.
   */
  for (const profile of [PROFILES.WEBHOOK, PROFILES.CREDENTIAL_VERIFY, 'nope']) {
    assert.throws(
      () => createGuardedSession({ profile }),
      error => error.code === 'GUARDED_FETCH_PROFILE_INVALID',
      `${profile} must not share connections`
    );
  }
  {
    const session = createGuardedSession({ profile: PROFILES.PROVIDER_READ, resolveAddresses: async () => [] });
    await assert.rejects(
      session.request({ url: 'https://example.com/hook', profile: PROFILES.WEBHOOK, method: 'POST' }),
      error => error.code === 'GUARDED_FETCH_PROFILE_INVALID',
      'a provider-read session will not carry another profile\'s request'
    );
    session.close();
  }

  /*
   * The site probe: anonymous, headers returned, the body cut rather than
   * refused, a compressed body reported unread -- and no other profile gains
   * any of that.
   */
  {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    const probe = (behaviour, extra = {}) => guardedFetch({
      url: 'https://site.example/.env', profile: PROFILES.SITE_PROBE, method: 'GET', addresses,
      requestImpl: fakeRequestImpl(behaviour), maxResponseBytes: 1024, ...extra
    });
    const headers = { 'Content-Type': 'text/plain', 'Set-Cookie': ['a=1', 'b=2'], Server: 'x'.repeat(5000) };
    const full = await probe(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, headers, chunks: ['KEY=value\n'] })));
    assert.strictEqual(full.statusCode, 200);
    assert.strictEqual(full.body, 'KEY=value\n');
    assert.strictEqual(full.headers['content-type'], 'text/plain', 'header names are lower-cased');
    assert.deepStrictEqual(full.headers['set-cookie'], ['a=1', 'b=2'], 'every cookie is kept apart');
    assert.strictEqual(full.headers.server.length, 2048, 'header values are bounded');

    const cut = await probe(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, chunks: ['x'.repeat(800), 'y'.repeat(800)] })));
    assert.strictEqual(cut.truncated, true, 'a long body is cut at the bound, not refused');
    assert.strictEqual(cut.body.length, 1024);

    const packed = await probe(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, headers: { 'content-encoding': 'gzip', 'x-frame-options': 'DENY' }, chunks: ['\x1f\x8b'] })));
    assert.strictEqual(packed.bodyUnread, true);
    assert.strictEqual(packed.headers['x-frame-options'], 'DENY', 'the headers still arrive when the body is not read');

    for (const name of ['Authorization', 'Cookie', 'X-Api-Key']) {
      await assert.rejects(probe(() => {}, { headers: { [name]: 'something-long-enough' } }),
        error => error.code === 'GUARDED_FETCH_REFUSED', `${name} must be refused on an anonymous probe`);
    }
    await assert.rejects(probe(() => {}, { url: 'https://site.example/?q=1' }), error => error.code === 'GUARDED_FETCH_URL_INVALID');
    await assert.rejects(probe(() => {}, { method: 'POST' }), error => error.code === 'GUARDED_FETCH_METHOD_INVALID');

    /* A provider read is unchanged: no headers, and an oversized body is still refused. */
    const read = await guardedFetch({
      url: 'https://provider.example/x', profile: PROFILES.PROVIDER_READ, method: 'GET', addresses,
      requestImpl: fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, headers: { server: 'x' }, chunks: ['ok'] })))
    });
    assert.strictEqual(read.headers, undefined);
    await assert.rejects(guardedFetch({
      url: 'https://provider.example/x', profile: PROFILES.PROVIDER_READ, method: 'GET', addresses, maxResponseBytes: 1024,
      requestImpl: fakeRequestImpl(({ onResponse }) => onResponse(fakeResponse({ statusCode: 200, chunks: ['x'.repeat(2000)] })))
    }), error => error.code === 'GUARDED_FETCH_RESPONSE_TOO_LARGE');
  }

  console.log('guarded fetch tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
