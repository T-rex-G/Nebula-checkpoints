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
assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'gitlab', authMethod: 'token', baseUrl: 'https://gitlab.com'
}), {
  label: 'Revoke the token on GitLab',
  url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  automatic: false
});

assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'GitHub', authMethod: 'token', baseUrl: ''
}), {
  label: 'Revoke the token on GitHub',
  url: 'https://github.com/settings/tokens',
  automatic: false
});
assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'gitlab', authMethod: 'token', baseUrl: 'https://gitlab.example.com/gitlab/'
}), {
  label: 'Revoke the token on GitLab',
  url: 'https://gitlab.example.com/gitlab/-/user_settings/personal_access_tokens',
  automatic: false
});
assert.deepStrictEqual(providerRevocationGuidance({
  provider: 'gitea', authMethod: 'token', baseUrl: 'https://gitea.example.com/forge/'
}), {
  label: 'Revoke the token on Gitea',
  url: 'https://gitea.example.com/forge/user/settings/applications',
  automatic: false
});
assert.throws(
  () => providerRevocationGuidance({ provider: 'bitbucket', baseUrl: 'https://bitbucket.org' }),
  /provider is unsupported/
);
assert.throws(
  () => providerRevocationGuidance({ provider: 'gitea', baseUrl: 'not a url' }),
  /provider baseUrl is invalid/
);
console.log('alpha privacy model tests passed');
