'use strict';

const assert = require('assert');
let twin = {};
try { twin = require('../src/governance-digital-twin'); } catch {}
for (const name of ['buildPolicyDigitalTwinReadModel', 'normalizeDigitalTwinOptions']) {
  assert.strictEqual(typeof twin[name], 'function', `${name} must be implemented`);
}
const { buildPolicyDigitalTwinReadModel, normalizeDigitalTwinOptions } = twin;
const scope = { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' };

assert.deepStrictEqual(normalizeDigitalTwinOptions({ historyLimit: '25', afterDecisionSeq: '4' }), { historyLimit: 25, afterDecisionSeq: 4 });
assert.throws(() => normalizeDigitalTwinOptions({ historyLimit: '1.2' }), error => error.code === 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');

const data = {
  asOf: '2026-07-22T20:00:00.000Z',
  totals: { policies: 2, activePolicies: 1, versions: 2 },
  policies: [
    { policy_id: '20000000-0000-4000-8000-000000000002', policy_key: 'zeta', name: 'Zeta', description: '', revision: 2, active_version_id: null, updated_at: '2026-07-22T19:00:00.000Z' },
    { policy_id: '10000000-0000-4000-8000-000000000001', policy_key: 'alpha', name: 'Alpha', description: '', revision: 3, active_version_id: '30000000-0000-4000-8000-000000000003', active_version_number: 2, active_document_hash: 'a'.repeat(64), active_enforcement_mode: 'warn', updated_at: '2026-07-22T19:30:00.000Z' }
  ],
  versions: [
    { policy_id: '10000000-0000-4000-8000-000000000001', version_id: '30000000-0000-4000-8000-000000000003', version_number: 2, document_hash: 'a'.repeat(64), required_approvals: 1, assignment_count: 1, approval_count: 1, rejection_count: 0, created_at: '2026-07-22T18:00:00.000Z' },
    { policy_id: '10000000-0000-4000-8000-000000000001', version_id: '40000000-0000-4000-8000-000000000004', version_number: 3, document_hash: 'b'.repeat(64), required_approvals: 2, assignment_count: 1, approval_count: 1, rejection_count: 0, created_at: '2026-07-22T19:45:00.000Z' }
  ],
  drafts: [{ draft_id: '60000000-0000-4000-8000-000000000006', policy_id: '10000000-0000-4000-8000-000000000001', revision: 1, document_hash: 'd'.repeat(64), authored_by_login: 'alice', required_approvals: 1, disallow_author_approval: true, created_at: '2026-07-22T19:40:00.000Z', updated_at: '2026-07-22T19:50:00.000Z' }],
  exceptions: [{ exception_id: '50000000-0000-4000-8000-000000000005', policy_id: '10000000-0000-4000-8000-000000000001', version_id: '30000000-0000-4000-8000-000000000003', kind: 'exception', action: 'branch.reset', state: 'approved', expires_at: '2026-07-23T20:00:00.000Z', created_at: '2026-07-22T19:50:00.000Z' }],
  activations: [{ seq: 4, policy_id: '10000000-0000-4000-8000-000000000001', version_id: '30000000-0000-4000-8000-000000000003', action: 'activate', actor_login: 'admin', created_at: '2026-07-22T18:10:00.000Z' }],
  decisions: [{ seq: 7, action: 'branch.reset', enforcement_outcome: 'warn', effective_effect: 'deny', evaluated_at: '2026-07-22T19:55:00.000Z', decision_hash: 'c'.repeat(64) }],
  completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: false },
  nextDecisionSeq: 7
};

const model = buildPolicyDigitalTwinReadModel({ scope, data, options: { historyLimit: 25, afterDecisionSeq: 4 } });
assert.strictEqual(model.schemaVersion, 1);
assert.strictEqual(model.scope.scopeKey, scope.scopeKey);
assert.deepStrictEqual(model.current.policies.map(item => item.policyKey), ['alpha', 'zeta']);
assert.strictEqual(model.current.activePolicyCount, 1);
assert.strictEqual(model.proposed.drafts.length, 1);
assert.strictEqual(model.proposed.versions.length, 1);
assert.strictEqual(model.proposed.versions[0].review.status, 'pending');
assert.strictEqual(model.effective.activeExceptionCount, 1);
assert.strictEqual(model.history.nextDecisionSeq, 7);
assert.strictEqual(model.freshness.status, 'partial');
assert(Object.isFrozen(model));
assert(!JSON.stringify(model).match(/authorization|cookie|privateKey|accessToken/i));
console.log('governance Digital Twin model tests passed');
