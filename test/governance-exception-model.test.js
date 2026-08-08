'use strict';
const assert = require('assert');
const {
  normalizeExceptionRequest,
  computeExceptionState,
  applyPolicyExceptions
} = require('../src/governance-exceptions');

const now = new Date('2026-07-22T19:00:00.000Z');
const document = {
  schemaVersion: 1,
  rules: [
    { id: 'deny-write', action: 'file.write', effect: 'deny' },
    { id: 'approval-write', action: 'file.write', effect: 'require-approval' }
  ]
};
const exception = normalizeExceptionRequest({
  kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { path: 'README.md' }, reason: 'Emergency repair',
  expiresAt: '2026-07-22T20:00:00.000Z'
}, document, now);
assert.deepStrictEqual(exception.ruleIds, ['deny-write']);
assert.strictEqual(exception.kind, 'exception');
assert.deepStrictEqual(exception.target, { path: 'README.md' });
assert.match(exception.targetHash, /^[0-9a-f]{64}$/);
assert.throws(() => normalizeExceptionRequest({ ...exception, kind: 'waiver' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_RULE_EFFECT_MISMATCH');
assert.throws(() => normalizeExceptionRequest({ ...exception, expiresAt: '2026-08-30T00:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_EXPIRY_INVALID');
assert.throws(() => normalizeExceptionRequest({ kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], reason: 'missing target', expiresAt: '2026-07-22T20:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
assert.throws(() => normalizeExceptionRequest({ kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: {}, reason: 'empty target', expiresAt: '2026-07-22T20:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
assert.throws(() => normalizeExceptionRequest({ kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { content: 'raw file body' }, reason: 'raw target', expiresAt: '2026-07-22T20:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
assert.throws(() => normalizeExceptionRequest({ kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { path: 'README.md', ref: 'github_pat_' + 'x'.repeat(24) }, reason: 'secret target', expiresAt: '2026-07-22T20:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
assert.throws(() => normalizeExceptionRequest({ kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], target: { path: 'x'.repeat(3000) }, reason: 'oversized target', expiresAt: '2026-07-22T20:00:00.000Z' }, document, now), error => error.code === 'GOVERNANCE_EXCEPTION_TARGET_INVALID');

const request = { expiresAt: '2026-07-22T20:00:00.000Z', versionId: '20000000-0000-4000-8000-000000000002', headRevision: 7 };
assert.strictEqual(computeExceptionState({ request, events: [], now, activeVersionId: request.versionId, activeHeadRevision: 7 }).status, 'pending');
assert.strictEqual(computeExceptionState({ request, events: [{ eventType: 'approve' }], now, activeVersionId: request.versionId, activeHeadRevision: 7 }).status, 'approved');
assert.strictEqual(computeExceptionState({ request, events: [{ eventType: 'approve' }, { eventType: 'revoke' }], now, activeVersionId: request.versionId, activeHeadRevision: 7 }).status, 'revoked');
assert.strictEqual(computeExceptionState({ request, events: [{ eventType: 'approve' }], now: new Date('2026-07-22T20:00:00.000Z'), activeVersionId: request.versionId, activeHeadRevision: 7 }).status, 'expired');
assert.strictEqual(computeExceptionState({ request, events: [{ eventType: 'approve' }], now, activeVersionId: '30000000-0000-4000-8000-000000000003', activeHeadRevision: 8 }).status, 'superseded');
assert.strictEqual(computeExceptionState({ request, events: [{ eventType: 'approve' }], now, activeVersionId: request.versionId, activeHeadRevision: 8 }).status, 'superseded', 'returning to the same version after any head transition must not revive an exception');

const evaluation = {
  policyId: '10000000-0000-4000-8000-000000000001',
  versionId: request.versionId,
  documentHash: 'a'.repeat(64),
  effect: 'deny',
  matchedRuleIds: ['deny-write', 'approval-write'],
  matchedRules: [
    { id: 'deny-write', effect: 'deny' },
    { id: 'approval-write', effect: 'require-approval' }
  ]
};
const applied = applyPolicyExceptions(evaluation, [{
  exceptionId: '40000000-0000-4000-8000-000000000004',
  policyId: evaluation.policyId,
  versionId: evaluation.versionId,
  documentHash: evaluation.documentHash,
  kind: 'exception', action: 'file.write', ruleIds: ['deny-write'], subjectIdentityKey: 'a'.repeat(64), target: { path: 'README.md' }, targetHash: exception.targetHash,
  expiresAt: '2026-07-22T20:00:00.000Z', approvedAt: '2026-07-22T19:05:00.000Z',
  approvedByIdentityKey: 'b'.repeat(64), approvedByLogin: 'Admin'
}], 'file.write', new Date('2026-07-22T19:10:00.000Z'), { actorIdentityKey: 'a'.repeat(64), metadata: { path: 'README.md' } });
assert.strictEqual(applied.originalEffect, 'deny');
assert.strictEqual(applied.effect, 'require-approval');
assert.deepStrictEqual(applied.waivedRuleIds, ['deny-write']);
assert.strictEqual(applied.exceptionApplications.length, 1);
assert.throws(() => applyPolicyExceptions(evaluation, [{
  exceptionId: '40000000-0000-4000-8000-000000000004', policyId: evaluation.policyId, versionId: evaluation.versionId,
  documentHash: evaluation.documentHash, kind: 'exception', action: 'file.write', ruleIds: ['deny-write'],
  subjectIdentityKey: 'a'.repeat(64), target: { path: 'README.md' }, targetHash: 'f'.repeat(64),
  expiresAt: '2026-07-22T20:00:00.000Z', approvedAt: '2026-07-22T19:05:00.000Z',
  approvedByIdentityKey: 'b'.repeat(64), approvedByLogin: 'Admin'
}], 'file.write', new Date('2026-07-22T19:10:00.000Z'), { actorIdentityKey: 'a'.repeat(64), metadata: { path: 'README.md' } }), error => error.code === 'POLICY_EXCEPTION_INVALID');

const wrongActor = applyPolicyExceptions(evaluation, [{
  exceptionId: '40000000-0000-4000-8000-000000000004', policyId: evaluation.policyId,
  versionId: evaluation.versionId, documentHash: evaluation.documentHash, kind: 'exception',
  action: 'file.write', ruleIds: ['deny-write'], subjectIdentityKey: 'a'.repeat(64),
  target: { path: 'README.md' }, targetHash: exception.targetHash,
  expiresAt: '2026-07-22T20:00:00.000Z', approvedAt: '2026-07-22T19:05:00.000Z',
  approvedByIdentityKey: 'b'.repeat(64), approvedByLogin: 'Admin'
}], 'file.write', new Date('2026-07-22T19:10:00.000Z'), { actorIdentityKey: 'c'.repeat(64), metadata: { path: 'README.md' } });
assert.deepStrictEqual(wrongActor.waivedRuleIds, [], 'exception must be bound to the verified requester identity');
const wrongTarget = applyPolicyExceptions(evaluation, [{
  exceptionId: '40000000-0000-4000-8000-000000000004', policyId: evaluation.policyId,
  versionId: evaluation.versionId, documentHash: evaluation.documentHash, kind: 'exception',
  action: 'file.write', ruleIds: ['deny-write'], subjectIdentityKey: 'a'.repeat(64),
  target: { path: 'README.md' }, targetHash: exception.targetHash,
  expiresAt: '2026-07-22T20:00:00.000Z', approvedAt: '2026-07-22T19:05:00.000Z',
  approvedByIdentityKey: 'b'.repeat(64), approvedByLogin: 'Admin'
}], 'file.write', new Date('2026-07-22T19:10:00.000Z'), { actorIdentityKey: 'a'.repeat(64), metadata: { path: 'OTHER.md' } });
assert.deepStrictEqual(wrongTarget.waivedRuleIds, [], 'exception must be bound to exact normalized mutation target metadata');
const largeRuntimeTarget = applyPolicyExceptions(evaluation, [], 'file.write', new Date('2026-07-22T19:10:00.000Z'), { actorIdentityKey: 'a'.repeat(64), metadata: { left: 'x'.repeat(1500), right: 'y'.repeat(1500) } });
assert.deepStrictEqual(largeRuntimeTarget.waivedRuleIds, [], 'the stricter persisted-target bound must not reject otherwise valid gateway metadata when no exception applies');

console.log('governance exception model tests passed');
