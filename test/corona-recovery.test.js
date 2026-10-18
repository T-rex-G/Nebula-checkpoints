'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { compareSnapshots, normalizeBranchName, normalizeCommitSha, referenceSha } = require('../src/intelligence');
const { memorySingleUseStore } = require('../src/single-use-store');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const routePrefix = '/api/repo/:owner/:repo';
const identity = 'fixture-identity';

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `server section ${startMarker} must exist`);
  return source.slice(start, end);
}
function routeSource(suffix, nextSuffix, nextMethod = 'post') {
  return section(`app.post('${routePrefix}/${suffix}'`, `app.${nextMethod}('${routePrefix}/${nextSuffix}'`);
}

function fixture(options = {}) {
  const handlers = new Map();
  const effects = [];
  const heads = new Map([['main', A]]);
  const persistedSafety = {};
  const req = { params: { owner: 'alice', repo: 'demo' }, gh: { provider: 'github' }, body: {}, session: {} };
  const sandbox = {
    crypto, Buffer, Map, SESSION_CONTENT_KEY: crypto.randomBytes(32), DB_URL: '',
    app: { post: (route, ...callbacks) => handlers.set(route, callbacks.at(-1)) },
    providerSessionAccess() {}, alphaRepositoryAccess() {}, auth() {},
    capabilityAccess: () => () => {}, mutationContext: () => () => {},
    requireBranchName: normalizeBranchName, requireCommitSha: normalizeCommitSha,
    identityKey: () => identity, memorySingleUseStore, referenceSha,
    R: () => '/repos/alice/demo',
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code, error: error.message }),
    cleanText: text => String(text),
    mutationGateway: { executionSnapshot: () => null },
    protectedPatternsForReq: () => [], safetyOf: () => ({ readOnly: false }),
    ALPHA_CONFIG: { enabled: options.alpha === true },
    captureRefsSnapshot: async () => { effects.push(['capture']); return { refs: [{ name: 'main', sha: A }] }; },
    savePersistentSafety: async (_req, safety) => { effects.push(['safety-save']); Object.assign(persistedSafety, safety); return safety; },
    setSession: async () => { effects.push(['session-save']); },
    sessionsForIdentity: async () => ({ available: false, rows: [] }),
    revokeContainedSessions: async () => [], closeLiveSessions: () => 0,
    retainedActor: () => 'fixture-operator', dbReady: async () => false,
    SNAPSHOT_SIGNATURES: { sign: () => 'synthetic', verify: () => ({ valid: true, keyId: 'fixture' }) },
    gh: async (_account, apiPath, input = {}) => {
      const method = input.method || 'GET';
      effects.push(['provider', method, apiPath]);
      if (method === 'GET') {
        const branch = decodeURIComponent(apiPath.split('/heads/')[1]);
        const sha = heads.get(branch);
        if (options.raceAfterRead && branch === options.raceAfterRead) heads.set(branch, B);
        if (!sha) throw Object.assign(new Error('Missing ref'), { status: 404 });
        return { object: { sha } };
      }
      if (method === 'PATCH') {
        const branch = decodeURIComponent(apiPath.split('/heads/')[1]);
        effects.push(['overwritten', heads.get(branch)]);
        heads.set(branch, input.body.sha);
        return { object: { sha: input.body.sha } };
      }
      const branch = input.body.ref.slice('refs/heads/'.length);
      if (heads.has(branch)) throw Object.assign(new Error('Reference already exists'), { status: 422 });
      heads.set(branch, input.body.sha);
      return { object: { sha: input.body.sha } };
    },
    snapshotComparisonForRequest: async (_req, baseline) => {
      const current = { owner: 'alice', repo: 'demo', provider: 'github', refs: [...heads].map(([name, sha]) => ({ name, sha })) };
      return { baseline, current, comparison: compareSnapshots(baseline, current) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(section('function seal(obj)', 'function getCookie('), sandbox);
  vm.runInContext(section('function defaultSafety(', 'async function loadPersistentSafety('), sandbox);
  vm.runInContext(section('const RESTORE_AUTH_TTL_MS', 'async function captureRefsSnapshot('), sandbox);
  vm.runInContext(routeSource('restore-preview', 'signed-snapshot'), sandbox);
  vm.runInContext(routeSource('restore-refs', 'activity', 'get'), sandbox);
  vm.runInContext(routeSource('emergency-manifest', 'signed-snapshots', 'get'), sandbox);
  async function call(suffix, body) {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get(`${routePrefix}/${suffix}`)({ ...req, body }, response);
    return { status: response.statusCode, body: response.body };
  }
  function oldGrant(actions) {
    return sandbox.seal({ kind: 'nebulaverse-restore-authorization', version: 1, expiresAt: Date.now() + 300000,
      provider: 'github', owner: 'alice', repo: 'demo', identityKey: identity, nonce: crypto.randomUUID(), actions });
  }
  return { call, oldGrant, effects, heads, persistedSafety };
}

(async () => {
  const unsafe = fixture({ raceAfterRead: 'main' });
  const authorization = unsafe.oldGrant([{ name: 'main', action: 'reset', from: A, to: C }]);
  const deniedReset = await unsafe.call('restore-refs', { confirm: 'RESTORE', authorization });
  console.log(JSON.stringify({ case: 'old-reset-grant-concurrent-head', status: deniedReset.status,
    providerCalls: unsafe.effects.filter(([kind]) => kind === 'provider').length,
    overwritten: unsafe.effects.filter(([kind]) => kind === 'overwritten'), finalHead: unsafe.heads.get('main') }));

  const preview = await fixture().call('restore-preview', {
    snapshot: { kind: 'nebulaverse-snapshot', owner: 'alice', repo: 'demo', provider: 'github', refs: [{ name: 'main', sha: C }] }
  });
  const alpha = fixture({ alpha: true });
  const deniedAlpha = await alpha.call('emergency-manifest', { confirm: 'FREEZE' });
  console.log(JSON.stringify({ case: 'hosted-alpha-emergency', status: deniedAlpha.status, effects: alpha.effects, state: alpha.persistedSafety }));

  assert.strictEqual(deniedReset.body.code, 'RESTORE_ATOMIC_RESET_UNAVAILABLE', 'an old reset grant must be refused even when its preflight head would match');
  assert(deniedReset.status >= 400 && deniedReset.status < 500);
  assert(!unsafe.effects.some(([kind]) => kind === 'provider'), 'refusal must precede any provider operation, including preflight');
  assert.strictEqual(unsafe.heads.get('main'), A);
  assert.strictEqual(preview.body.canRestore, false, 'previews must not offer a force-update path without provider compare-and-swap');
  assert.strictEqual(preview.body.authorization, '');
  assert(preview.body.warnings.some(warning => /atomic|compare.and.swap|expected.old/i.test(warning)));
  assert.strictEqual(deniedAlpha.status, 403);
  assert.strictEqual(deniedAlpha.body.code, 'ALPHA_REPOSITORY_SCOPE_REQUIRED');
  assert.deepStrictEqual(alpha.effects, [], 'unsupported global alpha containment must fail before capture or any state change');

  const recreate = fixture();
  const safePreview = await recreate.call('restore-preview', {
    snapshot: { kind: 'nebulaverse-snapshot', owner: 'alice', repo: 'demo', provider: 'github', refs: [{ name: 'main', sha: A }, { name: 'restored', sha: C }] }
  });
  assert.strictEqual(safePreview.body.canRestore, true, 'create-if-absent recovery remains available');
  const restored = await recreate.call('restore-refs', { confirm: 'RESTORE', authorization: safePreview.body.authorization });
  assert.strictEqual(restored.body.ok, true);
  assert.strictEqual(recreate.heads.get('restored'), C);
  assert.strictEqual(recreate.heads.get('main'), A);
  recreate.heads.delete('restored');
  const replay = await recreate.call('restore-refs', { confirm: 'RESTORE', authorization: safePreview.body.authorization });
  assert.strictEqual(replay.body.code, 'RESTORE_AUTHORIZATION_REPLAY');
  assert.strictEqual(recreate.effects.filter(([kind, method]) => kind === 'provider' && method === 'POST').length, 1);

  const racedCreate = fixture({ raceAfterRead: 'restored' });
  const raced = await racedCreate.call('restore-refs', {
    confirm: 'RESTORE', authorization: racedCreate.oldGrant([{ name: 'restored', action: 'recreate', from: '', to: C }])
  });
  assert.strictEqual(raced.body.ok, false, 'provider create-if-absent must reject a branch created after preflight');
  assert.strictEqual(racedCreate.heads.get('restored'), B, 'a raced branch must never be overwritten');
  assert(!racedCreate.effects.some(([kind, method]) => kind === 'provider' && method === 'PATCH'));
  console.log('Corona reference recovery and alpha containment regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
