'use strict';
const assert = require('assert');
const { loadsInShell } = require('./helpers/web-shell');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps', 'web', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'styles', 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'offline', 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
for (const marker of [
  'data-tab="governance"', 'id="tab-governance"', 'id="govRoot"', 'id="govLive"',
  'aria-labelledby="govTabLabel"', 'data-act="governance"'
]) assert(html.includes(marker), `governance interface shell missing ${marker}`);
assert(loadsInShell('apps/web/src/features/governance/GovernanceView.tsx'), 'governance view must be part of the page');
assert(html.includes('role="status"') && html.includes('aria-live="polite"'), 'governance interface needs an ARIA live region');
for (const selector of ['.gov-shell', '.gov-summary-grid', '.gov-policy-card', '.gov-banner', '.gov-history-grid']) {
  assert(css.includes(selector), `governance interface styles missing ${selector}`);
}
assert(css.includes('@media(max-width:900px)') || css.includes('@media (max-width:900px)'), 'governance interface must participate in responsive styling');
assert(css.includes('@media(prefers-reduced-motion:reduce)') || css.includes('@media (prefers-reduced-motion: reduce)'), 'governance interface must respect reduced motion');
assert(sw.includes('__NV_PRECACHE__'), 'governance renderer must be part of the versioned static shell, whose list the build writes');

assert(html.includes('role="dialog"') && html.includes('aria-labelledby="modalTitle"'), 'governance workflows need a labelled modal dialog');
assert(app.includes("e.key === 'Tab'") && app.includes("#modal button:not([disabled])"), 'modal workflows need a keyboard focus trap');
/* Focus goes back to what opened the dialog when it closes (components/modal.ts). */
{
  const { createModal } = require('../apps/web/src/components/modal.ts');
  const part = () => ({ textContent: '', hidden: false, scrollTop: 0, classList: { toggle() {} }, addEventListener() {}, contains: () => false });
  const parts = { scrim: part(), modal: part(), title: part(), body: { innerHTML: '', querySelector: () => null }, ok: part(), cancel: part(), close: null };
  const opener = { isConnected: true, focus() { active = opener; } };
  let active = opener;
  const frames = [];
  const dialog = createModal({ elements: () => parts, overlay: { openOverlay() {}, closeOverlay() {}, overlayOpen: () => true }, anchor() {}, epoch: () => 0, identity: () => null,
    activeElement: () => active, setTimeout() {}, requestAnimationFrame: run => frames.push(run) });
  dialog.open({ title: 'Policy', bodyHTML: '' });
  /* the dialog leaves, and focus with it */
  active = null;
  dialog.close(false);
  frames.forEach(run => run());
  assert.strictEqual(active, opener, 'modal workflows must restore focus');
}

console.log('governance interface UI contract tests passed');
