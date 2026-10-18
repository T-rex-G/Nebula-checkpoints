'use strict';
/*
 * The architecture mission's two server oracles, held on every run:
 *
 *  - the route policy: every middleware and route in order, each route's guard
 *    chain, and which routes sit in front of the alpha access boundary;
 *  - the negative-request matrix: what each route answers callers who should
 *    be refused, from a missing app header to an administrator without step-up.
 *
 * Both were recorded from the monolith before it was decomposed. A change to
 * either is a change to the security surface; it must be intended, and listed
 * in INTENDED_CHANGES with its reason, or the test fails.
 *
 * `node test/architecture-oracles.test.js --write` records the current server.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { currentRoutePolicy } = require('./oracles/current-route-policy');
const { runNegativeMatrix } = require('./oracles/negative-matrix');

const root = path.resolve(__dirname, '..');
const POLICY_FILE = path.join(__dirname, 'oracles', 'route-policy.json');
const MATRIX_FILE = path.join(__dirname, 'oracles', 'negative-matrix.json');
const WRITE = process.argv.includes('--write');

/*
 * Intended differences from the recorded monolith, each with its reason. A
 * route listed here may be absent now; nothing else about the surface may move.
 */
const INTENDED_CHANGES = Object.freeze({
  removedRoutes: Object.freeze({})
});

function withoutIntended(policy) {
  return {
    ...policy,
    sequence: policy.sequence.filter(entry =>
      entry.kind !== 'route' || !INTENDED_CHANGES.removedRoutes[`${entry.method} ${entry.path}`])
  };
}

(async () => {
  const policy = currentRoutePolicy(root);
  if (WRITE) {
    fs.writeFileSync(POLICY_FILE, `${JSON.stringify(policy, null, 1)}\n`);
  }
  const recordedPolicy = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  const expectedPolicy = withoutIntended(recordedPolicy);
  expectedPolicy.routes = expectedPolicy.sequence.filter(entry => entry.kind === 'route').length;
  assert.deepStrictEqual(policy, expectedPolicy, 'the route policy differs from the recorded monolith');
  console.log(`  ok  route policy: ${policy.routes} routes and ${policy.sequence.length - policy.routes} pipeline steps in recorded order`);

  const matrix = await runNegativeMatrix(root, policy);
  if (WRITE) {
    fs.writeFileSync(MATRIX_FILE, `${JSON.stringify(matrix, null, 1)}\n`);
  }
  const recordedMatrix = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
  const removed = new Set(Object.keys(INTENDED_CHANGES.removedRoutes));
  const expectedCells = recordedMatrix.cells.filter(cell => !removed.has(cell.route));
  assert.deepStrictEqual(matrix.contexts, recordedMatrix.contexts, 'the matrix contexts changed');
  const differences = [];
  const byKey = new Map(matrix.cells.map(cell => [`${cell.context} ${cell.route}`, cell]));
  for (const cell of expectedCells) {
    const now = byKey.get(`${cell.context} ${cell.route}`);
    if (!now) differences.push(`missing: ${cell.context} ${cell.route}`);
    else if (now.status !== cell.status || now.code !== cell.code) {
      differences.push(`${cell.context} ${cell.route}: was ${cell.status} ${cell.code}, now ${now.status} ${now.code}`);
    }
  }
  assert.strictEqual(matrix.cells.length, expectedCells.length, 'the matrix asked a different number of questions');
  assert.deepStrictEqual(differences, [], `negative-request matrix changed:\n${differences.join('\n')}`);
  console.log(`  ok  negative-request matrix: ${matrix.cells.length} refusals and answers unchanged across ${matrix.contexts.length} caller contexts`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
