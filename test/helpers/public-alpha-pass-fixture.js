'use strict';

const crypto = require('crypto');
const registry = require('../../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../../src/public-alpha-qualification');

const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const COMPLETED_AT = '2026-07-29T19:00:00.000Z';

/*
 * The probes a provider contributes beyond the shared mutation sequence, keyed
 * by provider so this fixture stays in step with the per-provider contract
 * rather than assuming every artifact carries the same list.
 */
const PROVIDER_PROBES = Object.freeze({
  github: [
    {
      key: 'tree-read',
      status: 'pass',
      statusClass: '2xx',
      entries: 3,
      proofPathPresent: true,
      blobIdentityMatched: true
    },
    { key: 'rate-read', status: 'pass', statusClass: '2xx', limitPositive: true, remainingWithinLimit: true },
    ...['pulls-read', 'issues-read', 'releases-read', 'workflows-read'].map(key => ({
      key,
      status: 'pass',
      statusClass: '2xx',
      listed: 1,
      detailAgreed: true,
      absentDiscriminated: true
    })),
    { key: 'blob-create', status: 'pass', statusClass: '2xx', gitObjectIdentityMatched: true, blobReadBack: true },
    {
      key: 'batch-commit',
      status: 'pass',
      statusClass: '2xx',
      paths: 2,
      parentIsObservedHead: true,
      pathsLanded: true,
      nonFastForwardRefused: true
    }
  ],
  gitlab: [
    {
      key: 'tree-read',
      status: 'pass',
      statusClass: '2xx',
      entries: 3,
      proofPathPresent: true,
      blobIdentityMatched: true
    },
    ...['pulls-read', 'issues-read'].map(key => ({
      key,
      status: 'pass',
      statusClass: '2xx',
      listed: 1,
      detailAgreed: true,
      absentDiscriminated: true
    }))
  ],
  gitea: []
});

function providerChecks(provider) {
  return [
    { key: 'repository-read', status: 'pass', statusClass: '2xx' },
    { key: 'default-branch-read', status: 'pass', statusClass: '2xx' },
    { key: 'disposable-branch-create', status: 'pass', statusClass: '2xx' },
    { key: 'expected-head-write', status: 'pass', statusClass: '2xx' },
    { key: 'utf8-readback', status: 'pass', statusClass: '2xx', bytes: 52, contentSha256: 'c'.repeat(64) },
    ...structuredClone(PROVIDER_PROBES[provider] || []),
    { key: 'conditional-update', status: 'pass', statusClass: '2xx', contentSha256: 'e'.repeat(64) },
    {
      key: 'stale-head',
      status: 'pass',
      zeroCommit: true,
      fileVerificationStatus: 'verified',
      fileVerificationReasonCode: null,
      fileVerificationDetail: 'content bytes and provider file identity match'
    },
    { key: 'permission-denial', status: 'pass', zeroCommit: true },
    { key: 'stale-head-delete', status: 'pass', zeroCommit: true, fileRetained: true },
    { key: 'expected-head-delete', status: 'pass', statusClass: '2xx', headAdvanced: true, fileAbsent: true },
    { key: 'cleanup-absence', status: 'pass', reasonCode: null }
  ];
}

function evidenceEntry(artifact) {
  return {
    status: 'pass',
    cleanupVerified: true,
    completedAt: COMPLETED_AT,
    artifact
  };
}

function claimsFor(labels) {
  return Object.fromEntries(labels.map(label => [label, {
    status: 'pass',
    cleanupVerified: true,
    completedAt: COMPLETED_AT
  }]));
}

function envelope(artifactType, originId, labels, context = {}) {
  return {
    schemaVersion: '1.1.0',
    artifactType,
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    originId,
    completedAt: COMPLETED_AT,
    cleanupVerified: true,
    ...context,
    claims: claimsFor(labels)
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hostedOperationalRecord() {
  return {
    schemaVersion: '1.0.0',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    completedAt: COMPLETED_AT,
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
    },
    signature: {
      algorithm: 'ed25519',
      keyId: 'fixture-operator',
      value: Buffer.alloc(64, 7).toString('base64')
    }
  };
}

function hostedRestoreRunnerRecord() {
  return {
    schemaVersion: '1.0.0',
    artifactType: 'hosted-restore-runner',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    originId: 'workflow-2048-restore',
    completedAt: COMPLETED_AT,
    cleanupVerified: true,
    check: {
      status: 'pass',
      latestMigration: '015_alpha_privacy',
      backupManifestSha256: '1'.repeat(64),
      backupCiphertextSha256: '2'.repeat(64),
      restoreTargetFingerprint: '3'.repeat(64),
      restoreAppDeployIdSha256: '8'.repeat(64),
      restoreEvidenceSha256: '4'.repeat(64),
      sourceIdentitySha256: '5'.repeat(64),
      targetIdentitySha256: '6'.repeat(64),
      sourceTargetDistinct: true,
      controlPlaneVerified: true,
      liveTargetVerified: true,
      smokePassed: true,
      backupRemoved: true
    },
    provenance: {
      issuer: 'github-actions',
      workflowOwnerProjectSha256: crypto.createHash('sha256')
        .update('fixture-owner/fixture-repository', 'utf8')
        .digest('hex'),
      workflow: '.github/workflows/public-alpha-alpha17.yml',
      runId: '2048'
    },
    signature: {
      algorithm: 'hmac-sha256',
      keyId: 'github-actions-2048',
      value: '7'.repeat(64)
    }
  };
}

function createPassFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const catalog = qualificationCatalog(registry);
  const automatedLabels = catalog.automated.map(key => `automated.${key}`);
  const hostedLabels = catalog.hosted.map(key => `hosted.${key}`);
  const manualLabels = catalog.manual.map(key => `manual.${key}`);
  const providers = {};
  const artifacts = [
    { id: 'automated-artifact', path: '/evidence/automated.json', sha256: '1'.repeat(64) },
    { id: 'hosted-artifact', path: '/evidence/hosted.json', sha256: '2'.repeat(64) },
    { id: 'manual-artifact', path: '/evidence/manual.json', sha256: '3'.repeat(64) }
  ];
  const operatorRecord = hostedOperationalRecord();
  const unsignedOperatorRecord = { ...operatorRecord };
  delete unsignedOperatorRecord.signature;
  operatorRecord.signature.value = crypto.sign(
    null,
    Buffer.from(stableJson(unsignedOperatorRecord), 'utf8'),
    privateKey
  ).toString('base64');
  const restoreRunnerRecord = hostedRestoreRunnerRecord();
  const restoreRecordSha256 = crypto.createHash('sha256')
    .update(stableJson(restoreRunnerRecord), 'utf8').digest('hex');
  /*
   * The operator witnesses which restore record belongs to this run. Note what
   * it does not say: nothing here claims the restore passed. That claim is the
   * runner's, and the operator's own record is still forbidden from carrying
   * it -- the witness only makes the runner's claim attributable.
   */
  const restoreWitness = {
    schemaVersion: '1.0.0',
    artifactType: 'hosted-restore-witness',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    originId: 'workflow-2048-hosted',
    restoreRecordSha256,
    completedAt: COMPLETED_AT,
    signature: { algorithm: 'ed25519', keyId: 'fixture-operator', value: '' }
  };
  const unsignedWitness = { ...restoreWitness };
  delete unsignedWitness.signature;
  restoreWitness.signature.value = crypto.sign(
    null,
    Buffer.from(stableJson(unsignedWitness), 'utf8'),
    privateKey
  ).toString('base64');
  const envelopes = {
    'automated-artifact': envelope('automated', 'workflow-2048-automated', automatedLabels),
    'hosted-artifact': envelope('hosted-live', 'workflow-2048-hosted', hostedLabels, {
      authorizedTargetSha256: '4'.repeat(64),
      deploymentSha256: '5'.repeat(64),
      operatorAttestation: {
        schemaVersion: '1.0.0',
        keyId: 'fixture-operator',
        completedAt: COMPLETED_AT,
        recordSha256: crypto.createHash('sha256').update(stableJson(operatorRecord), 'utf8').digest('hex'),
        record: operatorRecord
      },
      restoreRunnerAttestation: {
        schemaVersion: '1.0.0',
        completedAt: COMPLETED_AT,
        recordSha256: restoreRecordSha256,
        record: restoreRunnerRecord
      },
      checks: {
        'isolated-database-restore': restoreRunnerRecord.check
      }
    }),
    'manual-artifact': envelope('manual', 'manual-audit-2048', manualLabels)
  };

  const targetHashCharacters = ['9', 'a', 'b'];
  const expectedAuthorizedTargets = { hosted: '4'.repeat(64) };
  for (const [index, [provider, features]] of Object.entries(catalog.providers).entries()) {
    const artifactId = `${provider}-artifact`;
    const labels = features.map(feature => `providers.${provider}.${feature}`);
    artifacts.push({
      id: artifactId,
      path: `/evidence/${provider}.json`,
      sha256: String(index + 6).repeat(64)
    });
    envelopes[artifactId] = envelope('provider-live', `workflow-2048-${provider}`, labels, {
      provider,
      status: 'pass',
      authorizedTargetSha256: targetHashCharacters[index].repeat(64),
      targetHash: String(index + 6).repeat(64),
      capabilities: features,
      checks: providerChecks(provider),
      startedAt: '2026-07-29T18:55:00.000Z',
      nodeVersion: '22.23.1'
    });
    expectedAuthorizedTargets[provider] = envelopes[artifactId].authorizedTargetSha256;
    providers[provider] = Object.fromEntries(
      features.map(feature => [feature, evidenceEntry(artifactId)])
    );
  }

  const record = {
    schemaVersion: '1.1.0',
    product: 'Nebulaverse-X',
    version: '5.3.0-alpha.17.0',
    subjectSha256: SUBJECT,
    sourceCommit: SOURCE,
    nodeVersion: '22.23.1',
    latestMigration: '015_alpha_privacy',
    generatedAt: COMPLETED_AT,
    automated: Object.fromEntries(
      catalog.automated.map(key => [key, evidenceEntry('automated-artifact')])
    ),
    providers,
    hosted: Object.fromEntries(
      catalog.hosted.map(key => [key, evidenceEntry('hosted-artifact')])
    ),
    manual: Object.fromEntries(
      catalog.manual.map(key => [key, evidenceEntry('manual-artifact')])
    ),
    security: { criticalUnresolved: 0, highUnresolved: 0 },
    goldenPathCapabilities: [
      'github:repository.read',
      'github:file.write',
      'gitlab:file.write',
      'gitea:file.write'
    ],
    observedEnabledCapabilities: [],
    knownLimitations: ['Render Free wake delay.'],
    artifacts
  };
  return {
    record,
    envelopes,
    bindings: {
      expectedAuthorizedTargets,
      expectedDeploymentSha256: '5'.repeat(64),
      trustedOperatorKeys: {
        'fixture-operator': publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
      },
      restoreWitness
    }
  };
}

module.exports = Object.freeze({
  SUBJECT,
  SOURCE,
  COMPLETED_AT,
  createPassFixture
});
