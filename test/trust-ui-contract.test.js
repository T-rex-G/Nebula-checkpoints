'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'public', 'trust-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

for (const id of [
  'trustSummary', 'trustConnection', 'trustPipeline',
  'trustRisk', 'trustAction', 'trustEvidence', 'a11yStatus'
]) assert(html.includes(`id="${id}"`), `missing #${id}`);
for (const evidenceState of [
  'Provider-verified', 'Deterministic', 'Inferred',
  'Stale', 'Unavailable'
]) assert(ui.includes(evidenceState), `missing evidence state ${evidenceState}`);
assert(ui.includes('correlationId'));
assert(ui.includes('providerChanged'));
assert(ui.includes('safeState'));
assert(ui.includes('nextAction'));
assert(ui.includes('navigator.clipboard.writeText'));
assert(ui.includes("setAttribute('role', 'dialog')"));
assert(ui.includes("setAttribute('aria-modal', 'true')"));
assert(!ui.includes('.innerHTML'), 'trust and error values must be rendered through textContent');
assert(app.includes('Promise.allSettled(['));
for (const endpoint of ['live-events/status', 'access-surface', 'evidence']) {
  assert(app.includes(endpoint), `trust summary must load ${endpoint}`);
}
assert(app.includes('NebulaTrustUI.renderSummary'));
assert(app.includes('NebulaTrustUI.presentError'));
assert(html.includes('/trust-ui.js?v=__NV_ASSET_VERSION__'));
assert(sw.includes('/trust-ui.js?v='));

console.log('trust UI contract tests passed');
