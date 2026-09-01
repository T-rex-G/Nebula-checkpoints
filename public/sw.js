/* Nebulaverse-X service worker — versioned shell + opt-in scoped private reads. */
'use strict';
importScripts('/offline-cache-policy.js?v=__NV_ASSET_VERSION__');
const RELEASE_VERSION = '__NV_VERSION__';
const VER = 'v__NV_ASSET_VERSION__';
const STATIC = `nv-static-${VER}`;
const POLICY = self.NebulaOfflineCachePolicy;
const PRECACHE = [
  '/', `/style.css?v=__NV_ASSET_VERSION__`, `/offline-cache-policy.js?v=__NV_ASSET_VERSION__`,
  `/archive-safety.js?v=__NV_ASSET_VERSION__`, `/export-safety.js?v=__NV_ASSET_VERSION__`,
  `/app.js?v=__NV_ASSET_VERSION__`, `/alpha-ui.js?v=__NV_ASSET_VERSION__`, `/capability-ui.js?v=__NV_ASSET_VERSION__`, `/trust-ui.js?v=__NV_ASSET_VERSION__`,
  `/repo-sigil.js?v=__NV_ASSET_VERSION__`,
  `/workspace-pulse.js?v=__NV_ASSET_VERSION__`, `/nebula-visuals.js?v=__NV_ASSET_VERSION__`,
  `/governance-ui.js?v=__NV_ASSET_VERSION__`, `/neural.js?v=__NV_ASSET_VERSION__`,
  '/manifest.webmanifest', '/assets/icon.svg', '/assets/icon-192.png'
];
const FONTS = [
  '/vendor/fonts/archivo-variable-latin.woff2',
  '/vendor/fonts/public-sans-variable-latin.woff2',
  '/vendor/fonts/jetbrains-mono-variable-latin.woff2'
];
/*
 * three.js and the artwork modules are deliberately absent from both lists.
 * They are about 750KB, and warming them would spend that on every install --
 * including installs by readers who never open a screen that draws them. The
 * static branch of the fetch handler caches them on first use instead, so a
 * reader who has seen the artwork keeps it offline and a reader who has not
 * never pays for it.
 */
const VENDOR_WARM = [
  ...FONTS,
  '/vendor/codemirror/5.65.16/codemirror.min.js',
  '/vendor/codemirror/5.65.16/codemirror.min.css',
  '/vendor/codemirror/5.65.16/mode/meta.min.js',
  '/vendor/codemirror/5.65.16/addon/search/searchcursor.min.js',
  '/vendor/marked/15.0.12/marked.min.js',
  '/vendor/dompurify/3.4.13/purify.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC).then(cache => cache.addAll(PRECACHE)).then(async () => {
    const cache = await caches.open(STATIC);
    await Promise.allSettled(VENDOR_WARM.map(async url => {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) await cache.put(url, response);
    }));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key =>
      (key.startsWith('nv-static-') && key !== STATIC) ||
      key === 'nv-api-perm' ||
      key === 'nv-api'
    ).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'NV_PURGE_PRIVATE_DATA') return;
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('nv-api-')).map(key => caches.delete(key))
  )));
});

function offlineError(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function metadataResponse(response, body, cachedAt) {
  const headers = new Headers(response.headers);
  headers.set('X-NV-Cached-At', String(cachedAt));
  headers.set('X-NV-Cache-Bytes', String(body.byteLength));
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheEligibleResponse(decision, request, response) {
  if (!response.ok || response.status !== 200) return;
  if (!POLICY.responseMatchesBinding(response.headers, decision)) return;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json') && !contentType.startsWith('text/')) return;
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > POLICY.MAX_RESPONSE_BYTES) return;
  const body = await response.clone().arrayBuffer();
  if (body.byteLength > POLICY.MAX_RESPONSE_BYTES) return;
  const cache = await caches.open(decision.cacheName);
  await cache.put(request, metadataResponse(response, body, Date.now()));
  await prunePrivateCache(decision.cacheName);
}

async function prunePrivateCache(cacheName) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const entries = [];
  let total = 0;
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    const cachedAt = Number(response.headers.get('x-nv-cached-at') || 0);
    const bytes = Number(response.headers.get('x-nv-cache-bytes') || 0);
    if (!POLICY.isFresh(cachedAt)) {
      await cache.delete(key);
      continue;
    }
    const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
    entries.push({ key, cachedAt, bytes: safeBytes });
    total += safeBytes;
  }
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  while (entries.length > POLICY.MAX_ENTRIES || total > POLICY.MAX_TOTAL_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    await cache.delete(oldest.key);
    total -= oldest.bytes;
  }
}

async function cachedFallback(cacheName, request) {
  const cache = await caches.open(cacheName);
  const response = await cache.match(request);
  if (!response) return null;
  const cachedAt = Number(response.headers.get('x-nv-cached-at') || 0);
  if (!POLICY.isFresh(cachedAt)) {
    await cache.delete(request);
    return null;
  }
  return response;
}

async function privateNetworkFirst(request, decision) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) cacheEligibleResponse(decision, request, response).catch(() => {});
    return response;
  } catch {
    return await cachedFallback(decision.cacheName, request) || offlineError('You are offline and this repository view is not cached');
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    const decision = POLICY.classifyApiRequest(url, request.method, request.headers);
    if (decision.mode === 'bypass') return;
    if (decision.mode === 'private-cache') {
      event.respondWith(privateNetworkFirst(request, decision));
      return;
    }
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => offlineError('This view requires a live connection')));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(STATIC);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  })));
});
