'use strict';
const assert = require('assert');
let simulation = {};
try { simulation = require('../src/governance-simulation'); } catch {}
for (const name of ['GovernanceSimulationError', 'normalizeSimulationRequest', 'evaluatePolicyDocument', 'simulatePolicyImpact']) {
  assert(simulation[name], `${name} must be implemented`);
}
const { normalizeSimulationRequest, evaluatePolicyDocument, simulatePolicyImpact } = simulation;
const { policyDocumentHash } = require('../src/governance-model');

const requestA = normalizeSimulationRequest({
  schemaVersion: 1,
  scenarios: [
    { id: 'reset-main', action: 'branch.reset', attributes: { protected: true, branch: 'main' } },
    { id: 'write-docs', action: 'file.write', attributes: { paths: ['docs/readme.md'], branch: 'feature/docs' } },
    { id: 'merge-pr', action: 'pull.merge', attributes: { branch: 'main' } }
  ]
});
assert(Object.isFrozen(requestA) && Object.isFrozen(requestA.scenarios));
assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'x', action: 'unknown.action' }] }), error => error.code === 'SIMULATION_ACTION_UNKNOWN');
assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'x', action: 'branch.reset', attributes: { accessToken: 'ghp_secret' } }] }), error => error.code === 'SIMULATION_SENSITIVE_FIELD');
assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'x', action: 'branch.reset', actorIdentityKey: 'a'.repeat(64) }] }), error => error.code === 'SIMULATION_INPUT_INVALID');
assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'x', action: 'branch.reset', attributes: { note: 'github_pat_' + 'A'.repeat(30) } }] }), error => error.code === 'SIMULATION_SENSITIVE_VALUE');
assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'x', action: 'file.write', attributes: { content: 'raw file body' } }] }), error => error.code === 'SIMULATION_SENSITIVE_FIELD');

const proposed = {
  schemaVersion: 1,
  rules: [
    { id: 'deny-protected-reset', action: 'branch.reset', effect: 'deny', conditions: { protected: true, branches: ['main'] } },
    { id: 'approve-docs', action: 'file.write', effect: 'require-approval', conditions: { paths: ['docs/**'] } },
    { id: 'allow-main-reset', action: 'branch.reset', effect: 'allow', conditions: { branch: 'main' } }
  ]
};
const evaluated = evaluatePolicyDocument(proposed, requestA.scenarios);
assert.strictEqual(evaluated.results[0].effect, 'deny');
assert.strictEqual(evaluated.results[0].conflict, true);
assert.deepStrictEqual(evaluated.results[0].matchedRuleIds, ['deny-protected-reset', 'allow-main-reset']);
assert.strictEqual(evaluated.results[1].effect, 'require-approval');
assert.strictEqual(evaluated.results[2].effect, 'allow');
assert.deepStrictEqual(evaluated.unsupportedRuleActions, []);

const baseline = { schemaVersion: 1, rules: [{ id: 'allow-reset', action: 'branch.reset', effect: 'allow' }] };
const simulationScope = { provider: 'github', owner: 'Acme', repo: 'Demo' };
const report1 = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: { versionId: '10000000-0000-4000-8000-000000000001', versionNumber: 2, document: proposed, documentHash: policyDocumentHash(proposed) },
  baselineVersion: { versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, document: baseline, documentHash: policyDocumentHash(baseline) },
  request: requestA
});
assert.strictEqual(report1.baseline.kind, 'active-version');
assert.strictEqual(report1.results[0].change, 'strengthened');
assert.strictEqual(report1.results[1].change, 'strengthened');
assert.strictEqual(report1.summary.conflictCount, 1);
assert(report1.summary.affectedActionClasses.includes('branch'));
assert.strictEqual(report1.scope.scopeKey, 'github:github.com:acme/demo');
assert.match(report1.scenarioSetHash, /^[0-9a-f]{64}$/);
assert.match(report1.resultHash, /^[0-9a-f]{64}$/);
assert.match(report1.simulationHash, /^[0-9a-f]{64}$/);
assert(report1.impactDiff.some(item => item.scenarioId === 'reset-main' && item.fromEffect === 'allow' && item.toEffect === 'deny'));
assert(report1.warnings.some(item => item.code === 'SIMULATION_RULE_CONFLICTS'));
assert(report1.warnings.some(item => item.code === 'SIMULATION_NO_ACTIVE_POLICY') === false);
assert.strictEqual(report1.activationReadiness.eligible, false);
assert(report1.activationReadiness.blockers.includes('SIMULATION_RULE_CONFLICTS'));
assert(Object.isFrozen(report1) && Object.isFrozen(report1.summary));

const reordered = normalizeSimulationRequest({
  scenarios: [
    { action: 'branch.reset', id: 'reset-main', attributes: { branch: 'main', protected: true } },
    { attributes: { branch: 'feature/docs', paths: ['docs/readme.md'] }, action: 'file.write', id: 'write-docs' },
    { id: 'merge-pr', attributes: { branch: 'main' }, action: 'pull.merge' }
  ],
  schemaVersion: 1
});
const report2 = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: { documentHash: policyDocumentHash(proposed), document: proposed, versionNumber: 2, versionId: '10000000-0000-4000-8000-000000000001' },
  baselineVersion: { documentHash: policyDocumentHash(baseline), document: baseline, versionNumber: 1, versionId: '20000000-0000-4000-8000-000000000002' },
  request: reordered
});
assert.strictEqual(report1.simulationHash, report2.simulationHash, 'equivalent normalized input must have a stable hash');

const noPolicy = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: { versionId: '10000000-0000-4000-8000-000000000001', versionNumber: 2, document: proposed, documentHash: policyDocumentHash(proposed) },
  baselineVersion: null,
  request: requestA
});
assert.strictEqual(noPolicy.baseline.kind, 'no-policy');
assert(noPolicy.warnings.some(item => item.code === 'SIMULATION_NO_ACTIVE_POLICY'));
assert.strictEqual(noPolicy.results[2].change, 'unchanged');

const unsupported = evaluatePolicyDocument({ schemaVersion: 1, rules: [{ id: 'future-action', action: 'future.mutation', effect: 'deny' }] }, requestA.scenarios);
assert.deepStrictEqual(unsupported.unsupportedRuleActions, ['future.mutation']);
assert(unsupported.results.every(item => item.effect === 'allow'));
assert.throws(() => simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: { versionId: '10000000-0000-4000-8000-000000000001', versionNumber: 2, document: proposed, documentHash: 'f'.repeat(64) },
  baselineVersion: null,
  request: requestA
}), error => error.code === 'SIMULATION_VERSION_INTEGRITY_FAILED');

const relaxed = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: { versionId: '10000000-0000-4000-8000-000000000001', versionNumber: 2, document: { schemaVersion: 1, rules: [] }, documentHash: policyDocumentHash({ schemaVersion: 1, rules: [] }) },
  baselineVersion: { versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, document: proposed, documentHash: policyDocumentHash(proposed) },
  request: requestA
});
assert.strictEqual(relaxed.results[0].change, 'relaxed');
assert.strictEqual(relaxed.results[0].baselineConflict, true);
assert.strictEqual(relaxed.summary.baselineConflictCount, 1);


const safeReport = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: {
    versionId: '40000000-0000-4000-8000-000000000004', versionNumber: 3,
    document: { schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] },
    documentHash: policyDocumentHash({ schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] })
  },
  baselineVersion: null,
  request: requestA
});
assert.strictEqual(safeReport.activationReadiness.eligible, true);
assert.deepStrictEqual(safeReport.activationReadiness.blockers, []);


const incompleteCoverageReport = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: {
    versionId: '60000000-0000-4000-8000-000000000006', versionNumber: 5,
    document: { schemaVersion: 1, rules: [{ id: 'deny-release-create', action: 'release.create', effect: 'deny' }] },
    documentHash: policyDocumentHash({ schemaVersion: 1, rules: [{ id: 'deny-release-create', action: 'release.create', effect: 'deny' }] })
  },
  baselineVersion: null,
  request: requestA
});
assert.strictEqual(incompleteCoverageReport.activationReadiness.eligible, false);
assert(incompleteCoverageReport.activationReadiness.blockers.includes('SIMULATION_UNEXERCISED_POLICY_RULES'));
assert.deepStrictEqual(incompleteCoverageReport.summary.unexercisedProposedRuleIds, ['deny-release-create']);
assert(incompleteCoverageReport.warnings.some(item => item.code === 'SIMULATION_UNEXERCISED_POLICY_RULES'));

const unsupportedReport = simulatePolicyImpact({
  scope: simulationScope,
  proposedVersion: {
    versionId: '50000000-0000-4000-8000-000000000005', versionNumber: 4,
    document: { schemaVersion: 1, rules: [{ id: 'future-action', action: 'future.mutation', effect: 'deny' }] },
    documentHash: policyDocumentHash({ schemaVersion: 1, rules: [{ id: 'future-action', action: 'future.mutation', effect: 'deny' }] })
  },
  baselineVersion: null,
  request: requestA
});
assert.strictEqual(unsupportedReport.activationReadiness.eligible, false);
assert(unsupportedReport.activationReadiness.blockers.includes('SIMULATION_UNSUPPORTED_POLICY_ACTIONS'));
assert.deepStrictEqual(unsupportedReport.proposed.unsupportedRuleActions, ['future.mutation']);

console.log('governance simulation tests passed');
