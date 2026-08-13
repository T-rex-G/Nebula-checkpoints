/* Nebulaverse-X private offline cache policy — deterministic and testable. */
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NebulaOfflineCachePolicy = api;
})(typeof self !== 'undefined' ? self : globalThis, function createPolicy() {
  'use strict';
  const CACHE_SCHEMA = 'v1';
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 100;
  const MAX_RESPONSE_BYTES = 1024 * 1024;
  const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
  const SCOPE_RX = /^[A-Za-z0-9_-]{16,64}$/;
  const REPO_KEY_RX = /^(?:account|(?:github|gitlab|gitea):[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/i;

  const SENSITIVE = [
    /^\/api\/(?:login|logout|me|accounts|session|security|oauth|notifications|config)(?:\/|$)/,
    /\/governance(?:\/|$)/,
    /\/(?:raw|zip|star)(?:\/|$)/,
    /\/(?:activity|audit-deps|refs-snapshot|signed-snapshot|signed-snapshots|snapshot|snapshot-compare|restore-preview|restore|reset|evidence|access-surface|emergency-manifest|intelligence|live-events)(?:\/|$)/
  ];
  const CACHEABLE = [
    /^\/api\/repos(?:\/|$)/,
    /^\/api\/repo\/[^/]+\/[^/]+(?:\/)?$/,
    /^\/api\/repo\/[^/]+\/[^/]+\/(?:tree|files|file|commits|commit\/[^/]+|compare|search|pulls(?:\/\d+)?|issues(?:\/\d+)?|releases|actions(?:\/[^/]+\/jobs)?)(?:\/|$)/
  ];

  function validScope(value) { return SCOPE_RX.test(String(value || '')); }
  function validRepoKey(value) { return REPO_KEY_RX.test(String(value || '')); }
  function cacheNameForScope(scope) { return validScope(scope) ? `nv-api-${CACHE_SCHEMA}-${scope}` : ''; }
  function isFresh(cachedAt, now = Date.now()) {
    const timestamp = Number(cachedAt);
    return Number.isFinite(timestamp) && timestamp > 0 && now - timestamp <= TTL_MS;
  }
  function classifyApiRequest(url, method, headers) {
    const verb = String(method || 'GET').toUpperCase();
    if (verb !== 'GET') return { mode: 'bypass' };
    const pathname = url && url.pathname ? url.pathname : '';
    if (!pathname.startsWith('/api/')) return { mode: 'bypass' };
    if (SENSITIVE.some(rx => rx.test(pathname))) return { mode: 'network-only' };
    const scope = headers && headers.get ? headers.get('x-nv-offline-scope') : '';
    const repoKey = headers && headers.get ? headers.get('x-nv-offline-repo') : '';
    if (!validScope(scope) || !validRepoKey(repoKey)) return { mode: 'network-only' };
    if (!CACHEABLE.some(rx => rx.test(pathname))) return { mode: 'network-only' };
    return { mode: 'private-cache', scope, repoKey, cacheName: cacheNameForScope(scope) };
  }
  function responseMatchesBinding(headers, decision) {
    if (!headers || typeof headers.get !== 'function' || !decision || decision.mode !== 'private-cache') return false;
    if (!validScope(decision.scope) || !validRepoKey(decision.repoKey)) return false;
    return headers.get('x-nv-offline-scope') === decision.scope
      && headers.get('x-nv-offline-repo') === decision.repoKey;
  }

  return Object.freeze({
    CACHE_SCHEMA, TTL_MS, MAX_ENTRIES, MAX_RESPONSE_BYTES, MAX_TOTAL_BYTES,
    validScope, validRepoKey, cacheNameForScope, isFresh, classifyApiRequest, responseMatchesBinding
  });
});
