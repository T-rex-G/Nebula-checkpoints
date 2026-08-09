'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const {
  runHostedValidation,
  validateOperationalRecord
} = require('../ci/run-hosted-alpha17-validation');

const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const NOW = '2026-07-29T20:00:00.000Z';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hostedTargetHash(target) {
  return crypto.createHash('sha256').update(JSON.stringify({
    baseUrl: target.baseUrl,
    jobName: 'hosted',
    neonProjectId: target.neonProjectId,
    renderServiceId: target.renderServiceId
  })).digest('hex');
}

function signedOperationalRecord(privateKey) {
  const record = {
    schemaVersion: '1.0.0',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    completedAt: NOW,
    cleanupVerified: true,
    checks: {
      'neon-scale-to-zero-wake': { status: 'pass', wakeRetries: 1 },
      'memory-restart-observation': { status: 'pass', restartObserved: true },
      'active-session-revocation': { status: 'pass', deniedAfterRevocation: true },
      'provider-disconnect': { status: 'pass', browserStatePurged: true },
      'ephemeral-filesystem-restart': { status: 'pass', stateRecoveredFromDatabase: true },
      'database-interruption-recovery': { status: 'pass', failClosedDuringInterruption: true },
      'provider-429-outage': { status: 'pass', retryBounded: true },
      'application-rollback': { status: 'pass', candidateRestored: true },
      'isolated-database-restore': { status: 'pass', latestMigration: '015_alpha_privacy' },
      'disposable-tester-purge': { status: 'pass', tokenBearingStateRemoved: true }
    }
  };
  const signature = crypto.sign(null, Buffer.from(stableJson(record), 'utf8'), privateKey).toString('base64');
  return { ...record, signature: { algorithm: 'ed25519', keyId: 'fixture-operator', value: signature } };
}

function startFixtureServer() {
  let mutationPresent = false;
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Correlation-Id', 'fixture-correlation');
    if (request.method === 'POST' && url.pathname === '/api/qualification-mutation') {
      mutationPresent = true;
      response.statusCode = 201;
      response.end('{"ok":true}');
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/qualification-mutation') {
      mutationPresent = false;
      response.statusCode = 204;
      response.end();
      return;
    }
    const supported = new Set([
      '/healthz',
      '/readyz',
      '/api/version',
      '/api/config',
      '/api/capabilities',
      '/api/alpha/status'
    ]);
    if (supported.has(url.pathname)) {
      response.statusCode = 200;
      const body = JSON.stringify({ ok: true, memoryMb: 128, mutationPresent });
      response.setHeader('Content-Length', String(Buffer.byteLength(body)));
      response.end(body);
      return;
    }
    response.statusCode = 404;
    response.end('{"ok":false}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      mutationPresent: () => mutationPresent,
      requestCount: () => requestCount
    }));
  });
}

(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const operationalRecord = signedOperationalRecord(privateKey);
  const fixture = await startFixtureServer();
  try {
    const env = {
      NV_PUBLIC_ALPHA_SUBJECT_SHA256: SUBJECT,
      NV_PUBLIC_ALPHA_SOURCE_COMMIT: SOURCE,
      NV_ALPHA17_WORKFLOW_RUN_ID: 'run-2048',
      NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64: publicKeyBase64,
      NV_ALPHA_BASE_URL: fixture.baseUrl,
      NV_ALPHA17_RENDER_SERVICE_ID: 'fixture-owner/nvx-alpha17-render',
      NV_ALPHA17_NEON_PROJECT_ID: 'fixture-owner/nvx-alpha17-neon',
      NV_ALPHA_SESSION_COOKIES: JSON.stringify([
        'session=fixture-1',
        'session=fixture-2',
        'session=fixture-3',
        'session=fixture-4',
        'session=fixture-5'
      ]),
      NV_ALPHA_TESTERS: '5',
      NV_ALPHA_READS_PER_TESTER: '10',
      NV_ALPHA_MUTATIONS: '1',
      NV_ALPHA_MUTATION_REQUEST: JSON.stringify({
        method: 'POST',
        path: '/api/qualification-mutation',
        expectedStatus: 201,
        body: { expectedHeadSha: '1'.repeat(40) }
      }),
      NV_ALPHA_CLEANUP_REQUEST: JSON.stringify({
        method: 'DELETE',
        path: '/api/qualification-mutation',
        expectedStatus: 204,
        body: { expectedHeadSha: '2'.repeat(40) }
      })
    };
    env.NV_ALPHA17_SIGNED_TARGET_SHA256 = hostedTargetHash({
      baseUrl: env.NV_ALPHA_BASE_URL,
      renderServiceId: env.NV_ALPHA17_RENDER_SERVICE_ID,
      neonProjectId: env.NV_ALPHA17_NEON_PROJECT_ID
    });
    const result = await runHostedValidation({
      env,
      operationalRecord,
      now: () => new Date(NOW)
    });
    assert.strictEqual(result.schemaVersion, '1.1.0');
    assert.strictEqual(result.artifactType, 'hosted-live');
    assert.strictEqual(result.originId, 'workflow-run-2048-hosted');
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.cleanupVerified, true);
    assert.strictEqual(result.checks['five-concurrent-read-testers'].workers, 5);
    assert.strictEqual(result.checks['single-bounded-mutation'].mutations, 1);
    assert.strictEqual(result.checks['ephemeral-filesystem-restart'].stateRecoveredFromDatabase, true);
    assert.strictEqual(result.checks['isolated-database-restore'].latestMigration, '015_alpha_privacy');
    assert.strictEqual(result.checks['disposable-tester-purge'].tokenBearingStateRemoved, true);
    assert.match(result.artifactSha256, /^[0-9a-f]{64}$/);
    assert.match(result.authorizedTargetSha256, /^[0-9a-f]{64}$/);
    assert.match(result.deploymentSha256, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(
      Object.keys(result.claims).sort(),
      Object.keys(result.checks).map(key => `hosted.${key}`).sort()
    );
    for (const claim of Object.values(result.claims)) {
      assert.deepStrictEqual(claim, {
        status: 'pass',
        cleanupVerified: true,
        completedAt: NOW
      });
    }
    assert.strictEqual(fixture.mutationPresent(), false);
    assert(!JSON.stringify(result).includes('DATABASE_URL'));
    assert(!JSON.stringify(result).includes('session=fixture'));

    const wrongTarget = { ...env, NV_ALPHA17_SIGNED_TARGET_SHA256: 'f'.repeat(64) };
    const requestCountBeforeMismatch = fixture.requestCount();
    await assert.rejects(
      () => runHostedValidation({ env: wrongTarget, operationalRecord, now: () => new Date(NOW) }),
      error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
    );
    assert.strictEqual(fixture.requestCount(), requestCountBeforeMismatch, 'hosted target mismatch must fail before network access');

    const wrongSubject = structuredClone(operationalRecord);
    wrongSubject.subjectSha256 = 'd'.repeat(64);
    assert.throws(
      () => validateOperationalRecord(wrongSubject, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        publicKeyBase64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_OPERATIONAL_SUBJECT_MISMATCH'
    );

    const secretField = structuredClone(operationalRecord);
    secretField.operatorToken = 'opaque-credential-material';
    assert.throws(
      () => validateOperationalRecord(secretField, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        publicKeyBase64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_OPERATIONAL_SECRET_MATERIAL'
    );
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
  }
  console.log('alpha17 hosted harness tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
