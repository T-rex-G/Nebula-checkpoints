'use strict';
const assert = require('assert');
const { computeGovernanceReviewState } = require('../src/governance-model');
assert.strictEqual(typeof computeGovernanceReviewState, 'function', 'review state helper must exist');
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const assignments = [
  { reviewerIdentityKey: a }, { reviewerIdentityKey: b }, { reviewerIdentityKey: c }
];
assert.deepStrictEqual(computeGovernanceReviewState({ requiredApprovals: 2, assignments, decisions: [] }), {
  status: 'pending', terminal: false, quorumReached: false,
  assignedCount: 3, approvalCount: 0, rejectionCount: 0, pendingCount: 3
});
assert.deepStrictEqual(computeGovernanceReviewState({
  requiredApprovals: 2, assignments,
  decisions: [{ actorIdentityKey: a, decision: 'approve' }, { actorIdentityKey: b, decision: 'approve' }]
}), {
  status: 'approved', terminal: true, quorumReached: true,
  assignedCount: 3, approvalCount: 2, rejectionCount: 0, pendingCount: 1
});
assert.deepStrictEqual(computeGovernanceReviewState({
  requiredApprovals: 2, assignments,
  decisions: [{ actorIdentityKey: a, decision: 'approve' }, { actorIdentityKey: b, decision: 'reject' }]
}), {
  status: 'rejected', terminal: true, quorumReached: false,
  assignedCount: 3, approvalCount: 1, rejectionCount: 1, pendingCount: 1
});
assert.throws(() => computeGovernanceReviewState({ requiredApprovals: 2, assignments, decisions: [{ actorIdentityKey: 'd'.repeat(64), decision: 'approve' }] }), error => error.code === 'GOVERNANCE_REVIEW_STATE_INVALID');
assert.throws(() => computeGovernanceReviewState({ requiredApprovals: 2, assignments: [assignments[0], assignments[0]], decisions: [] }), error => error.code === 'GOVERNANCE_REVIEW_STATE_INVALID');
console.log('governance review model tests passed');
