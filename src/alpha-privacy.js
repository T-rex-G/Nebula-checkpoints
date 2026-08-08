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
  if (provider === 'gitlab') {
    const base = providerBaseUrl(account, 'https://gitlab.com');
    return Object.freeze({
      label: 'Revoke the token on GitLab',
      url: new URL(`${base}/-/user_settings/personal_access_tokens`).toString(),
      automatic: false
    });
  }
  if (provider !== 'gitea') throw new TypeError('provider is unsupported');
  const base = providerBaseUrl(account);
  return Object.freeze({
    label: 'Revoke the token on Gitea',
    url: new URL(`${base}/user/settings/applications`).toString(),
    automatic: false
  });
}

function providerBaseUrl(account, fallback) {
  let base;
  try {
    base = new URL(account && account.baseUrl || fallback);
  } catch {
    throw new TypeError('provider baseUrl is invalid');
  }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw new TypeError('provider baseUrl is invalid');
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
}

module.exports = Object.freeze({
  alphaRetentionPolicy, alphaActorLabel, sanitizeFeedback,
  buildSupportBundle, providerRevocationGuidance
});
