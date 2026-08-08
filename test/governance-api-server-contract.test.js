'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const gateway = fs.readFileSync(path.join(root, 'src', 'mutation-gateway.js'), 'utf8');

assert(server.includes("require('./src/governance-api')"), 'server must load the governance API boundary');
assert(server.includes("require('./src/governance-store')"), 'server must load the durable governance store');
assert(server.includes('function governanceAccess('), 'server must expose one governance authorization middleware');
assert(server.includes('function governanceMutationContext('), 'governance writes must use one mutation gateway middleware');
assert(server.includes('req.governance.authorization'), 'governance boundary must retain only server-derived authorization evidence');
assert(!server.includes('req.body.governanceRoles'), 'browser governance roles must never be trusted');
assert(!server.includes('req.body.actorIdentityKey'), 'browser actor identities must never be trusted');
assert(server.includes("req.get('Idempotency-Key')"), 'governance writes must accept a bounded idempotency key without putting it in descriptors');
assert(server.includes("res.setHeader('Cache-Control', 'no-store')"), 'governance responses must disable browser and intermediary caching');
assert(server.includes('function isCurrentGovernanceControlPlaneRequest('), 'read-only exemption must enumerate the current governance control-plane routes');
assert(server.includes('if (isCurrentGovernanceControlPlaneRequest(req)) return null;'), 'guardSafety must use the bounded governance-route classifier');
assert(!server.includes("if (/^\\/api\\/repo\\/[^/]+\\/[^/]+\\/governance(?:\\/|$)/.test(req.path)) return null;"), 'future governance routes must not inherit an automatic read-only exemption');

const routes = [
  "app.get('/api/repo/:owner/:repo/governance/policies'",
  "app.post('/api/repo/:owner/:repo/governance/policies'",
  "app.get('/api/repo/:owner/:repo/governance/policies/:policyId'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/validate'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts'",
  "app.get('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId'",
  "app.patch('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/submit'",
  "app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions'",
  "app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId'",
  "app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me'",
  "app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions'"
];
for (const route of routes) assert(server.includes(route), `missing governance route ${route}`);
for (const action of ['governance.policy.create', 'governance.draft.create', 'governance.draft.update', 'governance.draft.submit', 'governance.reviewer.assign', 'governance.approval.decide']) {
  assert(gateway.includes(`'${action}'`), `mutation gateway must register ${action}`);
  assert(server.includes(`governanceMutationContext('${action}'`), `server must enter the gateway for ${action}`);
}
assert(server.includes("governanceMutationContext('governance.approval.decide')"), 'Task 8 decisions must enter the mutation gateway');
assert(!server.includes('reviewerIdentityKey: req.body'), 'reviewer identity must never come from the browser body');
assert(!server.includes("governanceMutationContext('governance.activation"), 'Task 11 activation workflow must remain out of scope');
console.log('governance API server contract tests passed');
