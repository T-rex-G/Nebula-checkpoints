'use strict';

/*
 * The path set is only worth something if the server actually attaches it. A
 * module that computes complete path sets while the server keeps building
 * metadata the old way would leave the defect in place and the unit guard
 * green, so these assertions bind the two together.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const coverage = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-coverage.ts'), 'utf8');

const { ACTION_PATH_SEMANTICS, PATH_COVERAGE } = require('../apps/api/src/platform/mutation-gateway/protected-paths.ts');
const { MUTATION_ROUTE_INVENTORY } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');

/* The repository mutation context (mutation-context.ts) builds the metadata the server's context records. */
const mutationContextSource = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'platform', 'mutation-gateway', 'mutation-context.ts'), 'utf8');
assert(mutationContextSource.includes("import { pathFactsForAction } from './protected-paths.ts';"), 'the mutation context must load the effective path set module');
/* That the composed server's writes carry their path set, so a protected folder holds, is test/composition-postgres.test.js's. */
assert(
  mutationContextSource.includes('...pathFactsForAction(action, base)'),
  'every mutation descriptor must carry the effective path set of its action'
);
assert(
  /function mutationMetadataFor\(req: ContextRequest, action: string\): Record<string, unknown> \{\s*const base = baseMutationMetadataFor\(req, action\);/.test(mutationContextSource),
  'the path set must be merged for every action, not per switch case, so a new action cannot skip it'
);
assert(
  coverage.includes('summary: { itemCount: items.length, itemIds, batchHash, payloadBytes, paths: batchPaths }'),
  'a file batch must report the paths it touches'
);

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
