'use strict';

const assert = require('assert');
let governance = {};
try { governance = require('../src/governance-model'); } catch {}

for (const name of [
  'GovernanceError', 'normalizePolicyScope', 'normalizePolicyKey', 'normalizePolicyDocument',
  'normalizeApprovalPolicy', 'policyDocumentHash', 'normalizeAuditDetails',
  'createGovernanceAuditRecord', 'verifyGovernanceAuditChain'
]) {
  assert(governance[name], `${name} must be implemented`);
}

const {
  GovernanceError, normalizePolicyScope, normalizePolicyKey, normalizePolicyDocument,
  normalizeApprovalPolicy, policyDocumentHash, normalizeAuditDetails,
  createGovernanceAuditRecord, verifyGovernanceAuditChain, GOVERNANCE_AUDIT_GENESIS
} = governance;

const scope = normalizePolicyScope({ provider: 'GitHub', owner: 'Acme', repo: 'Demo' });
assert.deepStrictEqual(scope, {
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo'
});
const nested = normalizePolicyScope({ provider: 'gitlab', owner: 'Platform/Security', repo: 'Control-Plane' });
assert.strictEqual(nested.scopeKey, 'gitlab:gitlab.com:platform/security/control-plane');
const gitea = normalizePolicyScope({ provider: 'gitea', baseUrl: 'https://git.example.com/platform/', owner: 'Team', repo: 'Repo' });
assert.strictEqual(gitea.scopeKey, 'gitea:git.example.com/platform:team/repo');
assert.deepStrictEqual(normalizePolicyScope(gitea), gitea,
  'a normalized Gitea scope must be safe to normalize again across enforcement boundaries');
const caseSensitiveBasePath = normalizePolicyScope({ provider: 'gitea', baseUrl: 'https://git.example.com/GitRoot/', owner: 'Team', repo: 'Repo' });
assert.strictEqual(caseSensitiveBasePath.authority, 'git.example.com/GitRoot', 'self-hosted provider base paths must preserve case');
assert.strictEqual(caseSensitiveBasePath.scopeKey, 'gitea:git.example.com/GitRoot:team/repo');
assert.throws(() => normalizePolicyScope({ provider: 'gitea', owner: 'a', repo: 'b' }), error => error.code === 'GOVERNANCE_SCOPE_INVALID');
assert.throws(() => normalizePolicyScope({ provider: 'gitlab', baseUrl: 'https://user:pass@git.example.com', owner: 'a', repo: 'b' }), error => error.code === 'GOVERNANCE_SCOPE_INVALID');
assert.throws(() => normalizePolicyScope({ provider: 'bitbucket', owner: 'a', repo: 'b' }), error => error.code === 'GOVERNANCE_SCOPE_INVALID');
assert.strictEqual(normalizePolicyKey(' Release-Protection '), 'release-protection');
assert.throws(() => normalizePolicyKey('../escape'), error => error.code === 'GOVERNANCE_POLICY_KEY_INVALID');

const rawDocument = {
  rules: [
    { id: 'protected-delete', action: 'repository.delete', effect: 'require-approval', conditions: { branches: ['main'] } },
    { id: 'deny-force', action: 'branch.reset', effect: 'deny', conditions: { protected: true } }
  ],
  description: 'Repository safety baseline',
  schemaVersion: 1
};
const document = normalizePolicyDocument(rawDocument);
assert.deepStrictEqual(document, rawDocument, 'normalization must preserve semantic values');
assert.strictEqual(policyDocumentHash(document), policyDocumentHash({ ...rawDocument, rules: [...rawDocument.rules] }));
assert.match(policyDocumentHash(document), /^[0-9a-f]{64}$/);
assert.throws(
  () => normalizePolicyDocument({ schemaVersion: 1, rules: [rawDocument.rules[0], { ...rawDocument.rules[0] }] }),
  error => error.code === 'GOVERNANCE_RULE_DUPLICATE'
);
assert.throws(
  () => normalizePolicyDocument({ schemaVersion: 1, rules: [{ id: 'bad', action: 'repository.delete', effect: 'allow', conditions: { accessToken: 'ghp_secret' } }] }),
  error => error.code === 'GOVERNANCE_SENSITIVE_FIELD'
);
const prototypePayload = JSON.parse('{"schemaVersion":1,"rules":[{"id":"prototype-attack","action":"repository.delete","effect":"deny","conditions":{"__proto__":{"polluted":true}}}]}');
assert.throws(
  () => normalizePolicyDocument(prototypePayload),
  error => error.code === 'GOVERNANCE_DANGEROUS_FIELD',
  'prototype-control keys must be rejected before cloning governance JSON'
);
assert.strictEqual({}.polluted, undefined, 'governance normalization must not pollute Object.prototype');
assert.throws(
  () => normalizePolicyDocument({ schemaVersion: 2, rules: [] }),
  error => error.code === 'GOVERNANCE_SCHEMA_UNSUPPORTED'
);
assert.throws(
  () => normalizePolicyDocument({ schemaVersion: 1, rules: 'not-an-array' }),
  error => error.code === 'GOVERNANCE_DOCUMENT_INVALID'
);
assert.throws(
  () => normalizePolicyDocument({ schemaVersion: 1, rules: [{ id: 'huge', action: 'repository.delete', effect: 'deny', conditions: { note: 'x'.repeat(300000) } }] }),
  error => error.code === 'GOVERNANCE_DOCUMENT_TOO_LARGE'
);

assert.deepStrictEqual(normalizeApprovalPolicy(), { requiredApprovals: 1, disallowAuthorApproval: true });
assert.deepStrictEqual(normalizeApprovalPolicy({ requiredApprovals: 3, disallowAuthorApproval: false }), { requiredApprovals: 3, disallowAuthorApproval: false });
assert.throws(() => normalizeApprovalPolicy({ requiredApprovals: 0 }), error => error.code === 'GOVERNANCE_APPROVAL_POLICY_INVALID');
assert.throws(() => normalizeApprovalPolicy({ requiredApprovals: 6 }), error => error.code === 'GOVERNANCE_APPROVAL_POLICY_INVALID');

const safeDetails = normalizeAuditDetails({ reason: 'approved', count: 2, nested: { credentialType: 'github-app' } });
assert.strictEqual(safeDetails.nested.credentialType, 'github-app');
assert.throws(() => normalizeAuditDetails({ clientSecret: 'nope' }), error => error.code === 'GOVERNANCE_SENSITIVE_FIELD');
assert.throws(() => normalizeAuditDetails({ githubToken: 'nope' }), error => error.code === 'GOVERNANCE_SENSITIVE_FIELD');

const secret = 'governance-audit-secret-0123456789abcdef';
const base = {
  eventId: '11111111-1111-4111-8111-111111111111',
  policyId: '22222222-2222-4222-8222-222222222222',
  versionId: '33333333-3333-4333-8333-333333333333',
  eventType: 'version.created',
  actorIdentityKey: 'a'.repeat(64),
  actorLogin: 'alice',
  details: { versionNumber: 1 },
  createdAt: '2026-07-22T00:00:00.000Z'
};
const first = createGovernanceAuditRecord(secret, { ...base, previousHash: GOVERNANCE_AUDIT_GENESIS });
assert.strictEqual(first.previousHash, GOVERNANCE_AUDIT_GENESIS);
assert.match(first.detailsHash, /^[0-9a-f]{64}$/);
assert.match(first.recordHash, /^[0-9a-f]{64}$/);
const second = createGovernanceAuditRecord(secret, {
  ...base,
  eventId: '44444444-4444-4444-8444-444444444444',
  eventType: 'approval.recorded',
  previousHash: first.recordHash,
  details: { decision: 'approve' },
  createdAt: '2026-07-22T00:01:00.000Z'
});
assert.deepStrictEqual(verifyGovernanceAuditChain(secret, [first, second]), {
  valid: true, checked: 2, head: second.recordHash
});
const tampered = [{ ...first }, { ...second, details: { decision: 'reject' } }];
const invalid = verifyGovernanceAuditChain(secret, tampered);
assert.strictEqual(invalid.valid, false);
assert.strictEqual(invalid.failedAt, 2);
assert.throws(() => createGovernanceAuditRecord('short', base), error => error instanceof GovernanceError && error.code === 'GOVERNANCE_AUDIT_SECRET_INVALID');

console.log('governance model tests passed');
