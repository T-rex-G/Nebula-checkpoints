'use strict';

/*
 * Whether a discovered project is actually readable by anybody, rather than
 * whether its configuration looks wrong.
 *
 * The temptation with a leaked project URL and public key is to reason about
 * it: this key is anonymous, that table has no policy, therefore the data is
 * exposed. Every step of that is a guess. The only thing that settles it is
 * asking the service the way an anonymous stranger would, and the answer is
 * narrower than it looks -- a row comes back for one projection of one
 * relation under one role at one moment, and that is all it proves.
 *
 * Which makes the failure modes the interesting part. An empty array is not
 * proof of protection: an empty table and a row filter that hid everything are
 * indistinguishable from outside. A refusal is not proof of protection either:
 * it says this request was refused, not that the table is safe. Reporting
 * either as "protected" would tell a reader their data is fine on the strength
 * of no evidence at all.
 *
 * And the probe itself has to be safe to run. A read transfers data and
 * consumes somebody's quota even when it changes nothing, so it happens only
 * under a grant naming the exact project, relation and columns; it asks for one
 * row; it never asks for `*`; it never follows a page; and it brings back a
 * count and no values whatsoever.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { PROFILES, guardedFetch } = require('../src/guarded-fetch');
const {
  DEFAULT_TRANSPORT,
  KEY_KINDS,
  MAX_PROJECTION_COLUMNS,
  MAX_RESPONSE_BYTES,
  PROBE_STATES,
  REASONS,
  classifyKey,
  describeService,
  discoverProject,
  probeAnonymousReadability,
  signReadabilityAuthorization
} = require('../src/anonymous-readability-probe');

const MASTER = 'p'.repeat(64);
const authorizationKey = deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_READABILITY_AUTHORIZATION);

const PROJECT_REF = 'abcdefghijklmnopqrst';
const ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const COMMIT = 'c'.repeat(40);
const FINGERPRINT = 'f'.repeat(64);
const NOW = Date.parse('2026-09-22T14:00:00.000Z');

/* A JWT with a chosen payload and no signature worth anything: the point is
   the claims, which is all this module reads. */
function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.${'x'.repeat(43)}`;
}

const ANON_KEY = jwt({ iss: 'supabase', ref: PROJECT_REF, role: 'anon', iat: 1, exp: 9999999999 });
const SERVICE_KEY = jwt({ iss: 'supabase', ref: PROJECT_REF, role: 'service_role', iat: 1, exp: 9999999999 });
const USER_KEY = jwt({ iss: 'supabase', role: 'authenticated', sub: 'user-uuid', iat: 1, exp: 9999999999 });

function authorizationFor(overrides = {}) {
  return signReadabilityAuthorization({
    hmacKey: authorizationKey,
    authorizationId: overrides.authorizationId || '80000000-0000-4000-8000-000000000001',
    actorLogin: overrides.actorLogin || 'alice',
    scope: overrides.scope || scope,
    commit: overrides.commit || COMMIT,
    candidateFingerprint: overrides.candidateFingerprint || FINGERPRINT,
    projectRef: 'projectRef' in overrides ? overrides.projectRef : PROJECT_REF,
    relation: 'relation' in overrides ? overrides.relation : 'public_posts',
    projection: overrides.projection || ['id', 'title'],
    operation: overrides.operation || 'probe-readability',
    issuedAt: overrides.issuedAt || new Date(NOW - 1000).toISOString(),
    expiresAt: overrides.expiresAt || new Date(NOW + 60_000).toISOString()
  });
}

function transportReturning(...answers) {
  const calls = [];
  const queue = answers.slice();
  const transport = async request => {
    calls.push(request);
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof answer === 'function') return answer(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  transport.calls = calls;
  return transport;
}

function probe(overrides = {}) {
  return probeAnonymousReadability({
    authorization: 'authorization' in overrides ? overrides.authorization : authorizationFor(),
    authorizationKey,
    projectRef: 'projectRef' in overrides ? overrides.projectRef : PROJECT_REF,
    anonKey: 'anonKey' in overrides ? overrides.anonKey : ANON_KEY,
    relation: 'relation' in overrides ? overrides.relation : 'public_posts',
    projection: overrides.projection || ['id', 'title'],
    candidate: overrides.candidate || { fingerprint: FINGERPRINT, scope, commit: COMMIT },
    transport: overrides.transport || transportReturning({ statusCode: 200, body: '[]' }),
    now: overrides.now == null ? NOW : overrides.now
  });
}

(async () => {
  /* ---- Discovery sends nothing --------------------------------------- */

  /*
   * Finding a project in a repository is reading text. It must not touch the
   * network, because at that point nobody has agreed to anything: the whole
   * consent model rests on discovery being free.
   */
  {
    assert.strictEqual(DEFAULT_TRANSPORT, guardedFetch);
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'anonymous-readability-probe.js'), 'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(source.includes('function discoverProject'), 'the comment strip must leave the code behind');
    for (const forbidden of [/require\('https'\)/, /require\('http'\)/, /\bfetch\s*\(/, /https\.request/]) {
      assert.strictEqual(forbidden.test(source), false, `must not reach the network itself: ${forbidden}`);
    }

    const found = discoverProject(`const url = "${ORIGIN}";\n`);
    assert.strictEqual(found.projectRef, PROJECT_REF);
    /*
     * The origin is rebuilt from the reference, not copied from the text. A
     * URL taken out of a repository is a URL an attacker chose, and this is
     * the one place where a discovered string could otherwise become an
     * address this server connects to.
     */
    assert.strictEqual(found.origin, ORIGIN);

    for (const text of [
      'https://evil.example/abcdefghijklmnopqrst.supabase.co',
      'https://abcdefghijklmnopqrst.supabase.co.evil.example',
      'http://abcdefghijklmnopqrst.supabase.co',
      'https://short.supabase.co',
      'https://ABCDEFGHIJKLMNOPQRST.supabase.co',
      'https://abcdefghijklmnopqrs1.supabase.co',
      'nothing here',
      ''
    ]) {
      assert.strictEqual(discoverProject(text), null, text);
    }
  }

  /* ---- Which keys may be used ---------------------------------------- */

  /*
   * A public anonymous key is not a leaked administrator secret, and treating
   * it as one would make every Supabase project in every repository a critical
   * finding. The opposite mistake is worse: probing with a service-role key
   * bypasses every policy, so a row would come back whatever the project's
   * configuration is -- proving nothing and using an administrator credential
   * to do it.
   */
  {
    assert.strictEqual(classifyKey(ANON_KEY).kind, KEY_KINDS.ANON);
    assert.strictEqual(classifyKey(ANON_KEY).usable, true);
    assert.strictEqual(classifyKey('sb_publishable_AbCdEfGhIjKlMnOp').kind, KEY_KINDS.PUBLISHABLE);
    assert.strictEqual(classifyKey('sb_publishable_AbCdEfGhIjKlMnOp').usable, true);

    for (const [label, key, kind] of [
      ['a service-role JWT', SERVICE_KEY, KEY_KINDS.SERVICE_ROLE],
      ['a secret key', 'sb_secret_AbCdEfGhIjKlMnOp', KEY_KINDS.SECRET],
      ['a user session', USER_KEY, KEY_KINDS.USER_SESSION],
      ['something else', 'not-a-key', KEY_KINDS.UNKNOWN],
      ['an empty key', '', KEY_KINDS.UNKNOWN],
      ['a JWT with no role', jwt({ iss: 'supabase' }), KEY_KINDS.UNKNOWN],
      ['a JWT that is not JSON', 'aaa.bbb.ccc', KEY_KINDS.UNKNOWN],
      /*
       * A token that claims the anonymous role and carries a subject. It is
       * somebody's session whatever its role says, so a row coming back would
       * prove that person can read -- which is not the question. This is the
       * case the subject check exists for; a token with a non-anonymous role
       * is refused by the role alone.
       */
      ['a session claiming the anonymous role', jwt({
        iss: 'supabase', role: 'anon', sub: 'user-uuid', iat: 1, exp: 9999999999
      }), KEY_KINDS.USER_SESSION]
    ]) {
      assert.strictEqual(classifyKey(key).kind, kind, label);
      assert.strictEqual(classifyKey(key).usable, false, label);
    }
  }

  /* And an unusable key makes no request at all. */
  {
    for (const key of [SERVICE_KEY, 'sb_secret_AbCdEfGhIjKlMnOp', USER_KEY, 'not-a-key', '']) {
      const transport = transportReturning({ statusCode: 200, body: '[{"id":1}]' });
      const result = await probe({ anonKey: key, transport });
      assert.strictEqual(result.state, PROBE_STATES.UNVERIFIABLE, key.slice(0, 12));
      assert.strictEqual(result.reason, REASONS.KEY_NOT_ANONYMOUS, key.slice(0, 12));
      assert.strictEqual(transport.calls.length, 0, `${key.slice(0, 12)}: no request`);
    }
  }

  /* ---- Consent ------------------------------------------------------- */

  /*
   * A read transfers somebody's data and consumes their quota even though it
   * changes nothing, so it happens only under a grant naming the exact
   * project, relation and columns. Every one of these produces a record and
   * zero requests.
   */
  {
    const cases = [
      ['no authorization', undefined, REASONS.AUTHORIZATION_MISSING],
      ['an empty authorization', {}, REASONS.AUTHORIZATION_MISSING],
      ['a forged signature', { ...authorizationFor(), signature: 'a'.repeat(64) }, REASONS.AUTHORIZATION_INVALID],
      ['an expired grant', authorizationFor({
        issuedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString()
      }), REASONS.AUTHORIZATION_EXPIRED],
      ['a grant for another project', authorizationFor({ projectRef: 'tsrqponmlkjihgfedcba' }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for another relation', authorizationFor({ relation: 'private_users' }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for other columns', authorizationFor({ projection: ['id'] }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for reordered columns', authorizationFor({ projection: ['title', 'id'] }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for another candidate', authorizationFor({ candidateFingerprint: 'b'.repeat(64) }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for another repository', authorizationFor({ scope: { ...scope, repo: 'Other' } }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for another commit', authorizationFor({ commit: 'd'.repeat(40) }), REASONS.AUTHORIZATION_MISMATCH],
      ['a grant for a different operation', authorizationFor({ operation: 'describe-service' }), REASONS.AUTHORIZATION_MISMATCH]
    ];
    for (const [label, authorization, reason] of cases) {
      const transport = transportReturning({ statusCode: 200, body: '[{"id":1}]' });
      const result = await probe({ authorization, transport });
      assert.strictEqual(result.state, PROBE_STATES.UNVERIFIABLE, label);
      assert.strictEqual(result.reason, reason, label);
      assert.strictEqual(transport.calls.length, 0, `${label}: must make no request`);
    }
    assert(cases.length >= 12, 'the consent table must stay exhaustive');
  }

  /* ---- What may be asked for ----------------------------------------- */

  /*
   * The projection is a finite list of named columns an operator confirmed.
   * `*` is refused outright: selecting every column of a table somebody may
   * not have meant to expose is the difference between establishing that a
   * relation is readable and pulling out whatever is in it.
   */
  {
    for (const [label, projection] of [
      ['a wildcard', ['*']],
      ['a wildcard among columns', ['id', '*']],
      ['an empty projection', []],
      ['too many columns', Array.from({ length: MAX_PROJECTION_COLUMNS + 1 }, (_v, i) => `c${i}`)],
      ['an embedded resource', ['id', 'author:users(email)']],
      ['a function call', ['count(*)']],
      ['an alias', ['id:secret_column']],
      ['a cast', ['id::text']],
      ['a comma', ['id,title']],
      ['a quoted name', ['"id"']],
      ['a name with a space', ['id title']],
      ['a duplicate', ['id', 'id']]
    ]) {
      const transport = transportReturning({ statusCode: 200, body: '[{"id":1}]' });
      const result = await probe({
        projection, authorization: authorizationFor({ projection }), transport
      });
      assert.strictEqual(result.reason, REASONS.PROJECTION_REFUSED, label);
      assert.strictEqual(transport.calls.length, 0, `${label}: no request`);
    }
  }

  /* A relation is a plain table name and nothing more. */
  {
    for (const [label, relation] of [
      ['an rpc call', 'rpc/dangerous_function'],
      ['a schema-qualified name', 'auth.users'],
      ['a traversal', '../rest/v1/other'],
      ['a query string', 'posts?select=*'],
      ['an empty name', ''],
      ['an uppercase name', 'Posts'],
      ['a name with a slash', 'posts/1'],
      ['a name with a space', 'public posts'],
      ['an over-long name', 'a'.repeat(120)]
    ]) {
      const transport = transportReturning({ statusCode: 200, body: '[{"id":1}]' });
      const result = await probe({
        relation, authorization: authorizationFor({ relation }), transport
      });
      assert.strictEqual(result.reason, REASONS.RELATION_REFUSED, label);
      assert.strictEqual(transport.calls.length, 0, `${label}: no request`);
    }

    /*
     * And a name that merely looks like a function call is a table name. The
     * exclusion is by shape -- an `rpc/` path contains a slash, which a table
     * name cannot -- so refusing anything beginning `rpc` would lock out a
     * table somebody legitimately called `rpc_helpers`.
     */
    for (const relation of ['rpc_helpers', 'rpcs', 'auth_events', 'select_history', 'public_posts']) {
      const transport = transportReturning({ statusCode: 200, body: '[{"id":1}]' });
      const result = await probe({
        relation, authorization: authorizationFor({ relation }), transport
      });
      assert.notStrictEqual(result.reason, REASONS.RELATION_REFUSED, relation);
      assert.strictEqual(transport.calls.length, 1, `${relation}: a table name is a table name`);
      assert.strictEqual(transport.calls[0].url.includes(`/rest/v1/${relation}?`), true, relation);
    }
  }

  /* A project reference is twenty lowercase letters, and the origin is ours. */
  {
    for (const projectRef of ['', 'short', 'ABCDEFGHIJKLMNOPQRST', 'abcdefghijklmnopqrs1', 'a'.repeat(21), '../../etc']) {
      const transport = transportReturning({ statusCode: 200, body: '[]' });
      const result = await probe({
        projectRef, authorization: authorizationFor({ projectRef }), transport
      });
      assert.strictEqual(result.reason, REASONS.PROJECT_REFUSED, JSON.stringify(projectRef));
      assert.strictEqual(transport.calls.length, 0);
    }
  }

  /* ---- The request ---------------------------------------------------- */

  {
    /* Distinctive row values, so the leak check below is about values rather
       than about the column names the record is supposed to state. */
    const transport = transportReturning({
      statusCode: 200, body: '[{"id":424242,"title":"a-row-value-nobody-agreed-to-store"}]'
    });
    const result = await probe({ transport });
    assert.strictEqual(result.state, PROBE_STATES.READABLE);
    assert.strictEqual(result.reason, REASONS.ROWS_VISIBLE);

    assert.strictEqual(transport.calls.length, 1);
    const [call] = transport.calls;
    assert.strictEqual(call.url, `${ORIGIN}/rest/v1/public_posts?select=id%2Ctitle&limit=1`);
    assert.strictEqual(call.method, 'GET');
    /*
     * The provider-read profile, because this request needs a query string --
     * the projection and the row limit are the query -- and carries its key in
     * a header. The transport refuses a credential that appears in the URL on
     * any profile, which is what makes that combination safe here.
     */
    assert.strictEqual(call.profile, PROFILES.PROVIDER_READ);
    assert.strictEqual(call.headers.apikey, ANON_KEY);
    assert.strictEqual(call.headers.authorization, `Bearer ${ANON_KEY}`);
    assert.strictEqual(call.maxResponseBytes, MAX_RESPONSE_BYTES);
    /* One row, bounded at the provider as well as in bytes here. */
    assert.strictEqual(call.headers.range, '0-0');
    assert.strictEqual(call.headers.prefer, 'count=none');
    assert.strictEqual(
      call.url.includes(ANON_KEY), false, 'the key travels in headers only'
    );
    assert.strictEqual(/offset=|range=|page=/.test(call.url), false, 'no pagination is ever requested');

    /*
     * And nothing from inside the row comes back. The column names are
     * recorded on purpose -- the record has to say what was tested -- so the
     * check is about values, which is the distinction that matters.
     */
    const serialized = JSON.stringify(result);
    for (const value of ['424242', 'a-row-value-nobody-agreed-to-store', 'a-row-value']) {
      assert.strictEqual(serialized.includes(value), false, `a row value reached the record: ${value}`);
    }
    assert(serialized.includes('title'), 'while the tested projection is stated, because that is the finding');
    assert.deepStrictEqual(Object.keys(result).sort(), [
      'observedAt', 'projectRef', 'projection', 'reason', 'relation', 'rowCount', 'state', 'testedRole'
    ], 'the record shape is closed: it says what was tested, and how many rows, and nothing else');
    assert.strictEqual(result.rowCount, 1);
    assert.strictEqual(result.testedRole, 'anon');
    assert.deepStrictEqual(result.projection, ['id', 'title']);
    assert(Object.isFrozen(result));
  }

  /* ---- An empty array proves nothing --------------------------------- */

  /*
   * The single most important case. An empty result means the anonymous role
   * saw no rows -- which happens when the table is empty, when a row filter
   * hid everything, and when a policy allows the select but matches nothing.
   * Those are indistinguishable from outside, so none of them may be reported
   * as protection.
   */
  {
    for (const body of ['[]', '[ ]', '\n[]\n']) {
      const result = await probe({ transport: transportReturning({ statusCode: 200, body }) });
      assert.strictEqual(result.state, PROBE_STATES.UNVERIFIABLE, body);
      assert.strictEqual(result.reason, REASONS.NO_VISIBLE_ROWS, body);
      assert.strictEqual(result.rowCount, 0, body);
    }
  }

  /* ---- A refusal is about the request, not the table ----------------- */

  {
    for (const [statusCode, body] of [
      [401, '{"message":"JWT expired"}'],
      [403, '{"code":"42501","message":"permission denied for table public_posts"}'],
      [404, '{"code":"42P01","message":"relation does not exist"}']
    ]) {
      const result = await probe({ transport: transportReturning({ statusCode, body }) });
      assert.strictEqual(result.state, PROBE_STATES.DENIED, String(statusCode));
      assert.strictEqual(
        result.reason, REASONS.ACCESS_DENIED_FOR_TESTED_REQUEST,
        `${statusCode}: a refusal names the request it refused`
      );
      assert.strictEqual(result.rowCount, 0);
      /*
       * And the vocabulary deliberately contains no word for "protected".
       * A refusal of one projection of one relation under one role says
       * nothing about the rest of the table, the rest of the schema, or
       * whether row-level security is switched on at all.
       */
      assert.strictEqual(
        /protected|secure|safe|rls-enabled/.test(JSON.stringify(result)), false,
        'a refusal must not be dressed up as proof of protection'
      );
    }
    for (const reason of Object.values(REASONS)) {
      assert.strictEqual(
        /protected|rls/.test(reason), false,
        `no reason code may claim protection: ${reason}`
      );
    }
  }

  /* Anything else is unverifiable rather than interpreted. */
  {
    for (const [statusCode, body] of [[429, '{}'], [500, '{}'], [502, '{}'], [200, 'not json'], [200, '{"id":1}']]) {
      const result = await probe({ transport: transportReturning({ statusCode, body }) });
      assert.strictEqual(result.state, PROBE_STATES.UNVERIFIABLE, `${statusCode} ${body}`);
      assert(
        [REASONS.PROVIDER_THROTTLED, REASONS.PROVIDER_UNEXPECTED_RESPONSE].includes(result.reason),
        `${statusCode} ${body}: ${result.reason}`
      );
    }
  }

  /* A transport failure is unverifiable, and carries no message across. */
  {
    const transport = transportReturning(() => {
      const error = new Error(`connect failed while sending apikey ${ANON_KEY}`);
      error.code = 'GUARDED_FETCH_TRANSPORT_FAILED';
      throw error;
    });
    const result = await probe({ transport });
    assert.strictEqual(result.state, PROBE_STATES.UNVERIFIABLE);
    assert.strictEqual(result.reason, REASONS.TRANSPORT_REFUSED);
    assert.strictEqual(JSON.stringify(result).includes(ANON_KEY), false);
  }

  /* ---- Service description, under the same grant --------------------- */

  /*
   * Reading the service description is how a relation list is discovered
   * without an operator typing one, and it is a read like any other: it needs
   * its own grant, under its own operation, and it brings back names only.
   * When it is unavailable the coverage says so -- an operator confirming a
   * relation list from a partial description is confirming less than they
   * think.
   */
  {
    const openapi = JSON.stringify({
      paths: { '/': {}, '/public_posts': {}, '/private_users': {}, '/rpc/do_thing': {} },
      definitions: { public_posts: { properties: { id: {}, title: {}, secret: {} } } }
    });
    const transport = transportReturning({ statusCode: 200, body: openapi });
    const described = await describeService({
      authorization: authorizationFor({ operation: 'describe-service', relation: '', projection: [] }),
      authorizationKey, projectRef: PROJECT_REF, anonKey: ANON_KEY,
      candidate: { fingerprint: FINGERPRINT, scope, commit: COMMIT },
      transport, now: NOW
    });
    assert.strictEqual(described.coverage, 'complete');
    assert.deepStrictEqual(described.relations, ['private_users', 'public_posts'],
      'relation names, sorted, with rpc paths and the root left out');
    /* Names only. Not column names, not types, not a single value. */
    assert.strictEqual(JSON.stringify(described).includes('secret'), false);
    assert.strictEqual(JSON.stringify(described).includes('properties'), false);
    assert.strictEqual(transport.calls[0].url, `${ORIGIN}/rest/v1/`);

    /* Unavailable description reduces coverage rather than inventing a list. */
    for (const answer of [{ statusCode: 500, body: '{}' }, { statusCode: 200, body: 'not json' }, { statusCode: 200, body: '{}' }]) {
      const partial = await describeService({
        authorization: authorizationFor({ operation: 'describe-service', relation: '', projection: [] }),
        authorizationKey, projectRef: PROJECT_REF, anonKey: ANON_KEY,
        candidate: { fingerprint: FINGERPRINT, scope, commit: COMMIT },
        transport: transportReturning(answer), now: NOW
      });
      assert.strictEqual(partial.coverage, 'partial', JSON.stringify(answer));
      assert.deepStrictEqual(partial.relations, []);
    }

    /* And a probe grant is not a description grant. */
    const wrongGrant = await describeService({
      authorization: authorizationFor(),
      authorizationKey, projectRef: PROJECT_REF, anonKey: ANON_KEY,
      candidate: { fingerprint: FINGERPRINT, scope, commit: COMMIT },
      transport: transportReturning({ statusCode: 200, body: openapi }), now: NOW
    });
    assert.strictEqual(wrongGrant.coverage, 'refused');
    assert.strictEqual(wrongGrant.reason, REASONS.AUTHORIZATION_MISMATCH);
  }

  /* ---- Nothing is ever written --------------------------------------- */

  {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'anonymous-readability-probe.js'), 'utf8'
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.strictEqual(
        source.includes(`'${method}'`), false,
        `a readability probe never writes: ${method}`
      );
    }
    /* And the profile it uses cannot write even if somebody tried. */
    await assert.rejects(
      guardedFetch({
        url: `${ORIGIN}/rest/v1/public_posts`, profile: PROFILES.PROVIDER_READ, method: 'POST',
        resolveAddresses: async () => [{ address: '104.18.38.10', family: 4 }],
        requestImpl: () => { throw new Error('must not be called'); }
      }),
      error => error.code === 'GUARDED_FETCH_METHOD_INVALID'
    );
  }

  /* ---- The key does not come back ------------------------------------ */

  {
    const surfaces = [];
    for (const answer of [
      { statusCode: 200, body: `[{"key":"${ANON_KEY}"}]` },
      { statusCode: 403, body: `{"message":"denied for ${ANON_KEY}"}` },
      { statusCode: 500, body: ANON_KEY }
    ]) {
      const result = await probe({ transport: transportReturning(answer) });
      surfaces.push(JSON.stringify(result));
    }
    assert.strictEqual(surfaces.length, 3);
    for (const surface of surfaces) {
      for (const probeValue of [ANON_KEY, ANON_KEY.slice(0, 24), PROJECT_REF.toUpperCase()]) {
        assert.strictEqual(surface.includes(probeValue), false, `${probeValue} reached a record`);
      }
    }
    /* The project reference is not a secret and is deliberately recorded: it
       is what a reader needs to find the project being talked about. */
    assert(surfaces[0].includes(PROJECT_REF));
  }

  /* ---- The grant signature ------------------------------------------- */

  {
    const straight = authorizationFor();
    assert.match(straight.signature, /^[0-9a-f]{64}$/);
    /* Length-prefixed parts: a relation containing the separator must not
       forge a projection. */
    assert.notStrictEqual(
      signReadabilityAuthorization({
        hmacKey: authorizationKey, authorizationId: 'x', actorLogin: 'a', scope, commit: COMMIT,
        candidateFingerprint: FINGERPRINT, projectRef: PROJECT_REF, relation: 'a|b',
        projection: ['c'], operation: 'probe-readability',
        issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1000).toISOString()
      }).signature,
      signReadabilityAuthorization({
        hmacKey: authorizationKey, authorizationId: 'x', actorLogin: 'a', scope, commit: COMMIT,
        candidateFingerprint: FINGERPRINT, projectRef: PROJECT_REF, relation: 'a',
        projection: ['b|c'], operation: 'probe-readability',
        issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1000).toISOString()
      }).signature
    );
    for (const signature of ['', 'abc', 'z'.repeat(64), crypto.randomBytes(16).toString('hex')]) {
      const result = await probe({ authorization: { ...straight, signature } });
      assert.strictEqual(result.reason, REASONS.AUTHORIZATION_INVALID, JSON.stringify(signature));
    }
  }

  console.log('anonymous readability probe tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
