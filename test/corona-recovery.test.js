'use strict';

/*
 * Reference recovery and emergency containment, through Corona's snapshot
 * routes and recovery service: an old grant to reset a branch is refused
 * before any provider call, a preview never offers a force update, only
 * create-if-absent restores run and each grant is spent once, a branch
 * created after the preflight is never overwritten, and a hosted alpha's
 * identity-wide containment fails before anything is captured or changed.
 */
const assert = require('assert');
const crypto = require('crypto');
const { compareSnapshots, createRecovery, registerSnapshotRoutes } = require('../apps/api/src/modules/corona/index.ts');

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const routePrefix = '/api/repo/:owner/:repo';
const identity = 'fixture-identity';
/* A seal any grant survives intact: the routes are under test, not the session's encryption. */
const seal = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const unseal = value => { try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { return null; } };

function fixture(options = {}) {
  const handlers = new Map();
  const effects = [];
  const heads = new Map([['main', A]]);
  const persistedSafety = {};
  const req = { params: { owner: 'alice', repo: 'demo' }, gh: { provider: 'github' }, body: {}, session: {} };
  const gh = async (_account, apiPath, input = {}) => {
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
  };
  /* With a database, grants are claimed in the store every instance shares; without one, in this instance's memory. */
  const recovery = createRecovery({
    gh, seal, unseal, identityKey: () => identity, databaseConfigured: Boolean(options.durable),
    durableSingleUse: () => options.durable || assert.fail('without a database the grants are this instance\'s'), manifestMax: 10000
  });
  const pass = () => {};
  registerSnapshotRoutes({
    get: (route, ...callbacks) => handlers.set(route, callbacks.at(-1)),
    post: (route, ...callbacks) => handlers.set(route, callbacks.at(-1))
  }, {
    providerSessionAccess: pass, alphaRepositoryAccess: pass, capabilityAccess: () => pass, auth: pass, mutationContext: () => pass,
    account: request => request.gh,
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code, error: error.message }),
    gh,
    /* The provider's references are the fixture's heads: capture and comparison read them directly. */
    recovery: {
      ...recovery,
      captureRefsSnapshot: async () => { effects.push(['capture']); return { refs: [{ name: 'main', sha: A }] }; },
      compareWith: async (_target, baseline) => {
        const current = { owner: 'alice', repo: 'demo', provider: 'github', refs: [...heads].map(([name, sha]) => ({ name, sha })) };
        return { baseline, current, comparison: compareSnapshots(baseline, current) };
      }
    },
    dbReady: async () => false, pool: () => assert.fail('no database'), identityKey: () => identity,
    scopedEvidenceKey: () => 'evidence', appendEvidence: async () => null,
    signatures: { sign: () => 'synthetic', verify: () => ({ valid: true, keyId: 'fixture' }), activeKeyId: 'fixture' },
    retentionCount: 50, safetyOf: () => ({ readOnly: options.readOnly === true }), protectedPatternsForReq: () => options.protectedPatterns || [],
    alphaEnabled: options.alpha === true,
    savePersistentSafety: async (_req, safety) => { effects.push(['safety-save']); Object.assign(persistedSafety, safety); return safety; },
    saveSessionSafetyCopy: async () => { effects.push(['session-save']); },
    sessionsForIdentity: async () => ({ available: false, rows: [] }),
    revokeContainedSessions: async () => [], closeLiveSessions: () => 0,
    retainedActor: () => 'fixture-operator',
    executionSnapshot: () => null
  });
  async function call(suffix, body) {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get(`${routePrefix}/${suffix}`)({ ...req, body }, response);
    return { status: response.statusCode, body: response.body };
  }
  function oldGrant(actions) {
    return seal({ kind: 'nebulaverse-restore-authorization', version: 1, expiresAt: Date.now() + 300000,
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
  /* The same preview while read-only mode is on, or while a path is protected: shown, with the reason, and nothing granted. */
  for (const [held, pattern] of [[{ readOnly: true }, /read-only mode is active/], [{ protectedPatterns: ['docs/**'] }, /protected-path policies are active/]]) {
    const guarded = fixture(held);
    const shown = await guarded.call('restore-preview', {
      snapshot: { kind: 'nebulaverse-snapshot', owner: 'alice', repo: 'demo', provider: 'github', refs: [{ name: 'main', sha: A }, { name: 'restored', sha: C }] }
    });
    assert.deepStrictEqual([shown.status, shown.body.canRestore, shown.body.authorization], [200, false, ''], JSON.stringify(held));
    assert(shown.body.warnings.some(warning => pattern.test(warning)), JSON.stringify(held));
    assert.deepStrictEqual(guarded.effects.filter(([kind, method]) => kind === 'provider' && method !== 'GET'), [], 'a preview writes nothing');
  }
  const restored = await recreate.call('restore-refs', { confirm: 'RESTORE', authorization: safePreview.body.authorization });
  assert.strictEqual(restored.body.ok, true);
  assert.strictEqual(restored.body.partialFailure, false, 'all of it went through');
  assert.strictEqual(recreate.heads.get('restored'), C);
  assert.strictEqual(recreate.heads.get('main'), A);
  recreate.heads.delete('restored');
  const replay = await recreate.call('restore-refs', { confirm: 'RESTORE', authorization: safePreview.body.authorization });
  assert.strictEqual(replay.body.code, 'RESTORE_AUTHORIZATION_REPLAY');
  assert.strictEqual(recreate.effects.filter(([kind, method]) => kind === 'provider' && method === 'POST').length, 1);

  /* Only the product's own snapshots are recovered from -- a snapshot or a signed emergency manifest -- and anything else is refused before the provider is read. */
  {
    const reads = [];
    const recovery = createRecovery({
      gh: async (...args) => { reads.push(args); return []; }, seal, unseal, identityKey: () => identity, databaseConfigured: false,
      durableSingleUse: () => assert.fail('no grants here'), manifestMax: 10000
    });
    const target = { account: { provider: 'github' }, owner: 'alice', repo: 'demo' };
    const snapshot = kind => ({ kind, owner: 'alice', repo: 'demo', provider: 'github', refs: [] });
    for (const kind of ['nebulaverse-snapshot', 'nebulaverse-emergency-manifest']) assert.strictEqual(recovery.validateSnapshot(target, snapshot(kind)).kind, kind);
    for (const kind of ['nebulaverse-evidence', 'nebulaverse-restore-preview', 'NEBULAVERSE-SNAPSHOT', 'nebulaverse-snapshot ', '', undefined]) {
      await assert.rejects(recovery.compareWith(target, snapshot(kind)), error => error.code === 'SNAPSHOT_KIND_INVALID' && error.status === 400, String(kind));
    }
    assert.deepStrictEqual(reads, [], 'refused before the provider is read');
  }

  const racedCreate = fixture({ raceAfterRead: 'restored' });
  const raced = await racedCreate.call('restore-refs', {
    confirm: 'RESTORE', authorization: racedCreate.oldGrant([{ name: 'restored', action: 'recreate', from: '', to: C }])
  });
  assert.strictEqual(raced.body.ok, false, 'provider create-if-absent must reject a branch created after preflight');
  assert.strictEqual(raced.body.partialFailure, false, 'none of it went through, which is no partial failure');
  assert.strictEqual(racedCreate.heads.get('restored'), B, 'a raced branch must never be overwritten');
  assert(!racedCreate.effects.some(([kind, method]) => kind === 'provider' && method === 'PATCH'));
  /* A preview gone stale is refused before the claim, so its authorization is left unspent for when it is current again. */
  const stale = fixture();
  const staleGrant = stale.oldGrant([{ name: 'late', action: 'recreate', from: '', to: C }]);
  stale.heads.set('late', B);
  const refusedStale = await stale.call('restore-refs', { confirm: 'RESTORE', authorization: staleGrant });
  assert.deepStrictEqual([refusedStale.status, refusedStale.body.code], [409, 'RESTORE_PREVIEW_STALE'], 'a branch created since the preview makes it stale');
  stale.heads.delete('late');
  const current = await stale.call('restore-refs', { confirm: 'RESTORE', authorization: staleGrant });
  assert.strictEqual(current.body.ok, true, 'and the authorization was not spent on it');

  /* With a database, the shared store says whether a grant is spent: one that cannot answer refuses, and memory never stands in. */
  let durableAnswers = [new Error('database blinked')];
  const outage = fixture({ durable: { consumeOnce: async () => { const next = durableAnswers.shift(); if (next instanceof Error) throw next; return next; } } });
  const outageGrant = outage.oldGrant([{ name: 'fresh', action: 'recreate', from: '', to: C }]);
  const unavailable = await outage.call('restore-refs', { confirm: 'RESTORE', authorization: outageGrant });
  assert.deepStrictEqual([unavailable.status, unavailable.body.code], [503, 'RESTORE_AUTHORIZATION_UNAVAILABLE'], 'a claim that cannot be verified is refused');
  assert(!outage.effects.some(([kind, method]) => kind === 'provider' && method === 'POST'), 'and nothing is written');
  durableAnswers = [false];
  const spentElsewhere = await outage.call('restore-refs', { confirm: 'RESTORE', authorization: outageGrant });
  assert.strictEqual(spentElsewhere.body.code, 'RESTORE_AUTHORIZATION_REPLAY', 'a grant another instance spent is refused here too');
  durableAnswers = [true];
  const claimed = await outage.call('restore-refs', { confirm: 'RESTORE', authorization: outageGrant });
  assert.strictEqual(claimed.body.ok, true, 'and one the store grants goes through');

  /* A restore some of whose branches are recreated and some refused reports each, and says it was partial. */
  const mixed = fixture({ raceAfterRead: 'restored' });
  const partial = await mixed.call('restore-refs', {
    confirm: 'RESTORE', authorization: mixed.oldGrant([{ name: 'restored', action: 'recreate', from: '', to: C }, { name: 'fresh', action: 'recreate', from: '', to: C }])
  });
  assert.deepStrictEqual([partial.body.ok, partial.body.partialFailure], [false, true], 'a restore that went part of the way says so');
  assert.deepStrictEqual(partial.body.report.map(item => [item.name, item.ok]), [['restored', false], ['fresh', true]], 'and reports each branch');
  assert.deepStrictEqual([mixed.heads.get('restored'), mixed.heads.get('fresh')], [B, C]);
  console.log('Corona reference recovery and alpha containment regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
