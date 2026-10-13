'use strict';
const assert = require('assert');
const {
  alphaRetentionPolicy, alphaActorLabel, sanitizeFeedback,
  buildSupportBundle, providerRevocationGuidance
} = require('../src/alpha-privacy');

assert.deepStrictEqual(alphaRetentionPolicy(), {
  alphaSessionsDays: 7,
  verifiedEventsDays: 30,
  operationalLogsDays: 14,
  snapshotsDays: 30,
  evidenceExportsDays: 30,
  inviteMetadataDaysAfterClose: 30
});
assert.strictEqual(
  alphaActorLabel({ testerId: '12345678-1234-4234-9234-123456789abc' }),
  'alpha:123456781234'
);

const feedback = sanitizeFeedback({
  feature: 'repository-health',
  description: 'The state stayed stale after refresh.',
  repositoryContent: 'private source',
  token: 'ghp_secret',
  providerPayload: { private: true }
}, {
  releaseVersion: '5.3.0-alpha.17.0',
  correlationId: 'nvx-1234567890abcdef',
  provider: 'github',
  capabilityStatus: 'Supported',
  errorCode: 'EVIDENCE_STALE',
  timestamp: '2026-07-29T18:00:00.000Z',
  runtime: 'Safari iOS'
});
assert.deepStrictEqual(Object.keys(feedback).sort(), [
  'capabilityStatus', 'correlationId', 'errorCode', 'feature', 'provider',
  'releaseVersion', 'runtime', 'timestamp'
].sort());
assert(!Object.hasOwn(feedback, 'description'));
assert(!JSON.stringify(feedback).includes('The state stayed stale after refresh.'));
assert(!JSON.stringify(feedback).includes('private source'));
assert(!JSON.stringify(feedback).includes('ghp_secret'));
assert(!JSON.stringify(feedback).includes('providerPayload'));

const bundle = buildSupportBundle({
  releaseVersion: '5.3.0-alpha.17.0',
  correlationId: 'nvx-1234567890abcdef',
  provider: 'github',
  feature: 'repository-health',
  capabilityStatus: 'Supported',
  errorCode: 'EVIDENCE_STALE',
  timestamp: '2026-07-29T18:00:00.000Z',
  runtime: 'Safari iOS',
  description: 'Refresh did not recover.'
});
assert.deepStrictEqual(Object.keys(bundle).sort(), [
  'capabilityStatus', 'correlationId', 'errorCode', 'feature', 'provider',
  'releaseVersion', 'runtime', 'timestamp'
].sort());
assert(!Object.hasOwn(bundle, 'description'));
assert(!JSON.stringify(bundle).includes('Refresh did not recover.'));

assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'github', authMethod: 'token', baseUrl: ''
}), {
  label: 'Revoke the token on GitHub',
  url: 'https://github.com/settings/tokens',
  automatic: false
});
for (const provider of ['gitlab', 'gitea']) {
  assert.deepStrictEqual(providerRevocationGuidance({ provider, baseUrl: 'https://untrusted.example/anything' }), {
    label: 'Revoke this retired provider credential manually in its account settings',
    url: null,
    automatic: false
  });
  assert.strictEqual(providerRevocationGuidance({ provider, baseUrl: 'not a url' }).url, null);
}
assert.throws(() => providerRevocationGuidance({ provider: 'bitbucket' }), /provider is unsupported/);
console.log('alpha privacy model tests passed');
