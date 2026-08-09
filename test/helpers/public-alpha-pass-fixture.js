'use strict';

const registry = require('../../config/public-alpha-capabilities.json');
const { qualificationCatalog } = require('../../src/public-alpha-qualification');

const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const COMPLETED_AT = '2026-07-29T19:00:00.000Z';

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

function createPassFixture() {
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
  const envelopes = {
    'automated-artifact': envelope('automated', 'workflow-2048-automated', automatedLabels),
    'hosted-artifact': envelope('hosted-live', 'workflow-2048-hosted', hostedLabels, {
      authorizedTargetSha256: '4'.repeat(64),
      deploymentSha256: '5'.repeat(64)
    }),
    'manual-artifact': envelope('manual', 'manual-audit-2048', manualLabels)
  };

  const targetHashCharacters = ['9', 'a', 'b'];
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
      authorizedTargetSha256: targetHashCharacters[index].repeat(64)
    });
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
  return { record, envelopes };
}

module.exports = Object.freeze({
  SUBJECT,
  SOURCE,
  COMPLETED_AT,
  createPassFixture
});
