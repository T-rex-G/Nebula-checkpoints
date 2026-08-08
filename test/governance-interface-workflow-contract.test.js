'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
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
assert(app.includes("window.NebulaGovernanceUI.parseJsonObject"), 'JSON inputs must pass the bounded renderer parser');
assert(app.includes("state.governance.simulation = null"), 'authoritative read-model changes must invalidate stale simulation evidence');
console.log('governance interface workflow contract tests passed');
