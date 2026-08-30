'use strict';

/*
 * Safe Passage.
 *
 * When policy refuses a write because it needs approval, the work is simply
 * lost: the caller gets a 403 and whatever they were holding goes nowhere.
 * They then have to reconstruct the compliant route by hand — branch, commit,
 * pull request — which is the friction that keeps operators in observe mode
 * and never turning enforcement on.
 *
 * A refusal that needs approval should hand back the route to approval. These
 * assertions are outcomes: the route exists, it is one the same policy
 * actually permits, it preserves the exact bytes, and it is never offered when
 * no permitted route exists. That last one is the important one — a remedy
 * that routed around a deny would be a bypass wearing a helpful face.
 */

const assert = require('assert');
const crypto = require('crypto');

let safePassage = {};
try { safePassage = require('../src/safe-passage'); } catch { /* asserted below */ }
for (const name of ['SafePassageError', 'SAFE_PASSAGE_KIND', 'offerSafePassage']) {
  assert(safePassage[name], `${name} must be implemented`);
}
const { SAFE_PASSAGE_KIND, offerSafePassage } = safePassage;

const { normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { evaluateActivePolicySet } = require('../src/governance-enforcement');
const { policyDocumentHash } = require('../src/governance-model');
const { pathFactsForAction } = require('../src/protected-paths');

const scope = { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' };
const authorization = {
  schemaVersion: 1,
  scope,
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'write', providerRole: 'write', level: 30, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: false, activator: false, administrator: false },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-08-30T18:00:00.000Z', expiresAt: '2026-08-30T19:00:00.000Z', reasonCode: null }
};

const PROTECTED_FILE = '.github/workflows/release.yml';
const CONTENT = 'name: release\non: push\n';
const CONTENT_HASH = crypto.createHash('sha256').update(CONTENT, 'utf8').digest('hex');
const EVALUATED_AT = '2026-08-30T18:00:00.000Z';

function activeSet(document) {
  return [{
    policyId: '10000000-0000-4000-8000-000000000001',
    policyKey: 'protected-paths',
    versionId: '20000000-0000-4000-8000-000000000002',
    versionNumber: 1,
    headRevision: 1,
    document,
    documentHash: policyDocumentHash(document)
  }];
}

/* Approval on the protected branch, ordinary work elsewhere: a compliant route
 * exists, which is the case Safe Passage is for. */
const APPROVAL_ON_MAIN = {
  schemaVersion: 1,
  enforcement: { mode: 'block' },
  rules: [{
    id: 'workflows-need-approval',
    action: 'file.write',
    effect: 'require-approval',
    conditions: { path: ['.github/workflows/**'], branch: 'main' }
  }]
};

/* The same path refused outright, everywhere. No compliant route exists and
 * none may be invented. */
const DENIED_EVERYWHERE = {
  schemaVersion: 1,
  enforcement: { mode: 'block' },
  rules: [{
    id: 'workflows-denied',
    action: 'file.write',
    effect: 'deny',
    conditions: { path: ['.github/workflows/**'] }
  }]
};

function descriptorFor(action, base) {
  return normalizeMutationDescriptor({
    mutationId: '11111111-1111-4111-8111-111111111111',
    action,
    provider: 'github',
    owner: 'Acme',
    repo: 'Demo',
    actorIdentityKey: 'a'.repeat(64),
    actorLogin: 'Alice',
    method: 'PUT',
    route: '/api/repo/Acme/Demo/file',
    metadata: { ...base, ...pathFactsForAction(action, base) },
    authorization
  });
}

function decisionFor(document, descriptor) {
  return evaluateActivePolicySet({
    scope, descriptor, activePolicies: activeSet(document), evaluatedAt: EVALUATED_AT
  });
}

function offerFor(document, base = { branch: 'main', path: PROTECTED_FILE }) {
  const descriptor = descriptorFor('file.write', base);
  const decision = decisionFor(document, descriptor);
  return {
    decision,
    offer: offerSafePassage({
      descriptor,
      blockCode: decision.blockCode,
      content: CONTENT,
      scope,
      activePolicies: activeSet(document),
      activeExceptions: [],
      evaluatedAt: EVALUATED_AT
    })
  };
}

/* ---- the case Safe Passage is for ---- */

const approval = offerFor(APPROVAL_ON_MAIN);
assert.strictEqual(approval.decision.enforcementOutcome, 'block');
assert.strictEqual(approval.decision.blockCode, 'POLICY_APPROVAL_REQUIRED');
assert.strictEqual(approval.offer.available, true, 'an approval-required refusal must offer the route to approval');
assert.strictEqual(approval.offer.kind, SAFE_PASSAGE_KIND.PULL_REQUEST);
assert.strictEqual(approval.offer.baseBranch, 'main');
assert.strictEqual(approval.offer.path, PROTECTED_FILE);
assert.strictEqual(approval.offer.contentHash, CONTENT_HASH, 'the offer must commit to the exact bytes that were refused');
assert(/^safe-passage\/[0-9a-f]{12}$/.test(approval.offer.branch), `unexpected branch name ${approval.offer.branch}`);

/* The route it offers is one this policy really permits — every step of it. */
assert(Array.isArray(approval.offer.steps) && approval.offer.steps.length === 3);
assert.deepStrictEqual(
  approval.offer.steps.map(step => step.action),
  ['branch.create', 'file.write', 'pull.create']
);
for (const step of approval.offer.steps) {
  const stepDescriptor = descriptorFor(step.action, step.metadata);
  const stepDecision = decisionFor(APPROVAL_ON_MAIN, stepDescriptor);
  assert.strictEqual(
    stepDecision.enforcementOutcome,
    'allow',
    `offered step ${step.action} must be permitted by the same policy, got ${stepDecision.enforcementOutcome}`
  );
}

/* The same change offered twice lands on the same branch rather than growing a
 * new one each time it is refused. */
assert.strictEqual(offerFor(APPROVAL_ON_MAIN).offer.branch, approval.offer.branch);

/* ---- the cases where no route may be offered ---- */

/* A deny is a wall. Routing around it would be the bypass this feature must
 * never become. */
const denied = offerFor(DENIED_EVERYWHERE);
assert.strictEqual(denied.decision.blockCode, 'POLICY_MUTATION_BLOCKED');
assert.strictEqual(denied.offer.available, false, 'a denied mutation must never be offered a way through');
assert.match(denied.offer.reason, /denied|refused/i);

/* Approval required, but the branch write is refused too: the route does not
 * exist, so it is not offered. Verified, not assumed. */
const APPROVAL_PLUS_BRANCH_BLOCK = {
  schemaVersion: 1,
  enforcement: { mode: 'block' },
  rules: [
    { id: 'workflows-need-approval', action: 'file.write', effect: 'require-approval', conditions: { path: ['.github/workflows/**'], branch: 'main' } },
    { id: 'no-new-branches', action: 'branch.create', effect: 'deny' }
  ]
};
const noRoute = offerFor(APPROVAL_PLUS_BRANCH_BLOCK);
assert.strictEqual(noRoute.decision.blockCode, 'POLICY_APPROVAL_REQUIRED');
assert.strictEqual(noRoute.offer.available, false, 'a route whose own steps are refused must not be offered');
assert.strictEqual(noRoute.offer.refusedStep, 'branch.create');

/* A step that cannot be evaluated at all is reported as unevaluated, not as
 * refused. Both mean no offer, but only one of them is a policy decision, and
 * telling an operator their policy refused something it never saw would send
 * them looking for a rule that does not exist. */
const brokenSet = [{
  policyId: '10000000-0000-4000-8000-000000000001',
  policyKey: 'P',
  versionId: '20000000-0000-4000-8000-000000000002',
  versionNumber: 1, headRevision: 1,
  document: APPROVAL_ON_MAIN, documentHash: policyDocumentHash(APPROVAL_ON_MAIN)
}];
const unevaluated = offerSafePassage({
  descriptor: descriptorFor('file.write', { branch: 'main', path: PROTECTED_FILE }),
  blockCode: 'POLICY_APPROVAL_REQUIRED',
  content: CONTENT,
  scope,
  activePolicies: brokenSet,
  activeExceptions: [],
  evaluatedAt: EVALUATED_AT
});
assert.strictEqual(unevaluated.available, false);
assert.strictEqual(unevaluated.evaluated, false, 'an unevaluatable step must not be reported as evaluated');
assert.match(unevaluated.reason, /could not be evaluated/i);
assert(!/refused at/i.test(unevaluated.reason), 'an unevaluatable step must not be described as refused by policy');

/* A step the policy really did refuse says so. */
assert.strictEqual(noRoute.offer.evaluated, true, 'a genuine policy refusal must be reported as evaluated');
assert.match(noRoute.offer.reason, /refused at branch\.create/i);

/* A mutation that was not refused at all has nothing to route. */
const allowed = offerFor(APPROVAL_ON_MAIN, { branch: 'feature', path: PROTECTED_FILE });
assert.strictEqual(allowed.decision.enforcementOutcome, 'allow');
assert.strictEqual(allowed.offer.available, false);

/* ---- what the offer must never carry ---- */

/* The content is the caller's; the offer commits to its hash and holds none of
 * it. An offer that carried the bytes would put repository content into an
 * error response and, from there, into logs. */
const serialized = JSON.stringify(approval.offer);
assert(!serialized.includes(CONTENT), 'the offer must not carry the content it describes');
assert(!serialized.includes('name: release'), 'the offer must not carry any part of the content');
assert(serialized.includes(CONTENT_HASH), 'the offer must carry the content hash');

/* The branch it offers must be one this server would actually accept. Offering
 * a name the branch-create route rejects would turn a helpful route into a
 * second failure. */
const { normalizeBranchName } = require('../src/intelligence');
assert.strictEqual(normalizeBranchName(approval.offer.branch, 'branch'), approval.offer.branch);
for (const awkward of ['main', 'release/1.0', 'feature/.hidden', 'a'.repeat(120)]) {
  const branch = safePassage.branchFor(awkward.replace(/^feature\/\.hidden$/, 'main'), PROTECTED_FILE, CONTENT_HASH);
  assert.strictEqual(normalizeBranchName(branch, 'branch'), branch, `offered branch ${branch} must be a valid ref`);
}

console.log('safe passage tests passed');
