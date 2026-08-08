'use strict';
const assert = require('assert');
const { evaluateActivePolicySet, normalizePolicyDecision } = require('../src/governance-enforcement');
const { policyDocumentHash } = require('../src/governance-model');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { normalizeExceptionTarget } = require('../src/governance-exceptions');

const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true }, installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T21:00:00.000Z', reasonCode: null }
};
const descriptor = normalizeMutationDescriptor({
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file', metadata: { path: 'README.md' }, authorization
});
const document = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [
  { id: 'deny-write', action: 'file.write', effect: 'deny' },
  { id: 'approval-write', action: 'file.write', effect: 'require-approval' }
] };
const policy = {
  policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'secure',
  versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, headRevision: 1,
  document, documentHash: policyDocumentHash(document)
};
const exceptionTarget = { path: 'README.md' };
const exceptionTargetHash = normalizeExceptionTarget(exceptionTarget, 'file.write').targetHash;
function active(kind, ruleIds, expiresAt = '2026-07-22T20:00:00.000Z') {
  return {
    exceptionId: kind === 'exception' ? '30000000-0000-4000-8000-000000000003' : '40000000-0000-4000-8000-000000000004',
    policyId: policy.policyId, versionId: policy.versionId, documentHash: policy.documentHash,
    kind, action: 'file.write', ruleIds, subjectIdentityKey: 'a'.repeat(64), target: exceptionTarget, targetHash: exceptionTargetHash, expiresAt,
    approvedAt: '2026-07-22T19:00:00.000Z', approvedByIdentityKey: 'b'.repeat(64), approvedByLogin: 'Admin'
  };
}
const partial = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [policy], activeExceptions: [active('exception', ['deny-write'])], evaluatedAt: '2026-07-22T19:10:00.000Z' });
assert.strictEqual(partial.engineVersion, 2);
assert.strictEqual(partial.effectiveEffect, 'require-approval');
assert.strictEqual(partial.enforcementOutcome, 'block');
assert.strictEqual(partial.blockCode, 'POLICY_APPROVAL_REQUIRED');
assert.deepStrictEqual(partial.policyEvaluations[0].waivedRuleIds, ['deny-write']);
assert.doesNotThrow(() => normalizePolicyDecision(partial, descriptor));

const all = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [policy], activeExceptions: [active('exception', ['deny-write']), active('waiver', ['approval-write'])], evaluatedAt: '2026-07-22T19:10:00.000Z' });
assert.strictEqual(all.effectiveEffect, 'allow');
assert.strictEqual(all.enforcementOutcome, 'allow');
assert(all.warningCodes.includes('POLICY_EXCEPTION_APPLIED'));
assert.deepStrictEqual(all.policyEvaluations[0].waivedRuleIds, ['approval-write', 'deny-write']);


const futureApproval = evaluateActivePolicySet({
  scope: authorization.scope,
  descriptor,
  activePolicies: [policy],
  activeExceptions: [{ ...active('exception', ['deny-write']), approvedAt: '2026-07-22T19:20:00.000Z' }],
  evaluatedAt: '2026-07-22T19:10:00.000Z'
});
assert.strictEqual(futureApproval.effectiveEffect, 'deny', 'an exception must not apply before its approval timestamp');
assert.deepStrictEqual(futureApproval.policyEvaluations[0].waivedRuleIds, []);

const expired = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [policy], activeExceptions: [active('exception', ['deny-write'], '2026-07-22T19:00:00.000Z')], evaluatedAt: '2026-07-22T19:10:00.000Z' });
assert.strictEqual(expired.effectiveEffect, 'deny');
assert.deepStrictEqual(expired.policyEvaluations[0].waivedRuleIds, []);

const appAuthorization = {
  ...authorization,
  executionPrincipal: { kind: 'installation', identityKey: 'c'.repeat(64), login: 'Acme-App', authMethod: 'github-app', installationId: 77 },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  installationCapabilities: { repositorySelected: true, repositorySelection: 'selected', permissions: { metadata: 'read', contents: 'write' } }
};
const appDescriptor = normalizeMutationDescriptor({
  mutationId: '55555555-5555-4555-8555-555555555555', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'c'.repeat(64), actorLogin: 'Acme-App', method: 'PUT', route: '/api/repo/Acme/Demo/file',
  metadata: { path: 'README.md' }, authorization: appAuthorization
});
const appDecision = evaluateActivePolicySet({ scope: authorization.scope, descriptor: appDescriptor, activePolicies: [policy], activeExceptions: [active('exception', ['deny-write'])], evaluatedAt: '2026-07-22T19:10:00.000Z' });
assert.deepStrictEqual(appDecision.policyEvaluations[0].waivedRuleIds, ['deny-write'], 'GitHub App execution must bind exception scope to the verified human governance actor');
console.log('governance exception enforcement tests passed');
