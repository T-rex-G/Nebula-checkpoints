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

console.log('protected paths tests passed');
