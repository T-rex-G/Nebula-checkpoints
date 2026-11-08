'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const { locations } = require('./oracles/route-policy');
const { MUTATION_ROUTE_INVENTORY } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');
/* Every route with its guard chain, as the route policy reads it from the composition root and the modules' registration functions. */
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
const guardsOf = new Map(policyRoutes.map(entry => [`${entry.method} ${entry.path}`, entry.guards]));
for (const item of MUTATION_ROUTE_INVENTORY) {
  const guards = guardsOf.get(`${item.method} ${item.route}`);
  assert(guards, `missing inventoried mutation route ${item.method} ${item.route}`);
  /*
   * Exposure and code-audit actions take the governance mutation context for
   * the same reason governance actions do: they record a decision in this
   * server's own evidence ledger rather than writing to a provider. The rule
   * keys off the namespace so a new action in any of these families cannot
   * quietly pick the wrong recorder.
   */
  const governanceShaped = ['governance.', 'exposure.', 'code-audit.'].some(prefix => item.action.startsWith(prefix));
  const middleware = governanceShaped ? 'governanceMutationContext' : 'mutationContext';
  assert(guards.includes(`${middleware}('${item.action}')`), `${item.route} must use ${middleware}('${item.action}')`);
}
const covered = new Set(MUTATION_ROUTE_INVENTORY.map(x => `${x.method} ${x.route}`));
const explicitNonRepositoryWrites = new Set([
  'POST /hooks/github/:hookId','POST /api/login','POST /api/accounts/switch-idx','POST /api/accounts/remove','POST /api/accounts/switch',
  'POST /api/github-app/connect','POST /api/github-app/refresh','POST /api/github-app/disconnect','POST /api/security/step-up','POST /api/logout',
  'POST /api/repo/:owner/:repo/governance/baselines/generate','POST /api/repo/:owner/:repo/governance/policies/:policyId/validate',
  'POST /api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate','POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate',
  'POST /api/safety','POST /api/repo/:owner/:repo/snapshot-compare','POST /api/repo/:owner/:repo/restore-preview',
  'POST /api/repo/:owner/:repo/signed-snapshot','POST /api/repo/:owner/:repo/emergency-manifest','POST /api/security/revoke-others'
]);
for (const entry of policyRoutes.filter(route => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method))) {
  const key = `${entry.method} ${entry.path}`;
  if (entry.path.startsWith('/api/repo') || entry.path === '/api/repos') {
    assert(covered.has(key) || explicitNonRepositoryWrites.has(key), `repository mutating-method route is unclassified: ${key}`);
  }
}
/*
 * Every provider write asks the gateway first, and is asked of the code that
 * writes:
 *   - the GitHub REST client refuses a write outside a mutation before
 *     anything leaves the server (test/github-rest.test.js), and the composed
 *     client and the workbench's two transports that bypass it -- the native
 *     Git push and the LFS upload -- are each refused outside one
 *     (test/composition.test.js);
 *   - each transport names itself to the gateway: the push as
 *     git-receive-pack, each LFS exchange as its batch, upload and verify
 *     (test/workbench-collaboration-routes.test.js).
 * A restore's metadata inspects its preview without spending it, and binds the
 * restore to its batch (test/mutation-context.test.js; the composed server's
 * in test/composition-postgres.test.js). A folder move names the head its
 * listing came from (test/workbench-collaboration-routes.test.js). The
 * reference restore reports each branch, and a restore that went part of the
 * way as partial (test/corona-recovery.test.js). A content write reports the
 * provider operations it made (test/workbench-repository-routes.test.js).
 */

console.log('mutation coverage server contract tests passed');
