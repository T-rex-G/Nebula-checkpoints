'use strict';

const assert = require('assert');
const {
  parseArgs,
  publicInviteView,
  main
} = require('../scripts/alpha-invites');

const DATABASE_URL = 'postgresql://alpha:password@db.example.test/alpha?sslmode=verify-full';
const PEPPER = '0123456789abcdef0123456789abcdef';
const TERMS_VERSION = '2026-07-29';
const TESTER_ID = '123e4567-e89b-42d3-a456-426614174000';
const CODE = 'nvx_alpha_0123456789abcdef0123456789.abcdefghijklmnopqrstuvwxyzABCDEFG';
const WARNING =
  'This plaintext invitation is shown once. Store and transmit it securely.';

function validEnv(overrides = {}) {
  return {
    DATABASE_URL,
    NV_ALPHA_INVITE_PEPPER: PEPPER,
    NV_ALPHA_TERMS_VERSION: TERMS_VERSION,
    ...overrides
  };
}

function createDependencies(options = {}) {
  const events = [];
  const poolInstances = [];
  const listRows = options.listRows || [{
    invite_id: 'invite-public-01',
    tester_id: TESTER_ID,
    tester_label: 'Tester 01',
    repository_scopes: ['github:github.com/acme/demo'],
    terms_version: TERMS_VERSION,
    created_at: new Date('2026-07-29T00:00:00.000Z'),
    expires_at: new Date('2026-08-05T00:00:00.000Z'),
    redeemed_at: null,
    revoked_at: null,
    tester_revoked_at: null,
    secret_digest: 'must-never-be-output',
    session_id: 'must-never-be-output',
    ip_hash: 'must-never-be-output'
  }];

  class FakePool {
    constructor(config) {
      events.push(['pool', config]);
      this.config = config;
      this.releaseCount = 0;
      this.endCount = 0;
      this.queries = [];
      poolInstances.push(this);
    }

    async connect() {
      events.push(['connect']);
      if (options.connectError) throw options.connectError;
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          this.releaseCount += 1;
          events.push(['release']);
        }
      };
    }

    async query(sql, params) {
      events.push(['list-query']);
      this.queries.push({ sql: String(sql), params: [...(params || [])] });
      if (options.listError) throw options.listError;
      return { rows: listRows, rowCount: listRows.length };
    }

    async end() {
      this.endCount += 1;
      events.push(['end']);
      if (options.endError) throw options.endError;
    }
  }

  class FakeStore {
    constructor(storeOptions) {
      events.push(['store', storeOptions]);
      this.options = storeOptions;
    }

    async issueInvite(input) {
      events.push(['issue', input]);
      if (options.issueError) throw options.issueError;
      if (options.issueCircularOutput) {
        const repositoryScopes = [];
        repositoryScopes.push(repositoryScopes);
        return {
          inviteId: '0123456789abcdef0123456789',
          code: CODE,
          expiresAt: '2026-08-05T00:00:00.000Z',
          repositoryScopes
        };
      }
      return {
        inviteId: '0123456789abcdef0123456789',
        code: CODE,
        expiresAt: '2026-08-05T00:00:00.000Z',
        repositoryScopes: input.repositoryScopes,
        secretDigest: 'must-never-be-output'
      };
    }

    async revokeInvite(inviteId) {
      events.push(['revoke-invite', inviteId]);
      if (options.revokeInviteError) throw options.revokeInviteError;
      return options.revokeInviteResult
        || { inviteId, state: 'revoked', revoked: true };
    }

    async revokeTester(testerId, reason) {
      events.push(['revoke', testerId, reason]);
      if (options.revokeError) throw options.revokeError;
      return { sessionsRevoked: 3, sessionId: 'must-never-be-output' };
    }

    async purgeExpired() {
      events.push(['purge']);
      if (options.purgeError) throw options.purgeError;
      return {
        invites: 2,
        sessions: 4,
        locks: 1,
        ipHash: 'must-never-be-output'
      };
    }
  }

  const dependencies = {
    normalizeDatabaseUrl(raw, config) {
      events.push(['normalize-config', raw, config]);
      if (options.normalizeError) throw options.normalizeError;
      return raw;
    },
    loadAlphaAccessConfig(env, config) {
      events.push(['load-config', env, config]);
      if (options.configError) throw options.configError;
      assert.strictEqual(env.NV_ALPHA_ACCESS_MODE, 'invite');
      assert.strictEqual(env.NV_ALPHA_INVITE_PEPPER, PEPPER);
      assert.strictEqual(env.NV_ALPHA_TERMS_VERSION, TERMS_VERSION);
      assert.deepStrictEqual(config, {
        production: false,
        databaseUrl: DATABASE_URL
      });
      return {
        mode: 'invite',
        enabled: true,
        pepper: PEPPER,
        termsVersion: TERMS_VERSION,
        inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
        sessionAbsoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
        sessionIdleTtlMs: 24 * 60 * 60 * 1000
      };
    },
    Pool: FakePool,
    async runMigrations(client, migrationOptions) {
      events.push(['migrate', client, migrationOptions]);
      if (options.migrationError) throw options.migrationError;
      assert.strictEqual(typeof client.query, 'function');
      assert.strictEqual(typeof migrationOptions.logger.info, 'function');
      return { applied: [], total: 14 };
    },
    AlphaAccessStore: FakeStore
  };

  return { dependencies, events, poolInstances };
}

async function runMain(argv, options = {}) {
  const stdout = [];
  const stderr = [];
  const exitCodes = [];
  const fixture = createDependencies(options);
  const status = await main({
    argv,
    env: validEnv(options.env),
    stdout: { write: value => stdout.push(String(value)) },
    stderr: { write: value => stderr.push(String(value)) },
    setExitCode: code => exitCodes.push(code),
    dependencies: fixture.dependencies
  });
  return {
    ...fixture,
    status,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCodes
  };
}

async function tests() {
  assert.deepStrictEqual(parseArgs([
    'issue',
    '--label',
    ' Tester 01 ',
    '--repo',
    'GITHUB:github.com/ACME/DEMO',
    '--repo',
    'gitea:gitea.example.com/acme/demo'
  ]), {
    command: 'issue',
    label: 'Tester 01',
    repos: [
      'github:github.com/acme/demo',
      'gitea:gitea.example.com/acme/demo'
    ]
  });
  assert.deepStrictEqual(parseArgs(['list']), { command: 'list' });
  assert.deepStrictEqual(parseArgs([
    'revoke',
    '--tester',
    TESTER_ID.toUpperCase(),
    '--reason',
    ' cohort access ended '
  ]), {
    command: 'revoke',
    tester: TESTER_ID,
    reason: 'cohort access ended'
  });
  assert.deepStrictEqual(parseArgs(['purge']), { command: 'purge' });
  assert.deepStrictEqual(
    parseArgs(['revoke-invite', '--invite', ' 0123456789ABCDEF0123456789 ']),
    { command: 'revoke-invite', invite: '0123456789abcdef0123456789' },
    'an invitation id is matched case-insensitively and trimmed'
  );

  for (const invalid of [
    [],
    ['unknown'],
    ['list', '--repo', 'github:github.com/acme/demo'],
    ['purge', '--force'],
    ['issue', '--label', 'Tester 01'],
    ['issue', '--repo', 'github:github.com/acme/demo'],
    ['issue', '--label'],
    ['issue', '--label', '--repo', 'github:github.com/acme/demo'],
    ['issue', '--label', 'Tester', '--label', 'Other', '--repo', 'github:github.com/acme/demo'],
    ['issue', '--label', 'Tester', '--repo', 'github:github.com/acme/demo', '--unknown', 'x'],
    ['issue', '--label', 'Tester', '--repo', 'github:github.com/acme/demo', '--repo'],
    ['issue', '--label', 'Tester', '--repo', 'github:github.com/acme/demo', '--repo', 'GITHUB:github.com/ACME/DEMO'],
    ['issue', '--label', 'Tester', '--repo', 'github:evil.example/acme/demo'],
    ['revoke', '--tester', TESTER_ID],
    ['revoke', '--reason', 'ended'],
    ['revoke', '--tester', 'not-a-uuid', '--reason', 'ended'],
    ['revoke', '--tester', TESTER_ID, '--tester', TESTER_ID, '--reason', 'ended'],
    ['revoke', '--tester', TESTER_ID, '--reason', 'ended', '--reason', 'again'],
    ['revoke', '--tester', TESTER_ID, '--reason'],
    ['revoke', '--tester', TESTER_ID, '--reason', '--other'],
    ['revoke-invite'],
    ['revoke-invite', '--invite'],
    ['revoke-invite', '--invite', 'too-short'],
    ['revoke-invite', '--invite', 'x'.repeat(41)],
    ['revoke-invite', '--invite', 'bad_character_0123456789'],
    ['revoke-invite', '--invite', '0123456789abcdef0123456789', '--invite', '0123456789abcdef0123456789'],
    ['revoke-invite', '--invite', '0123456789abcdef0123456789', '--reason', 'exposed'],
    /* The secret half must never be accepted, so it can never be logged. */
    ['revoke-invite', '--invite', CODE],
    ['revoke-invite', '--code', CODE]
  ]) {
    assert.throws(
      () => parseArgs(invalid),
      error => error instanceof TypeError && !JSON.stringify(error).includes(CODE),
      `invalid command shape must fail: ${JSON.stringify(invalid)}`
    );
  }

  const view = publicInviteView({
    inviteId: 'abc',
    code: 'nvx_alpha_abc.secret',
    expiresAt: '2026-08-05T00:00:00.000Z',
    repositoryScopes: ['github:github.com/acme/demo'],
    secretDigest: 'not-public',
    sessionId: 'not-public',
    ipHash: 'not-public'
  });
  assert.deepStrictEqual(view, {
    inviteId: 'abc',
    code: 'nvx_alpha_abc.secret',
    expiresAt: '2026-08-05T00:00:00.000Z',
    repositoryScopes: ['github:github.com/acme/demo'],
    warning: WARNING
  });
  assert(!JSON.stringify(view).includes('digest'));
  assert(!JSON.stringify(view).includes('session'));
  assert(!JSON.stringify(view).includes('ipHash'));

  const inputFailure = await runMain([
    'issue',
    '--label',
    'Tester 01'
  ]);
  assert.strictEqual(inputFailure.status, 2);
  assert.deepStrictEqual(inputFailure.exitCodes, [2]);
  assert.match(inputFailure.stderr, /^Input error:/);
  assert.strictEqual(inputFailure.stdout, '');
  assert.strictEqual(inputFailure.poolInstances.length, 0);
  assert.strictEqual(
    inputFailure.events.some(event => event[0] === 'load-config'),
    false,
    'invalid input must fail before environment or database setup'
  );

  const issue = await runMain([
    'issue',
    '--label',
    'Tester 01',
    '--repo',
    'GITHUB:github.com/ACME/DEMO'
  ]);
  assert.strictEqual(issue.status, 0);
  assert.deepStrictEqual(issue.exitCodes, []);
  assert.strictEqual(issue.stderr, '');
  const issueOutput = JSON.parse(issue.stdout);
  assert.deepStrictEqual(issueOutput, {
    inviteId: '0123456789abcdef0123456789',
    code: CODE,
    expiresAt: '2026-08-05T00:00:00.000Z',
    repositoryScopes: ['github:github.com/acme/demo'],
    warning: WARNING
  });
  assert.strictEqual(issue.stdout.split(CODE).length - 1, 1);
  assert(
    issue.events.findIndex(event => event[0] === 'migrate')
      < issue.events.findIndex(event => event[0] === 'issue'),
    'migrations must finish before invitation issuance'
  );
  assert(
    issue.events.findIndex(event => event[0] === 'load-config')
      < issue.events.findIndex(event => event[0] === 'pool'),
    'configuration must validate before the pool is initialized'
  );
  assert.deepStrictEqual(
    issue.events.find(event => event[0] === 'pool')[1],
    { connectionString: DATABASE_URL }
  );
  assert.strictEqual(issue.poolInstances[0].releaseCount, 1);
  assert.strictEqual(issue.poolInstances[0].endCount, 1);

  const listed = await runMain(['list']);
  assert.strictEqual(listed.status, 0);
  const listOutput = JSON.parse(listed.stdout);
  assert.deepStrictEqual(listOutput, {
    invitations: [{
      inviteId: 'invite-public-01',
      testerId: TESTER_ID,
      testerLabel: 'Tester 01',
      repositoryScopes: ['github:github.com/acme/demo'],
      termsVersion: TERMS_VERSION,
      createdAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-08-05T00:00:00.000Z',
      redeemedAt: null,
      revokedAt: null,
      testerRevokedAt: null
    }]
  });
  const serializedList = JSON.stringify(listOutput);
  for (const forbidden of [
    'must-never-be-output',
    'secret_digest',
    'session_id',
    'ip_hash',
    'code'
  ]) {
    assert(!serializedList.includes(forbidden), `list must omit ${forbidden}`);
  }
  const listQuery = listed.poolInstances[0].queries[0];
  assert(listQuery, 'list must execute one safe projection');
  assert.match(listQuery.sql, /LIMIT \$1/);
  assert.deepStrictEqual(listQuery.params, [100]);
  for (const forbiddenColumn of ['secret_digest', 'session_id', 'ip_hash']) {
    assert(
      !listQuery.sql.includes(forbiddenColumn),
      `list query must not select ${forbiddenColumn}`
    );
  }
  assert(
    listed.events.findIndex(event => event[0] === 'migrate')
      < listed.events.findIndex(event => event[0] === 'list-query'),
    'schema migrations must finish before invitation reads'
  );
  assert.strictEqual(listed.poolInstances[0].releaseCount, 1);
  assert.strictEqual(listed.poolInstances[0].endCount, 1);

  const revoked = await runMain([
    'revoke',
    '--tester',
    TESTER_ID,
    '--reason',
    'cohort access ended'
  ]);
  assert.strictEqual(revoked.status, 0);
  assert.deepStrictEqual(JSON.parse(revoked.stdout), {
    testerId: TESTER_ID,
    sessionsRevoked: 3
  });
  assert(!revoked.stdout.includes('cohort access ended'));
  assert(
    revoked.events.findIndex(event => event[0] === 'migrate')
      < revoked.events.findIndex(event => event[0] === 'revoke'),
    'migrations must finish before revocation'
  );
  assert.strictEqual(revoked.poolInstances[0].endCount, 1);

  const purged = await runMain(['purge']);
  assert.strictEqual(purged.status, 0);
  assert.deepStrictEqual(JSON.parse(purged.stdout), {
    purged: {
      invites: 2,
      sessions: 4,
      locks: 1
    }
  });
  assert(
    purged.events.findIndex(event => event[0] === 'migrate')
      < purged.events.findIndex(event => event[0] === 'purge'),
    'migrations must finish before purge'
  );
  assert(!purged.stdout.includes('must-never-be-output'));

  const runtimeSecret =
    'nvx_alpha_0123456789abcdef0123456789.runtimeFailureSecretShouldStayHidden';
  const failed = await runMain([
    'issue',
    '--label',
    'Tester 01',
    '--repo',
    'github:github.com/acme/demo'
  ], {
    issueError: new Error(`database rejected ${runtimeSecret}`)
  });
  assert.strictEqual(failed.status, 1);
  assert.deepStrictEqual(failed.exitCodes, [1]);
  assert.strictEqual(failed.stdout, '');
  assert.strictEqual(
    failed.stderr,
    'Alpha invitation operation could not be completed.\n'
  );
  assert(!failed.stderr.includes(runtimeSecret));
  assert.strictEqual(failed.poolInstances[0].releaseCount, 1);
  assert.strictEqual(failed.poolInstances[0].endCount, 1);

  const migrationFailed = await runMain([
    'issue',
    '--label',
    'Tester 01',
    '--repo',
    'github:github.com/acme/demo'
  ], {
    migrationError: new Error(`migration failed ${runtimeSecret}`)
  });
  assert.strictEqual(migrationFailed.status, 1);
  assert.strictEqual(migrationFailed.stdout, '');
  assert.strictEqual(
    migrationFailed.stderr,
    'Alpha invitation operation could not be completed.\n'
  );
  assert(!migrationFailed.stderr.includes(runtimeSecret));
  assert.strictEqual(migrationFailed.poolInstances[0].releaseCount, 1);
  assert.strictEqual(migrationFailed.poolInstances[0].endCount, 1);

  const serializationFailed = await runMain([
    'issue',
    '--label',
    'Tester 01',
    '--repo',
    'github:github.com/acme/demo'
  ], {
    issueCircularOutput: true
  });
  assert.strictEqual(serializationFailed.status, 1);
  assert.strictEqual(serializationFailed.stdout, '');
  assert.strictEqual(
    serializationFailed.stderr,
    'Alpha invitation operation could not be completed.\n'
  );
  assert(!serializationFailed.stderr.includes(CODE));
  assert.strictEqual(serializationFailed.poolInstances[0].releaseCount, 1);
  assert.strictEqual(serializationFailed.poolInstances[0].endCount, 1);

  const cleanupFailed = await runMain([
    'issue',
    '--label',
    'Tester 01',
    '--repo',
    'github:github.com/acme/demo'
  ], {
    endError: new Error(`pool cleanup failed ${runtimeSecret}`)
  });
  assert.strictEqual(cleanupFailed.status, 1);
  assert.deepStrictEqual(cleanupFailed.exitCodes, [1]);
  assert.strictEqual(
    cleanupFailed.stderr,
    'Alpha invitation operation could not be completed.\n'
  );
  assert.strictEqual(
    cleanupFailed.stdout,
    '',
    'invite output must remain withheld when required cleanup fails'
  );
  assert(!cleanupFailed.stderr.includes(runtimeSecret));
  assert(!cleanupFailed.stderr.includes(CODE));
  assert.strictEqual(cleanupFailed.poolInstances[0].releaseCount, 1);
  assert.strictEqual(cleanupFailed.poolInstances[0].endCount, 1);

  const connectFailed = await runMain(['list'], {
    connectError: new Error(`connection failed ${runtimeSecret}`)
  });
  assert.strictEqual(connectFailed.status, 1);
  assert.strictEqual(
    connectFailed.stderr,
    'Alpha invitation operation could not be completed.\n'
  );
  assert.strictEqual(connectFailed.poolInstances[0].releaseCount, 0);
  assert.strictEqual(connectFailed.poolInstances[0].endCount, 1);

  const configFailed = await runMain(['list'], {
    configError: new Error(`bad configuration ${runtimeSecret}`)
  });
  assert.strictEqual(configFailed.status, 1);
  assert(!configFailed.stderr.includes(runtimeSecret));
  assert.strictEqual(configFailed.poolInstances.length, 0);

  /*
 * An exposed invitation nobody redeemed has no tester behind it, so `revoke`
 * cannot reach it. The command takes the invitation id -- the public half,
 * which `list` prints and which is legible inside an exposed code -- so the
 * secret never reaches a shell history, a process list, or this output.
 */
const inviteRevocation = await runMain(['revoke-invite', '--invite', '0123456789abcdef0123456789']);
assert.strictEqual(inviteRevocation.status, 0);
assert.deepStrictEqual(
  inviteRevocation.events.filter(event => event[0] === 'revoke-invite'),
  [['revoke-invite', '0123456789abcdef0123456789']]
);
assert.deepStrictEqual(JSON.parse(inviteRevocation.stdout), {
  inviteId: '0123456789abcdef0123456789',
  state: 'revoked',
  revoked: true
});
assert(!inviteRevocation.stdout.includes(CODE),
  'the invitation secret must never appear in output');

/*
 * A redeemed invitation belongs to a tester, and revoking the code would not
 * end the session it produced. The command must report that rather than let an
 * operator stop at a revocation that leaves the tester active.
 */
const redeemedRevocation = await runMain(
  ['revoke-invite', '--invite', '0123456789abcdef0123456789'],
  { revokeInviteResult: { inviteId: '0123456789abcdef0123456789', state: 'redeemed', revoked: false } }
);
assert.strictEqual(redeemedRevocation.status, 1,
  'a refusal must not exit zero, or a containment block would continue past it');
assert.deepStrictEqual(redeemedRevocation.exitCodes, [1]);
assert.deepStrictEqual(JSON.parse(redeemedRevocation.stdout), {
  inviteId: '0123456789abcdef0123456789', state: 'redeemed', revoked: false
}, 'the state must still be printed so the operator knows which path to take');
assert.match(redeemedRevocation.stderr, /Invitation was not revoked: redeemed/);

/* Every non-revoking state must refuse, not just the redeemed one. */
for (const state of ['already-revoked', 'unknown', 'purged']) {
  const refusal = await runMain(
    ['revoke-invite', '--invite', '0123456789abcdef0123456789'],
    { revokeInviteResult: { inviteId: '0123456789abcdef0123456789', state, revoked: false } }
  );
  assert.strictEqual(refusal.status, 1, `state ${state} must exit non-zero`);
}

console.log('alpha invite CLI tests passed');
}

tests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
