'use strict';

const clean = (value, max) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .trim()
  .slice(0, max);

function alphaRetentionPolicy() {
  return Object.freeze({
    alphaSessionsDays: 7,
    verifiedEventsDays: 30,
    operationalLogsDays: 14,
    snapshotsDays: 30,
    evidenceExportsDays: 30,
    inviteMetadataDaysAfterClose: 30
  });
}

function alphaActorLabel(alpha) {
  const compact = String(alpha && alpha.testerId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError('alpha testerId is invalid');
  return `alpha:${compact.slice(0, 12)}`;
}

function buildSupportBundle(input) {
  return Object.freeze({
    releaseVersion: clean(input.releaseVersion, 80),
    correlationId: clean(input.correlationId, 80),
    provider: clean(input.provider, 20),
    feature: clean(input.feature, 80),
    capabilityStatus: clean(input.capabilityStatus, 20),
    errorCode: clean(input.errorCode, 80),
    timestamp: new Date(input.timestamp).toISOString(),
    runtime: clean(input.runtime, 200)
  });
}

function sanitizeFeedback(input, context) {
  return buildSupportBundle({
    ...context,
    feature: input.feature
  });
}

function providerRevocationGuidance(account) {
  const provider = String(account && account.provider || 'github').trim().toLowerCase();
  if (provider === 'github') {
    return Object.freeze({
      label: account && account.authMethod === 'github-app'
        ? 'Manage or uninstall the GitHub App'
        : 'Revoke the token on GitHub',
      url: account && account.authMethod === 'github-app'
        ? 'https://github.com/settings/installations'
        : 'https://github.com/settings/tokens',
      automatic: false
    });
  }
  // Retired account records remain eligible for local privacy cleanup. Never
  // construct or contact a URL from their saved provider configuration.
  if (!['gitlab', 'gitea'].includes(provider)) throw new TypeError('provider is unsupported');
  return Object.freeze({
    label: 'Revoke this retired provider credential manually in its account settings',
    url: null,
    automatic: false
  });
}

module.exports = Object.freeze({
  alphaRetentionPolicy, alphaActorLabel, sanitizeFeedback,
  buildSupportBundle, providerRevocationGuidance
});
