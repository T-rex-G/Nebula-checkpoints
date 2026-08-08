'use strict';

const crypto = require('crypto');

function normalizeDatabaseUrl(raw, options = {}) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try { url = new URL(value); }
  catch { throw new Error('DATABASE_URL is not a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://');

  const production = !!options.production;
  const insecure = !!options.insecure;
  const mode = String(url.searchParams.get('sslmode') || '').toLowerCase();
  if (production && mode === 'disable' && !insecure) throw new Error('DATABASE_URL cannot disable TLS in production');
  if (!insecure && mode !== 'disable') {
    /* node-postgres parses sslmode from the URL and replaces any separate ssl object.
       Normalize to strict hostname/certificate verification instead of mixing settings. */
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}


function normalizeGovernanceRuntimeFailureMode(raw) {
  const mode = String(raw || '').trim().toLowerCase() || 'warn';
  if (!['warn', 'block'].includes(mode)) {
    throw new Error('NV_GOVERNANCE_RUNTIME_FAILURE_MODE must be warn or block');
  }
  return mode;
}

function loadAlphaAccessConfig(env = process.env, options = {}) {
  const mode = String(env.NV_ALPHA_ACCESS_MODE || 'off').trim().toLowerCase();
  if (!['off', 'invite'].includes(mode)) {
    throw new Error('NV_ALPHA_ACCESS_MODE must be off or invite');
  }

  const enabled = mode === 'invite';
  const pepper = String(env.NV_ALPHA_INVITE_PEPPER || '');
  const termsVersion = String(env.NV_ALPHA_TERMS_VERSION || '').trim();
  if (enabled && !String(options.databaseUrl || '').trim()) {
    throw new Error('Invite alpha access requires PostgreSQL DATABASE_URL');
  }
  if (enabled && Buffer.byteLength(pepper, 'utf8') < 32) {
    throw new Error('NV_ALPHA_INVITE_PEPPER must contain at least 32 bytes');
  }
  if (enabled && !/^\d{4}-\d{2}-\d{2}(?:\.[1-9]\d*)?$/.test(termsVersion)) {
    throw new Error('NV_ALPHA_TERMS_VERSION must be a versioned YYYY-MM-DD value');
  }

  return Object.freeze({
    mode,
    enabled,
    pepper: enabled ? pepper : '',
    termsVersion: enabled ? termsVersion : '',
    inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
    sessionAbsoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
    sessionIdleTtlMs: 24 * 60 * 60 * 1000
  });
}

function normalizeGithubPrivateKey(env) {
  const raw = String(env.GITHUB_APP_PRIVATE_KEY || '').trim();
  const encoded = String(env.GITHUB_APP_PRIVATE_KEY_BASE64 || '').trim();
  if (raw && encoded) throw new Error('GitHub App configuration must use only one private-key environment variable');
  let value = raw;
  if (encoded) {
    try { value = Buffer.from(encoded, 'base64').toString('utf8'); }
    catch { throw new Error('GitHub App private key base64 value is invalid'); }
  }
  value = String(value || '').replace(/\\n/g, '\n').trim();
  if (!value) return '';
  try {
    const key = crypto.createPrivateKey(value);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new Error('GitHub App private key must be a valid RSA private key');
  }
  return `${value}\n`;
}

function requireHttpsUrl(raw, label, production) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); }
  catch { throw new Error(`${label} must be a valid absolute URL`); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`);
  if (production && parsed.protocol !== 'https:') throw new Error(`${label} must use https in production`);
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`${label} must not contain credentials or a fragment`);
  return parsed;
}

function loadGithubAppConfig(env = process.env, options = {}) {
  const appSpecificValues = [
    env.GITHUB_APP_ID, env.GITHUB_APP_SLUG, env.GITHUB_APP_CLIENT_ID,
    env.GITHUB_APP_CLIENT_SECRET, env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_APP_PRIVATE_KEY_BASE64, env.GITHUB_APP_CALLBACK_URL,
    env.GITHUB_APP_WEBHOOK_SECRET
  ].map(value => String(value || '').trim());
  if (!appSpecificValues.some(Boolean)) return { enabled: false };

  const appIdText = String(env.GITHUB_APP_ID || '').trim();
  const slug = String(env.GITHUB_APP_SLUG || '').trim().toLowerCase();
  const clientId = String(env.GITHUB_APP_CLIENT_ID || '').trim();
  const clientSecret = String(env.GITHUB_APP_CLIENT_SECRET || '').trim();
  const privateKey = normalizeGithubPrivateKey(env);
  let callbackRaw = String(env.GITHUB_APP_CALLBACK_URL || '').trim();
  if (!callbackRaw && String(env.PUBLIC_BASE_URL || '').trim()) {
    const base = requireHttpsUrl(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', !!options.production);
    callbackRaw = new URL('/api/github-app/oauth/callback', base).toString();
  }

  const missing = [];
  if (!appIdText) missing.push('GITHUB_APP_ID');
  if (!slug) missing.push('GITHUB_APP_SLUG');
  if (!clientId) missing.push('GITHUB_APP_CLIENT_ID');
  if (!clientSecret) missing.push('GITHUB_APP_CLIENT_SECRET');
  if (!privateKey) missing.push('GITHUB_APP_PRIVATE_KEY');
  if (!callbackRaw) missing.push('GITHUB_APP_CALLBACK_URL or PUBLIC_BASE_URL');
  if (missing.length) throw new Error(`GitHub App configuration is incomplete: missing ${missing.join(', ')}`);

  const appId = Number(appIdText);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GITHUB_APP_ID must be a positive integer');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) throw new Error('GITHUB_APP_SLUG is invalid');
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(clientId)) throw new Error('GITHUB_APP_CLIENT_ID is invalid');
  if (clientSecret.length < 10 || clientSecret.length > 1000) throw new Error('GITHUB_APP_CLIENT_SECRET is invalid');

  const callback = requireHttpsUrl(callbackRaw, 'GITHUB_APP_CALLBACK_URL', !!options.production);
  if (callback.search) throw new Error('GITHUB_APP_CALLBACK_URL must not contain a query string');
  const callbackPath = callback.pathname.replace(/\/+$/, '');
  if (!callbackPath.endsWith('/api/github-app/oauth/callback')) {
    throw new Error('GITHUB_APP_CALLBACK_URL must end with /api/github-app/oauth/callback');
  }
  const setupUrl = new URL('/api/github-app/setup', callback).toString();
  const webhookSecret = String(env.GITHUB_APP_WEBHOOK_SECRET || '').trim();
  if (webhookSecret && (webhookSecret.length < 16 || webhookSecret.length > 1000)) {
    throw new Error('GITHUB_APP_WEBHOOK_SECRET must contain at least 16 characters');
  }

  return Object.freeze({
    enabled: true,
    appId,
    slug,
    clientId,
    clientSecret,
    privateKey,
    callbackUrl: callback.toString(),
    setupUrl,
    webhookSecret,
    webhookConfigured: !!webhookSecret,
    apiBase: 'https://api.github.com',
    webBase: 'https://github.com'
  });
}

module.exports = {
  normalizeDatabaseUrl,
  normalizeGovernanceRuntimeFailureMode,
  loadGithubAppConfig,
  loadAlphaAccessConfig
};
