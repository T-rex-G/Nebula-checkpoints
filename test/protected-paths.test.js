'use strict';

/*
 * A path-scoped policy is only worth what it covers. Before this guard existed,
 * `conditions: { path: [...] }` reached file.write, file.delete and file.upload
 * and silently missed file.rename, file.batch, directory.move and the history
 * restores: those actions never put their paths into mutation metadata, so the
 * rule had nothing to match and the gateway recorded an allow for a mutation the
 * operator believed was blocked. These assertions are written as outcomes — a
 * protected path is blocked — so they cannot pass because the apparatus exists.
 */

const assert = require('assert');

let protectedPaths = {};
try { protectedPaths = require('../src/protected-paths'); } catch { /* asserted below */ }
for (const name of ['PATH_COVERAGE', 'ACTION_PATH_SEMANTICS', 'pathFactsForAction', 'ProtectedPathError']) {
  assert(protectedPaths[name], `${name} must be implemented`);
}

const { PATH_COVERAGE, ACTION_PATH_SEMANTICS, pathFactsForAction } = protectedPaths;
const { MUTATION_ACTIONS } = require('../src/mutation-gateway');
const { evaluatePolicyDocument } = require('../src/governance-simulation');

assert(Object.isFrozen(PATH_COVERAGE), 'path coverage vocabulary must be immutable');
assert(Object.isFrozen(ACTION_PATH_SEMANTICS), 'action path semantics must be immutable');
assert.deepStrictEqual(
  Object.values(PATH_COVERAGE).slice().sort(),
  ['exact', 'subtree', 'unbounded'],
  'path coverage must stay exactly exact, subtree, unbounded'
);

/* Drift guard: an action that can change repository content must declare how
 * precisely its path set is knowable, or a future action silently repeats the
 * defect this guard exists for. */
for (const [action, definition] of Object.entries(MUTATION_ACTIONS)) {
  if (definition.category !== 'content' && definition.category !== 'history') continue;
  assert(ACTION_PATH_SEMANTICS[action], `content action ${action} must declare its path semantics`);
}
for (const action of Object.keys(ACTION_PATH_SEMANTICS)) {
  assert(MUTATION_ACTIONS[action], `path semantics declared for unknown action ${action}`);
  assert(
    Object.values(PATH_COVERAGE).includes(ACTION_PATH_SEMANTICS[action].coverage),
    `action ${action} declares an unknown path coverage`
  );
}

const PROTECTED = '.github/workflows/**';

function denyEveryContentAction() {
  return {
    schemaVersion: 1,
    rules: Object.keys(ACTION_PATH_SEMANTICS).map((action, index) => ({
      id: `protect-${index}`,
      action,
      effect: 'deny',
      conditions: { path: [PROTECTED] }
    }))
  };
}

/* Metadata exactly as the server builds it, with the path facts merged in. */
function metadataFor(action, base) {
  return { ...base, ...pathFactsForAction(action, base) };
}

function effectFor(action, base) {
  const evaluation = evaluatePolicyDocument(denyEveryContentAction(), [
    { id: 'runtime-mutation', action, attributes: metadataFor(action, base) }
  ]);
  return evaluation.results[0].effect;
}

const PROTECTED_FILE = '.github/workflows/release.yml';

/* Outcome: every way of changing a protected file is refused. */
const blocked = [
  ['file.write', { branch: 'main', path: PROTECTED_FILE }],
  ['file.delete', { branch: 'main', path: PROTECTED_FILE }],
  ['file.upload', { branch: 'main', path: PROTECTED_FILE, lfsMode: 'auto' }],
  ['git.blob.create', { path: PROTECTED_FILE }],
  ['file.rename', { branch: 'main', from: PROTECTED_FILE, to: 'release.yml.bak' }],
  ['file.rename', { branch: 'main', from: 'release.yml.bak', to: PROTECTED_FILE }],
  ['file.batch', { branch: 'main', itemCount: 2, paths: ['README.md', PROTECTED_FILE] }]
];
for (const [action, base] of blocked) {
  assert.strictEqual(
    effectFor(action, base),
    'deny',
    `${action} must not be able to change ${PROTECTED_FILE} while it is protected`
  );
}

/* Outcome: the protection does not spill onto paths it does not name. */
const allowed = [
  ['file.write', { branch: 'main', path: 'README.md' }],
  ['file.rename', { branch: 'main', from: 'README.md', to: 'READYOU.md' }],
  ['file.batch', { branch: 'main', itemCount: 2, paths: ['README.md', 'src/a.js'] }]
];
for (const [action, base] of allowed) {
  assert.strictEqual(effectFor(action, base), 'allow', `${action} on an unprotected path must stay allowed`);
}

/* The exact set is reported as exact, and stays sorted and de-duplicated so the
 * decision record is stable for the same mutation. */
const renameFacts = pathFactsForAction('file.rename', { from: 'b/two.txt', to: 'a/one.txt' });
assert.strictEqual(renameFacts.pathCoverage, PATH_COVERAGE.EXACT);
assert.deepStrictEqual(renameFacts.paths, ['a/one.txt', 'b/two.txt']);
const sameTarget = pathFactsForAction('file.rename', { from: 'a/one.txt', to: 'a/one.txt' });
assert.deepStrictEqual(sameTarget.paths, ['a/one.txt']);

/* A subtree action knows its root but not its members at decision time, and says
 * so rather than reporting a set it cannot stand behind. */
const moveFacts = pathFactsForAction('directory.move', { from: '.github/workflows', to: 'archived/workflows' });
assert.strictEqual(moveFacts.pathCoverage, PATH_COVERAGE.SUBTREE);
assert.deepStrictEqual(moveFacts.paths, ['.github/workflows', 'archived/workflows']);
const restoreFacts = pathFactsForAction('commit.restore-paths', { pathPrefix: '.github/workflows' });
assert.strictEqual(restoreFacts.pathCoverage, PATH_COVERAGE.SUBTREE);
assert.deepStrictEqual(restoreFacts.paths, ['.github/workflows']);

/* An action that can rewrite anything reports no path set at all. Claiming a
 * narrow one here would be the same lie in a different place. */
for (const action of ['commit.revert', 'commit.restore', 'branch.reset']) {
  const facts = pathFactsForAction(action, { branch: 'main', commitSha: 'a'.repeat(40) });
  assert.strictEqual(facts.pathCoverage, PATH_COVERAGE.UNBOUNDED, `${action} must report unbounded path coverage`);
  assert.deepStrictEqual(facts.paths, [], `${action} must not claim a path set it cannot know`);
}

/* An action with no path semantics is left exactly as it was. */
assert.deepStrictEqual(pathFactsForAction('pull.merge', { pullNumber: 4 }), {});
assert.deepStrictEqual(pathFactsForAction('issue.create', {}), {});

/* A path that cannot be normalised is never silently dropped: the set stops
 * claiming to be exact, because a dropped entry is an unguarded path. */
const escaped = pathFactsForAction('file.rename', { from: 'a/../../etc/passwd', to: 'ok.txt' });
assert.strictEqual(escaped.pathCoverage, PATH_COVERAGE.UNBOUNDED);
assert.deepStrictEqual(escaped.paths, [], 'a partially understood path set must not be presented as the whole set');

/* The path set has to fit the envelope the mutation gateway will accept. It
 * fails closed with its own code rather than being trimmed to fit. */
const oversized = Array.from({ length: 100 }, (_, index) => `${'nested/'.repeat(20)}file-${index}.txt`);
assert.throws(
  () => pathFactsForAction('file.batch', { branch: 'main', paths: oversized }),
  error => error.code === 'MUTATION_PATH_SET_TOO_LARGE' && error.status === 413,
  'an ungovernable path set must be refused, not truncated'
);
const tooMany = Array.from({ length: 101 }, (_, index) => `f${index}.txt`);
assert.throws(
  () => pathFactsForAction('file.batch', { branch: 'main', paths: tooMany }),
  error => error.code === 'MUTATION_PATH_SET_TOO_LARGE',
  'a path set beyond the metadata array bound must be refused'
);

/* ------------------------------------------------------------------ *
 * Protected path declarations
 *
 * A path is only protected if every way of changing it is covered. Writing
 * that by hand means one rule per action per pattern, and getting the
 * subtree cases right: a file under .github/workflows travels with a move of
 * .github, so protecting the file means gating moves of its ancestors too.
 * These assertions are outcomes — the protected file survives — so a wrong
 * expansion cannot pass them.
 * ------------------------------------------------------------------ */

const { expandProtectedPaths } = protectedPaths;
assert(expandProtectedPaths, 'expandProtectedPaths must be implemented');

const { normalizePolicyDocument } = require('../src/governance-model');

function documentFor(declarations, options) {
  const expansion = expandProtectedPaths(declarations, options);
  return { expansion, document: normalizePolicyDocument({ schemaVersion: 1, rules: expansion.rules }) };
}

const guarded = documentFor([{ pattern: PROTECTED, effect: 'deny' }]);

function expandedEffect(action, base) {
  const evaluation = evaluatePolicyDocument(guarded.document, [
    { id: 'runtime-mutation', action, attributes: metadataFor(action, base) }
  ]);
  return evaluation.results[0].effect;
}

/* The expansion is a valid policy document on its own terms. */
assert.strictEqual(guarded.document.schemaVersion, 1);
assert(guarded.document.rules.length >= Object.keys(ACTION_PATH_SEMANTICS).length);

/* Outcome: no route to the protected file is left open. */
const refused = [
  ['file.write', { branch: 'main', path: PROTECTED_FILE }],
  ['file.delete', { branch: 'main', path: PROTECTED_FILE }],
  ['file.upload', { branch: 'main', path: PROTECTED_FILE, lfsMode: 'auto' }],
  ['file.rename', { branch: 'main', from: PROTECTED_FILE, to: 'elsewhere.yml' }],
  ['file.batch', { branch: 'main', itemCount: 1, paths: [PROTECTED_FILE] }],
  /* the file travels with a move of the directory it lives in ... */
  ['directory.move', { branch: 'main', from: '.github/workflows', to: 'archived' }],
  /* ... and with a move of any directory above it */
  ['directory.move', { branch: 'main', from: '.github', to: 'archived' }],
  /* a restore rewrites it from history */
  ['commit.restore-paths', { branch: 'main', pathPrefix: '.github/workflows' }],
  ['commit.restore-paths', { branch: 'main', pathPrefix: '.github' }],
  /* and these can rewrite anything at all */
  ['commit.revert', { branch: 'main', commitSha: 'a'.repeat(40) }],
  ['commit.restore', { branch: 'main', commitSha: 'a'.repeat(40) }],
  ['branch.reset', { branch: 'main', targetSha: 'a'.repeat(40) }]
];
for (const [action, base] of refused) {
  assert.strictEqual(
    expandedEffect(action, base),
    'deny',
    `${action} must not be able to reach ${PROTECTED_FILE} — ${JSON.stringify(base)}`
  );
}

/* Outcome: work that cannot reach the protected file is not obstructed. */
const untouched = [
  ['file.write', { branch: 'main', path: 'src/index.js' }],
  ['file.rename', { branch: 'main', from: 'src/a.js', to: 'src/b.js' }],
  ['file.batch', { branch: 'main', itemCount: 2, paths: ['src/a.js', 'docs/x.md'] }],
  ['directory.move', { branch: 'main', from: 'src/old', to: 'src/new' }],
  ['commit.restore-paths', { branch: 'main', pathPrefix: 'src' }]
];
for (const [action, base] of untouched) {
  assert.strictEqual(expandedEffect(action, base), 'allow', `${action} away from the protected path must stay allowed`);
}

/* The expansion says out loud which ancestors it had to gate, so the operator
 * is not surprised by a blocked move of a directory they never named. */
const workflowCoverage = guarded.expansion.coverage[0];
assert.strictEqual(workflowCoverage.pattern, PROTECTED);
assert.deepStrictEqual(workflowCoverage.ancestorPaths, ['.github', '.github/workflows']);
assert.deepStrictEqual(
  workflowCoverage.wholeActionGuards.slice().sort(),
  ['branch.reset', 'commit.restore', 'commit.revert'],
  'actions that can rewrite anything must be reported as gated whole'
);
assert(workflowCoverage.limits.length > 0, 'the expansion must state what it could not narrow');

/* Same declarations, same rules — the policy version an operator reviews must
 * not churn because a list was reordered. */
const repeat = expandProtectedPaths([{ pattern: PROTECTED, effect: 'deny' }]);
assert.deepStrictEqual(repeat.rules, guarded.expansion.rules, 'expansion must be deterministic');
const twoWays = [
  expandProtectedPaths([{ pattern: 'a/**', effect: 'deny' }, { pattern: 'b/**', effect: 'deny' }]),
  expandProtectedPaths([{ pattern: 'b/**', effect: 'deny' }, { pattern: 'a/**', effect: 'deny' }])
];
assert.deepStrictEqual(twoWays[0].rules, twoWays[1].rules, 'rule identity must not depend on declaration order');

/* Opting out of the whole-action guards is allowed, and is stated as the gap
 * it is rather than quietly leaving the path reachable. */
const partial = documentFor([{ pattern: PROTECTED, effect: 'deny', guardWholeActions: false }]);
assert.deepStrictEqual(partial.expansion.coverage[0].wholeActionGuards, []);
assert(
  partial.expansion.coverage[0].limits.some(limit => /branch\.reset/.test(limit)),
  'declining the whole-action guards must be reported as an open route to the path'
);

/* A pattern with no fixed directory cannot narrow a directory move to it, so
 * the move is gated whole and the widening is stated. */
const anywhere = expandProtectedPaths([{ pattern: '**/*.pem', effect: 'deny' }]);
assert.deepStrictEqual(anywhere.coverage[0].ancestorPaths, []);
assert(anywhere.coverage[0].wholeActionGuards.includes('directory.move'));
assert(anywhere.coverage[0].limits.some(limit => /directory move/i.test(limit)));

/* require-approval is a protection too. */
const reviewed = documentFor([{ pattern: PROTECTED, effect: 'require-approval' }]);
assert.strictEqual(
  evaluatePolicyDocument(reviewed.document, [{
    id: 'runtime-mutation',
    action: 'file.rename',
    attributes: metadataFor('file.rename', { branch: 'main', from: PROTECTED_FILE, to: 'x.yml' })
  }]).results[0].effect,
  'require-approval'
);

/* Declarations are bounded and validated. */
assert.throws(() => expandProtectedPaths([{ pattern: PROTECTED, effect: 'allow' }]),
  error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID',
  'a protected path cannot be declared with an allow effect');
assert.throws(() => expandProtectedPaths([{ pattern: '', effect: 'deny' }]),
  error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID');
assert.throws(() => expandProtectedPaths([{ pattern: 'a/../b', effect: 'deny' }]),
  error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID');
assert.throws(() => expandProtectedPaths([{ pattern: 'a/**', effect: 'deny' }, { pattern: 'a/**', effect: 'deny' }]),
  error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID',
  'a repeated pattern would produce duplicate rule ids');
assert.throws(
  () => expandProtectedPaths(Array.from({ length: 33 }, (_, index) => ({ pattern: `p${index}/**`, effect: 'deny' }))),
  error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID'
);
assert.throws(() => expandProtectedPaths([]), error => error.code === 'PROTECTED_PATH_DECLARATION_INVALID');

/* ------------------------------------------------------------------ *
 * The template an operator actually reaches for
 * ------------------------------------------------------------------ */

const { getPolicyTemplate, listPolicyTemplates } = require('../src/governance-templates');

assert(
  listPolicyTemplates().some(entry => entry.templateId === 'protected-paths'),
  'the protected paths template must be offered alongside the other baselines'
);

const template = getPolicyTemplate('protected-paths');
const templateDocument = normalizePolicyDocument(template.document);

/* Outcome: out of the box, the template stops a workflow file being changed by
 * any of the routes that used to walk past a path rule. */
const templateRefusals = [
  ['file.write', { branch: 'main', path: '.github/workflows/ci.yml' }],
  ['file.rename', { branch: 'main', from: '.github/workflows/ci.yml', to: 'ci.yml' }],
  ['file.batch', { branch: 'main', itemCount: 1, paths: ['.github/workflows/ci.yml'] }],
  ['directory.move', { branch: 'main', from: '.github', to: 'archived' }],
  ['file.write', { branch: 'main', path: 'CODEOWNERS' }],
  ['file.delete', { branch: 'main', path: '.github/CODEOWNERS' }],
  ['file.write', { branch: 'main', path: '.gitattributes' }]
];
for (const [action, base] of templateRefusals) {
  const evaluation = evaluatePolicyDocument(templateDocument, [
    { id: 'runtime-mutation', action, attributes: metadataFor(action, base) }
  ]);
  assert.strictEqual(evaluation.results[0].effect, 'deny', `template must cover ${action} ${JSON.stringify(base)}`);
}

/* Outcome: ordinary work is untouched. */
for (const [action, base] of [
  ['file.write', { branch: 'main', path: 'src/index.js' }],
  ['file.rename', { branch: 'main', from: 'README.md', to: 'READYOU.md' }],
  ['directory.move', { branch: 'main', from: 'src/old', to: 'src/new' }]
]) {
  const evaluation = evaluatePolicyDocument(templateDocument, [
    { id: 'runtime-mutation', action, attributes: metadataFor(action, base) }
  ]);
  assert.strictEqual(evaluation.results[0].effect, 'allow', `template must not obstruct ${action}`);
}

/* The template says what it does not do. A generated policy that reads as
 * protection while sitting in observe mode would be the same overstatement in
 * a friendlier place. */
assert.strictEqual(templateDocument.enforcement.mode, 'observe');
assert(
  /observe mode/i.test(templateDocument.description) && /nothing is blocked/i.test(templateDocument.description),
  'the template must state that it records rather than blocks until it is activated'
);
assert(
  /travels with the directory/i.test(templateDocument.description),
  'the template must state that it gates the directories holding a protected path'
);

/* ------------------------------------------------------------------ *
 * End to end through the gateway
 *
 * Everything above judges policy documents. This runs a mutation the way the
 * server runs one — descriptor, metadata normalisation, policy evaluation,
 * enforcement — and asserts the provider call never happens. It also proves
 * the path set survives the gateway's own metadata bounds, which is where a
 * silently dropped array would undo all of it.
 * ------------------------------------------------------------------ */

const { createMutationGateway, normalizeMutationDescriptor } = require('../src/mutation-gateway');
const { createGovernanceRuntime, evaluateActivePolicySet } = require('../src/governance-enforcement');
const { policyDocumentHash } = require('../src/governance-model');
void createGovernanceRuntime;

const gatewayAuthorization = {
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T19:00:00.000Z', reasonCode: null }
};

/* The protected-paths template as an operator would activate it once they have
 * moved past observing. */
const enforcedDocument = { ...template.document, enforcement: { mode: 'block' } };
const activePolicies = [{
  policyId: '10000000-0000-4000-8000-000000000001',
  policyKey: 'protected-paths',
  versionId: '20000000-0000-4000-8000-000000000002',
  versionNumber: 1,
  headRevision: 1,
  document: enforcedDocument,
  documentHash: policyDocumentHash(enforcedDocument)
}];

function descriptorFor(action, base) {
  return normalizeMutationDescriptor({
    mutationId: '11111111-1111-4111-8111-111111111111',
    action,
    provider: 'github',
    owner: 'Acme',
    repo: 'Demo',
    actorIdentityKey: 'a'.repeat(64),
    actorLogin: 'Alice',
    method: 'POST',
    route: `/api/repo/Acme/Demo/${action}`,
    metadata: metadataFor(action, base),
    authorization: gatewayAuthorization
  });
}

async function runThroughGateway(action, base) {
  const descriptor = descriptorFor(action, base);
  const gateway = createMutationGateway({
    policyEvaluator: async () => evaluateActivePolicySet({
      scope: gatewayAuthorization.scope,
      descriptor,
      activePolicies,
      evaluatedAt: '2026-07-22T18:00:00.000Z'
    })
  });
  let providerCalled = false;
  let blocked = null;
  try {
    await gateway.run(descriptor, async () => { providerCalled = true; });
  } catch (error) {
    blocked = error;
  }
  return { providerCalled, blocked, descriptor };
}

(async () => {
  /* The path set reaches the gateway intact rather than being dropped by the
   * metadata bounds on the way in. */
  const renameDescriptor = descriptorFor('file.rename', {
    branch: 'main', from: '.github/workflows/ci.yml', to: 'ci.yml'
  });
  assert.deepStrictEqual(
    renameDescriptor.metadata.paths,
    ['.github/workflows/ci.yml', 'ci.yml'],
    'the path set must survive mutation metadata normalisation'
  );
  assert.strictEqual(renameDescriptor.metadata.pathCoverage, 'exact');

  /* Outcome: the provider is never called for a mutation that reaches a
   * protected path. */
  const renameRun = await runThroughGateway('file.rename', {
    branch: 'main', from: '.github/workflows/ci.yml', to: 'ci.yml'
  });
  assert.strictEqual(renameRun.providerCalled, false, 'renaming a protected workflow must not reach the provider');
  assert(renameRun.blocked, 'the gateway must refuse the mutation');
  assert.strictEqual(renameRun.blocked.code, 'POLICY_MUTATION_BLOCKED');

  const batchRun = await runThroughGateway('file.batch', {
    branch: 'main', itemCount: 2, paths: ['README.md', '.github/workflows/ci.yml']
  });
  assert.strictEqual(batchRun.providerCalled, false, 'a batch containing a protected path must not reach the provider');

  const moveRun = await runThroughGateway('directory.move', { branch: 'main', from: '.github', to: 'archived' });
  assert.strictEqual(moveRun.providerCalled, false, 'moving a directory holding a protected path must not reach the provider');

  /* Outcome: ordinary work still reaches the provider. */
  const ordinary = await runThroughGateway('file.write', { branch: 'main', path: 'src/index.js' });
  assert.strictEqual(ordinary.providerCalled, true, 'unrelated work must still reach the provider');
  assert.strictEqual(ordinary.blocked, null);

  console.log('protected paths tests passed');
})().catch(error => { console.error(error); process.exit(1); });
