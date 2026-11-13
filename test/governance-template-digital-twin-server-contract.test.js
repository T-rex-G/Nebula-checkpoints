'use strict';
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
/* Every route with its guard chain, as the route policy reads them from the composition root and the modules' registrations. */
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
/*
 * What these routes do is asked of them where they are built: that a
 * governance answer is never cached, of Kepler's governance context
 * (test/governance-context.test.js); that a baseline is generated from the
 * repository's own facts -- its default branch, its visibility and its
 * protected branches, read a page of a hundred at a time -- of Kepler's
 * routes (test/kepler-governance-routes.test.js); and that read-only mode lets
 * exactly baseline generation through, of Corona's safety guard
 * (test/corona-safety-guard.test.js).
 */

console.log('governance template and Digital Twin server contract tests passed');
