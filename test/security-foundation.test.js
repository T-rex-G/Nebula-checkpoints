'use strict';

const assert = require('assert');
const path = require('path');

let security = {};
try { security = require(path.join('..', 'src', 'security-foundation')); } catch {}

for (const name of [
  'createCsrfToken', 'verifyCsrfToken', 'createStepUpGrant', 'verifyStepUpGrant',
  'normalizeStepUpRequest', 'sensitiveOperationFor', 'consumePendingStepUp'
]) {
  assert.strictEqual(typeof security[name], 'function', `${name} must be implemented`);
}

const {
  createCsrfToken, verifyCsrfToken, createStepUpGrant, verifyStepUpGrant,
  normalizeStepUpRequest, sensitiveOperationFor, consumePendingStepUp
} = security;

const secret = 'security-foundation-test-secret-0123456789abcdef';
const now = 1_800_000_000_000;
const context = { sessionBinding: 'session-1', identityKey: 'identity-1' };

const csrf = createCsrfToken(secret, context, { now, ttlMs: 60_000, nonce: 'csrf-nonce-1' });
const csrfClaims = verifyCsrfToken(secret, csrf, context, { now: now + 10_000 });
assert.strictEqual(csrfClaims.kind, 'csrf');
assert.strictEqual(csrfClaims.sessionBinding, context.sessionBinding);
assert.strictEqual(csrfClaims.identityKey, context.identityKey);
assert.throws(
  () => verifyCsrfToken(secret, csrf, { ...context, identityKey: 'identity-2' }, { now: now + 10_000 }),
  error => error && error.code === 'CSRF_INVALID',
  'CSRF tokens must be identity-bound'
);
assert.throws(
  () => verifyCsrfToken(secret, csrf.slice(0, -1) + (csrf.endsWith('a') ? 'b' : 'a'), context, { now: now + 10_000 }),
  error => error && error.code === 'CSRF_INVALID',
  'tampered CSRF tokens must fail closed'
);
assert.throws(
  () => verifyCsrfToken(secret, csrf, context, { now: now + 60_001 }),
  error => error && error.code === 'CSRF_EXPIRED',
  'expired CSRF tokens must be rejected'
);

const normalizedDelete = normalizeStepUpRequest('repository.delete', { owner: 'Acme', repo: 'Demo' }, {
  provider: 'github', identityKey: 'identity-1'
});
assert.deepStrictEqual(normalizedDelete, {
  action: 'repository.delete',
  scope: { provider: 'github', owner: 'acme', repo: 'demo' }
});

const normalizedReset = normalizeStepUpRequest('branch.reset', {
  owner: 'Acme', repo: 'Demo', branch: 'Release/V1', targetSha: 'A'.repeat(40), expectedHeadSha: 'B'.repeat(40)
}, { provider: 'github', identityKey: 'identity-1' });
assert.strictEqual(normalizedReset.scope.branch, 'Release/V1');
assert.strictEqual(normalizedReset.scope.targetSha, 'a'.repeat(40));
assert.strictEqual(normalizedReset.scope.expectedHeadSha, 'b'.repeat(40));
assert.throws(
  () => normalizeStepUpRequest('unknown.action', {}, { provider: 'github', identityKey: 'identity-1' }),
  error => error && error.code === 'STEP_UP_ACTION_INVALID'
);

const grant = createStepUpGrant(secret, {
  ...context,
  action: normalizedDelete.action,
  scope: normalizedDelete.scope,
  assurance: 'credential'
}, { now, ttlMs: 300_000, jti: 'grant-1' });
const grantClaims = verifyStepUpGrant(secret, grant, {
  ...context,
  action: normalizedDelete.action,
  scope: normalizedDelete.scope
}, { now: now + 20_000 });
assert.strictEqual(grantClaims.jti, 'grant-1');
assert.strictEqual(grantClaims.assurance, 'credential');
assert.throws(
  () => verifyStepUpGrant(secret, grant, { ...context, action: 'pull.merge', scope: normalizedDelete.scope }, { now: now + 20_000 }),
  error => error && error.code === 'STEP_UP_SCOPE_MISMATCH',
  'step-up grants must be action-bound'
);
assert.throws(
  () => verifyStepUpGrant(secret, grant, { ...context, action: normalizedDelete.action, scope: { ...normalizedDelete.scope, repo: 'other' } }, { now: now + 20_000 }),
  error => error && error.code === 'STEP_UP_SCOPE_MISMATCH',
  'step-up grants must be scope-bound'
);
assert.throws(
  () => verifyStepUpGrant(secret, grant, { ...context, sessionBinding: 'session-2', action: normalizedDelete.action, scope: normalizedDelete.scope }, { now: now + 20_000 }),
  error => error && error.code === 'STEP_UP_SCOPE_MISMATCH',
  'step-up grants must be session-bound'
);
assert.throws(
  () => verifyStepUpGrant(secret, grant, { ...context, action: normalizedDelete.action, scope: normalizedDelete.scope }, { now: now + 300_001 }),
  error => error && error.code === 'STEP_UP_EXPIRED'
);

const pendingState = {
  stepUp: {
    jti: grantClaims.jti,
    action: normalizedDelete.action,
    scopeHash: security.scopeHash(normalizedDelete.scope),
    expiresAt: now + 300_000,
    assurance: 'credential'
  }
};
/*
 * Consumption is asynchronous because the store that decides it may not be in
 * this process. What the contract has to hold either way: one grant is
 * claimed exactly once, a claim that does not validate never reaches the
 * store at all, and a store that cannot answer denies rather than allows.
 */
const at = now + 20_000;

function pendingFor(claims = grantClaims, operation = normalizedDelete) {
  return {
    stepUp: {
      jti: claims.jti,
      action: operation.action,
      scopeHash: security.scopeHash(operation.scope),
      expiresAt: now + 300_000,
      assurance: 'credential'
    }
  };
}

/*
 * A store that takes time to answer and then decides atomically: the latency
 * is before the decision, so the read and the write are one indivisible step.
 * That is what a database doing INSERT .. ON CONFLICT DO NOTHING gives, and a
 * store that instead awaited between its own read and write would be the race
 * this contract exists to make impossible.
 */
function atomicStore({ delayMs = 5, fail = false } = {}) {
  const consumed = new Map();
  const store = {
    calls: 0,
    async consumeOnce({ key, expiresAt, now: currentTime }) {
      store.calls += 1;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (fail) throw new Error('replay store is unreachable');
      const until = Number(consumed.get(key) || 0);
      if (until >= currentTime) return false;
      consumed.set(key, expiresAt);
      return true;
    }
  };
  return store;
}

async function replayContract() {
  /* The in-memory Map keeps its meaning: consumed once, refused after. */
  const pendingState = pendingFor();
  const consumed = await consumePendingStepUp(pendingState, grantClaims, normalizedDelete, { now: at });
  assert.strictEqual(consumed.assurance, 'credential');
  assert.strictEqual(pendingState.stepUp, null, 'a consumed grant must be removed before the sensitive action executes');
  await assert.rejects(
    consumePendingStepUp(pendingState, grantClaims, normalizedDelete, { now: at }),
    error => error && error.code === 'STEP_UP_REPLAY',
    'the same grant must not be reusable'
  );

  const sharedReplayStore = new Map();
  await consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: sharedReplayStore });
  await assert.rejects(
    consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: sharedReplayStore }),
    error => error && error.code === 'STEP_UP_REPLAY',
    'parallel copies of the same session must not consume one grant twice'
  );

  /* A store that is not a Map but honours the contract must be accepted:
     that is the whole point, since a durable one can never be a Map. */
  const durable = atomicStore();
  const viaContract = await consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: durable });
  assert.strictEqual(viaContract.assurance, 'credential', 'a conforming store must be usable');

  /*
   * The race. Two requests carrying the same valid grant arrive together and
   * the store takes time to answer. Widening the type check without making
   * consumption one operation leaves both of them past the read before either
   * writes, and both proceed.
   */
  const contended = atomicStore({ delayMs: 15 });
  const raced = await Promise.allSettled([
    consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: contended }),
    consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: contended })
  ]);
  assert.strictEqual(
    raced.filter(result => result.status === 'fulfilled').length, 1,
    'exactly one of two racing consumers of one grant may proceed'
  );
  assert.strictEqual(
    raced.filter(result => result.status === 'rejected' && result.reason && result.reason.code === 'STEP_UP_REPLAY').length, 1,
    'the consumer that loses the race is refused as a replay'
  );

  /* A claim that does not validate must not spend anything in the store. */
  const untouched = atomicStore();
  await assert.rejects(
    consumePendingStepUp(pendingFor(), grantClaims, normalizedReset, { now: at, replayStore: untouched }),
    error => error && error.code === 'STEP_UP_REPLAY',
    'a grant for one action must not authorize another'
  );
  await assert.rejects(
    consumePendingStepUp(pendingFor(), { ...grantClaims, jti: '' }, normalizedDelete, { now: at, replayStore: untouched }),
    error => error && error.code === 'STEP_UP_REPLAY',
    'a claim with no grant id is not a grant'
  );
  await assert.rejects(
    consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: now + 400_000, replayStore: untouched }),
    error => error && error.code === 'STEP_UP_REPLAY',
    'an expired pending grant is not consumable'
  );
  assert.strictEqual(untouched.calls, 0, 'a claim that does not validate must never reach the store');

  /* A store that cannot answer denies, and leaves the grant unspent. */
  const unreachable = atomicStore({ fail: true });
  const survives = pendingFor();
  await assert.rejects(
    consumePendingStepUp(survives, grantClaims, normalizedDelete, { now: at, replayStore: unreachable }),
    error => error && error.code === 'STEP_UP_STORE_UNAVAILABLE' && error.status === 503,
    'an unavailable store must deny rather than allow, and say it is unavailable rather than a replay'
  );
  assert.notStrictEqual(survives.stepUp, null, 'a store failure must not spend the pending grant');

  /* A store that does not implement the contract is refused, not ignored. */
  await assert.rejects(
    consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: { get() {}, set() {} } }),
    error => error instanceof TypeError,
    'a store missing the contract method must be rejected rather than silently skipped'
  );

  /* The returned promise is not an authorization until it resolves. */
  const unresolved = consumePendingStepUp(pendingFor(), grantClaims, normalizedDelete, { now: at, replayStore: atomicStore() });
  assert.strictEqual(typeof unresolved.then, 'function', 'consumption is asynchronous');
  assert.strictEqual(unresolved.action, undefined, 'an unresolved promise carries no authorization');
  assert.strictEqual((await unresolved).action, normalizedDelete.action);
}

assert.deepStrictEqual(sensitiveOperationFor({
  method: 'DELETE', path: '/api/repo/acme/demo', params: { owner: 'Acme', repo: 'Demo' }, body: {},
  provider: 'github', identityKey: 'identity-1'
}), normalizedDelete);
assert.deepStrictEqual(sensitiveOperationFor({
  method: 'POST', path: '/api/repo/acme/demo/reset', params: { owner: 'Acme', repo: 'Demo' },
  body: { branch: 'Release/V1', sha: 'A'.repeat(40), expectedHeadSha: 'B'.repeat(40) },
  provider: 'github', identityKey: 'identity-1'
}), normalizedReset);
assert.deepStrictEqual(sensitiveOperationFor({
  method: 'PUT', path: '/api/repo/acme/demo/pulls/42/merge', params: { owner: 'Acme', repo: 'Demo', num: '42' },
  body: { method: 'squash' }, provider: 'github', identityKey: 'identity-1'
}), {
  action: 'pull.merge',
  scope: { provider: 'github', owner: 'acme', repo: 'demo', pullNumber: 42, method: 'squash' }
});
assert.deepStrictEqual(sensitiveOperationFor({
  method: 'POST', path: '/api/security/revoke-others', params: {}, body: {},
  provider: 'gitlab', identityKey: 'identity-1'
}), {
  action: 'sessions.revoke-others',
  scope: { provider: 'gitlab', identityKey: 'identity-1' }
});
assert.deepStrictEqual(sensitiveOperationFor({
  method: 'POST', path: '/api/repo/acme/demo/emergency-manifest', params: { owner: 'acme', repo: 'demo' }, body: { confirm: 'FREEZE' },
  provider: 'github', identityKey: 'identity-1'
}), {
  action: 'sessions.revoke-others',
  scope: { provider: 'github', identityKey: 'identity-1' }
}, 'Emergency Shield must not bypass step-up when it revokes other sessions');
assert.strictEqual(sensitiveOperationFor({ method: 'POST', path: '/api/repo/acme/demo/issues', params: {}, body: {} }), null);
assert.strictEqual(sensitiveOperationFor({ method: 'POST', path: '/api/profile/reset', params: {}, body: {} }), null, 'unrelated reset routes must not be classified as repository hard resets');

replayContract().then(() => {
  console.log('security foundation unit tests passed');
}).catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
