'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
for (const marker of [
  'data-tab="governance"', 'id="tab-governance"', 'id="govRoot"', 'id="govLive"',
  'aria-labelledby="govTabLabel"', 'data-act="governance"', '/governance-ui.js?v=__NV_ASSET_VERSION__'
]) assert(html.includes(marker), `governance interface shell missing ${marker}`);
assert(html.includes('role="status"') && html.includes('aria-live="polite"'), 'governance interface needs an ARIA live region');
for (const selector of ['.gov-shell', '.gov-summary-grid', '.gov-policy-card', '.gov-banner', '.gov-history-grid']) {
  assert(css.includes(selector), `governance interface styles missing ${selector}`);
}
assert(css.includes('@media(max-width:900px)') || css.includes('@media (max-width:900px)'), 'governance interface must participate in responsive styling');
assert(css.includes('@media(prefers-reduced-motion:reduce)') || css.includes('@media (prefers-reduced-motion: reduce)'), 'governance interface must respect reduced motion');
assert(sw.includes('/governance-ui.js?v=__NV_ASSET_VERSION__'), 'governance renderer must be part of the versioned static shell');

assert(html.includes('role="dialog"') && html.includes('aria-labelledby="modalTitle"'), 'governance workflows need a labelled modal dialog');
assert(app.includes("e.key === 'Tab'") && app.includes("#modal button:not([disabled])"), 'modal workflows need a keyboard focus trap');
assert(app.includes('modalReturnFocus'), 'modal workflows must restore focus');

console.log('governance interface UI contract tests passed');
