import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { memorySingleUseStore } from '../rate-limit/single-use-store.ts';
import { property } from '../values/fields.ts';
import { ASSURANCE_LEVELS } from '../../../../../packages/contracts/src/mutation.ts';
import { isCommitSha } from '../../../../../packages/contracts/src/ids.ts';

const TOKEN_VERSION = 1;
const STEP_UP_ACTION_NAMES = Object.freeze([
  'repository.delete',
  'branch.reset',
  'pull.merge',
  'sessions.revoke-others',
  'governance.reset'
] as const);
export type StepUpActionName = (typeof STEP_UP_ACTION_NAMES)[number];
const STEP_UP_ACTIONS = new Set<string>(STEP_UP_ACTION_NAMES);
const isStepUpAction = (value: string): value is StepUpActionName => STEP_UP_ACTIONS.has(value);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

export class SecurityTokenError extends Error {
  override readonly name = 'SecurityTokenError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* A token's claims, and anything a caller hands in as claims or bindings. */
type Claims = Readonly<Record<string, unknown>>;

/*
 * Sorted keys, nothing else: undefined and toJSON are left to JSON.stringify.
 * Scope hashes are bound into signed grants, so this stays byte for byte; the
 * server's other canonical-JSON copies differ, and Phase G unifies them only
 * with proof that no recorded value moves.
 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Claims;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stableValue(record[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function scopeHash(scope: unknown): string {
  return createHash('sha256').update(stableJson(scope)).digest('base64url');
}

function sign(secret: unknown, encodedPayload: string): string {
  return createHmac('sha256', String(secret)).update(encodedPayload).digest('base64url');
}

function safeEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface TokenOptions {
  readonly now?: number;
  readonly ttlMs?: number;
  readonly nonce?: string;
}

/* What a verified token carries: the fixed claims, then whatever it was issued with. */
export interface TokenPayload extends Claims {
  readonly v: number;
  readonly kind: string;
  readonly iat: number;
  readonly exp: number;
}

function createToken(secret: unknown, kind: string, claims: Claims, { now = Date.now(), ttlMs, nonce }: TokenOptions = {}): string {
  if (!secret || !Number.isFinite(ttlMs) || (ttlMs as number) <= 0) throw new TypeError('A secret and positive token lifetime are required');
  const issuedAt = Math.floor(Number(now));
  const payload = {
    v: TOKEN_VERSION,
    kind,
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttlMs as number),
    nonce: String(nonce || randomBytes(18).toString('base64url')),
    ...claims
  };
  const encoded = Buffer.from(stableJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(secret, encoded)}`;
}

function decodeToken(secret: unknown, token: unknown, expectedKind: string, { now = Date.now() }: { readonly now?: number } = {}): TokenPayload {
  const raw = String(token || '');
  const codePrefix = expectedKind === 'csrf' ? 'CSRF' : 'STEP_UP';
  if (!raw || raw.length > 4096) throw new SecurityTokenError(`${expectedKind} token is missing or malformed`, `${codePrefix}_INVALID`);
  const pieces = raw.split('.');
  const [encoded, signature] = pieces;
  if (pieces.length !== 2 || !encoded || !signature) throw new SecurityTokenError(`${expectedKind} token is malformed`, `${codePrefix}_INVALID`);
  if (!safeEqual(signature, sign(secret, encoded))) throw new SecurityTokenError(`${expectedKind} token signature is invalid`, `${codePrefix}_INVALID`);
  let payload: TokenPayload | null;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload | null; }
  catch { throw new SecurityTokenError(`${expectedKind} token payload is invalid`, `${codePrefix}_INVALID`); }
  if (!payload || payload.v !== TOKEN_VERSION || payload.kind !== expectedKind || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    throw new SecurityTokenError(`${expectedKind} token claims are invalid`, `${codePrefix}_INVALID`);
  }
  if (Number(now) > payload.exp) throw new SecurityTokenError(`${expectedKind} token has expired`, `${codePrefix}_EXPIRED`);
  if (payload.iat > Number(now) + 30_000 || payload.exp <= payload.iat) {
    throw new SecurityTokenError(`${expectedKind} token timestamps are invalid`, `${codePrefix}_INVALID`);
  }
  return payload;
}

/* The session and the identity a token is bound to; a type, so it is also a set of claims. */
export type TokenBindings = {
  readonly sessionBinding: string;
  readonly identityKey: string;
};

function requireContext(context: Claims | null | undefined, prefix: string): TokenBindings {
  const sessionBinding = String(context && context.sessionBinding || '');
  const identityKey = String(context && context.identityKey || '');
  if (!sessionBinding || !identityKey) throw new TypeError(`${prefix} requires session and identity bindings`);
  return { sessionBinding, identityKey };
}

export function createCsrfToken(secret: unknown, context: Claims | null | undefined, options: TokenOptions = {}): string {
  const bindings = requireContext(context, 'CSRF token');
  return createToken(secret, 'csrf', bindings, { ...options, ttlMs: options.ttlMs || 30 * 60 * 1000 });
}

export function verifyCsrfToken(secret: unknown, token: unknown, context: Claims | null | undefined, options: { readonly now?: number } = {}): TokenPayload {
  const bindings = requireContext(context, 'CSRF verification');
  const payload = decodeToken(secret, token, 'csrf', options);
  if (!safeEqual(payload.sessionBinding, bindings.sessionBinding) || !safeEqual(payload.identityKey, bindings.identityKey)) {
    throw new SecurityTokenError('CSRF token does not match the active session and identity', 'CSRF_INVALID');
  }
  return payload;
}

function cleanProvider(value: unknown): string {
  const provider = String(value || 'github').toLowerCase();
  if (!['github'].includes(provider)) throw new SecurityTokenError('Unsupported provider for step-up authorization', 'STEP_UP_SCOPE_INVALID', 400);
  return provider;
}

function cleanRepoPart(value: unknown, field: string): string {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 100 || !/^[a-z0-9_.-]+$/.test(text)) {
    throw new SecurityTokenError(`Invalid ${field} in step-up scope`, 'STEP_UP_SCOPE_INVALID', 400);
  }
  return text;
}

function cleanBranch(value: unknown): string {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\0-\x1f\x7f]/.test(text)) {
    throw new SecurityTokenError('Invalid branch in step-up scope', 'STEP_UP_SCOPE_INVALID', 400);
  }
  return text;
}

function cleanSha(value: unknown, required = true): string {
  const text = String(value || '').trim().toLowerCase();
  if (!text && !required) return '';
  if (!isCommitSha(text)) throw new SecurityTokenError('Invalid commit SHA in step-up scope', 'STEP_UP_SCOPE_INVALID', 400);
  return text;
}

/* The exact thing a step-up grant authorizes; its hash is what the grant is bound to. */
export type StepUpScope = Readonly<Record<string, string | number>> & { readonly provider: string };

export interface StepUpRequest {
  readonly action: StepUpActionName;
  readonly scope: StepUpScope;
}

/* Each action's scope, cleaned field by field in the order its refusals have always been reported. */
function stepUpScopeFor(action: StepUpActionName, source: Claims, provider: string, context: Claims): StepUpScope {
  switch (action) {
    case 'repository.delete':
    case 'governance.reset':
      return { provider, owner: cleanRepoPart(source.owner, 'owner'), repo: cleanRepoPart(source.repo, 'repository') };
    case 'branch.reset':
      return {
        provider,
        owner: cleanRepoPart(source.owner, 'owner'),
        repo: cleanRepoPart(source.repo, 'repository'),
        branch: cleanBranch(source.branch),
        targetSha: cleanSha(source.targetSha),
        expectedHeadSha: cleanSha(source.expectedHeadSha, false)
      };
    case 'pull.merge': {
      const pullNumber = Number(source.pullNumber);
      const method = String(source.method || 'merge').toLowerCase();
      if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0 || pullNumber > 2_147_483_647 || !MERGE_METHODS.has(method)) {
        throw new SecurityTokenError('Invalid pull request merge scope', 'STEP_UP_SCOPE_INVALID', 400);
      }
      return {
        provider,
        owner: cleanRepoPart(source.owner, 'owner'),
        repo: cleanRepoPart(source.repo, 'repository'),
        pullNumber,
        method
      };
    }
    case 'sessions.revoke-others': {
      const identityKey = String(context.identityKey || '');
      if (!identityKey) throw new SecurityTokenError('Active identity is required', 'STEP_UP_SCOPE_INVALID', 400);
      return { provider, identityKey };
    }
  }
}

export function normalizeStepUpRequest(action: unknown, requestedScope: unknown, context: Claims = {}): StepUpRequest {
  const normalizedAction = String(action || '').trim();
  if (!isStepUpAction(normalizedAction)) {
    throw new SecurityTokenError('Unsupported step-up action', 'STEP_UP_ACTION_INVALID', 400);
  }
  const source = requestedScope && typeof requestedScope === 'object' ? requestedScope as Claims : {};
  const provider = cleanProvider(context.provider);
  return { action: normalizedAction, scope: stepUpScopeFor(normalizedAction, source, provider, context) };
}

export interface StepUpGrantOptions extends TokenOptions {
  readonly jti?: string;
}

export function createStepUpGrant(secret: unknown, claims: Claims | null | undefined, options: StepUpGrantOptions = {}): string {
  const bindings = requireContext(claims, 'Step-up grant');
  const action = String(claims && claims.action || '');
  if (!STEP_UP_ACTIONS.has(action)) throw new SecurityTokenError('Unsupported step-up action', 'STEP_UP_ACTION_INVALID', 400);
  const assurance = String(claims && claims.assurance || '');
  if (!(ASSURANCE_LEVELS as readonly string[]).includes(assurance)) {
    throw new SecurityTokenError('Unsupported step-up assurance', 'STEP_UP_ASSURANCE_INVALID', 400);
  }
  const jti = String(options.jti || randomUUID());
  return createToken(secret, 'step-up', {
    ...bindings,
    action,
    scopeHash: scopeHash(claims?.scope || {}),
    assurance,
    jti
  }, { ...options, ttlMs: options.ttlMs || 5 * 60 * 1000 });
}

export function verifyStepUpGrant(secret: unknown, token: unknown, expected: Claims | null | undefined, options: { readonly now?: number } = {}): TokenPayload {
  const bindings = requireContext(expected, 'Step-up verification');
  const payload = decodeToken(secret, token, 'step-up', options);
  const expectedScopeHash = scopeHash(expected?.scope || {});
  if (!safeEqual(payload.sessionBinding, bindings.sessionBinding) ||
      !safeEqual(payload.identityKey, bindings.identityKey) ||
      !safeEqual(payload.action, String(expected?.action || '')) ||
      !safeEqual(payload.scopeHash, expectedScopeHash)) {
    throw new SecurityTokenError('Step-up grant does not match this sensitive action', 'STEP_UP_SCOPE_MISMATCH');
  }
  if (!payload.jti || !payload.assurance) throw new SecurityTokenError('Step-up grant claims are invalid', 'STEP_UP_INVALID');
  return payload;
}

/*
 * The replay guard was typed as a Map, which is a decision about where the
 * guard lives rather than about what it has to do. A Map is per-process, so
 * the guarantee it gives -- this grant is spent -- held only for the process
 * that spent it, and a second instance would have honoured the same grant
 * again. Nothing durable could be passed in to fix that, because the type
 * check refused anything that was not a Map.
 *
 * What the guard actually needs is one operation: claim this grant, and say
 * whether this caller is the one that claimed it. Expressed that way it can be
 * a Map, a table, or anything else that can answer, and the answer means the
 * same thing in every one of them.
 *
 * The operation has to be indivisible, which is the reason the old shape could
 * not simply be widened. It read the guard at the top and wrote it at the
 * bottom with the validation in between, and that is only safe while the read
 * and the write cannot be interleaved -- true of a Map in one process, false
 * of anything that has to be asked over a connection. Two requests carrying
 * one grant would both get past the read before either wrote, and both would
 * be authorized. `consumeOnce` is one call so there is no interval to
 * interleave, and the store is the thing that makes it atomic: a table does it
 * with an insert whose conflict means "already used".
 */
export const REPLAY_STORE_UNAVAILABLE = 'STEP_UP_STORE_UNAVAILABLE';

/* One claim on a single-use guard: true for the one caller that made it. */
export interface ReplayClaim {
  readonly kind: 'step-up';
  readonly key: string;
  readonly expiresAt: number;
  readonly now: number;
}
export interface ReplayStore {
  consumeOnce(claim: ReplayClaim): boolean | Promise<boolean>;
}

function replayStoreFor(store: unknown, maxEntries: number): ReplayStore {
  /* One in-process adapter, shared with the server's other single-use guards,
     so the meaning of a claim cannot drift between them. */
  if (store instanceof Map) return memorySingleUseStore(store, { maxEntries });
  if (store && typeof (store as Partial<ReplayStore>).consumeOnce === 'function') return store as ReplayStore;
  throw new TypeError('The step-up replay store must be a Map or implement consumeOnce()');
}

/*
 * The pending grant a session is holding: the identifiers the claim has to
 * match, and the moment past which it is no longer a grant at all.
 */
/*
 * A session's security state. The pending grant comes back from wherever the
 * session was stored, so it is read field by field, as anything it holds may
 * be.
 */
export interface SessionSecurityState {
  stepUp?: unknown;
}

export interface StepUpOperation {
  readonly action?: unknown;
  readonly scope?: unknown;
}

export interface ConsumeOptions {
  readonly now?: number;
  readonly replayStore?: unknown;
  readonly maxReplayEntries?: number;
}

export interface ConsumedStepUp {
  readonly action: unknown;
  readonly assurance: unknown;
  readonly authorizedAt: unknown;
}

export async function consumePendingStepUp(
  securityState: SessionSecurityState | null | undefined,
  claims: Claims | null | undefined,
  operation: StepUpOperation | null | undefined,
  { now = Date.now(), replayStore, maxReplayEntries = 5000 }: ConsumeOptions = {}
): Promise<ConsumedStepUp> {
  if (!securityState || typeof securityState !== 'object') {
    throw new TypeError('A mutable session security state is required');
  }
  const store = replayStore === undefined
    ? null
    : replayStoreFor(replayStore, Math.max(100, Number(maxReplayEntries) || 5000));
  const currentTime = Number(now);
  const grantId = String(claims && claims.jti || '');

  /*
   * Validation comes first, and nothing reaches the store until it passes. A
   * claim that names another action, another scope, or no grant at all is not
   * this session's grant, and spending a guard entry on it would let anyone
   * who can reach the route burn a grant its owner is still entitled to use.
   */
  const pending = securityState.stepUp;
  const expectedScopeHash = scopeHash(operation && operation.scope || {});
  const valid = pending && grantId &&
    safeEqual(property(pending, 'jti'), grantId) &&
    safeEqual(property(pending, 'action'), operation && operation.action) &&
    safeEqual(property(pending, 'scopeHash'), expectedScopeHash) &&
    Number(property(pending, 'expiresAt') || 0) >= currentTime;
  if (!valid || !pending) {
    throw new SecurityTokenError('Step-up authorization is missing, expired, or already used', 'STEP_UP_REPLAY');
  }

  if (store) {
    let claimed: boolean;
    try {
      claimed = await store.consumeOnce({
        kind: 'step-up',
        key: grantId,
        expiresAt: Math.max(Number(claims?.exp || 0), Number(property(pending, 'expiresAt') || 0)),
        now: currentTime
      });
    } catch (error) {
      /*
       * A guard that cannot answer has not said this grant is unspent, so the
       * only safe reading is to refuse. It is reported as unavailable rather
       * than as a replay because they are different facts: one says try again,
       * the other says this grant is finished, and telling a caller its valid
       * grant is spent because a database blinked would be a lie it cannot
       * recover from.
       */
      if (error instanceof SecurityTokenError) throw error;
      throw new SecurityTokenError(
        'Step-up authorization cannot be verified right now', REPLAY_STORE_UNAVAILABLE, 503
      );
    }
    if (!claimed) {
      throw new SecurityTokenError('Step-up authorization is missing, expired, or already used', 'STEP_UP_REPLAY');
    }
  }

  /* Only now: the grant is claimed, so clearing the pending state cannot lose
     an authorization that was never spent. */
  securityState.stepUp = null;
  return {
    action: operation?.action,
    assurance: claims?.assurance,
    authorizedAt: claims?.iat
  };
}

/* The parts of a request that decide whether it needs a step-up grant. */
export interface SensitiveRequest {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly params?: Claims | null;
  readonly body?: Claims | null;
  readonly provider?: unknown;
  readonly identityKey?: unknown;
}

export function sensitiveOperationFor(request: SensitiveRequest = {}): StepUpRequest | null {
  const method = String(request.method || '').toUpperCase();
  const path = String(request.path || '');
  const params = request.params || {};
  const body = request.body || {};
  const context = { provider: request.provider, identityKey: request.identityKey };

  if (method === 'DELETE' && /^\/api\/repo\/[^/]+\/[^/]+$/.test(path)) {
    return normalizeStepUpRequest('repository.delete', { owner: params.owner, repo: params.repo }, context);
  }
  if (method === 'POST' && /^\/api\/repo\/[^/]+\/[^/]+\/reset$/.test(path)) {
    return normalizeStepUpRequest('branch.reset', {
      owner: params.owner, repo: params.repo, branch: body.branch,
      targetSha: body.sha, expectedHeadSha: body.expectedHeadSha
    }, context);
  }
  if (method === 'PUT' && /^\/api\/repo\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) {
    return normalizeStepUpRequest('pull.merge', {
      owner: params.owner, repo: params.repo, pullNumber: params.num, method: body.method
    }, context);
  }
  /* Clearing a repository's governance re-authenticates first, like deleting
     the repository does: one request switches off everything that protects it. */
  if (method === 'POST' && /^\/api\/repo\/[^/]+\/[^/]+\/governance\/reset$/.test(path)) {
    return normalizeStepUpRequest('governance.reset', { owner: params.owner, repo: params.repo }, context);
  }
  if (method === 'POST' && (path === '/api/security/revoke-others' || /^\/api\/repo\/[^/]+\/[^/]+\/emergency-manifest$/.test(path))) {
    return normalizeStepUpRequest('sessions.revoke-others', {}, context);
  }
  return null;
}
