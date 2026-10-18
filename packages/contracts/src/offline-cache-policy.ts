/* Nebulaverse-X private offline cache policy — deterministic and testable. */

export const CACHE_SCHEMA = 'v1';
export const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 100;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SCOPE_RX = /^[A-Za-z0-9_-]{16,64}$/;
const REPO_KEY_RX = /^(?:account|github:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/i;

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
  if (SENSITIVE.some(rx => rx.test(pathname))) return { mode: 'network-only' };
  const scope = readHeader(headers, 'x-nv-offline-scope');
  const repoKey = readHeader(headers, 'x-nv-offline-repo');
  if (!validScope(scope) || !validRepoKey(repoKey)) return { mode: 'network-only' };
  if (!CACHEABLE.some(rx => rx.test(pathname))) return { mode: 'network-only' };
  return { mode: 'private-cache', scope, repoKey, cacheName: cacheNameForScope(scope) };
}

export function responseMatchesBinding(headers: unknown, decision: CacheDecision | null | undefined): boolean {
  const reader = headers as Partial<HeaderReader> | null | undefined;
  if (!reader || typeof reader.get !== 'function' || !decision || decision.mode !== 'private-cache') return false;
  if (!validScope(decision.scope) || !validRepoKey(decision.repoKey)) return false;
  return reader.get('x-nv-offline-scope') === decision.scope
    && reader.get('x-nv-offline-repo') === decision.repoKey;
}
