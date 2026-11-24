/*
 * GitHub's REST API as the server calls it, and the repository archive
 * transport.
 *
 * Every call is made for a GitHub account on github.com, and every change it
 * would make is asked of the mutation gateway first (assertProviderMutation),
 * so nothing reaches the provider that the gateway has not seen. Reads are
 * conditional: a 304 answers from the last body GitHub sent for the same
 * account and path, kept in a small cache keyed by a digest that includes the
 * credential, so one account never reads another's.
 */
import { createHash } from 'node:crypto';
import { assertGithubAccount } from '../../identity-access/index.ts';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
const ETAG_CACHE_LIMIT = 400;
const REDIRECTS = [301, 302, 303, 307, 308];

/*
 * A code for a provider's own refusal, so its explanation survives.
 *
 * publicErrorBody only passes an error's message through when the error
 * carries a recognised code; anything else becomes "Operation could not be
 * completed". The GitHub helper attached no code, so every refusal GitHub
 * explained -- a workflow file rejected for want of scope, a conflict,
 * a rate limit -- reached the operator as that one sentence, and the reason
 * they had actually been given was thrown away at the last step.
 *
 * The redaction in publicErrorBody is unchanged and still runs: a message that
 * looks like it carries a credential is still suppressed. This only stops a
 * message being discarded merely for having no code.
 */
export function providerFailureCode(status: unknown): string {
  const value = Number(status);
  if (value === 401 || value === 403) return 'PROVIDER_FORBIDDEN';
  if (value === 404) return 'PROVIDER_NOT_FOUND';
  if (value === 409) return 'PROVIDER_CONFLICT';
  if (value === 422) return 'PROVIDER_REJECTED';
  if (value === 429) return 'PROVIDER_RATE_LIMITED';
  if (value >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_FAILED';
}

interface HeaderReader { get(name: string): string | null }

/*
 * GitHub answers an exhausted primary rate limit, and every secondary limit,
 * with 403 as often as with 429. Read as a 403 it told the reader their
 * credential could not do what it had just been doing, sent the deletion and
 * webhook routes into permission advice, and gave no time to try again. A
 * limit is recognised by what GitHub documents for it -- a retry-after, an
 * exhausted x-ratelimit-remaining, or its own words -- and the wait is the one
 * GitHub gives: retry-after, else the reset, else a minute. The server does not
 * retry on the reader's behalf; it says when, and the client decides.
 */
export function providerRateLimit(status: number, headers: HeaderReader, body: unknown, now: number = Date.now()): Readonly<{ retryAfterSeconds: number }> | null {
  const retryAfter = headers.get('retry-after');
  const limited = status === 429 || (status === 403 && (
    retryAfter != null || headers.get('x-ratelimit-remaining') === '0'
    || /\brate limit\b/i.test(String(body && (body as { readonly message?: unknown }).message || ''))));
  if (!limited) return null;
  let seconds = /^\d+$/.test(String(retryAfter || '').trim()) ? Number(retryAfter) : NaN;
  if (!Number.isFinite(seconds) && headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) seconds = Math.ceil(reset - now / 1000);
  }
  if (!Number.isFinite(seconds)) seconds = 60;
  return Object.freeze({ retryAfterSeconds: Math.min(Math.max(Math.trunc(seconds), 1), 3600) });
}

export interface GithubAccount {
  readonly provider?: unknown;
  readonly token?: unknown;
  readonly baseUrl?: unknown;
  readonly authMethod?: unknown;
  readonly installationId?: unknown;
}

export interface GithubRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly raw?: boolean;
  readonly accept?: string;
  readonly headers?: Record<string, string>;
  readonly redirect?: 'manual' | 'error';
  readonly timeoutMs?: number;
}

export interface GithubRestDeps {
  /* The timed fetch (platform/network/timed-fetch.ts). */
  readonly fetch: (url: string | URL, options: RequestInit, ms: number) => Promise<Response>;
  /* The mutation gateway's check, asked before any call that would change something. */
  readonly assertProviderMutation: (descriptor: { provider: string; baseUrl: unknown; method: string; apiPath: string; body: unknown }) => void;
  readonly userAgent: string;
  /* How long a raw transfer (an archive, an upload) may take. */
  readonly transferTimeoutMs: number;
  /* The GitHub App broker, told when an installation's token is refused; outside the alpha only. */
  readonly appBroker: { invalidate(installationId: unknown): void } | null;
  readonly alphaEnabled: boolean;
}

type GithubError = Error & { status?: number; body?: unknown; code?: string; retryAfterSeconds?: number };

export function createGithubRestClient(deps: GithubRestDeps) {
  const etags = new Map<string, { etag: string; body: string }>();

  /* GitHub's answer as JSON (or { raw } when it is not), or the response itself for a raw request. */
  /* Whatever a route holds as the account is handed in: a token, or an account the check below lets through. A raw request answers with the response itself. */
  function gh(account: unknown, apiPath: string, options: GithubRequestOptions & { readonly raw: true }): Promise<Response>;
  function gh(account: unknown, apiPath: string, options?: GithubRequestOptions): Promise<unknown>;
  async function gh(account: unknown, apiPath: string, options: GithubRequestOptions = {}): Promise<unknown> {
    const acct = typeof account === 'string' ? { provider: 'github', token: account } : account;
    assertGithubAccount(acct);
    const provider = 'github';
    const token = acct.token;
    const method = options.method || 'GET';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      deps.assertProviderMutation({ provider, baseUrl: acct.baseUrl, method, apiPath, body: options.body });
    }
    const cacheable = method === 'GET' && !options.raw && !options.accept;
    const key = cacheable ? createHash('sha1').update(`${provider}|${acct.baseUrl || ''}|${token}|${apiPath}`).digest('hex') : null;
    const cached = key ? etags.get(key) : null;
    const response = await deps.fetch(GITHUB_API + apiPath, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: options.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': deps.userAgent,
        ...(cached ? { 'If-None-Match': cached.etag } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: options.redirect === 'manual' ? 'manual' : 'error'
    }, options.timeoutMs || (options.raw ? deps.transferTimeoutMs : 20000));
    if (options.raw) return response;
    if (cached && response.status === 304) return JSON.parse(cached.body);
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) {
      if (!deps.alphaEnabled && acct.authMethod === 'github-app' && deps.appBroker && response.status === 401) {
        deps.appBroker.invalidate(acct.installationId);
      }
      const error: GithubError = new Error(((data && (data as { readonly message?: unknown }).message) || `GitHub error ${response.status}`) as string);
      const limit = providerRateLimit(response.status, response.headers, data);
      error.status = limit ? 429 : response.status; error.body = data;
      error.code = providerFailureCode(error.status);
      if (limit) error.retryAfterSeconds = limit.retryAfterSeconds;
      throw error;
    }
    if (key && response.headers.get('etag')) {
      if (etags.size > ETAG_CACHE_LIMIT) etags.delete(etags.keys().next().value!);
      etags.set(key, { etag: response.headers.get('etag')!, body: text });
    }
    return data;
  }

  /*
   * A repository's archive. GitHub redirects the request to codeload; the
   * redirect is followed only to codeload.github.com, for the same owner and
   * repository, with no credentials, fragment or other path in the URL, and
   * the archive is fetched from there without the account's token.
   */
  async function githubArchiveResponse(acct: GithubAccount, owner: string, repo: string, ref: string): Promise<Response> {
    if ((acct.provider || 'github') !== 'github') {
      throw Object.assign(new Error('GitHub archive transport requires a GitHub account'), { status: 400 });
    }
    const initial = await gh(acct, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`, {
      raw: true,
      redirect: 'manual'
    }) as Response;
    if (!REDIRECTS.includes(initial.status)) return initial;
    if (initial.body) await initial.body.cancel();
    const location = initial.headers.get('location');
    let target: URL;
    try { target = new URL(String(location || '')); }
    catch { throw Object.assign(new Error('GitHub archive redirect is invalid'), { status: 502 }); }
    const segments = target.pathname.split('/').filter(Boolean);
    let redirectedOwner = '';
    let redirectedRepo = '';
    try {
      redirectedOwner = decodeURIComponent(segments[0] || '');
      redirectedRepo = decodeURIComponent(segments[1] || '');
    } catch {
      throw Object.assign(new Error('GitHub archive redirect is invalid'), { status: 502 });
    }
    if (
      target.origin !== 'https://codeload.github.com' ||
      target.username ||
      target.password ||
      target.hash ||
      segments[2] !== 'legacy.zip' ||
      redirectedOwner.toLowerCase() !== String(owner).toLowerCase() ||
      redirectedRepo.toLowerCase() !== String(repo).toLowerCase()
    ) {
      throw Object.assign(new Error('GitHub archive redirect target is not trusted'), { status: 502 });
    }
    return deps.fetch(target, {
      headers: {
        Accept: 'application/zip',
        'User-Agent': deps.userAgent
      },
      redirect: 'error'
    }, deps.transferTimeoutMs);
  }

  return { gh, githubArchiveResponse };
}

export type GithubRestClient = ReturnType<typeof createGithubRestClient>;
