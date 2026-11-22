'use strict';
/*
 * The governance client (features/governance/governance-actions.ts): the
 * Digital Twin read with a bounded history, chain verification bounded, the
 * screen's controls delegated through data-gov-action, and no governance
 * evidence kept in the browser's storage -- only the view's own cleared-
 * through sequence. The section is drawn by the module's renderer: the
 * governance browser tests press its controls (test/e2e/governance-lifecycle.spec.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createGovernance } = require('../apps/web/src/features/governance/governance-actions.ts');
const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');

/* The page wires it: the tab reads the twin when it is first shown, and opening a repository clears the last one's governance before anything else. */
assert(app.includes("if (name === 'governance') loadGovernanceTwin()"), 'Governance tab must lazy-load the read model');
assert(/function resetRepositoryViews\(\) \{\s*clearGovernanceState\(\);/.test(app), 'opening a repository must clear prior governance state before assigning the new repository');
/* Governance is either Supported and whole, or not rendered and refused by the server; there is no view-only middle state. */
assert(!app.includes('GOVERNANCE_EXPERIMENTAL_VIEW_ACTIONS') && !app.includes('applyGovernanceCapabilityBoundary'),
  'the experimental view-only governance path is gone');

(async () => {
  const asked = [];
  const stored = [];
  const listeners = {};
  const root = { addEventListener: (type, run) => { listeners[type] = run; } };
  const state = { work: { owner: 'Acme', repo: 'Demo' }, governance: { delivery: {} } };
  const governance = createGovernance({
    state, mutate: change => change(state.governance),
    api: async url => { asked.push(url); return /digital-twin/.test(url) ? { digitalTwin: { readModelHash: 'h' }, access: null } : { verification: { valid: true } }; },
    modal: async () => true, toast() {}, stepUp: async () => null,
    $: selector => (selector === '#govRoot' ? root : null),
    doc: { createElement: () => ({}), body: { appendChild() {} }, activeElement: null },
    storage: () => ({ getItem: () => null, setItem: (key, value) => stored.push(key) }),
    draw() {}, requestAnimationFrame: run => run(), setTimeout: () => 0, clearTimeout() {}, now: () => 0, randomId: () => 'id', cssEscape: value => value
  });
  for (const name of ['clear', 'render', 'load', 'announce', 'scheduleAccessExpiry', 'wire']) assert.strictEqual(typeof governance[name], 'function', `client missing ${name}`);
  await governance.load();
  assert(asked[0] === '/api/repo/Acme/Demo/governance/digital-twin?historyLimit=50', 'client must request a bounded Digital Twin history page');
  governance.wire(root);
  const control = { dataset: { govAction: 'verify-chain' }, disabled: false, setAttribute() {}, removeAttribute() {} };
  await listeners.click({ target: { closest: selector => (selector === '[data-gov-action]' ? control : null) } });
  assert(asked.includes('/api/repo/Acme/Demo/governance/decisions/verify?limit=50000'), 'client must expose bounded chain verification, through delegated actions');
  await governance.handlers['ledger-clear']({ dataset: { through: '3' } });
  assert.deepStrictEqual(stored, ['nv_view:ledger:acme/demo'], 'governance evidence must not be persisted in browser storage; only the view is');
  console.log('governance interface client contract tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
