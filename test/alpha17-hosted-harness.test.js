'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const {
  runHostedValidation,
  validateOperationalRecord,
  validateRunnerRestoreAttestation
} = require('../ci/run-hosted-alpha17-validation');
const { signRunnerRestoreAttestation } = require('../ci/alpha17-restore-attestation');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');

const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const NOW = '2026-07-29T20:00:00.000Z';
const RESTORE_ATTESTATION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const WORKFLOW_REPOSITORY = 'fixture-owner/fixture-repository';
const WORKFLOW_PATH = '.github/workflows/public-alpha-alpha17.yml';
const RESTORE_APP_BASE_URL = 'https://restore-alpha17.example.test';
const RESTORE_APP_DEPLOY_ID = 'deploy-restore-2048';

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
    cohortNeonBranchId: target.cohortNeonBranchId,
    jobName: 'hosted',
    neonProjectId: target.neonProjectId,
    renderServiceId: target.renderServiceId,
    restoreAppBaseUrl: target.restoreAppBaseUrl,
    restoreAppDeployId: target.restoreAppDeployId,
    restoreNeonBranchId: target.restoreNeonBranchId,
    restoreNeonProjectId: target.restoreNeonProjectId,
    restoreTargetFingerprint: target.restoreTargetFingerprint,
    restoreTargetKind: target.restoreTargetKind
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
      'disposable-tester-purge': { status: 'pass', tokenBearingStateRemoved: true }
    }
  };
  const signature = crypto.sign(null, Buffer.from(stableJson(record), 'utf8'), privateKey).toString('base64');
  return { ...record, signature: { algorithm: 'ed25519', keyId: 'fixture-operator', value: signature } };
}

function runnerRestoreAttestation() {
  return signRunnerRestoreAttestation({
    schemaVersion: '1.0.0',
    artifactType: 'hosted-restore-runner',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    originId: 'workflow-run-2048-restore',
    completedAt: NOW,
    cleanupVerified: true,
    check: {
      status: 'pass',
      latestMigration: '015_alpha_privacy',
      backupManifestSha256: '1'.repeat(64),
      backupCiphertextSha256: '2'.repeat(64),
      restoreTargetFingerprint: '3'.repeat(64),
      restoreAppDeployIdSha256: crypto.createHash('sha256')
        .update(RESTORE_APP_DEPLOY_ID, 'utf8')
        .digest('hex'),
      restoreEvidenceSha256: '4'.repeat(64),
      sourceIdentitySha256: '5'.repeat(64),
      targetIdentitySha256: '6'.repeat(64),
      sourceTargetDistinct: true,
      controlPlaneVerified: true,
      liveTargetVerified: true,
      smokePassed: true,
      backupRemoved: true
    }
  }, {
    workflowRepository: WORKFLOW_REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    workflowRunId: 'run-2048',
    attestationKeyBase64: RESTORE_ATTESTATION_KEY_BASE64
  });
}

function startFixtureServer(initialReleaseTreeSha256) {
  let mutationPresent = false;
  let requestCount = 0;
  let releaseTreeSha256 = initialReleaseTreeSha256;
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
      const body = JSON.stringify(url.pathname === '/api/version'
        ? { version: '5.3.0-alpha.17.0', product: 'Nebulaverse-X', releaseTreeSha256 }
        : { ok: true, memoryMb: 128, mutationPresent });
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
      requestCount: () => requestCount,
      setReleaseTreeSha256: value => { releaseTreeSha256 = value; }
    }));
  });
}

(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const operationalRecord = signedOperationalRecord(privateKey);
  const restoreAttestation = runnerRestoreAttestation();
  const expectedDeploymentSha256 = computeReleaseFingerprint(path.resolve(__dirname, '..'));
  const fixture = await startFixtureServer(expectedDeploymentSha256);
  try {
    const env = {
      NV_PUBLIC_ALPHA_SUBJECT_SHA256: SUBJECT,
      NV_PUBLIC_ALPHA_SOURCE_COMMIT: SOURCE,
      NV_ALPHA17_WORKFLOW_RUN_ID: 'run-2048',
      NV_ALPHA17_WORKFLOW_REPOSITORY: WORKFLOW_REPOSITORY,
      NV_ALPHA17_WORKFLOW_PATH: WORKFLOW_PATH,
      NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64: RESTORE_ATTESTATION_KEY_BASE64,
      NV_ALPHA17_RESTORE_APP_BASE_URL: RESTORE_APP_BASE_URL,
      NV_ALPHA17_RESTORE_APP_DEPLOY_ID: RESTORE_APP_DEPLOY_ID,
      NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64: publicKeyBase64,
      NV_ALPHA17_OPERATOR_KEY_ID: 'fixture-operator',
      NV_RESTORE_TARGET_FINGERPRINT: restoreAttestation.check.restoreTargetFingerprint,
      NV_ALPHA_BASE_URL: fixture.baseUrl,
      NV_ALPHA17_RENDER_SERVICE_ID: 'fixture-owner/nvx-alpha17-render',
      NV_ALPHA17_NEON_PROJECT_ID: 'fixture-owner/nvx-alpha17-neon',
      NV_ALPHA17_COHORT_NEON_BRANCH_ID: 'br-cohort-111111',
      NV_ALPHA17_RESTORE_NEON_PROJECT_ID: 'fixture-owner/nvx-alpha17-neon',
      NV_ALPHA17_RESTORE_NEON_BRANCH_ID: 'br-restore-222222',
      NV_ALPHA17_RESTORE_TARGET_KIND: 'isolated-neon-branch',
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
      neonProjectId: env.NV_ALPHA17_NEON_PROJECT_ID,
      cohortNeonBranchId: env.NV_ALPHA17_COHORT_NEON_BRANCH_ID,
      restoreNeonProjectId: env.NV_ALPHA17_RESTORE_NEON_PROJECT_ID,
      restoreNeonBranchId: env.NV_ALPHA17_RESTORE_NEON_BRANCH_ID,
      restoreTargetKind: env.NV_ALPHA17_RESTORE_TARGET_KIND,
      restoreTargetFingerprint: env.NV_RESTORE_TARGET_FINGERPRINT,
      restoreAppBaseUrl: env.NV_ALPHA17_RESTORE_APP_BASE_URL,
      restoreAppDeployId: env.NV_ALPHA17_RESTORE_APP_DEPLOY_ID
    });
    const result = await runHostedValidation({
      env,
      operationalRecord,
      restoreAttestation,
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
    assert.strictEqual(result.authorizedTargetSha256, env.NV_ALPHA17_SIGNED_TARGET_SHA256);
    assert.strictEqual(result.deploymentSha256, expectedDeploymentSha256);
    assert.strictEqual(result.operatorAttestation.schemaVersion, '1.0.0');
    assert.strictEqual(result.operatorAttestation.keyId, 'fixture-operator');
    assert.strictEqual(result.operatorAttestation.completedAt, NOW);
    assert.strictEqual(
      result.operatorAttestation.recordSha256,
      crypto.createHash('sha256').update(stableJson(operationalRecord), 'utf8').digest('hex')
    );
    assert.deepStrictEqual(result.operatorAttestation.record, operationalRecord);
    assert.deepStrictEqual(result.restoreRunnerAttestation.record, restoreAttestation);
    assert.strictEqual(
      Object.hasOwn(result.operatorAttestation.record.checks, 'isolated-database-restore'),
      false,
      'operator-authored evidence must not claim workflow-executed restore proof'
    );
    const { artifactSha256, ...artifactCore } = result;
    assert.strictEqual(
      artifactSha256,
      crypto.createHash('sha256').update(stableJson(artifactCore), 'utf8').digest('hex'),
      'the hosted artifact hash must cover the exact sanitized core'
    );
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

    const requestCountBeforeMissingRestore = fixture.requestCount();
    await assert.rejects(
      () => runHostedValidation({ env, operationalRecord, now: () => new Date(NOW) }),
      error => error && error.code === 'ALPHA17_RESTORE_ATTESTATION_MISSING'
    );
    assert.strictEqual(
      fixture.requestCount(),
      requestCountBeforeMissingRestore,
      'missing runner restore proof must fail before hosted traffic'
    );

    const wrongOperatorKeyId = { ...env, NV_ALPHA17_OPERATOR_KEY_ID: 'different-operator' };
    const requestCountBeforeWrongOperator = fixture.requestCount();
    await assert.rejects(
      () => runHostedValidation({
        env: wrongOperatorKeyId,
        operationalRecord,
        restoreAttestation,
        now: () => new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID'
    );
    assert.strictEqual(
      fixture.requestCount(),
      requestCountBeforeWrongOperator,
      'an untrusted operator key ID must fail before hosted traffic'
    );

    const wrongTarget = { ...env, NV_ALPHA17_SIGNED_TARGET_SHA256: 'f'.repeat(64) };
    const requestCountBeforeMismatch = fixture.requestCount();
    await assert.rejects(
      () => runHostedValidation({ env: wrongTarget, operationalRecord, restoreAttestation, now: () => new Date(NOW) }),
      error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
    );
    assert.strictEqual(fixture.requestCount(), requestCountBeforeMismatch, 'hosted target mismatch must fail before network access');

    fixture.setReleaseTreeSha256('e'.repeat(64));
    const requestCountBeforeDeploymentMismatch = fixture.requestCount();
    await assert.rejects(
      () => runHostedValidation({ env, operationalRecord, restoreAttestation, now: () => new Date(NOW) }),
      error => error && error.code === 'ALPHA17_HOSTED_DEPLOYMENT_MISMATCH'
    );
    assert.strictEqual(
      fixture.requestCount(),
      requestCountBeforeDeploymentMismatch + 1,
      'deployment mismatch must stop after the single identity request'
    );
    assert.strictEqual(fixture.mutationPresent(), false, 'deployment mismatch must not execute a mutation');

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

    const unboundRestore = structuredClone(restoreAttestation);
    unboundRestore.check.liveTargetVerified = false;
    assert.throws(
      () => validateRunnerRestoreAttestation(unboundRestore, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        expectedOriginId: restoreAttestation.originId,
        expectedRestoreTargetFingerprint: restoreAttestation.check.restoreTargetFingerprint,
        expectedRestoreAppDeployIdSha256: restoreAttestation.check.restoreAppDeployIdSha256,
        workflowRepository: WORKFLOW_REPOSITORY,
        workflowPath: WORKFLOW_PATH,
        workflowRunId: 'run-2048',
        attestationKeyBase64: RESTORE_ATTESTATION_KEY_BASE64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_RESTORE_ATTESTATION_INVALID'
    );

    const extendedCheck = structuredClone(operationalRecord);
    extendedCheck.checks['memory-restart-observation'].observedAt = NOW;
    assert.throws(
      () => validateOperationalRecord(extendedCheck, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        publicKeyBase64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_OPERATIONAL_CHECK_FAILED'
    );

    const ambiguousRestore = structuredClone(restoreAttestation);
    ambiguousRestore.check.targetIdentitySha256 = ambiguousRestore.check.sourceIdentitySha256;
    assert.throws(
      () => validateRunnerRestoreAttestation(ambiguousRestore, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        expectedOriginId: restoreAttestation.originId,
        expectedRestoreTargetFingerprint: restoreAttestation.check.restoreTargetFingerprint,
        expectedRestoreAppDeployIdSha256: restoreAttestation.check.restoreAppDeployIdSha256,
        workflowRepository: WORKFLOW_REPOSITORY,
        workflowPath: WORKFLOW_PATH,
        workflowRunId: 'run-2048',
        attestationKeyBase64: RESTORE_ATTESTATION_KEY_BASE64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_RESTORE_ATTESTATION_INVALID'
    );

    const tamperedProvenance = structuredClone(restoreAttestation);
    tamperedProvenance.provenance.workflowOwnerProjectSha256 = '8'.repeat(64);
    assert.throws(
      () => validateRunnerRestoreAttestation(tamperedProvenance, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        expectedOriginId: restoreAttestation.originId,
        expectedRestoreTargetFingerprint: restoreAttestation.check.restoreTargetFingerprint,
        expectedRestoreAppDeployIdSha256: restoreAttestation.check.restoreAppDeployIdSha256,
        workflowRepository: WORKFLOW_REPOSITORY,
        workflowPath: WORKFLOW_PATH,
        workflowRunId: 'run-2048',
        attestationKeyBase64: RESTORE_ATTESTATION_KEY_BASE64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_RESTORE_ATTESTATION_INVALID'
    );

    const tamperedSignature = structuredClone(restoreAttestation);
    tamperedSignature.check.backupManifestSha256 = '9'.repeat(64);
    assert.throws(
      () => validateRunnerRestoreAttestation(tamperedSignature, {
        expectedSubjectHash: SUBJECT,
        expectedSourceCommit: SOURCE,
        expectedOriginId: restoreAttestation.originId,
        expectedRestoreTargetFingerprint: restoreAttestation.check.restoreTargetFingerprint,
        expectedRestoreAppDeployIdSha256: restoreAttestation.check.restoreAppDeployIdSha256,
        workflowRepository: WORKFLOW_REPOSITORY,
        workflowPath: WORKFLOW_PATH,
        workflowRunId: 'run-2048',
        attestationKeyBase64: RESTORE_ATTESTATION_KEY_BASE64,
        now: new Date(NOW)
      }),
      error => error && error.code === 'ALPHA17_RESTORE_ATTESTATION_INVALID'
    );
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
  }
  console.log('alpha17 hosted harness tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
