'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
for (const route of [
  "/api/repo/:owner/:repo/governance/templates",
  "/api/repo/:owner/:repo/governance/templates/:templateId",
  "/api/repo/:owner/:repo/governance/baselines/generate",
  "/api/repo/:owner/:repo/governance/digital-twin"
]) assert(server.includes(route), `missing ${route}`);
assert(server.includes("governanceAccess('reader')"));
assert(server.includes("res.setHeader('Cache-Control', 'no-store')"));
assert(server.includes('governanceRepositoryFacts'));
assert(server.includes('repositoryFacts'));

assert(server.includes("new RegExp('^/api/repo/[^/]+/[^/]+/governance/baselines/generate$')"),
  'read-only safeguards must exempt only the exact baseline generation route');
assert(server.includes('gh(req.gh, `${R(req)}/branches?per_page=100`)'),
  'branch facts must use GitHub pagination');

console.log('governance template and Digital Twin server contract tests passed');
