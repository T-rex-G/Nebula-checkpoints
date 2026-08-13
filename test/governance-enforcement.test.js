'use strict';
const assert = require('assert');
let runtime = {};
try { runtime = require('../src/governance-enforcement'); } catch {}
for (const name of ['GovernanceEnforcementError', 'evaluateActivePolicySet', 'normalizePolicyDecision', 'createGovernanceRuntime']) {
  assert(runtime[name], `${name} must be implemented`);
}
const { evaluateActivePolicySet, normalizePolicyDecision, createGovernanceRuntime } = runtime;
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { policyDocumentHash } = require('../src/governance-model');

const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T19:00:00.000Z', reasonCode: null }
};
const descriptor = normalizeMutationDescriptor({
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'branch.reset', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'POST', route: '/api/repo/Acme/Demo/reset',
  metadata: { branch: 'main', targetSha: 'f'.repeat(40) },
  security: { stepUpAction: 'branch.reset', assurance: 'credential', authorizedAt: Date.now() }, authorization
});
function active(policyId, policyKey, mode, effect) {
  const document = {
    schemaVersion: 1,
    enforcement: { mode },
    rules: [{ id: `${effect}-reset`, action: 'branch.reset', effect, controlRefs: ['SOC2-TSC:CC8.1'] }]
  };
  return {
    policyId, policyKey, versionId: policyId.replace(/^1/, '2'), versionNumber: 1,
    headRevision: 1, document, documentHash: policyDocumentHash(document)
  };
}
const observe = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [active('10000000-0000-4000-8000-000000000001', 'observe-policy', 'observe', 'deny')] });
assert.strictEqual(observe.effectiveEffect, 'deny');
assert.strictEqual(observe.enforcementOutcome, 'allow');
assert.strictEqual(observe.rolloutMode, 'observe');
assert(observe.warningCodes.includes('POLICY_DENY_OBSERVED'));
assert.match(observe.descriptorHash, /^[0-9a-f]{64}$/, 'decision must bind the exact mutation descriptor');

const warn = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [active('10000000-0000-4000-8000-000000000001', 'warn-policy', 'warn', 'deny')] });
assert.strictEqual(warn.enforcementOutcome, 'warn');
assert.strictEqual(warn.rolloutMode, 'warn');

const block = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [active('10000000-0000-4000-8000-000000000001', 'block-policy', 'block', 'deny')] });
assert.strictEqual(block.enforcementOutcome, 'block');
assert.strictEqual(block.blockCode, 'POLICY_MUTATION_BLOCKED');

const withoutRuleControlsDocument = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [
  { id: 'deny-reset', action: 'branch.reset', effect: 'deny' }
] };
const withoutRuleControls = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [{
  policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'no-control-refs',
  versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, headRevision: 1,
  document: withoutRuleControlsDocument, documentHash: policyDocumentHash(withoutRuleControlsDocument)
}] });
assert.strictEqual(withoutRuleControls.enforcementOutcome, block.enforcementOutcome, 'control metadata must never change enforcement');
assert.strictEqual(withoutRuleControls.blockCode, block.blockCode, 'control metadata must never change block semantics');


const approval = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [active('10000000-0000-4000-8000-000000000001', 'approval-policy', 'block', 'require-approval')] });
assert.strictEqual(approval.blockCode, 'POLICY_APPROVAL_REQUIRED');

const governanceDescriptor = { ...descriptor,
  mutationId: '90000000-0000-4000-8000-000000000009',
  action: 'governance.policy.rollback', category: 'governance', risk: 'critical',
  actorIdentityKey: descriptor.actorIdentityKey, actorLogin: descriptor.actorLogin, metadata: {}
};
const governanceBlockDocument = { schemaVersion: 1, enforcement: { mode: 'block' }, rules: [
  { id: 'deny-policy-rollback', action: 'governance.policy.rollback', effect: 'deny' }
] };
const governanceRecovery = evaluateActivePolicySet({ scope: authorization.scope, descriptor: governanceDescriptor, activePolicies: [{
  policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'control-plane',
  versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, headRevision: 1,
  document: governanceBlockDocument, documentHash: policyDocumentHash(governanceBlockDocument)
}] });
assert.strictEqual(governanceRecovery.enforcementOutcome, 'warn', 'active policies must not create governance recovery lockout');
assert(governanceRecovery.warningCodes.includes('POLICY_CONTROL_PLANE_NON_BLOCKING'));

const legacyDocument = { schemaVersion: 1, rules: [{ id: 'legacy-deny', action: 'branch.reset', effect: 'deny' }] };
const legacy = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [{
  policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'legacy', versionId: '20000000-0000-4000-8000-000000000002',
  versionNumber: 1, headRevision: 1, document: legacyDocument, documentHash: policyDocumentHash(legacyDocument)
}] });
assert.strictEqual(legacy.rolloutMode, 'observe', 'legacy policies must not unexpectedly block after deployment');

const none = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [] });
assert.strictEqual(none.source, 'no-active-policy');
assert.strictEqual(none.enforcementOutcome, 'allow');

const unsupportedDocument = {
  schemaVersion: 1,
  enforcement: { mode: 'block' },
  rules: [{ id: 'future-rule', action: 'future.mutation', effect: 'deny' }]
};
assert.throws(
  () => evaluateActivePolicySet({
    scope: authorization.scope,
    descriptor,
    activePolicies: [{
      policyId: '10000000-0000-4000-8000-000000000009',
      policyKey: 'future-policy',
      versionId: '20000000-0000-4000-8000-000000000009',
      versionNumber: 1,
      headRevision: 1,
      document: unsupportedDocument,
      documentHash: policyDocumentHash(unsupportedDocument)
    }]
  }),
  error => error.code === 'POLICY_UNSUPPORTED_ACTIVE_RULES',
  'unsupported rules in the active set must fail evaluation instead of default-allowing the mutation'
);

const changedDescriptor = normalizeMutationDescriptor({
  mutationId: descriptor.mutationId, action: 'branch.reset', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'POST', route: '/api/repo/Acme/Demo/reset',
  metadata: { branch: 'release', targetSha: 'f'.repeat(40) },
  security: descriptor.security, authorization
});
const changedDecision = evaluateActivePolicySet({ scope: authorization.scope, descriptor: changedDescriptor, activePolicies: [] });
assert.notStrictEqual(changedDecision.descriptorHash, none.descriptorHash, 'descriptor hash must change with evaluated mutation facts');
assert.throws(() => normalizePolicyDecision({
  ...block,
  policyEvaluations: block.policyEvaluations.map(item => ({ ...item, versionNumber: 0 }))
}, descriptor), error => error.code === 'POLICY_DECISION_INVALID');
assert.throws(() => normalizePolicyDecision({ ...block, enforcementOutcome: 'allow', blockCode: null }, descriptor), error => error.code === 'POLICY_DECISION_INVALID');
assert.throws(() => normalizePolicyDecision({ ...block, policySetHash: 'f'.repeat(64) }, descriptor), error => error.code === 'POLICY_DECISION_INVALID');
assert.throws(() => normalizePolicyDecision({
  ...block,
  policyEvaluations: block.policyEvaluations.map(item => ({ ...item, effect: 'allow', source: 'default-allow', conflict: false })),
  effectiveEffect: 'allow', enforcementOutcome: 'allow', rolloutMode: 'observe', blockCode: null,
  warningCodes: [], controlMapping: block.controlMapping
}, descriptor), error => error.code === 'POLICY_DECISION_INVALID');
assert.throws(() => normalizePolicyDecision({
  ...block,
  policyEvaluations: block.policyEvaluations.map(item => ({
    ...item,
    matchedRules: item.matchedRules.map(rule => ({ ...rule, controlRefs: ['SOC2-TSC:CC999.9'] }))
  }))
}, descriptor), error => error.code === 'POLICY_DECISION_INVALID');

const mixed = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [
  active('10000000-0000-4000-8000-000000000001', 'a-warn', 'warn', 'deny'),
  active('10000000-0000-4000-8000-000000000003', 'b-block', 'block', 'require-approval')
] });
assert.strictEqual(mixed.enforcementOutcome, 'block');
assert.strictEqual(mixed.blockCode, 'POLICY_APPROVAL_REQUIRED');
assert.deepStrictEqual(mixed.policyEvaluations.map(item => item.policyKey), ['a-warn', 'b-block']);

const mixedNonBlocking = evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies: [
  active('10000000-0000-4000-8000-000000000005', 'a-observe-deny', 'observe', 'deny'),
  active('10000000-0000-4000-8000-000000000007', 'b-warn-approval', 'warn', 'require-approval')
] });
assert.strictEqual(mixedNonBlocking.enforcementOutcome, 'warn');
assert(mixedNonBlocking.warningCodes.includes('POLICY_APPROVAL_WARNING'), 'warn-mode approval must be reported as a warning');
assert(mixedNonBlocking.warningCodes.includes('POLICY_DENY_OBSERVED'), 'observe-mode denial must remain visible separately');
assert(!mixedNonBlocking.warningCodes.includes('POLICY_DENY_WARNING'), 'observe-only denial must not be mislabeled as warn-mode denial');

(async () => {
  const failures = [];
  const degradedWarn = createGovernanceRuntime({ store: { async evaluateAndAppendPolicyDecision() { throw Object.assign(new Error('db down'), { code: 'GOVERNANCE_DATABASE_REQUIRED' }); } }, failureMode: 'warn', onError: event => failures.push(event) });
  const warning = await degradedWarn.evaluate(descriptor);
  assert.strictEqual(warning.enforcementOutcome, 'warn');
  assert.strictEqual(warning.source, 'evaluation-unavailable');
  assert(warning.warningCodes.includes('POLICY_EVALUATION_UNAVAILABLE'));
  assert.deepStrictEqual(failures, [{ code: 'GOVERNANCE_DATABASE_REQUIRED', action: descriptor.action, scopeKey: descriptor.scopeKey }], 'runtime failures must be scoped and observable without exposing raw errors');

  const degradedBlock = createGovernanceRuntime({ store: { async evaluateAndAppendPolicyDecision() { throw new Error('db down'); } }, failureMode: 'block' });
  const blocked = await degradedBlock.evaluate(descriptor);
  assert.strictEqual(blocked.enforcementOutcome, 'block');
  assert.strictEqual(blocked.blockCode, 'POLICY_EVALUATION_UNAVAILABLE');

  const recoveryDuringFailure = await degradedBlock.evaluate(governanceDescriptor);
  assert.strictEqual(recoveryDuringFailure.enforcementOutcome, 'warn', 'evaluation failure must not lock the governance recovery path');
  assert.strictEqual(recoveryDuringFailure.blockCode, null);
  assert(recoveryDuringFailure.warningCodes.includes('POLICY_CONTROL_PLANE_NON_BLOCKING'));

  const unsupportedStore = {
    async evaluateAndAppendPolicyDecision() {
      throw Object.assign(new Error('unsupported active policy'), { code: 'POLICY_UNSUPPORTED_ACTIVE_RULES' });
    }
  };
  const unsupportedWarn = await createGovernanceRuntime({ store: unsupportedStore, failureMode: 'warn' }).evaluate(descriptor);
  assert.strictEqual(unsupportedWarn.enforcementOutcome, 'warn');
  const unsupportedBlock = await createGovernanceRuntime({ store: unsupportedStore, failureMode: 'block' }).evaluate(descriptor);
  assert.strictEqual(unsupportedBlock.enforcementOutcome, 'block');
  const unsupportedRecovery = await createGovernanceRuntime({ store: unsupportedStore, failureMode: 'block' }).evaluate(governanceDescriptor);
  assert.strictEqual(unsupportedRecovery.enforcementOutcome, 'warn', 'control-plane recovery remains non-blocking during evaluator failure');

  const giteaAuthorization = {
    ...authorization,
    scope: {
      provider: 'gitea',
      authority: 'gitea.example',
      owner: 'Acme',
      repo: 'Demo',
      scopeKey: 'gitea:gitea.example:acme/demo'
    },
    repositoryAccess: { ...authorization.repositoryAccess, source: 'gitea.collaborator.permission' }
  };
  const giteaDescriptor = normalizeMutationDescriptor({
    mutationId: '44444444-4444-4444-8444-444444444444',
    action: 'file.write',
    provider: 'gitea',
    baseUrl: 'https://gitea.example',
    owner: 'Acme',
    repo: 'Demo',
    actorIdentityKey: 'a'.repeat(64),
    actorLogin: 'Alice',
    method: 'PUT',
    route: '/api/repo/Acme/Demo/file',
    metadata: { path: 'folder/a.txt', branch: 'main', expectedHeadSha: 'f'.repeat(40) },
    authorization: giteaAuthorization
  });
  const giteaWarning = await degradedWarn.evaluate(giteaDescriptor);
  assert.strictEqual(giteaWarning.scope.scopeKey, giteaAuthorization.scope.scopeKey);
  assert.strictEqual(giteaWarning.enforcementOutcome, 'warn',
    'Gitea mutations must remain available under the configured warn-mode database fallback');
  console.log('governance enforcement tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
