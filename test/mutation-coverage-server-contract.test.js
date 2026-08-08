'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const { MUTATION_ROUTE_INVENTORY } = require('../src/mutation-coverage');
for (const item of MUTATION_ROUTE_INVENTORY) {
  const needle = `app.${item.method.toLowerCase()}('${item.route}'`;
  const index = server.indexOf(needle);
  assert(index >= 0, `missing inventoried mutation route ${item.method} ${item.route}`);
  const line = server.slice(index, server.indexOf('\n', index));
  const middleware = item.action.startsWith('governance.') ? 'governanceMutationContext' : 'mutationContext';
  assert(line.includes(`${middleware}('${item.action}')`), `${item.route} must use ${middleware}('${item.action}')`);
}
const routeRx = /app\.(post|put|patch|delete)\('([^']+)'[^\n]*/g;
const covered = new Set(MUTATION_ROUTE_INVENTORY.map(x => `${x.method} ${x.route}`));
const explicitNonRepositoryWrites = new Set([
  'POST /hooks/github/:hookId','POST /api/login','POST /api/accounts/switch-idx','POST /api/accounts/remove','POST /api/accounts/switch',
  'POST /api/github-app/connect','POST /api/github-app/refresh','POST /api/github-app/disconnect','POST /api/security/step-up','POST /api/logout',
  'POST /api/repo/:owner/:repo/governance/baselines/generate','POST /api/repo/:owner/:repo/governance/policies/:policyId/validate',
  'POST /api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate','POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate',
  'POST /api/safety','POST /api/repo/:owner/:repo/snapshot-compare','POST /api/repo/:owner/:repo/restore-preview',
  'POST /api/repo/:owner/:repo/signed-snapshot','POST /api/repo/:owner/:repo/emergency-manifest','POST /api/security/revoke-others'
]);
let match;
while ((match = routeRx.exec(server))) {
  const key = `${match[1].toUpperCase()} ${match[2]}`;
  if (match[2].startsWith('/api/repo') || match[2] === '/api/repos') {
    assert(covered.has(key) || explicitNonRepositoryWrites.has(key), `repository mutating-method route is unclassified: ${key}`);
  }
}
for (const helper of ['async function gh(', 'async function glFetch(', 'async function uploadViaGitPush(', 'async function uploadViaLFS(']) {
  const start = server.indexOf(helper);
  assert(start >= 0, `missing helper ${helper}`);
  const end = server.indexOf('\n}', start);
  const body = server.slice(start, end + 2);
  assert(body.includes('mutationGateway.assertProviderMutation'), `${helper} must assert provider writes`);
}
assert(server.includes("transport: 'git-lfs.batch'"));
assert(server.includes("transport: 'git-lfs.upload'"));
assert(server.includes("transport: 'git-lfs.verify'"));
assert(server.includes('inspectRestoreAuthorization(req, body.authorization)'));
assert(server.includes("case 'recovery.restore-refs':"));
assert(server.includes('requireAggregateExpectedHead(expectedHeadSha)'));
assert(server.includes('partialFailure: !ok && report.some(item => item.ok)'));
assert(server.includes('providerOperationIds: execution ? execution.operationIds : []'));

console.log('mutation coverage server contract tests passed');
