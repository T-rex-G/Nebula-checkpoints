/*
 * How the page asks its server: every request same-origin, uncached unless
 * asked, marked as the page's own, carrying the request-security token on
 * anything that changes state and the offline-keeping headers on the reads
 * the reader has chosen to keep. An answer that is not a success becomes an
 * error carrying what the server said of it -- its code, its correlation ID,
 * whether the provider changed anything, the state it was left in, the next
 * step and any safe route to approval -- or, where no JSON came with it,
 * what the hosting edge in front of the server meant by its status.
 *
 * The page's own reactions are handed in: a branch that moved under a write
 * reads the repository again, and an alpha session that ended or was revoked
 * clears the page before the error reaches the caller.
 */
import { APP_HEADER, APP_HEADER_VALUE, CORRELATION_HEADER, CSRF_HEADER } from '../../../../packages/contracts/src/api-envelope.ts';
import { offlineHeadersForPath, type OfflineStorage } from './offline-repos.ts';
import { field, hasFields } from './values.ts';

/* What a refused request carries, beyond its message. */
export interface RequestError extends Error {
  status: number;
  code: string;
  /* No JSON came with the answer: the hosting edge answered, not the server. */
  edge: boolean;
  retryAfter: number;
  correlationId: string;
  providerChanged: string;
  safeState: string;
  nextAction: string;
  safePassage: Readonly<Record<string, unknown>> | null;
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal | null;
  readonly cache?: RequestCache;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportDeps {
  readonly fetch: Fetch;
  /* Who is signed in: their cache scope and provider name the reads kept offline. */
  readonly identity: () => unknown;
  /* Where the offline list is kept; it may be absent, or refuse to be read. */
  readonly storage: () => OfflineStorage | null;
  readonly now: () => number;
  /* A write was refused because the branch moved: read the repository again. */
  readonly onBranchChanged: () => void;
  /* The alpha session ended or was revoked: clear the page before the error is thrown. */
  readonly onAlphaEnded: (code: string) => Promise<void>;
}

/* What a status means when the server's own JSON did not come with it. */
export function statusMessage(status: number, fromServer: boolean): string {
  if (!fromServer) {
    if (status === 429) return 'The hosting edge is limiting requests from this connection. Wait a minute, then try again.';
    if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 527)) return 'The server did not answer in time: it may be waking up or restarting. Wait a few seconds, then try again.';
  }
  return `Request failed (${status})`;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_REFUSALS: ReadonlySet<string> = new Set(['CSRF_REQUIRED', 'CSRF_INVALID', 'CSRF_EXPIRED']);
const ALPHA_ENDINGS: ReadonlySet<string> = new Set(['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED']);
/* A sign-in, sign-out or account switch: the session's token is another session's afterwards. */
const SESSION_CHANGES = /^\/api\/(?:login|logout|accounts\/(?:switch|switch-idx|remove))$/;
/* A token is renewed this long before it lapses, so no request is sent with one about to. */
const CSRF_MARGIN_MS = 30_000;

const text = (value: unknown): string => (value ? String(value) : '');

function requestError(message: string, init: Omit<RequestError, keyof Error>): RequestError {
  return Object.assign(new Error(message), init);
}

export interface Transport {
  /* Ask the server; the answer's JSON, or a RequestError. */
  api(path: string, opts?: RequestOptions): Promise<unknown>;
  /* A read answered from this page's memory while it is younger than `ttl`. */
  apiCached(path: string, ttl?: number): Promise<unknown>;
  /* The page's memory of reads: forgotten whole, or one read put in it. */
  readonly cache: { clear(): void; set(path: string, data: unknown): void };
  /* A request-security token good for at least half a minute more. */
  ensureCsrfToken(): Promise<string>;
  clearCsrfToken(): void;
}

export function createTransport(deps: TransportDeps): Transport {
  const cache = new Map<string, { readonly data: unknown; readonly at: number }>();
  /* Reads on their way, so two readers of one path at once share one request. */
  const inflight = new Map<string, Promise<unknown>>();
  /*
   * Moved on whenever the memory is forgotten, so a read that set out before
   * a write is not kept after it: its answer may be from before the write.
   */
  let cacheGeneration = 0;
  const forget = (): void => { cache.clear(); inflight.clear(); cacheGeneration++; };
  let csrfToken = '';
  let csrfExpiresAt = 0;
  let csrfRequest: Promise<string> | null = null;
  /*
   * Moved on whenever the token is forgotten, so a token asked for before a
   * sign-in, sign-out or switch is never kept after it: it would belong to
   * the session that has just ended.
   */
  let csrfGeneration = 0;

  const storage = (): OfflineStorage | null => {
    try { return deps.storage(); } catch { return null; }
  };

  function clearCsrfToken(): void {
    csrfToken = '';
    csrfExpiresAt = 0;
    csrfRequest = null;
    csrfGeneration++;
  }

  /* One request for a token at a time: a second write waits for the first's. */
  function refreshCsrfToken(): Promise<string> {
    if (csrfRequest) return csrfRequest;
    const generation = csrfGeneration;
    const request = (async () => {
      const response = await deps.fetch('/api/security/csrf', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { [APP_HEADER]: APP_HEADER_VALUE }
      });
      const data: unknown = await response.json().catch(() => ({}));
      const token = field(data, 'token');
      if (!response.ok || !token) {
        /* Only its status and code: what the server said of a write is not what it said of a token. */
        throw Object.assign(new Error(text(field(data, 'error')) || 'Unable to establish the request security context'), {
          status: response.status, code: text(field(data, 'code'))
        });
      }
      if (generation === csrfGeneration) {
        csrfToken = String(token);
        const expires = field(data, 'expiresAt') || 0;
        csrfExpiresAt = new Date(typeof expires === 'number' ? expires : String(expires)).getTime();
      }
      return String(token);
    })();
    csrfRequest = request;
    const settle = (): void => { if (csrfRequest === request) csrfRequest = null; };
    request.then(settle, settle);
    return request;
  }

  async function ensureCsrfToken(): Promise<string> {
    if (csrfToken && csrfExpiresAt - deps.now() > CSRF_MARGIN_MS) return csrfToken;
    csrfToken = '';
    csrfExpiresAt = 0;
    return refreshCsrfToken();
  }

  async function api(path: string, opts: RequestOptions = {}, allowCsrfRetry = true): Promise<unknown> {
    const method = String(opts.method || 'GET').toUpperCase();
    const unsafe = !SAFE_METHODS.has(method);
    const needsCsrf = unsafe && path !== '/api/login';
    if (unsafe) forget();
    const token = needsCsrf ? await ensureCsrfToken() : '';
    const response = await deps.fetch(path, {
      method,
      credentials: 'same-origin',
      cache: opts.cache || 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {}),
      headers: {
        ...(opts.headers || {}),
        [APP_HEADER]: APP_HEADER_VALUE,
        ...(needsCsrf ? { [CSRF_HEADER]: token } : {}),
        ...offlineHeadersForPath(path, method, deps.identity(), storage()),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
    });
    let fromServer = true;
    const data: unknown = await response.json().catch(() => { fromServer = false; return {}; });
    if (!response.ok) {
      const code = text(field(data, 'code'));
      if (allowCsrfRetry && needsCsrf && CSRF_REFUSALS.has(code)) {
        clearCsrfToken();
        return api(path, opts, false);
      }
      const safePassage = field(data, 'safePassage');
      const error = requestError(text(field(data, 'error')) || statusMessage(response.status, fromServer), {
        status: response.status,
        code,
        edge: !fromServer,
        retryAfter: Number(response.headers.get('retry-after')) || 0,
        correlationId: text(field(data, 'correlationId')) || response.headers.get(CORRELATION_HEADER) || '',
        providerChanged: text(field(data, 'providerChanged')) || 'unknown',
        safeState: text(field(data, 'safeState')),
        nextAction: text(field(data, 'nextAction')),
        safePassage: hasFields(safePassage) ? safePassage : null
      });
      if (code === 'BRANCH_CHANGED') deps.onBranchChanged();
      if (ALPHA_ENDINGS.has(code)) await deps.onAlphaEnded(code);
      throw error;
    }
    if (SESSION_CHANGES.test(path)) clearCsrfToken();
    return data;
  }

  function apiCached(path: string, ttl = 45000): Promise<unknown> {
    const hit = cache.get(path);
    if (hit && deps.now() - hit.at < ttl) return Promise.resolve(hit.data);
    const pending = inflight.get(path);
    if (pending) return pending;
    const generation = cacheGeneration;
    const request = api(path).then(data => {
      if (generation === cacheGeneration) cache.set(path, { data, at: deps.now() });
      return data;
    });
    inflight.set(path, request);
    const settle = (): void => { if (inflight.get(path) === request) inflight.delete(path); };
    request.then(settle, settle);
    return request;
  }

  return {
    api: (path, opts) => api(path, opts),
    apiCached,
    cache: { clear: forget, set: (path, data) => { cache.set(path, { data, at: deps.now() }); } },
    ensureCsrfToken,
    clearCsrfToken
  };
}
