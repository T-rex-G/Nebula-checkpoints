'use strict';

/*
 * The path set is only worth something if the server actually attaches it. A
 * module that computes complete path sets while the server keeps building
 * metadata the old way would leave the defect in place and the unit guard
 * green, so these assertions bind the two together.
 */

const assert = require('assert');

const { ACTION_PATH_SEMANTICS, PATH_COVERAGE } = require('../apps/api/src/platform/mutation-gateway/protected-paths.ts');
const { MUTATION_ROUTE_INVENTORY } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');

/*
 * The repository mutation context attaches each action's effective path set
 * to the metadata it records, for every action alike
 * (test/mutation-context.test.js), and a file batch reports the paths it
 * touches (test/mutation-coverage.test.js). That the composed server's writes
 * carry their path set, so a protected folder holds, is
 * test/composition-postgres.test.js's.
 */

/* Every action that declares path semantics has to be a real governed route,
 * otherwise the declaration protects nothing. */
const routedActions = new Set(MUTATION_ROUTE_INVENTORY.map(entry => entry.action));
for (const action of Object.keys(ACTION_PATH_SEMANTICS)) {
  assert(routedActions.has(action), `path semantics declared for unrouted action ${action}`);
}

/* Actions that can rewrite arbitrary paths must stay labelled as such. If one of
 * these is ever relabelled to a narrower coverage, a protected path would look
 * guarded while this action walked past it. */
for (const action of ['commit.revert', 'commit.restore', 'branch.reset']) {
  assert.strictEqual(
    ACTION_PATH_SEMANTICS[action].coverage,
    PATH_COVERAGE.UNBOUNDED,
    `${action} must keep declaring unbounded path coverage`
  );
}

console.log('protected paths server contract tests passed');
