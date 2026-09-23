'use strict';

/*
 * Asking a provider whether a discovered credential is live.
 *
 * Three things make this different from every other outbound call in this
 * server, and the tests here are organised around them.
 *
 * It carries a secret this repository does not own. So nothing it returns, logs
 * or throws may contain that secret, and the check for that is not a code
 * review -- it is a synthetic token asserted absent from every record, every
 * error, every stack and everything written to the console during a run.
 *
 * A read permission on a repository is not permission to use what is inside it.
 * So a probe requires a separate, signed, expiring authorization bound to the
 * actor, the repository, the commit, the exact candidate, the adapter and the
 * target -- and an absent or mismatched one produces a record with zero network
 * calls rather than an attempt.
 *
 * The answer is three-state and asymmetric. `verified` means an identity
 * endpoint confirmed the credential. `rejected` means this verifier was told no
 * by an unambiguous documented signal. Everything else -- throttling, a policy
 * restriction, an unsupported token class, a malformed body, an IP-restricted
 * Slack error, a timeout -- is `unverifiable`, because "we could not tell" and
 * "it is harmless" are different sentences and only one of them is true.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { PROFILES, guardedFetch } = require('../src/guarded-fetch');
const {
  ADAPTERS,
  DEFAULT_TRANSPORT,
  MAX_AUTHORIZATION_LIFETIME_MS,
  MAX_PROBES_PER_RUN,
  PROBE_MAX_RESPONSE_BYTES,
  REASONS,
  VERIFICATION_STATES,
  adapterForCandidate,
  signVerificationAuthorization,
  verificationFreshness,
  verifyCandidates,
  verifyCredential
} = require('../src/credential-verification');

/*
 * Synthetic values, shaped like the real thing so the detection rules match
 * them, and asserted absent from every output surface at the end of this file.
 *
 * Every prefix is split across a template expression. That is not style: this
 * repository's own release gate scans every tracked file for exactly these
 * shapes, and a test fixture written as one literal fails the build it is
 * meant to protect. The value at run time is the contiguous string.
 */
const SECRET = `gh${'p'}_SyNtHeTiC0000000000000000000000000000`;
const SLACK_SECRET = `xo${'xb'}-000000000000-000000000000-SyNtHeTiCnotreal`;
const GITLAB_SECRET = `gl${'pat'}-SyNtHeTiCnotreal12`;
const AWS_KEY_ID = `AK${'IA'}0000SYNTHETIC0000`;

/* The classes a supported rule finds and no reviewed adapter accepts. */
const UNREVIEWED = Object.freeze([
  ['github-token', `gh${'s'}_SyNtHeTiC0000000000000000000000000000`],
  ['github-token', `gh${'r'}_SyNtHeTiC0000000000000000000000000000`],
  ['gitlab-token', `gl${'dt'}-SyNtHeTiCnotreal12`],
  ['gitlab-token', `gl${'rt'}-SyNtHeTiCnotreal12`],
  ['gitlab-token', `gl${'agent'}-SyNtHeTiCnotreal12`],
  ['slack-token', `xo${'xa'}-000000000000-SyNtHeTiCnotreal`],
  ['slack-token', `xo${'xr'}-000000000000-SyNtHeTiCnotreal`]
]);

/* And the classes with no adapter at all. */
const UNSUPPORTED = Object.freeze([
  ['private-key', `-----BEGIN ${'PRIVATE'} KEY-----`],
  ['authenticated-url', ['postgres://', 'user:', 'synthetic0000000000', '@db.example.com/app'].join('')],
  ['contextual-provider-secret', `SESSION_${'SECRET'}=synthetic00000000000000`]
]);

const MASTER = 'x'.repeat(64);
const authorizationKey = deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_VERIFICATION_AUTHORIZATION);
/* A separate key for the subject digest, because a MAC over a grant this
   server issued and a MAC over a value a provider told us are two purposes. */
const subjectKey = deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT);

const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const NOW = Date.parse('2026-09-22T10:00:00.000Z');

function candidateFor(rule, secret, fingerprint = 'f'.repeat(64)) {
  return { rule, secret, fingerprint, scope, commit: 'a'.repeat(40) };
}

function authorizationFor(candidate, overrides = {}) {
  const adapter = overrides.adapter || (adapterForCandidate(candidate) || {}).id || 'none';
  return signVerificationAuthorization({
    hmacKey: authorizationKey,
    authorizationId: overrides.authorizationId || '70000000-0000-4000-8000-000000000001',
    actorLogin: overrides.actorLogin || 'alice',
    scope: overrides.scope || candidate.scope,
    commit: overrides.commit || candidate.commit,
    candidateFingerprint: overrides.candidateFingerprint || candidate.fingerprint,
    adapter,
    targetId: overrides.targetId || (ADAPTERS[adapter] && ADAPTERS[adapter].targetId) || 'none',
    issuedAt: overrides.issuedAt || new Date(NOW - 1000).toISOString(),
    expiresAt: overrides.expiresAt || new Date(NOW + 60_000).toISOString()
  });
}

/* A transport that records what it was asked and answers from a fixture. */
function fixtureTransport(...answers) {
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

const refusingTransport = () => {
  const transport = fixtureTransport(() => { throw new Error('this transport refuses every request'); });
  return transport;
};

(async () => {
  /* ---- Nothing reaches the network except through the guarded transport --- */

  {
    assert.strictEqual(
      DEFAULT_TRANSPORT, guardedFetch,
      'the default transport must be the guarded one itself, not a lookalike with the same shape'
    );
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'credential-verification.js'), 'utf8');
    for (const forbidden of [/require\('https'\)/, /require\('http'\)/, /require\('net'\)/, /\bfetch\s*\(/, /https\.request/]) {
      assert.strictEqual(
        forbidden.test(source), false,
        `this module must not reach the network itself: ${forbidden}`
      );
    }
    /* And every adapter probes with the credential-bearing profile, which is
       the one that refuses a query string. */
    for (const adapter of Object.values(ADAPTERS)) {
      assert.strictEqual(
        adapter.profile, PROFILES.CREDENTIAL_VERIFY,
        `${adapter.id} must probe with the credential-bearing profile`
      );
      assert.match(adapter.origin, /^https:\/\/[a-z0-9.-]+$/, `${adapter.id} origin must be a fixed https origin`);
      assert.match(adapter.probePath, /^\/[\w./-]*$/, `${adapter.id} path must be a fixed path`);
      assert(Object.isFrozen(adapter), 'an adapter descriptor must be frozen');
    }
  }

  /* ---- Consent ----------------------------------------------------------- */

  /*
   * Every one of these must produce a record and zero requests. A probe that
   * happens before the authorization is checked has already used the
   * credential, and no later verdict takes that back.
   */
  {
    const candidate = candidateFor('github-token', SECRET);
    const cases = [
      ['no authorization at all', undefined, REASONS.AUTHORIZATION_MISSING],
      ['an empty authorization', {}, REASONS.AUTHORIZATION_MISSING],
      ['a forged signature', { ...authorizationFor(candidate), signature: 'a'.repeat(64) }, REASONS.AUTHORIZATION_INVALID],
      ['an expired authorization', authorizationFor(candidate, {
        issuedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 1000).toISOString()
      }), REASONS.AUTHORIZATION_EXPIRED],
      ['one issued in the future', authorizationFor(candidate, {
        issuedAt: new Date(NOW + 60_000).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString()
      }), REASONS.AUTHORIZATION_INVALID],
      ['one that outlives the ceiling', authorizationFor(candidate, {
        expiresAt: new Date(NOW + MAX_AUTHORIZATION_LIFETIME_MS + 60_000).toISOString()
      }), REASONS.AUTHORIZATION_INVALID],
      ['one bound to another candidate', authorizationFor(candidate, {
        candidateFingerprint: 'b'.repeat(64)
      }), REASONS.AUTHORIZATION_MISMATCH],
      ['one bound to another repository', authorizationFor(candidate, {
        scope: { ...scope, repo: 'Other' }
      }), REASONS.AUTHORIZATION_MISMATCH],
      ['one bound to another commit', authorizationFor(candidate, {
        commit: 'b'.repeat(40)
      }), REASONS.AUTHORIZATION_MISMATCH],
      ['one bound to another adapter', authorizationFor(candidate, {
        adapter: 'slack-user-token', targetId: 'slack.com'
      }), REASONS.AUTHORIZATION_MISMATCH],
      ['one bound to another target', authorizationFor(candidate, {
        targetId: 'api.example.invalid'
      }), REASONS.AUTHORIZATION_MISMATCH]
    ];

    for (const [label, authorization, reason] of cases) {
      const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
      const record = await verifyCredential({
        candidate, authorization, authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, `${label}: must not be a verdict`);
      assert.strictEqual(record.reason, reason, `${label}: reason`);
      assert.strictEqual(transport.calls.length, 0, `${label}: must make no request at all`);
    }
    assert(cases.length >= 11, 'the consent table must stay exhaustive');
  }

  /* A valid authorization under the wrong key is not a valid authorization. */
  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const record = await verifyCredential({
      candidate,
      authorization: authorizationFor(candidate),
      authorizationKey: deriveKey('y'.repeat(64), KEY_PURPOSES.EXPOSURE_VERIFICATION_AUTHORIZATION),
      transport,
      now: NOW
    });
    assert.strictEqual(record.reason, REASONS.AUTHORIZATION_INVALID);
    assert.strictEqual(transport.calls.length, 0);
  }

  /*
   * The actor is bound too, and enforced when the caller says who is asking.
   * A grant signed for one person is not a grant for the next.
   */
  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const record = await verifyCredential({
      candidate,
      authorization: authorizationFor(candidate, { actorLogin: 'alice' }),
      actorLogin: 'mallory',
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.reason, REASONS.AUTHORIZATION_MISMATCH);
    assert.strictEqual(transport.calls.length, 0);

    const matched = await verifyCredential({
      candidate,
      authorization: authorizationFor(candidate, { actorLogin: 'alice' }),
      actorLogin: 'alice',
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(matched.state, VERIFICATION_STATES.VERIFIED);
  }

  /* ---- Credential classes ------------------------------------------------ */

  /*
   * An access key ID is not a credential. The rule that finds it finds half of
   * one, and the plan is explicit that the other half is never guessed at,
   * never paired with another finding, and never sent to STS on spec.
   */
  {
    const candidate = candidateFor('aws-access-key', AWS_KEY_ID);
    const transport = fixtureTransport({ statusCode: 200, body: '{}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE);
    assert.strictEqual(record.reason, REASONS.INCOMPLETE_CREDENTIAL);
    assert.strictEqual(transport.calls.length, 0, 'an incomplete credential is never sent anywhere');
  }

  /* Detected, and deliberately not probed. */
  {
    for (const [rule, secret] of UNSUPPORTED) {
      const candidate = candidateFor(rule, secret);
      const transport = fixtureTransport({ statusCode: 200, body: '{}' });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, rule);
      assert.strictEqual(record.reason, REASONS.UNSUPPORTED_CREDENTIAL_CLASS, rule);
      assert.strictEqual(transport.calls.length, 0, `${rule}: never submitted to an unrelated authority`);
      assert.strictEqual(record.adapter, null, `${rule}: no adapter claims it`);
    }
  }

  /*
   * Token classes within a supported rule that have no reviewed adapter. A
   * GitHub installation token does not authenticate as a user, so /user is the
   * wrong question and answering it would be a guess dressed as a verdict.
   */
  {
    for (const [rule, secret] of UNREVIEWED) {
      const candidate = candidateFor(rule, secret);
      const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, secret.slice(0, 8));
      assert.strictEqual(record.reason, REASONS.UNSUPPORTED_TOKEN_CLASS, secret.slice(0, 8));
      assert.strictEqual(transport.calls.length, 0, `${secret.slice(0, 8)}: no probe for an unreviewed class`);
    }
  }

  /* ---- GitHub ------------------------------------------------------------ */

  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":4242,"type":"User"}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
    assert.strictEqual(record.reason, REASONS.IDENTITY_CONFIRMED);
    assert.strictEqual(record.adapter, 'github-user-token');
    assert.strictEqual(record.observedAt, new Date(NOW).toISOString());

    /* The identity endpoint, not the rate limit endpoint: /rate_limit answers
       200 for an unauthenticated caller too, so a 200 there proves nothing. */
    assert.strictEqual(transport.calls.length, 1);
    const [call] = transport.calls;
    assert.strictEqual(call.url, 'https://api.github.com/user');
    assert.strictEqual(call.method, 'GET');
    assert.strictEqual(call.profile, PROFILES.CREDENTIAL_VERIFY);
    assert.strictEqual(call.maxResponseBytes, PROBE_MAX_RESPONSE_BYTES);
    assert.strictEqual(call.headers.authorization, `Bearer ${SECRET}`);
    assert.strictEqual(call.headers['x-github-api-version'], '2022-11-28');

    /* The subject is recorded as a digest. Which account a leaked credential
       belongs to is worth being able to compare across runs; storing the login
       to do it is a detail the finding does not need. */
    assert.match(record.subjectDigest, /^[0-9a-f]{32}$/);
    assert.strictEqual(JSON.stringify(record).includes('alice'), false, 'and not the login itself');
  }

  /* A 200 whose body is not an identity is not an identity. */
  {
    for (const body of ['{}', '{"login":4242}', '{"login":"alice"}', 'not json', '[]', '{"id":4242}']) {
      const candidate = candidateFor('github-token', SECRET);
      const transport = fixtureTransport({ statusCode: 200, body });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, body);
      assert.strictEqual(record.reason, REASONS.MALFORMED_IDENTITY_RESPONSE, body);
    }
  }

  /* 401 is the one unambiguous no. */
  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 401, body: '{"message":"Bad credentials"}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.REJECTED);
    assert.strictEqual(record.reason, REASONS.CREDENTIAL_REFUSED);
  }

  /*
   * 403 is not. It is primary throttling, secondary throttling, or an
   * organisation policy that blocks this token from this endpoint -- and all
   * three describe a live credential.
   */
  {
    const cases = [
      [{ statusCode: 403, body: '{"message":"API rate limit exceeded"}', headers: { 'retry-after': '120' } },
        REASONS.PROVIDER_THROTTLED, 120_000],
      [{ statusCode: 403, body: '{"message":"You have exceeded a secondary rate limit"}', headers: {} },
        REASONS.PROVIDER_THROTTLED, null],
      [{ statusCode: 403, body: '{"message":"Resource protected by organization SAML enforcement"}', headers: {} },
        REASONS.PROVIDER_POLICY_RESTRICTED, null],
      [{ statusCode: 429, body: '{"message":"Too many requests"}', headers: { 'retry-after': '30' } },
        REASONS.PROVIDER_THROTTLED, 30_000]
    ];
    for (const [answer, reason, retryAfterMs] of cases) {
      const candidate = candidateFor('github-token', SECRET);
      const transport = fixtureTransport(answer);
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, reason);
      assert.strictEqual(record.reason, reason);
      assert.strictEqual(record.retryAfterMs, retryAfterMs, `${reason}: bounded retry window`);
    }
  }

  /* An absurd Retry-After is clamped rather than believed. */
  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({
      statusCode: 429, body: '{}', headers: { 'retry-after': '99999999' }
    });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert(record.retryAfterMs > 0 && record.retryAfterMs <= 3_600_000, 'a retry window is bounded by us, not by them');
  }

  /* Any other status is an answer this adapter has not been reviewed against. */
  {
    for (const statusCode of [404, 500, 502, 301]) {
      const candidate = candidateFor('github-token', SECRET);
      const transport = fixtureTransport({ statusCode, body: '{}' });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, String(statusCode));
      assert.strictEqual(record.reason, REASONS.PROVIDER_UNEXPECTED_STATUS, String(statusCode));
    }
  }

  /* ---- GitLab ------------------------------------------------------------ */

  {
    const candidate = candidateFor('gitlab-token', GITLAB_SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"id":77,"username":"alice"}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
    assert.strictEqual(record.adapter, 'gitlab-user-token');
    assert.strictEqual(transport.calls[0].url, 'https://gitlab.com/api/v4/user');
    assert.strictEqual(transport.calls[0].headers.authorization, `Bearer ${GITLAB_SECRET}`);
  }
  {
    const candidate = candidateFor('gitlab-token', GITLAB_SECRET);
    const transport = fixtureTransport({ statusCode: 401, body: '{"message":"401 Unauthorized"}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.REJECTED);
  }

  /* ---- Slack ------------------------------------------------------------- */

  /*
   * Slack answers 200 to almost everything, so the status code carries no
   * information and `ok` does. It is also the provider whose documented error
   * codes divide most sharply into "this token is gone" and "this token is
   * fine but you are not allowed to ask from here".
   */
  {
    const candidate = candidateFor('slack-token', SLACK_SECRET);
    const transport = fixtureTransport({
      statusCode: 200, body: '{"ok":true,"user_id":"U01","team_id":"T01","url":"https://acme.slack.com/"}'
    });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
    assert.strictEqual(record.adapter, 'slack-user-token');
    assert.strictEqual(transport.calls[0].url, 'https://slack.com/api/auth.test');
    assert.strictEqual(transport.calls[0].method, 'POST');
    assert.strictEqual(
      transport.calls[0].headers['content-type'], 'application/x-www-form-urlencoded',
      'auth.test is documented as a POST and the probe sends one'
    );
    assert.strictEqual(transport.calls[0].body, '', 'the credential travels in the header, never in a form field');
  }

  {
    const definite = ['token_revoked', 'token_expired', 'account_inactive', 'invalid_token'];
    for (const error of definite) {
      const candidate = candidateFor('slack-token', SLACK_SECRET);
      const transport = fixtureTransport({ statusCode: 200, body: JSON.stringify({ ok: false, error }) });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.REJECTED, error);
      assert.strictEqual(record.reason, REASONS.CREDENTIAL_REFUSED, error);
    }

    /*
     * `invalid_auth` is the ambiguous one and the plan names it: Slack returns
     * it for a revoked token and for a valid token used from an address the
     * workspace restricts. Presenting that as revoked tells a reader the
     * exposure is over when it is not.
     */
    const ambiguous = [
      ['invalid_auth', REASONS.PROVIDER_AMBIGUOUS_REJECTION],
      ['not_authed', REASONS.PROVIDER_AMBIGUOUS_REJECTION],
      ['ekm_access_denied', REASONS.PROVIDER_POLICY_RESTRICTED],
      ['ratelimited', REASONS.PROVIDER_THROTTLED],
      ['fatal_error', REASONS.PROVIDER_UNEXPECTED_STATUS],
      ['something_new_slack_added', REASONS.PROVIDER_UNEXPECTED_STATUS]
    ];
    for (const [error, reason] of ambiguous) {
      const candidate = candidateFor('slack-token', SLACK_SECRET);
      const transport = fixtureTransport({ statusCode: 200, body: JSON.stringify({ ok: false, error }) });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, error);
      assert.strictEqual(record.reason, reason, error);
    }

    /* A 200 with neither ok:true nor a documented error is not a verdict. */
    for (const body of ['{"ok":"yes"}', '{}', 'null', '{"ok":false}']) {
      const candidate = candidateFor('slack-token', SLACK_SECRET);
      const transport = fixtureTransport({ statusCode: 200, body });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, body);
      assert.strictEqual(record.reason, REASONS.MALFORMED_IDENTITY_RESPONSE, body);
    }

    /* ok:true without the identity fields is not proof either. */
    {
      const candidate = candidateFor('slack-token', SLACK_SECRET);
      const transport = fixtureTransport({ statusCode: 200, body: '{"ok":true}' });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE);
      assert.strictEqual(record.reason, REASONS.MALFORMED_IDENTITY_RESPONSE);
    }
  }

  /* ---- Transport failure ------------------------------------------------- */

  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = refusingTransport();
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE);
    assert.strictEqual(record.reason, REASONS.TRANSPORT_REFUSED);
    assert.strictEqual(
      JSON.stringify(record).includes('refuses every request'), false,
      'a transport error message is not carried into a record: it can quote the request'
    );
  }

  {
    for (const [code, reason] of [
      ['GUARDED_FETCH_TIMEOUT', REASONS.TRANSPORT_TIMEOUT],
      ['GUARDED_FETCH_DEADLINE', REASONS.TRANSPORT_TIMEOUT],
      ['GUARDED_FETCH_SSRF_BLOCKED', REASONS.TRANSPORT_REFUSED],
      ['GUARDED_FETCH_RESPONSE_TOO_LARGE', REASONS.MALFORMED_IDENTITY_RESPONSE]
    ]) {
      const candidate = candidateFor('github-token', SECRET);
      const transport = fixtureTransport(() => {
        const error = new Error('transport failed');
        error.code = code;
        throw error;
      });
      const record = await verifyCredential({
        candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
      });
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE, code);
      assert.strictEqual(record.reason, reason, code);
    }
  }

  /* ---- A run ------------------------------------------------------------- */

  /*
   * The same credential found in four files is one probe. Repeating it is a
   * gift to whoever is rate-limiting us and tells us nothing new.
   */
  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const records = await verifyCandidates({
      requests: [
        { candidate, authorization: authorizationFor(candidate) },
        { candidate, authorization: authorizationFor(candidate) },
        { candidate, authorization: authorizationFor(candidate) }
      ],
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(records.length, 3, 'every request gets a record');
    assert.strictEqual(transport.calls.length, 1, 'and the provider is asked once');
    assert.strictEqual(records[0].deduplicated, false);
    assert.strictEqual(records[1].deduplicated, true);
    assert.strictEqual(records[2].deduplicated, true);
    for (const record of records) assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
    assert(Object.isFrozen(records), 'a run of attempts is a historical record, not a mutable list');
  }

  /* Different credentials are different probes even under one rule. */
  {
    const first = candidateFor('github-token', SECRET, 'a'.repeat(64));
    const second = candidateFor('github-token', `${SECRET}2`, 'b'.repeat(64));
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    await verifyCandidates({
      requests: [
        { candidate: first, authorization: authorizationFor(first) },
        { candidate: second, authorization: authorizationFor(second) }
      ],
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(transport.calls.length, 2);
  }

  /*
   * Throttling stops the run against that adapter rather than being retried
   * inside the window it just told us about. A 403 answered four more times is
   * four more chances to be blocked for longer.
   */
  {
    const candidates = [0, 1, 2, 3].map(index => candidateFor('github-token', `${SECRET}${index}`, String(index).repeat(64)));
    const transport = fixtureTransport({
      statusCode: 429, body: '{}', headers: { 'retry-after': '60' }
    });
    const records = await verifyCandidates({
      requests: candidates.map(candidate => ({ candidate, authorization: authorizationFor(candidate) })),
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(transport.calls.length, 1, 'one throttled answer ends the run for that adapter');
    assert.strictEqual(records.length, 4);
    assert.strictEqual(records[0].reason, REASONS.PROVIDER_THROTTLED);
    for (const record of records.slice(1)) {
      assert.strictEqual(record.state, VERIFICATION_STATES.UNVERIFIABLE);
      assert.strictEqual(record.reason, REASONS.PROVIDER_THROTTLED);
      assert.strictEqual(record.retryAfterMs, 60_000);
      assert.strictEqual(record.deduplicated, false, 'not a duplicate: a different credential, deliberately not asked');
    }
  }

  /* Throttling one provider does not stop another. */
  {
    const github = candidateFor('github-token', SECRET, 'a'.repeat(64));
    const slack = candidateFor('slack-token', SLACK_SECRET, 'b'.repeat(64));
    const transport = fixtureTransport(
      { statusCode: 429, body: '{}', headers: { 'retry-after': '60' } },
      { statusCode: 200, body: '{"ok":true,"user_id":"U01","team_id":"T01"}' }
    );
    const records = await verifyCandidates({
      requests: [
        { candidate: github, authorization: authorizationFor(github) },
        { candidate: slack, authorization: authorizationFor(slack) }
      ],
      authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(transport.calls.length, 2);
    assert.strictEqual(records[1].state, VERIFICATION_STATES.VERIFIED);
  }

  /* A run is finite. */
  {
    const requests = [];
    for (let index = 0; index <= MAX_PROBES_PER_RUN + 4; index += 1) {
      const candidate = candidateFor('github-token', `${SECRET}${index}`, index.toString(16).padStart(64, '0'));
      requests.push({ candidate, authorization: authorizationFor(candidate) });
    }
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const records = await verifyCandidates({ requests, authorizationKey, subjectKey, transport, now: NOW });
    assert.strictEqual(transport.calls.length, MAX_PROBES_PER_RUN, 'a run has a ceiling on probes');
    assert.strictEqual(records.length, requests.length, 'and still accounts for every request');
    assert.strictEqual(records.at(-1).reason, REASONS.RUN_LIMIT_REACHED);
    assert.strictEqual(records.at(-1).state, VERIFICATION_STATES.UNVERIFIABLE);
  }

  /*
   * The subject digest is keyed, and the test has to say why rather than just
   * matching a hex shape: a provider user id is a short integer, so an unkeyed
   * digest of one is the id with extra steps -- anybody holding the record can
   * enumerate it. Two keys over the same subject must therefore disagree, and
   * no key at all must produce no digest rather than a keyless one.
   */
  {
    const candidate = candidateFor('github-token', SECRET);
    const answer = { statusCode: 200, body: '{"login":"alice","id":4242}' };
    const digestUnder = async key => (await verifyCredential({
      candidate,
      authorization: authorizationFor(candidate),
      authorizationKey,
      subjectKey: key,
      transport: fixtureTransport(answer),
      now: NOW
    })).subjectDigest;

    const first = await digestUnder(subjectKey);
    const second = await digestUnder(deriveKey('z'.repeat(64), KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT));
    const repeated = await digestUnder(subjectKey);
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.strictEqual(repeated, first, 'the same subject under the same key compares equal between runs');
    assert.notStrictEqual(second, first, 'and a digest of a guessable id must depend on a key we hold');
    assert.strictEqual(
      await digestUnder(undefined), null,
      'without a key there is no digest: a keyless one would be the id itself'
    );
  }

  /*
   * A candidate names a rule and carries bytes. It never contributes an
   * origin, a path or a query string, because a URL that came out of a
   * repository is a URL an attacker chose -- and this is the one request in
   * the server that carries a credential.
   */
  {
    const candidate = {
      ...candidateFor('github-token', SECRET),
      url: 'https://attacker.example/collect',
      origin: 'https://attacker.example',
      probePath: '/collect',
      targetId: 'attacker.example'
    };
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });
    assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
    assert.strictEqual(transport.calls[0].url, 'https://api.github.com/user', 'the adapter decides where a probe goes');
    assert.strictEqual(record.targetId, 'api.github.com');
    assert.strictEqual(
      JSON.stringify(transport.calls[0]).includes('attacker.example'), false,
      'and nothing a candidate supplied reaches the request'
    );
  }

  /* ---- The record -------------------------------------------------------- */

  {
    const candidate = candidateFor('github-token', SECRET);
    const transport = fixtureTransport({ statusCode: 200, body: '{"login":"alice","id":1}' });
    const record = await verifyCredential({
      candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
    });

    assert(Object.isFrozen(record), 'an attempt is immutable once made');
    assert.deepStrictEqual(Object.keys(record).sort(), [
      'adapter', 'adapterVersion', 'authorizationId', 'candidateFingerprint', 'deduplicated',
      'freshnessDeadline', 'observedAt', 'reason', 'retryAfterMs', 'state', 'subjectDigest', 'targetId'
    ], 'the record shape is closed: a field added here has to be considered for leakage');

    /* Liveness is not severity. A verified credential and a critical finding
       are two different judgements and this record makes only one of them. */
    assert.strictEqual('severity' in record, false);

    assert.strictEqual(record.freshnessDeadline, new Date(NOW + 24 * 60 * 60 * 1000).toISOString());
    assert.strictEqual(verificationFreshness(record, NOW), 'fresh');
    assert.strictEqual(verificationFreshness(record, NOW + 25 * 60 * 60 * 1000), 'stale');

    /*
     * Going stale is not a verdict. A verified credential whose observation
     * has aged out is still a verified credential that was seen live; the only
     * honest change is that we no longer know, which is what re-verification
     * is for. A stale record that flipped to `rejected` would resolve a finding
     * by doing nothing.
     */
    assert.strictEqual(record.state, VERIFICATION_STATES.VERIFIED);
  }

  /* Reason codes are a closed vocabulary, and every one is reachable. */
  {
    assert(Object.isFrozen(REASONS));
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'credential-verification.js'), 'utf8');
    const declaration = source.match(/const REASONS = Object\.freeze\(\{[\s\S]*?\n\}\);/);
    assert(declaration, 'the reason vocabulary must be declared in one place');
    const used = source.replace(declaration[0], '');
    for (const key of Object.keys(REASONS)) {
      assert(
        used.includes(`REASONS.${key}`),
        `REASONS.${key} is declared and never used: a reason nothing can produce invites handling that never runs`
      );
    }
  }

  /* ---- The secret does not come back ------------------------------------- */

  /*
   * The whole point. Every string this module can hand back, throw or print is
   * searched for the synthetic credential -- records, errors, stacks, and
   * anything written to the console while a run is in flight.
   */
  {
    const written = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = methods.map(name => [name, console[name]]);
    for (const name of methods) console[name] = (...args) => written.push(args.map(String).join(' '));
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = chunk => { written.push(String(chunk)); return true; };
    process.stderr.write = chunk => { written.push(String(chunk)); return true; };

    const surfaces = [];
    try {
      const probes = [
        { secret: SECRET, rule: 'github-token', answer: { statusCode: 200, body: '{"login":"alice","id":1}' } },
        { secret: SECRET, rule: 'github-token', answer: { statusCode: 401, body: `{"message":"Bad credentials for ${SECRET}"}` } },
        { secret: SECRET, rule: 'github-token', answer: { statusCode: 500, body: SECRET } },
        { secret: SLACK_SECRET, rule: 'slack-token', answer: { statusCode: 200, body: `{"ok":false,"error":"invalid_auth","token":"${SLACK_SECRET}"}` } },
        { secret: GITLAB_SECRET, rule: 'gitlab-token', answer: { statusCode: 200, body: 'not json' } },
        {
          secret: SECRET,
          rule: 'github-token',
          answer: () => { throw new Error(`connect failed while sending ${SECRET}`); }
        }
      ];
      for (const probe of probes) {
        const candidate = candidateFor(probe.rule, probe.secret);
        const transport = fixtureTransport(probe.answer);
        try {
          const record = await verifyCredential({
            candidate, authorization: authorizationFor(candidate), authorizationKey, subjectKey, transport, now: NOW
          });
          surfaces.push(JSON.stringify(record), String(record.reason), Object.keys(record).join(','));
        } catch (error) {
          surfaces.push(String(error && error.message), String(error && error.stack), JSON.stringify(error));
        }
      }
    } finally {
      for (const [name, original] of originals) console[name] = original;
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }

    assert(surfaces.length > 0, 'the leak sweep must have something to search');
    for (const secret of [SECRET, SLACK_SECRET, GITLAB_SECRET, SECRET.slice(4, 24)]) {
      for (const surface of [...surfaces, ...written]) {
        assert.strictEqual(
          String(surface).includes(secret), false,
          `a credential reached an output surface: ${String(surface).slice(0, 120)}`
        );
      }
    }
    assert.deepStrictEqual(written, [], 'and this module writes nothing at all while probing');
  }

  /* ---- The authorization signature -------------------------------------- */

  /*
   * Length-prefixed parts, so no rearrangement of one authorization's fields
   * can produce another's message -- an owner named `Demo` in a repository
   * named `Acme` must not sign the same bytes as the reverse.
   */
  {
    const candidate = candidateFor('github-token', SECRET);
    const swapped = authorizationFor(candidate, { scope: { ...scope, owner: 'Demo', repo: 'Acme' } });
    const straight = authorizationFor(candidate);
    assert.notStrictEqual(swapped.signature, straight.signature);

    /* And the signature is compared without leaking its shape. */
    const record = await verifyCredential({
      candidate,
      authorization: { ...straight, signature: `${straight.signature.slice(0, -1)}0` },
      authorizationKey,
      subjectKey,
      transport: fixtureTransport({ statusCode: 200, body: '{"login":"a","id":1}' }),
      now: NOW
    });
    assert.strictEqual(record.reason, REASONS.AUTHORIZATION_INVALID);

    /* A signature of the wrong length is refused rather than compared. */
    for (const signature of ['', 'abc', 'z'.repeat(64), crypto.randomBytes(16).toString('hex')]) {
      const bad = await verifyCredential({
        candidate,
        authorization: { ...straight, signature },
        authorizationKey,
        subjectKey,
        transport: fixtureTransport({ statusCode: 200, body: '{"login":"a","id":1}' }),
        now: NOW
      });
      assert.strictEqual(bad.reason, REASONS.AUTHORIZATION_INVALID, JSON.stringify(signature));
    }
  }

  console.log('credential verification tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
