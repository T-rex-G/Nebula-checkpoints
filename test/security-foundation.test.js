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
const consumed = consumePendingStepUp(pendingState, grantClaims, normalizedDelete, { now: now + 20_000 });
assert.strictEqual(consumed.assurance, 'credential');
assert.strictEqual(pendingState.stepUp, null, 'a consumed grant must be removed before the sensitive action executes');
assert.throws(
  () => consumePendingStepUp(pendingState, grantClaims, normalizedDelete, { now: now + 20_000 }),
  error => error && error.code === 'STEP_UP_REPLAY',
  'the same grant must not be reusable'
);

const sharedReplayStore = new Map();
const concurrentStateA = { stepUp: { ...pendingState.stepUp, jti: grantClaims.jti, action: normalizedDelete.action, scopeHash: security.scopeHash(normalizedDelete.scope), expiresAt: now + 300_000 } };
const concurrentStateB = { stepUp: { ...concurrentStateA.stepUp } };
consumePendingStepUp(concurrentStateA, grantClaims, normalizedDelete, { now: now + 20_000, replayStore: sharedReplayStore });
assert.throws(
  () => consumePendingStepUp(concurrentStateB, grantClaims, normalizedDelete, { now: now + 20_000, replayStore: sharedReplayStore }),
  error => error && error.code === 'STEP_UP_REPLAY',
  'parallel copies of the same session must not consume one grant twice'
);

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

console.log('security foundation unit tests passed');
