'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
for (const symbol of ['clearGovernanceState', 'renderGovernanceInterface', 'loadGovernanceTwin', 'announceGovernance']) {
  assert(app.includes(`function ${symbol}`) || app.includes(`async function ${symbol}`), `client missing ${symbol}`);
}
assert(app.includes("if (name === 'governance') loadGovernanceTwin()"), 'Governance tab must lazy-load the read model');
assert(app.includes('/governance/digital-twin?historyLimit=50'), 'client must request a bounded Digital Twin history page');
assert(app.includes('/governance/decisions/verify?limit=50000'), 'client must expose bounded chain verification');
assert(app.includes("$('#govRoot').innerHTML = window.NebulaGovernanceUI.renderGovernanceInterface"), 'client must use the pure renderer');
assert(app.includes('clearGovernanceState();') && app.indexOf('clearGovernanceState();') < app.indexOf('state.work = { owner, repo'), 'opening a repository must clear prior governance state before assigning the new repository');
assert(!app.includes('nv_governance') && !app.includes('localStorage.setItem(\'governance'), 'governance evidence must not be persisted in browser storage');
assert(app.includes("data-gov-action") || app.includes("closest('[data-gov-action]')"), 'client needs delegated governance actions');
assert(app.includes('GOVERNANCE_EXPERIMENTAL_VIEW_ACTIONS'), 'client must define the experimental governance view allowlist');
assert(app.includes('function applyGovernanceCapabilityBoundary'), 'client must enforce provider governance view-only presentation');
const governanceViewAllowlist = app.match(
  /const GOVERNANCE_EXPERIMENTAL_VIEW_ACTIONS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/
);
assert(governanceViewAllowlist, 'client must expose a statically reviewable experimental governance view allowlist');
for (const action of [
  'refresh', 'select-policy', 'view-version', 'view-exception', 'verify-chain',
  'load-more-decisions', 'delivery-refresh', 'download-export', 'verify-export'
]) assert(governanceViewAllowlist[1].includes(`'${action}'`), `experimental governance view allowlist missing ${action}`);
assert(app.includes("decision('governance').status !== 'Experimental'"),
  'governance mutation controls must be disabled only for the view-only experimental boundary');
assert(app.includes("button.dataset.governanceExperimentalDisabled = 'true'"),
  'experimental governance mutations must carry an explicit disabled reason');
console.log('governance interface client contract tests passed');
