'use strict';

const crypto = require('crypto');

const API_VERSION = '2022-11-28';
const STATE_VERSION = 1;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

class GithubAppError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'GithubAppError';
    this.code = code;
    this.status = status;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function encodeJson(value) {
  return Buffer.from(stableJson(value), 'utf8').toString('base64url');
}

function hmac(secret, encoded) {
  return crypto.createHmac('sha256', String(secret)).update(encoded).digest('base64url');
}

function requireEnabledConfig(config) {
  if (!config || !config.enabled) throw new GithubAppError('GitHub App authentication is not configured', 'GITHUB_APP_DISABLED', 404);
  return config;
}

function createGithubAppJwt(config, options = {}) {
  requireEnabledConfig(config);
  const nowSeconds = Math.floor(Number(options.now == null ? Date.now() : options.now) / 1000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: String(config.appId)
  });
  const input = `${header}.${payload}`;
  let signature;
  try { signature = crypto.sign('RSA-SHA256', Buffer.from(input), config.privateKey).toString('base64url'); }
  catch { throw new GithubAppError('GitHub App signing configuration is invalid', 'GITHUB_APP_SIGNING_FAILED', 503); }
  return `${input}.${signature}`;
}

function requireStateContext(context) {
  const purpose = String(context && context.purpose || '').trim();
  const sessionBinding = String(context && context.sessionBinding || '').trim();
  const identityKey = String(context && context.identityKey || '').trim();
  if (!purpose || !sessionBinding || !identityKey) throw new TypeError('GitHub App state requires purpose, session, and identity bindings');
  return { purpose, sessionBinding, identityKey };
}

function createGithubAppState(secret, context, options = {}) {
  const clean = requireStateContext(context);
  const now = Math.floor(Number(options.now == null ? Date.now() : options.now));
  const ttlMs = Number(options.ttlMs || 10 * 60 * 1000);
  if (!secret || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    throw new TypeError('GitHub App state requires a secret and a bounded positive lifetime');
  }
  const payload = {
    v: STATE_VERSION,
    kind: 'github-app-state',
    ...clean,
    nonce: String(options.nonce || crypto.randomBytes(18).toString('base64url')),
    iat: now,
    exp: now + Math.floor(ttlMs)
  };
  const encoded = encodeJson(payload);
  return `${encoded}.${hmac(secret, encoded)}`;
}

function verifyGithubAppState(secret, token, expected, options = {}) {
  const clean = requireStateContext(expected);
  const raw = String(token || '');
  if (!raw || raw.length > 4096) throw new GithubAppError('GitHub App state is missing or malformed', 'GITHUB_APP_STATE_INVALID');
  const pieces = raw.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new GithubAppError('GitHub App state is malformed', 'GITHUB_APP_STATE_INVALID');
  const [encoded, signature] = pieces;
  if (!safeEqual(signature, hmac(secret, encoded))) throw new GithubAppError('GitHub App state signature is invalid', 'GITHUB_APP_STATE_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new GithubAppError('GitHub App state payload is invalid', 'GITHUB_APP_STATE_INVALID'); }
  const now = Number(options.now == null ? Date.now() : options.now);
  if (!payload || payload.v !== STATE_VERSION || payload.kind !== 'github-app-state' || !payload.nonce || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    throw new GithubAppError('GitHub App state claims are invalid', 'GITHUB_APP_STATE_INVALID');
  }
  if (now > payload.exp) throw new GithubAppError('GitHub App state has expired', 'GITHUB_APP_STATE_EXPIRED');
  if (payload.iat > now + 30000 || payload.exp <= payload.iat) throw new GithubAppError('GitHub App state timestamps are invalid', 'GITHUB_APP_STATE_INVALID');
  if (!safeEqual(payload.purpose, clean.purpose) || !safeEqual(payload.sessionBinding, clean.sessionBinding) || !safeEqual(payload.identityKey, clean.identityKey)) {
    throw new GithubAppError('GitHub App state does not match the active security context', 'GITHUB_APP_STATE_CONTEXT');
  }
  return payload;
}

function cleanInstallationId(value) {
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GithubAppError('GitHub App installation ID is invalid', 'GITHUB_APP_INSTALLATION_INVALID', 400);
  }
  return installationId;
}

function sanitizePermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, permission] of Object.entries(value)) {
    if (/^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(String(permission))) out[key] = String(permission);
  }
  return out;
}

function assertInstallationAccount(account, installation) {
  const expectedLogin = String(account && account.login || '').trim().toLowerCase();
  const expectedAccountId = Number(account && account.installationAccountId);
  if (!expectedLogin || !Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0) {
    throw new GithubAppError('GitHub App account ownership metadata is invalid', 'GITHUB_APP_ACCOUNT_INVALID', 401);
  }
  if (expectedLogin !== String(installation && installation.account && installation.account.login || '').trim().toLowerCase() ||
      expectedAccountId !== Number(installation && installation.account && installation.account.id)) {
    throw new GithubAppError('GitHub App installation no longer matches the stored account', 'GITHUB_APP_ACCOUNT_MISMATCH', 403);
  }
  return installation;
}

function sanitizeInstallation(value, expectedAppId) {
  const installationId = cleanInstallationId(value && value.id);
  const appId = Number(value && value.app_id);
  if (appId !== Number(expectedAppId)) {
    throw new GithubAppError('The installation does not belong to this GitHub App', 'GITHUB_APP_INSTALLATION_MISMATCH');
  }
  const account = value && value.account && typeof value.account === 'object' ? value.account : {};
  const login = String(account.login || '').trim();
  const accountId = Number(account.id);
  if (!login || login.length > 100 || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new GithubAppError('GitHub returned incomplete installation ownership metadata', 'GITHUB_APP_INSTALLATION_INVALID');
  }
  const suspendedAt = value.suspended_at ? String(value.suspended_at) : '';
  const installation = Object.freeze({
    id: installationId,
    appId,
    account: Object.freeze({
      login,
      id: accountId,
      type: String(account.type || 'User').slice(0, 40),
      avatarUrl: String(account.avatar_url || '').slice(0, 500)
    }),
    repositorySelection: value.repository_selection === 'all' ? 'all' : 'selected',
    permissions: Object.freeze(sanitizePermissions(value.permissions)),
    suspendedAt,
    htmlUrl: String(value.html_url || '').slice(0, 500)
  });
  if (suspendedAt) throw new GithubAppError('This GitHub App installation is suspended', 'GITHUB_APP_INSTALLATION_SUSPENDED', 403);
  return installation;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

class GithubAppBroker {
  constructor(config, options = {}) {
    this.config = requireEnabledConfig(config);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('GitHub App broker requires fetch');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    const timeoutMs = Number(options.timeoutMs == null ? 15000 : options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new TypeError('GitHub App broker timeout must be between 1 and 60 seconds');
    this.timeoutMs = Math.floor(timeoutMs);
    this.cache = new Map();
    this.inFlight = new Map();
    this.installationEpochs = new Map();
  }

  requestSignal() {
    return AbortSignal.timeout(this.timeoutMs);
  }

  appHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${createGithubAppJwt(this.config, { now: this.now() })}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'Nebulaverse-X',
      ...extra
    };
  }

  async appJson(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.config.apiBase}${path}`, {
        method: options.method || 'GET',
        headers: this.appHeaders(options.body ? { 'Content-Type': 'application/json' } : {}),
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        signal: this.requestSignal()
      });
    } catch {
      throw new GithubAppError('GitHub App service is temporarily unavailable', 'GITHUB_APP_UPSTREAM_UNAVAILABLE', 503);
    }
    const data = await readJson(response);
    if (!response.ok) {
      const code = response.status === 404 ? 'GITHUB_APP_INSTALLATION_REVOKED' : 'GITHUB_APP_UPSTREAM_REJECTED';
      throw new GithubAppError(`GitHub App request failed (${response.status})`, code, response.status === 404 ? 401 : response.status);
    }
    return data;
  }

  async getInstallation(installationId) {
    const id = cleanInstallationId(installationId);
    const data = await this.appJson(`/app/installations/${id}`);
    return sanitizeInstallation(data, this.config.appId);
  }

  async mintInstallationToken(installationId, auditContext = {}) {
    const installation = await this.getInstallation(installationId);
    const data = await this.appJson(`/app/installations/${installation.id}/access_tokens`, { method: 'POST' });
    const token = String(data && data.token || '');
    const expiresAt = new Date(data && data.expires_at || 0).getTime();
    if (!token || token.length > 4096 || !Number.isFinite(expiresAt) || expiresAt <= this.now() + TOKEN_REFRESH_MARGIN_MS) {
      throw new GithubAppError('GitHub returned an invalid installation credential', 'GITHUB_APP_TOKEN_INVALID', 503);
    }
    const record = { token, expiresAt, installation };
    await Promise.resolve(this.audit({
      type: 'authorization.refreshed',
      identityKey: String(auditContext.identityKey || ''),
      installationId: installation.id,
      accountLogin: installation.account.login,
      expiresAt: new Date(expiresAt).toISOString()
    })).catch(() => {});
    return record;
  }

  cachePrefix(installationId) {
    return `${this.config.appId}:${cleanInstallationId(installationId)}:`;
  }

  cacheKey(installationId, identityKey) {
    const identity = String(identityKey || '').trim();
    if (!identity || identity.length > 512) {
      throw new GithubAppError('GitHub App account authorization identity is invalid', 'GITHUB_APP_ACCOUNT_INVALID', 401);
    }
    return `${this.cachePrefix(installationId)}${crypto.createHash('sha256').update(identity).digest('base64url')}`;
  }

  installationEpoch(installationId) {
    return this.installationEpochs.get(cleanInstallationId(installationId)) || 0;
  }

  async resolveInstallationAccount(account) {
    if (!account || account.provider !== 'github' || account.authMethod !== 'github-app') {
      throw new GithubAppError('A valid GitHub App account is required', 'GITHUB_APP_ACCOUNT_INVALID', 401);
    }
    const id = cleanInstallationId(account.installationId);
    const identityKey = String(account.authorizedByIdentityKey || '').trim();
    const key = this.cacheKey(id, identityKey);
    const epoch = this.installationEpoch(id);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      assertInstallationAccount(account, cached.installation);
      return { ...account, token: cached.token, installation: cached.installation };
    }
    if (this.inFlight.has(key)) {
      const record = await this.inFlight.get(key);
      assertInstallationAccount(account, record.installation);
      return { ...account, token: record.token, installation: record.installation };
    }
    const pending = this.mintInstallationToken(id, { identityKey })
      .then(record => {
        assertInstallationAccount(account, record.installation);
        if (this.installationEpoch(id) !== epoch) {
          throw new GithubAppError('GitHub App credential was invalidated during authorization', 'GITHUB_APP_CREDENTIAL_INVALIDATED', 401);
        }
        this.cache.set(key, record);
        return record;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    const record = await pending;
    assertInstallationAccount(account, record.installation);
    return { ...account, token: record.token, installation: record.installation };
  }

  invalidate(installationId) {
    const id = cleanInstallationId(installationId);
    const prefix = this.cachePrefix(id);
    let existed = false;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) existed = this.cache.delete(key) || existed;
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
        existed = true;
      }
    }
    this.installationEpochs.set(id, this.installationEpoch(id) + 1);
    return existed;
  }

  cacheSize() {
    return this.cache.size;
  }

  authorizationUrl(state) {
    const url = new URL('/login/oauth/authorize', this.config.webBase);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.callbackUrl);
    url.searchParams.set('state', String(state));
    return url.toString();
  }

  installationUrl(state) {
    const url = new URL(`/apps/${encodeURIComponent(this.config.slug)}/installations/new`, this.config.webBase);
    url.searchParams.set('state', String(state));
    return url.toString();
  }

  async exchangeUserCode(code) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode || cleanCode.length > 1000) throw new GithubAppError('GitHub App authorization code is invalid', 'GITHUB_APP_CODE_INVALID', 400);
    let response;
    try {
      response = await this.fetchImpl(`${this.config.webBase}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Nebulaverse-X' },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: cleanCode,
          redirect_uri: this.config.callbackUrl
        }),
        redirect: 'error',
        signal: this.requestSignal()
      });
    } catch {
      throw new GithubAppError('GitHub App authorization exchange is unavailable', 'GITHUB_APP_UPSTREAM_UNAVAILABLE', 503);
    }
    const data = await readJson(response);
    const token = String(data && data.access_token || '');
    if (!response.ok || !token || token.length > 4096) {
      throw new GithubAppError('GitHub App authorization exchange was rejected', 'GITHUB_APP_AUTHORIZATION_REJECTED', 401);
    }
    return {
      token,
      expiresIn: Number.isFinite(Number(data.expires_in)) ? Math.max(0, Number(data.expires_in)) : 0
    };
  }

  async userJson(userToken, path) {
    const token = String(userToken || '');
    if (!token || token.length > 4096) throw new GithubAppError('GitHub App user authorization is unavailable', 'GITHUB_APP_USER_TOKEN_INVALID', 401);
    let response;
    try {
      response = await this.fetchImpl(`${this.config.apiBase}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'Nebulaverse-X'
        },
        redirect: 'error',
        signal: this.requestSignal()
      });
    } catch {
      throw new GithubAppError('GitHub user authorization is temporarily unavailable', 'GITHUB_APP_UPSTREAM_UNAVAILABLE', 503);
    }
    const data = await readJson(response);
    if (!response.ok) throw new GithubAppError(`GitHub user authorization failed (${response.status})`, 'GITHUB_APP_USER_AUTHORIZATION_REJECTED', response.status);
    return data;
  }

  async getAuthorizedUser(userToken) {
    const user = await this.userJson(userToken, '/user');
    const id = Number(user && user.id);
    const login = String(user && user.login || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !login) throw new GithubAppError('GitHub returned incomplete user identity data', 'GITHUB_APP_USER_INVALID', 502);
    return { id, login, name: String(user.name || ''), avatarUrl: String(user.avatar_url || '') };
  }

  async findUserInstallation(userToken, installationId) {
    const id = cleanInstallationId(installationId);
    for (let page = 1; page <= 10; page += 1) {
      const data = await this.userJson(userToken, `/user/installations?per_page=100&page=${page}`);
      const installations = Array.isArray(data && data.installations) ? data.installations : [];
      const found = installations.find(item => Number(item && item.id) === id);
      if (found) return sanitizeInstallation(found, this.config.appId);
      if (installations.length < 100) break;
    }
    throw new GithubAppError('The active GitHub user cannot claim this installation', 'GITHUB_APP_INSTALLATION_OWNERSHIP', 403);
  }
}

module.exports = {
  GithubAppError,
  createGithubAppJwt,
  createGithubAppState,
  verifyGithubAppState,
  sanitizeInstallation,
  GithubAppBroker,
  TOKEN_REFRESH_MARGIN_MS
};
