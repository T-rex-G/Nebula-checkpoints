'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
const requiredFunctions = [
  'createGovernancePolicy', 'createGovernanceDraft', 'generateGovernanceBaseline',
  'editGovernanceDraft', 'validateGovernanceDraft', 'submitGovernanceDraft',
  'simulateGovernanceVersion', 'claimGovernanceReview', 'decideGovernanceReview',
  'governanceActivateOrRollback', 'requestGovernanceException',
  'decideGovernanceException', 'revokeGovernanceException', 'loadMoreGovernanceDecisions'
];
for (const fn of requiredFunctions) assert(app.includes(`function ${fn}`) || app.includes(`async function ${fn}`), `missing workflow ${fn}`);
for (const route of [
  '/templates', '/baselines/generate', '/policies',
  '/drafts', '/validate', '/submit', '/simulate', '/reviewers/me', '/decisions',
  '/versions/', '/exceptions', '/decision', '/revoke'
]) assert(app.includes(route), `workflow route fragment missing ${route}`);
assert(app.includes("'Idempotency-Key': governanceIdempotencyKey"), 'governance writes need unique idempotency keys');
/* JSON inputs pass the module's bounded parser: test/e2e/governance-lifecycle.spec.js refuses each malformed one before a request. */
assert(app.includes("state.governance.simulation = null"), 'authoritative read-model changes must invalidate stale simulation evidence');
console.log('governance interface workflow contract tests passed');
