/* Nebulaverse-X private offline cache policy — deterministic and testable. */

export const OFFLINE_CACHE_CONTRACT_VERSION = 1;
/* The cache's own schema, part of every cache name: raising it orphans every cache written under the old one. */
export const CACHE_SCHEMA = 'v1';
/* The binding the page asks for and the server confirms: whose cache, and which repository's. */
export const OFFLINE_SCOPE_HEADER = 'x-nv-offline-scope';
export const OFFLINE_REPO_HEADER = 'x-nv-offline-repo';
export const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 100;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SCOPE_RX = /^[A-Za-z0-9_-]{16,64}$/;
const REPO_KEY_RX = /^(?:account|github:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/i;

/*
 * What is never kept, wherever in a route it is named. A repository's owner
 * and name are the reader's, and may be any of these words, so they are read
 * past: a repository called `governance` is cached like any other, while its
 * governance routes are not.
 */
const SENSITIVE: readonly RegExp[] = [
  /^\/api\/(?:login|logout|me|accounts|session|security|oauth|notifications|config)(?:\/|$)/,
  /\/governance(?:\/|$)/,
  /\/(?:raw|zip|star)(?:\/|$)/,
  /\/(?:activity|audit-deps|refs-snapshot|signed-snapshot|signed-snapshots|snapshot|snapshot-compare|restore-preview|restore|reset|evidence|access-surface|emergency-manifest|intelligence|live-events)(?:\/|$)/
];
const CACHEABLE: readonly RegExp[] = [
  /^\/api\/repos(?:\/|$)/,
  /^\/api\/repo\/[^/]+\/[^/]+(?:\/)?$/,
  /^\/api\/repo\/[^/]+\/[^/]+\/(?:tree|files|file|commits|commit\/[^/]+|compare|search|pulls(?:\/\d+)?|issues(?:\/\d+)?|releases|actions(?:\/[^/]+\/jobs)?)(?:\/|$)/
];

/* What a request is to the worker: left alone, sent to the network only, or kept in the account's private cache. */
export type CacheDecision =
  | { readonly mode: 'bypass' }
  | { readonly mode: 'network-only' }
  | { readonly mode: 'private-cache'; readonly scope: string; readonly repoKey: string; readonly cacheName: string };

/* The two halves of a Request and a Response the policy reads; a real URL and Headers satisfy them. */
export interface RequestUrl { readonly pathname?: string }
export interface HeaderReader { get(name: string): string | null }

export function validScope(value: unknown): boolean { return SCOPE_RX.test(String(value || '')); }
export function validRepoKey(value: unknown): boolean { return REPO_KEY_RX.test(String(value || '')); }
export function cacheNameForScope(scope: unknown): string { return validScope(scope) ? `nv-api-${CACHE_SCHEMA}-${scope}` : ''; }
export function isFresh(cachedAt: unknown, now: number = Date.now()): boolean {
  const timestamp = Number(cachedAt);
  return Number.isFinite(timestamp) && timestamp > 0 && now - timestamp <= TTL_MS;
}

function readHeader(headers: unknown, name: string): string {
  const reader = headers as Partial<HeaderReader> | null | undefined;
  return reader && typeof reader.get === 'function' ? reader.get(name) || '' : '';
}

export function classifyApiRequest(url: RequestUrl | null | undefined, method: unknown, headers: unknown): CacheDecision {
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') return { mode: 'bypass' };
  const pathname = url && url.pathname ? url.pathname : '';
  if (!pathname.startsWith('/api/')) return { mode: 'bypass' };
  const route = pathname.replace(/^\/api\/repo\/[^/]+\/[^/]+(?=\/|$)/, '/api/repo/:owner/:repo');
  if (SENSITIVE.some(rx => rx.test(route))) return { mode: 'network-only' };
  const scope = readHeader(headers, OFFLINE_SCOPE_HEADER);
  const repoKey = readHeader(headers, OFFLINE_REPO_HEADER);
  if (!validScope(scope) || !validRepoKey(repoKey)) return { mode: 'network-only' };
  if (!CACHEABLE.some(rx => rx.test(pathname))) return { mode: 'network-only' };
  return { mode: 'private-cache', scope, repoKey, cacheName: cacheNameForScope(scope) };
}

export function responseMatchesBinding(headers: unknown, decision: CacheDecision | null | undefined): boolean {
  const reader = headers as Partial<HeaderReader> | null | undefined;
  if (!reader || typeof reader.get !== 'function' || !decision || decision.mode !== 'private-cache') return false;
  if (!validScope(decision.scope) || !validRepoKey(decision.repoKey)) return false;
  return reader.get(OFFLINE_SCOPE_HEADER) === decision.scope
    && reader.get(OFFLINE_REPO_HEADER) === decision.repoKey;
}
