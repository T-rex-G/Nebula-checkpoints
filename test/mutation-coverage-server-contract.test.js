'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { locations } = require('./oracles/route-policy');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const { MUTATION_ROUTE_INVENTORY } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');
/* Every route with its guard chain, as the route policy reads it from server.js and the modules' registration functions. */
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
 * Every provider write asks the gateway first: the API client in server.js,
 * and the workbench's two transports that bypass it -- the native Git push and
 * the LFS upload, with each LFS exchange named.
 */
const workbench = file => fs.readFileSync(path.join(root, 'apps/api/src/modules/workbench', file), 'utf8');
const bodyOf = (source, start, end, label) => {
  const at = source.indexOf(start);
  assert(at >= 0, `missing helper ${label}`);
  return source.slice(at, source.indexOf(end, at) + end.length);
};
const providerWriters = [
  ['gh', bodyOf(server, 'async function gh(', '\n}', 'gh'), 'mutationGateway.assertProviderMutation'],
  ['the native push', bodyOf(workbench('application/native-push.ts'), '  async function push(', '\n  }', 'push'), 'deps.assertProviderMutation'],
  ['the LFS upload', bodyOf(workbench('application/lfs.ts'), '  async function upload(', '\n  }', 'upload'), 'deps.assertProviderMutation']
];
for (const [label, body, assertion] of providerWriters) assert(body.includes(assertion), `${label} must assert provider writes`);
const lfsUpload = providerWriters[2][1];
assert(providerWriters[1][1].includes("transport: 'git-receive-pack'"));
assert(lfsUpload.includes("transport: 'git-lfs.batch'"));
assert(lfsUpload.includes("transport: 'git-lfs.upload'"));
assert(lfsUpload.includes("transport: 'git-lfs.verify'"));
assert(server.includes('recovery.inspectRestoreAuthorization({ account: req.gh, owner: req.params.owner, repo: req.params.repo }, body.authorization)'));
assert(server.includes("case 'recovery.restore-refs':"));
/* A folder move names the head its listing came from (the workbench's folder move). */
assert(workbench('http/folder-move-route.ts').includes('requireAggregateExpectedHead(requestedHead)'));
/* The reference restore reports each branch, a partial failure as one (Corona's recovery routes). */
assert(fs.readFileSync(path.join(root, 'apps/api/src/modules/corona/http/recovery-routes.ts'), 'utf8').includes('partialFailure: !ok && report.some(item => item.ok)'));
assert(fs.readFileSync(path.join(root, 'apps/api/src/modules/workbench/http/content-routes.ts'), 'utf8').includes('providerOperationIds: execution ? execution.operationIds : []'));

console.log('mutation coverage server contract tests passed');
