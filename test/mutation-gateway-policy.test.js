'use strict';
const assert = require('assert');
const { createMutationGateway, normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { deriveControlMapping } = require('../src/control-catalog');
const { createGovernanceRuntime, evaluateActivePolicySet } = require('../src/governance-enforcement');
const { policyDocumentHash } = require('../src/governance-model');
const authorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true }, installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T19:00:00.000Z', reasonCode: null }
};
const base = {
  mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
  actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file',
  metadata: { branch: 'main', path: 'README.md' }, authorization
};
assert.throws(() => normalizeMutationDescriptor({ ...base, controlMapping: {} }), error => error.code === 'MUTATION_POLICY_INPUT_FORBIDDEN');
assert.throws(() => normalizeMutationDescriptor({ ...base, policyDecision: {} }), error => error.code === 'MUTATION_POLICY_INPUT_FORBIDDEN');

function decision(outcome, extra = {}) {
  const descriptor = normalizeMutationDescriptor(base);
  const activePolicies = outcome === 'allow' ? [] : (() => {
    const document = {
      schemaVersion: 1,
      enforcement: { mode: outcome },
      rules: [{ id: 'deny-write', action: 'file.write', effect: 'deny' }]
    };
    return [{
      policyId: '10000000-0000-4000-8000-000000000001', policyKey: `${outcome}-policy`,
      versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, headRevision: 1,
      document, documentHash: policyDocumentHash(document)
    }];
  })();
  return { ...evaluateActivePolicySet({ scope: authorization.scope, descriptor, activePolicies, evaluatedAt: '2026-07-22T18:00:00.000Z' }), ...extra };
}
(async () => {
  let callbackRan = false;
  const allowGateway = createMutationGateway({ policyEvaluator: async () => decision('allow') });
  await allowGateway.run(base, async () => {
    callbackRan = true;
    assert.strictEqual(allowGateway.current().policyDecision.enforcementOutcome, 'allow');
  });
  assert(callbackRan);

  const warnGateway = createMutationGateway({ policyEvaluator: async () => decision('warn') });
  await warnGateway.run(base, async () => assert.strictEqual(warnGateway.current().policyDecision.enforcementOutcome, 'warn'));

  const blockGateway = createMutationGateway({ policyEvaluator: async () => decision('block') });
  await assert.rejects(() => blockGateway.run(base, async () => { throw new Error('must not execute'); }), error => error.code === 'POLICY_MUTATION_BLOCKED' && error.status === 403);

  const mismatchGateway = createMutationGateway({ policyEvaluator: async () => decision('allow', { mutationId: '50000000-0000-4000-8000-000000000005' }) });
  await assert.rejects(() => mismatchGateway.run(base, async () => {}), error => error.code === 'MUTATION_POLICY_DECISION_MISMATCH');

  /*
   * warn is deliberate and load-bearing, not an oversight.
   *
   * unavailableDecision blocks when `failureMode === 'block' || unsupportedActiveRules`,
   * so unsupported active rules fail closed whatever the operator configured.
   * Asserting that under warn proves the fail-closed path; asserting it under
   * block would only prove that block mode blocks.
   */
  let unsupportedCallbackRan = false;
  const unsupportedRuntime = createGovernanceRuntime({
    failureMode: 'warn',
    store: {
      async evaluateAndAppendPolicyDecision() {
        throw Object.assign(new Error('unsupported active policy'), { code: 'POLICY_UNSUPPORTED_ACTIVE_RULES' });
      }
    }
  });
  const unsupportedGateway = createMutationGateway({ policyEvaluator: unsupportedRuntime.evaluate });
  await assert.rejects(
    () => unsupportedGateway.run(base, async () => { unsupportedCallbackRan = true; }),
    error => error.code === 'POLICY_UNSUPPORTED_ACTIVE_RULES' && error.status === 503
  );
  assert.strictEqual(unsupportedCallbackRan, false, 'unsupported active rules must block before provider mutation');
  console.log('mutation gateway policy tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
