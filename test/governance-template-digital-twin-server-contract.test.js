'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { serverSource } = require('./helpers/server-source');
const root = path.resolve(__dirname, '..');
const server = serverSource();
const governanceRoutes = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-routes.ts'), 'utf8');
/* Every route with its guard chain, as the route policy reads them from server.js and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
const policyRoutes = locations(root).filter(entry => entry.kind === 'route');
for (const [method, routePath] of [
  ['GET', '/api/repo/:owner/:repo/governance/templates'],
  ['GET', '/api/repo/:owner/:repo/governance/templates/:templateId'],
  ['POST', '/api/repo/:owner/:repo/governance/baselines/generate'],
  ['GET', '/api/repo/:owner/:repo/governance/digital-twin']
]) {
  const entry = policyRoutes.find(candidate => candidate.method === method && candidate.path === routePath);
  assert(entry, `missing ${method} ${routePath}`);
  assert(entry.guards.includes("governanceAccess('reader')"), `${method} ${routePath} must be reader authorized`);
}
assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-context.ts'), 'utf8').includes("res.setHeader('Cache-Control', 'no-store')"), 'governance answers are never cached (Kepler\'s governance context)');
assert(governanceRoutes.includes('const readRepositoryFacts = async (req: Request)'));
assert(governanceRoutes.includes('const repositoryFacts = await readRepositoryFacts(req);'));

assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'corona', 'domain', 'safety-guard.ts'), 'utf8').includes("new RegExp('^/api/repo/[^/]+/[^/]+/governance/baselines/generate$')"),
  'read-only safeguards must exempt only the exact baseline generation route');
assert(governanceRoutes.includes('deps.gh(account(req), `${repositoryPath(req)}/branches?per_page=100`)'),
  'branch facts must use GitHub pagination');

console.log('governance template and Digital Twin server contract tests passed');
