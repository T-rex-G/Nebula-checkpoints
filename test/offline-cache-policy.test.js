'use strict';
const assert = require('assert');
const policy = require('../public/offline-cache-policy');

assert.strictEqual(policy.TTL_MS, 24 * 60 * 60 * 1000);
assert.strictEqual(policy.MAX_ENTRIES, 100);
assert.strictEqual(policy.MAX_RESPONSE_BYTES, 1024 * 1024);
assert.strictEqual(policy.MAX_TOTAL_BYTES, 25 * 1024 * 1024);
assert.strictEqual(policy.validScope('abcDEF0123_-xyz987654321'), true);
assert.strictEqual(policy.validScope('shared'), false);

const headers = new Headers({
  'x-nv-offline-scope': 'abcDEF0123_-xyz987654321',
  'x-nv-offline-repo': 'github:acme/demo'
});
function classify(path, method = 'GET', custom = headers) {
  return policy.classifyApiRequest(new URL(`https://app.example${path}`), method, custom);
}

assert.deepStrictEqual(classify('/api/repo/acme/demo/tree?path=&ref=main').mode, 'private-cache');
assert.deepStrictEqual(classify('/api/repo/acme/demo/file?path=README.md&ref=main').mode, 'private-cache');
assert.deepStrictEqual(classify('/api/repo/acme/demo/commits?ref=main&page=1').mode, 'private-cache');
assert.deepStrictEqual(classify('/api/repos?page=1').mode, 'private-cache');

const decision = classify('/api/repo/acme/demo/tree?path=&ref=main');
assert.strictEqual(policy.responseMatchesBinding(new Headers({
  'x-nv-offline-scope': decision.scope,
  'x-nv-offline-repo': decision.repoKey
}), decision), true);
assert.strictEqual(policy.responseMatchesBinding(new Headers({
  'x-nv-offline-scope': 'differentScope_1234567890',
  'x-nv-offline-repo': decision.repoKey
}), decision), false, 'a response for a new session must not enter the stale session cache');
assert.strictEqual(policy.responseMatchesBinding(new Headers({
  'x-nv-offline-scope': decision.scope,
  'x-nv-offline-repo': 'github:acme/other'
}), decision), false, 'a response for another repository must not enter this repository cache');
assert.strictEqual(policy.responseMatchesBinding(new Headers(), decision), false);
assert.strictEqual(policy.responseMatchesBinding(new Headers({
  'x-nv-offline-scope': decision.scope,
  'x-nv-offline-repo': decision.repoKey
}), { ...decision, mode: 'network-only' }), false,
'a network-only decision must never become cacheable even when its response headers match');

for (const path of [
  '/api/session', '/api/me', '/api/accounts', '/api/notifications',
  '/api/repo/acme/demo/raw?path=a.bin', '/api/repo/acme/demo/zip',
  '/api/security/sessions', '/api/repo/acme/demo/evidence',
  '/api/repo/acme/demo/restore-preview', '/api/repo/acme/demo/live-events/stream',
  '/api/repo/acme/demo/governance/digital-twin', '/api/repo/acme/demo/governance/policies'
]) assert.strictEqual(classify(path).mode, 'network-only', path);

assert.strictEqual(classify('/api/repo/acme/demo/tree', 'POST').mode, 'bypass');
assert.strictEqual(classify('/api/repo/acme/demo/tree', 'GET', new Headers()).mode, 'network-only');
assert.strictEqual(policy.CACHE_SCHEMA, 'v1');
assert.strictEqual(policy.cacheNameForScope('abcDEF0123_-xyz987654321'), 'nv-api-v1-abcDEF0123_-xyz987654321');
assert.strictEqual(policy.cacheNameForScope('bad'), '');
assert.strictEqual(policy.isFresh(Date.now() - policy.TTL_MS + 1000, Date.now()), true);
assert.strictEqual(policy.isFresh(Date.now() - policy.TTL_MS - 1000, Date.now()), false);

const swSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sw.js'), 'utf8');
assert(swSource.includes("key === 'nv-api-perm'"), 'service worker must delete the legacy shared private cache during activation');
assert(swSource.includes("key === 'nv-api'"), 'service worker must delete the earlier unscoped API cache during activation');
assert(swSource.includes('POLICY.responseMatchesBinding(response.headers, decision)'),
  'service worker must require a server-verified response binding before caching');
const serverSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const offlineBoundaryStart = serverSource.indexOf('/* Private offline reads are opt-in');
const offlineBoundaryEnd = serverSource.indexOf('/* Browser request boundary', offlineBoundaryStart);
assert(offlineBoundaryStart >= 0 && offlineBoundaryEnd > offlineBoundaryStart,
  'server must retain the bounded private offline response middleware');
const offlineBoundary = serverSource.slice(offlineBoundaryStart, offlineBoundaryEnd);
assert(offlineBoundary.includes("res.setHeader('Cache-Control', 'no-store')"));
assert(offlineBoundary.includes("res.setHeader('X-NV-Offline-Scope', binding.scope)"));
assert(offlineBoundary.includes("res.setHeader('X-NV-Offline-Repo', binding.repoKey)"));
assert(serverSource.includes("decision.scope !== expectedScope || decision.repoKey !== expectedRepoKey"));
console.log('offline cache policy tests passed');
