'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'public', 'capability-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'config', 'public-alpha-capabilities.json'), 'utf8'));
const knownFeatures = new Set(Object.keys(registry.providers.github['hosted-alpha']));

function uniqueMatch(matches, label) {
  assert.strictEqual(matches.length, 1, `${label} must match exactly once; observed ${matches.length}`);
  return matches[0];
}

function htmlTagsWith(...attributes) {
  return [...html.matchAll(/<[^>]+>/g)].map(match => match[0])
    .filter(tag => attributes.every(attribute => tag.includes(attribute)));
}

function htmlTagWith(...attributes) {
  return uniqueMatch(htmlTagsWith(...attributes), `HTML tag with ${attributes.join(', ')}`);
}

function commandObjectAt(start) {
  let depth = 0;
  let quote = '';
  let escapedCharacter = false;
  for (let index = start; index < app.length; index += 1) {
    const character = app[index];
    if (quote) {
      if (escapedCharacter) escapedCharacter = false;
      else if (character === '\\') escapedCharacter = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (["'", '"', '`'].includes(character)) quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return app.slice(start, index + 1);
  }
  return null;
}

function commandObjects(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...app.matchAll(new RegExp(`\\{\\s*label:\\s*'${escaped}'`, 'g'))]
    .map(marker => commandObjectAt(marker.index))
    .filter(Boolean);
}

/*
 * The palette's own entries, told apart from anywhere else in the interface
 * that offers the same action. Every palette command declares a kind; the
 * floating action's entries do not. Without that distinction the arrival of a
 * second placement for "New branch" read as a duplicate palette command, when
 * what had actually happened is that the action is now reachable from two
 * places -- which is fine, and is exactly what the check below insists on:
 * wherever an action is offered, it is gated on the same capability.
 */
function commandObject(label) {
  const palette = commandObjects(label).filter(entry => /\bkind:\s*'/.test(entry));
  return uniqueMatch(palette, `palette command ${label}`);
}

function everyPlacement(label) {
  const placements = commandObjects(label);
  assert(placements.length >= 1, `${label} is offered nowhere`);
  return placements;
}

assert.deepStrictEqual(commandObjects('Synthetic command that is absent'), []);
assert.throws(() => uniqueMatch(['first', 'second'], 'synthetic duplicate'), /match exactly once/);

assert(ui.includes('/api/capabilities'));
assert(ui.includes("status === 'Unavailable'"));
assert(ui.includes("status === 'Experimental'"));
assert(ui.includes('aria-disabled'));
assert(ui.includes('data-capability-reason'));
assert(ui.includes('Object.freeze'));
assert(app.includes('NebulaCapabilityUI.load'));
assert(app.includes('NebulaCapabilityUI.apply'));
assert(app.includes('function runCapabilityAction'));
/*
 * switchTab has to gate on the chosen tab's own capability. This used to pin
 * the exact source line, which broke the moment the function grew a guard for
 * unknown tab names -- and a literal match cannot tell a refactor from a
 * regression. Read the function and assert what it must do instead.
 */
const switchTabBody = (() => {
  const start = app.indexOf('function switchTab(');
  assert(start !== -1, 'switchTab must exist');
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error('switchTab body did not close');
})();
assert(/dataset\.feature/.test(switchTabBody), 'switchTab must read the tab capability');
assert(switchTabBody.includes('runCapabilityAction'), 'switchTab must gate on that capability');
assert(/if \(!tab\) return;/.test(switchTabBody),
  'switchTab must leave the workbench alone when no tab matches: selection is a toggle ' +
  'over every tab and pane, so an unknown name deselects all of them');
assert(html.includes('/capability-ui.js?v=__NV_ASSET_VERSION__'));
assert(sw.includes('/capability-ui.js?v='));
assert(!html.includes('data-cap='), 'legacy capability markers must be replaced, not hidden');

const features = [...html.matchAll(/data-feature="([^"]+)"/g)].map(match => match[1]);
assert(features.length >= 20, 'all primary and mobile alpha actions need capability markers');
for (const feature of features) {
  assert(knownFeatures.has(feature), `unknown capability marker: ${feature}`);
}
for (const [id, feature] of Object.entries({
  newRepoBtnRepos: 'repository.create',
  notifBtn: 'notifications',
  codeSearch: 'search',
  newFileBtn: 'file.write',
  newBranchBtn: 'branches.write',
  tmOpenBtn: 'recovery',
  neuralLiveBtn: 'live-events',
  govTabLabel: 'governance'
})) {
  const tag = htmlTagWith(`id="${id}"`, `data-feature="${feature}"`);
  assert(tag, `#${id} must map to ${feature}`);
}
assert(
  htmlTagWith('id="neuralLiveBtn"', 'data-allow-experimental="true"'),
  'verified live events must remain an explicitly labelled experimental opt-in'
);
assert(
  htmlTagWith('id="codeSearch"', 'data-allow-experimental="true"'),
  'bounded repository search must remain an explicitly labelled experimental opt-in'
);
for (const [id, feature] of Object.entries({
  renameFileBtn: 'file.rename',
  uploadMode: 'file.batch',
  newPrBtn: 'pulls.write',
  newIssueBtn: 'issues.write',
  newReleaseBtn: 'releases.write'
})) {
  const tag = htmlTagWith(
    `id="${id}"`,
    `data-feature="${feature}"`,
    'data-allow-experimental="true"'
  );
  assert(tag,
    `#${id} must remain an explicitly labelled ${feature} experimental opt-in`);
}
for (const feature of ['pulls.read', 'issues.read', 'releases.read', 'workflows.read']) {
  const tag = htmlTagWith('<button', `data-feature="${feature}"`, 'data-tab=');
  assert(tag && tag.includes('data-allow-experimental="true"'),
    `${feature} desktop navigation must remain an explicit experimental opt-in`);
  const mobile = htmlTagWith('<button', `data-feature="${feature}"`, 'data-act=');
  assert(mobile && mobile.includes('data-allow-experimental="true"'),
    `${feature} mobile navigation must remain an explicit experimental opt-in`);
}
for (const [label, feature] of [
  ['Push files (upload)', 'native-push'],
  ['New branch', 'branches.write'],
  ['Emergency recovery snapshot', 'recovery'],
  ['Security scan — vulnerable dependencies', 'dependency-audit'],
  ['Delete this repository…', 'repository.delete']
]) {
  const command = commandObject(label);
  assert(command, `command ${label} is missing`);
  /*
   * Every placement, not just the palette's. An action that is gated in the
   * palette and ungated in the floating menu is an action with no gate.
   */
  for (const placement of everyPlacement(label)) {
    assert(placement.includes(`feature: '${feature}'`),
      `${label} must map to ${feature} wherever it is offered`);
  }
}
for (const [label, feature] of [
  ['Pull requests', 'pulls.read'],
  ['Issues', 'issues.read'],
  ['Releases', 'releases.read'],
  ['Staged changes', 'file.batch'],
  ['Actions (CI)', 'workflows.read'],
  ['Star / unstar this repo', 'stars.write']
]) {
  const command = commandObject(label);
  assert(command, `command ${label} is missing`);
  assert(command.includes(`feature: '${feature}'`) && command.includes('allowExperimental: true'),
    `command ${label} must remain an explicit experimental opt-in`);
}

for (const [id, feature] of Object.entries({
  sgSnap: 'recovery',
  sgRecover: 'recovery',
  sgActivity: 'governance',
  sgScan: 'dependency-audit',
  sgEvidence: 'governance'
})) {
  assert(app.includes(`id="${id}" data-feature="${feature}"`),
    `dynamic safeguard #${id} must map to ${feature}`);
}
assert(app.includes('data-rerun data-feature="workflows.rerun" data-allow-experimental="true"'),
  'dynamic workflow rerun must declare its experimental capability');
assert(app.includes("NebulaCapabilityUI.apply($('#modalBody'))"),
  'dynamic safeguard controls must receive capability state');
assert(app.includes('NebulaCapabilityUI.apply(acts)'),
  'dynamic workflow controls must receive capability state');

console.log('capability UI contract tests passed');
