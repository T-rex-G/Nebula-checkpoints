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

assert(ui.includes('/api/capabilities'));
assert(ui.includes("status === 'Unavailable'"));
assert(ui.includes("status === 'Experimental'"));
assert(ui.includes('aria-disabled'));
assert(ui.includes('data-capability-reason'));
assert(ui.includes('Object.freeze'));
assert(app.includes('NebulaCapabilityUI.load'));
assert(app.includes('NebulaCapabilityUI.apply'));
assert(app.includes('function runCapabilityAction'));
assert(app.includes("const tabCapability = tab && tab.dataset.feature"));
assert(html.includes('/capability-ui.js?v=__NV_ASSET_VERSION__'));
assert(sw.includes('/capability-ui.js?v='));
assert(!html.includes('data-cap='), 'legacy capability markers must be replaced, not hidden');

const features = [...html.matchAll(/data-feature="([^"]+)"/g)].map(match => match[1]);
assert(features.length >= 20, 'all primary and mobile alpha actions need capability markers');
for (const feature of features) {
  assert(knownFeatures.has(feature), `unknown capability marker: ${feature}`);
}
for (const [id, feature] of Object.entries({
  newRepoBtn: 'repository.create',
  notifBtn: 'notifications',
  repoGlobalSearchBtn: 'global-search',
  codeSearch: 'search',
  newFileBtn: 'file.write',
  newBranchBtn: 'branches.write',
  tmOpenBtn: 'recovery',
  neuralLiveBtn: 'live-events',
  govTabLabel: 'governance'
})) {
  const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`));
  assert(tag && tag[0].includes(`data-feature="${feature}"`), `#${id} must map to ${feature}`);
}
assert(
  html.match(/id="neuralLiveBtn"[^>]*data-allow-experimental="true"/),
  'verified live events must remain an explicitly labelled experimental opt-in'
);
assert(
  html.match(/id="codeSearch"[^>]*data-allow-experimental="true"/),
  'bounded repository search must remain an explicitly labelled experimental opt-in'
);
for (const [id, feature] of Object.entries({
  renameFileBtn: 'file.rename',
  uploadMode: 'file.batch',
  newPrBtn: 'pulls.write',
  newIssueBtn: 'issues.write',
  newReleaseBtn: 'releases.write'
})) {
  const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`));
  assert(tag && tag[0].includes(`data-feature="${feature}"`) && tag[0].includes('data-allow-experimental="true"'),
    `#${id} must remain an explicitly labelled ${feature} experimental opt-in`);
}
for (const feature of ['pulls.read', 'issues.read', 'releases.read', 'workflows.read']) {
  const tag = html.match(new RegExp(`<button[^>]+data-feature="${feature}"[^>]*data-tab=`));
  assert(tag && tag[0].includes('data-allow-experimental="true"'),
    `${feature} desktop navigation must remain an explicit experimental opt-in`);
  const mobile = html.match(new RegExp(`<button[^>]+data-feature="${feature}"[^>]*data-act=`));
  assert(mobile && mobile[0].includes('data-allow-experimental="true"'),
    `${feature} mobile navigation must remain an explicit experimental opt-in`);
}
for (const [label, feature] of [
  ['Push files (upload)', 'native-push'],
  ['New branch', 'branches.write'],
  ['Emergency recovery snapshot', 'recovery'],
  ['Security scan — vulnerable dependencies', 'dependency-audit'],
  ['Delete this repository…', 'repository.delete']
]) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert(new RegExp(`label: '${escaped}'[^\n]+feature: '${feature}'`).test(app),
    `command ${label} must map to ${feature}`);
}
for (const [label, feature] of [
  ['Pull requests', 'pulls.read'],
  ['Issues', 'issues.read'],
  ['Releases', 'releases.read'],
  ['Staged changes', 'file.batch'],
  ['Actions (CI)', 'workflows.read'],
  ['Star / unstar this repo', 'stars.write']
]) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert(new RegExp(`label: '${escaped}'[^\n]+feature: '${feature}'[^\n]+allowExperimental: true`).test(app),
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
