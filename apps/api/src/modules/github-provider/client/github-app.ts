import { createHash, createHmac, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { KeyLike } from 'node:crypto';

const API_VERSION = '2022-11-28';
const STATE_VERSION = 1;
export const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export class GithubAppError extends Error {
  override readonly name = 'GithubAppError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Fields = Readonly<Record<string, unknown>>;

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

/* What the server's configuration says about its GitHub App when one is enabled. */
export interface GithubAppConfig {
  readonly enabled: true;
  readonly appId: unknown;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: KeyLike;
  readonly callbackUrl: string;
  readonly apiBase: string;
  readonly webBase: string;
}

function safeEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/*
 * Sorted keys, nothing else, as the security foundation's: undefined and
 * toJSON are left to JSON.stringify. The state token's signature is over these
 * bytes, so they stay byte for byte; Phase G unifies the copies only with proof.
 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Fields;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stableValue(record[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function encodeJson(value: unknown): string {
  return Buffer.from(stableJson(value), 'utf8').toString('base64url');
}

function hmac(secret: unknown, encoded: string): string {
  return createHmac('sha256', String(secret)).update(encoded).digest('base64url');
}

function requireEnabledConfig(config: unknown): GithubAppConfig {
  if (!config || !read(config, 'enabled')) throw new GithubAppError('GitHub App authentication is not configured', 'GITHUB_APP_DISABLED', 404);
  return config as GithubAppConfig;
}

export function createGithubAppJwt(config: unknown, options: { readonly now?: unknown } = {}): string {
  const enabled = requireEnabledConfig(config);
  const nowSeconds = Math.floor(Number(options.now == null ? Date.now() : options.now) / 1000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: String(enabled.appId)
  });
  const input = `${header}.${payload}`;
  let signature: string;
  try { signature = sign('RSA-SHA256', Buffer.from(input), enabled.privateKey).toString('base64url'); }
  catch { throw new GithubAppError('GitHub App signing configuration is invalid', 'GITHUB_APP_SIGNING_FAILED', 503); }
  return `${input}.${signature}`;
}

/* What a state token binds: the flow it belongs to, the session and the identity. */
export interface StateContext {
  readonly purpose: string;
  readonly sessionBinding: string;
  readonly identityKey: string;
}

function requireStateContext(context: unknown): StateContext {
  const purpose = String(read(context, 'purpose') || '').trim();
  const sessionBinding = String(read(context, 'sessionBinding') || '').trim();
  const identityKey = String(read(context, 'identityKey') || '').trim();
  if (!purpose || !sessionBinding || !identityKey) throw new TypeError('GitHub App state requires purpose, session, and identity bindings');
  return { purpose, sessionBinding, identityKey };
}

export interface StateOptions {
  readonly now?: unknown;
  readonly ttlMs?: unknown;
  readonly nonce?: unknown;
}

export function createGithubAppState(secret: unknown, context: unknown, options: StateOptions = {}): string {
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
    nonce: String(options.nonce || randomBytes(18).toString('base64url')),
    iat: now,
    exp: now + Math.floor(ttlMs)
  };
  const encoded = encodeJson(payload);
  return `${encoded}.${hmac(secret, encoded)}`;
}

/* A verified state token's claims. */
export interface StatePayload extends Fields {
  readonly v: number;
  readonly kind: string;
  readonly nonce: unknown;
  readonly iat: number;
  readonly exp: number;
}

export function verifyGithubAppState(secret: unknown, token: unknown, expected: unknown, options: { readonly now?: unknown } = {}): StatePayload {
  const clean = requireStateContext(expected);
  const raw = String(token || '');
  if (!raw || raw.length > 4096) throw new GithubAppError('GitHub App state is missing or malformed', 'GITHUB_APP_STATE_INVALID');
  const pieces = raw.split('.');
  const [encoded, signature] = pieces;
  if (pieces.length !== 2 || !encoded || !signature) throw new GithubAppError('GitHub App state is malformed', 'GITHUB_APP_STATE_INVALID');
  if (!safeEqual(signature, hmac(secret, encoded))) throw new GithubAppError('GitHub App state signature is invalid', 'GITHUB_APP_STATE_INVALID');
  let payload: StatePayload | null;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload | null; }
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

function cleanInstallationId(value: unknown): number {
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GithubAppError('GitHub App installation ID is invalid', 'GITHUB_APP_INSTALLATION_INVALID', 400);
  }
  return installationId;
}

type InstallationPermission = 'read' | 'write' | 'admin';

function sanitizePermissions(value: unknown): Record<string, InstallationPermission> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, InstallationPermission> = {};
  for (const [key, permission] of Object.entries(value)) {
    if (/^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(String(permission))) out[key] = String(permission) as InstallationPermission;
  }
  return out;
}

/* An installation as GitHub described it, reduced to what the server keeps. */
export interface Installation {
  readonly id: number;
  readonly appId: number;
  readonly account: Readonly<{ login: string; id: number; type: string; avatarUrl: string }>;
  readonly repositorySelection: 'all' | 'selected';
  readonly permissions: Readonly<Record<string, InstallationPermission>>;
  readonly suspendedAt: string;
  readonly htmlUrl: string;
}

function assertInstallationAccount(account: unknown, installation: Installation): Installation {
  const expectedLogin = String(read(account, 'login') || '').trim().toLowerCase();
  const expectedAccountId = Number(read(account, 'installationAccountId'));
  if (!expectedLogin || !Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0) {
    throw new GithubAppError('GitHub App account ownership metadata is invalid', 'GITHUB_APP_ACCOUNT_INVALID', 401);
  }
  if (expectedLogin !== String(installation && installation.account && installation.account.login || '').trim().toLowerCase() ||
      expectedAccountId !== Number(installation && installation.account && installation.account.id)) {
    throw new GithubAppError('GitHub App installation no longer matches the stored account', 'GITHUB_APP_ACCOUNT_MISMATCH', 403);
  }
  return installation;
}

export function sanitizeInstallation(value: unknown, expectedAppId: unknown): Installation {
  const installationId = cleanInstallationId(read(value, 'id'));
  const appId = Number(read(value, 'app_id'));
  if (appId !== Number(expectedAppId)) {
    throw new GithubAppError('The installation does not belong to this GitHub App', 'GITHUB_APP_INSTALLATION_MISMATCH');
  }
  const owner = read(value, 'account');
  const account: Fields = owner && typeof owner === 'object' ? owner as Fields : {};
  const login = String(account.login || '').trim();
  const accountId = Number(account.id);
  if (!login || login.length > 100 || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new GithubAppError('GitHub returned incomplete installation ownership metadata', 'GITHUB_APP_INSTALLATION_INVALID');
  }
  const fields = value as Fields;
  const suspendedAt = fields.suspended_at ? String(fields.suspended_at) : '';
  const installation: Installation = Object.freeze({
    id: installationId,
    appId,
    account: Object.freeze({
      login,
      id: accountId,
      type: String(account.type || 'User').slice(0, 40),
      avatarUrl: String(account.avatar_url || '').slice(0, 500)
    }),
    repositorySelection: fields.repository_selection === 'all' ? 'all' : 'selected',
    permissions: Object.freeze(sanitizePermissions(fields.permissions)),
    suspendedAt,
    htmlUrl: String(fields.html_url || '').slice(0, 500)
  });
  if (suspendedAt) throw new GithubAppError('This GitHub App installation is suspended', 'GITHUB_APP_INSTALLATION_SUSPENDED', 403);
  return installation;
}

/* The part of a fetch response the broker reads. */
interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
type Fetch = (url: string, init: Readonly<Record<string, unknown>>) => Promise<FetchResponse>;

async function readJson(response: FetchResponse): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

/* A minted installation credential, cached until shortly before it expires. */
interface CredentialRecord {
  readonly token: string;
  readonly expiresAt: number;
  readonly installation: Installation;
}

export interface BrokerOptions {
  readonly fetchImpl?: unknown;
  readonly now?: unknown;
  readonly audit?: unknown;
  readonly timeoutMs?: unknown;
}

export class GithubAppBroker {
  readonly config: GithubAppConfig;
  readonly fetchImpl: Fetch;
  readonly now: () => number;
  readonly audit: (event: Fields) => unknown;
  readonly timeoutMs: number;
  readonly cache: Map<string, CredentialRecord>;
  readonly inFlight: Map<string, Promise<CredentialRecord>>;
  readonly installationEpochs: Map<number, number>;

  constructor(config: unknown, options: BrokerOptions = {}) {
    this.config = requireEnabledConfig(config);
    this.fetchImpl = (options.fetchImpl || globalThis.fetch) as Fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('GitHub App broker requires fetch');
    this.now = typeof options.now === 'function' ? options.now as () => number : () => Date.now();
    this.audit = typeof options.audit === 'function' ? options.audit as (event: Fields) => unknown : () => {};
    const timeoutMs = Number(options.timeoutMs == null ? 15000 : options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new TypeError('GitHub App broker timeout must be between 1 and 60 seconds');
    this.timeoutMs = Math.floor(timeoutMs);
    this.cache = new Map();
    this.inFlight = new Map();
    this.installationEpochs = new Map();
  }

  requestSignal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  appHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${createGithubAppJwt(this.config, { now: this.now() })}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'Nebulaverse-X',
      ...extra
    };
  }

  async appJson(path: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<unknown> {
    let response: FetchResponse;
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

  async getInstallation(installationId: unknown): Promise<Installation> {
    const id = cleanInstallationId(installationId);
    const data = await this.appJson(`/app/installations/${id}`);
    return sanitizeInstallation(data, this.config.appId);
  }

  async mintInstallationToken(installationId: unknown, auditContext: { readonly identityKey?: unknown } = {}): Promise<CredentialRecord> {
    const installation = await this.getInstallation(installationId);
    const data = await this.appJson(`/app/installations/${installation.id}/access_tokens`, { method: 'POST' });
    const token = String(data && read(data, 'token') || '');
    const expiresAt = new Date((data && read(data, 'expires_at') || 0) as string | number).getTime();
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

  cachePrefix(installationId: unknown): string {
    return `${String(this.config.appId)}:${cleanInstallationId(installationId)}:`;
  }

  cacheKey(installationId: unknown, identityKey: unknown): string {
    const identity = String(identityKey || '').trim();
    if (!identity || identity.length > 512) {
      throw new GithubAppError('GitHub App account authorization identity is invalid', 'GITHUB_APP_ACCOUNT_INVALID', 401);
    }
    return `${this.cachePrefix(installationId)}${createHash('sha256').update(identity).digest('base64url')}`;
  }

  installationEpoch(installationId: unknown): number {
    return this.installationEpochs.get(cleanInstallationId(installationId)) || 0;
  }

  async resolveInstallationAccount(account: unknown): Promise<Record<string, unknown>> {
    if (!account || read(account, 'provider') !== 'github' || read(account, 'authMethod') !== 'github-app') {
      throw new GithubAppError('A valid GitHub App account is required', 'GITHUB_APP_ACCOUNT_INVALID', 401);
    }
    const fields = account as Fields;
    const id = cleanInstallationId(fields.installationId);
    const identityKey = String(fields.authorizedByIdentityKey || '').trim();
    const key = this.cacheKey(id, identityKey);
    const epoch = this.installationEpoch(id);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      assertInstallationAccount(fields, cached.installation);
      return { ...fields, token: cached.token, installation: cached.installation };
    }
    const already = this.inFlight.get(key);
    if (already) {
      const record = await already;
      assertInstallationAccount(fields, record.installation);
      return { ...fields, token: record.token, installation: record.installation };
    }
    const pending: Promise<CredentialRecord> = this.mintInstallationToken(id, { identityKey })
      .then(record => {
        assertInstallationAccount(fields, record.installation);
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
    assertInstallationAccount(fields, record.installation);
    return { ...fields, token: record.token, installation: record.installation };
  }

  invalidate(installationId: unknown): boolean {
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

  cacheSize(): number {
    return this.cache.size;
  }

  authorizationUrl(state: unknown): string {
    const url = new URL('/login/oauth/authorize', this.config.webBase);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.callbackUrl);
    url.searchParams.set('state', String(state));
    return url.toString();
  }

  installationUrl(state: unknown): string {
    const url = new URL(`/apps/${encodeURIComponent(this.config.slug)}/installations/new`, this.config.webBase);
    url.searchParams.set('state', String(state));
    return url.toString();
  }

  async exchangeUserCode(code: unknown): Promise<{ readonly token: string; readonly expiresIn: number }> {
    const cleanCode = String(code || '').trim();
    if (!cleanCode || cleanCode.length > 1000) throw new GithubAppError('GitHub App authorization code is invalid', 'GITHUB_APP_CODE_INVALID', 400);
    let response: FetchResponse;
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
    const token = String(data && read(data, 'access_token') || '');
    if (!response.ok || !token || token.length > 4096) {
      throw new GithubAppError('GitHub App authorization exchange was rejected', 'GITHUB_APP_AUTHORIZATION_REJECTED', 401);
    }
    const expiresIn = read(data, 'expires_in');
    return {
      token,
      expiresIn: Number.isFinite(Number(expiresIn)) ? Math.max(0, Number(expiresIn)) : 0
    };
  }

  async userJson(userToken: unknown, path: string): Promise<unknown> {
    const token = String(userToken || '');
    if (!token || token.length > 4096) throw new GithubAppError('GitHub App user authorization is unavailable', 'GITHUB_APP_USER_TOKEN_INVALID', 401);
    let response: FetchResponse;
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

  async getAuthorizedUser(userToken: unknown): Promise<{ readonly id: number; readonly login: string; readonly name: string; readonly avatarUrl: string }> {
    const user = await this.userJson(userToken, '/user');
    const id = Number(user && read(user, 'id'));
    const login = String(user && read(user, 'login') || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !login) throw new GithubAppError('GitHub returned incomplete user identity data', 'GITHUB_APP_USER_INVALID', 502);
    return { id, login, name: String(read(user, 'name') || ''), avatarUrl: String(read(user, 'avatar_url') || '') };
  }

  async findUserInstallation(userToken: unknown, installationId: unknown): Promise<Installation> {
    const id = cleanInstallationId(installationId);
    for (let page = 1; page <= 10; page += 1) {
      const data = await this.userJson(userToken, `/user/installations?per_page=100&page=${page}`);
      const listed = data && read(data, 'installations');
      const installations: readonly unknown[] = Array.isArray(listed) ? listed : [];
      const found = installations.find(item => Number(item && read(item, 'id')) === id);
      if (found) return sanitizeInstallation(found, this.config.appId);
      if (installations.length < 100) break;
    }
    throw new GithubAppError('The active GitHub user cannot claim this installation', 'GITHUB_APP_INSTALLATION_OWNERSHIP', 403);
  }
}
