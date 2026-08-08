'use strict';
const assert = require('assert');
let ui = {};
try { ui = require('../public/governance-ui'); } catch {}
for (const name of ['renderGovernanceInterface', 'normalizeInterfaceAccess', 'parseJsonObject', 'defaultSimulationRequest']) {
  assert.strictEqual(typeof ui[name], 'function', `${name} must be implemented`);
}
const twin = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  current: {
    policyCount: 1, returnedPolicyCount: 1, activePolicyCount: 1,
    policies: [{
      policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'release-safety',
      name: '<script>alert(1)</script>', description: 'Protect releases', revision: 4,
      updatedAt: '2026-07-23T00:00:00.000Z',
      active: { versionId: '20000000-0000-4000-8000-000000000002', versionNumber: 1, documentHash: 'a'.repeat(64), enforcementMode: 'warn' },
      latestVersion: { versionId: '30000000-0000-4000-8000-000000000003', versionNumber: 2, documentHash: 'b'.repeat(64), createdAt: '2026-07-23T00:10:00.000Z', review: { status: 'pending', requiredApprovals: 1, assignedCount: 0, approvalCount: 0, rejectionCount: 0, terminal: false }, simulationEvidence: { status: 'fresh-simulation-required' } },
      versionCount: 2
    }]
  },
  proposed: {
    drafts: [{ draftId: '40000000-0000-4000-8000-000000000004', policyId: '10000000-0000-4000-8000-000000000001', revision: 2, documentHash: 'c'.repeat(64), authoredByLogin: 'alice', requiredApprovals: 1, disallowAuthorApproval: true, createdAt: '2026-07-23T00:11:00.000Z', updatedAt: '2026-07-23T00:12:00.000Z' }],
    draftCount: 1,
    versions: [{ policyId: '10000000-0000-4000-8000-000000000001', policyKey: 'release-safety', versionId: '30000000-0000-4000-8000-000000000003', versionNumber: 2, documentHash: 'b'.repeat(64), createdAt: '2026-07-23T00:10:00.000Z', review: { status: 'pending', requiredApprovals: 1, assignedCount: 0, approvalCount: 0, rejectionCount: 0, terminal: false }, simulationEvidence: { status: 'fresh-simulation-required' }, activationReadiness: { eligible: false, blockers: ['fresh-simulation-required'] } }],
    versionCount: 1
  },
  effective: { activePolicyCount: 1, activeExceptionCount: 1, activeExceptionsByAction: [{ action: 'file.write', count: 1 }], exceptionReferences: [] },
  history: {
    activations: [{ seq: 2, policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002', action: 'activate', actorLogin: 'admin', createdAt: '2026-07-23T00:20:00.000Z', evidence: { simulationHash: 'd'.repeat(64), scenarioSetHash: 'e'.repeat(64), resultHash: 'f'.repeat(64) } }],
    decisions: [{ seq: 8, action: 'file.write', enforcementOutcome: 'warn', effectiveEffect: 'deny', evaluatedAt: '2026-07-23T00:30:00.000Z', decisionHash: '1'.repeat(64) }],
    exceptions: [{ exceptionId: '50000000-0000-4000-8000-000000000005', policyId: '10000000-0000-4000-8000-000000000001', versionId: '20000000-0000-4000-8000-000000000002', kind: 'exception', action: 'file.write', state: 'pending', expiresAt: '2026-07-24T00:00:00.000Z', createdAt: '2026-07-23T00:15:00.000Z' }],
    nextDecisionSeq: 9, requestedAfterDecisionSeq: 0, limit: 50
  },
  freshness: { status: 'partial', asOf: '2026-07-23T00:31:00.000Z', completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: false } },
  readModelHash: '2'.repeat(64)
};
const reader = { schemaVersion: 1, repository: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo' }, actor: { login: 'alice' }, execution: { kind: 'user', authMethod: 'oauth' }, capabilities: { read: true, author: false, review: false, activate: false, administer: false }, evidence: { status: 'current', expiresAt: '2099-07-23T00:40:00.000Z' } };
const html = ui.renderGovernanceInterface({ digitalTwin: twin, access: reader });
assert(html.includes('Policy Digital Twin'));
assert(html.includes('Partial evidence'));
assert(html.includes('Active policies') && html.includes('<strong>1</strong>'));
assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert(!html.includes('<script>alert(1)</script>'));
assert(html.includes('data-gov-action="simulate"'), 'reader must be able to simulate');
assert(!html.includes('data-gov-action="create-policy"'), 'reader must not receive author controls');
assert(!html.includes('data-gov-action="activate"'), 'reader must not receive activator controls');
const adminHtml = ui.renderGovernanceInterface({ digitalTwin: twin, access: { ...reader, capabilities: { read: true, author: true, review: true, activate: true, administer: true } } });
for (const action of ['create-policy', 'new-draft', 'edit-draft', 'claim-review', 'activate', 'request-exception', 'decide-exception', 'rollback']) {
  assert(adminHtml.includes(`data-gov-action="${action}"`), `administrator interface missing ${action}`);
}

const expiredHtml = ui.renderGovernanceInterface({ digitalTwin: twin, access: { ...reader, evidence: { status: 'current', expiresAt: '2020-01-01T00:00:00.000Z' } }, now: Date.parse('2026-07-23T00:00:00.000Z') });
assert(expiredHtml.includes('Authorization evidence stale'));
assert(!expiredHtml.includes('data-gov-action="activate"'));

assert(ui.renderGovernanceInterface({ loading: true }).includes('aria-busy="true"'));
assert(ui.renderGovernanceInterface({ error: 'Database <offline>' }).includes('Database &lt;offline&gt;'));
assert(ui.renderGovernanceInterface({ digitalTwin: { ...twin, current: { policyCount: 0, returnedPolicyCount: 0, activePolicyCount: 0, policies: [] }, proposed: { drafts: [], draftCount: 0, versions: [], versionCount: 0 }, effective: { activePolicyCount: 0, activeExceptionCount: 0, activeExceptionsByAction: [], exceptionReferences: [] }, history: { activations: [], decisions: [], exceptions: [], nextDecisionSeq: null, requestedAfterDecisionSeq: 0, limit: 50 } }, access: reader }).includes('No governance policy yet'));
assert.deepStrictEqual(ui.parseJsonObject('{"branch":"main"}', 'Target'), { branch: 'main' });
assert.throws(() => ui.parseJsonObject('[]', 'Target'), /JSON object/);
const scenarios = ui.defaultSimulationRequest('main');
assert.strictEqual(scenarios.schemaVersion, 1);
assert(Array.isArray(scenarios.scenarios) && scenarios.scenarios.length >= 3);
console.log('governance interface renderer tests passed');
