'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'capability-ui.js'), 'utf8');
const notes = new Map();

function control(feature, options = {}) {
  const element = {
    dataset: {
      feature,
      ...(options.allowExperimental ? { allowExperimental: 'true' } : {})
    },
    attributes: new Map(),
    children: options.children || [],
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) || null; },
    querySelectorAll() { return this.children; },
    insertAdjacentElement(_position, note) { notes.set(note.id, note); }
  };
  if (options.native !== false) element.disabled = !!options.disabled;
  return element;
}

const body = {
  provider: 'gitlab',
  authority: 'gitlab.com',
  deployment: 'hosted-alpha',
  features: {
    'file.batch': {
      feature: 'file.batch', provider: 'gitlab', authority: 'gitlab.com', deployment: 'hosted-alpha',
      status: 'Unavailable', evidenceState: 'Unavailable', reason: 'Atomic batch is not qualified for GitLab.'
    },
    governance: {
      feature: 'governance', provider: 'gitlab', authority: 'gitlab.com', deployment: 'hosted-alpha',
      status: 'Experimental', evidenceState: 'Deterministic', reason: 'Policy views have narrower mutation coverage.'
    },
    'file.read': {
      feature: 'file.read', provider: 'gitlab', authority: 'gitlab.com', deployment: 'hosted-alpha',
      status: 'Supported', evidenceState: 'Provider-verified', reason: 'Qualified GitLab file reads.'
    }
  }
};

const window = {};
const document = {
  getElementById: id => notes.get(id) || null,
  createElement: () => ({ id: '', className: '', textContent: '', dataset: {} })
};
const sandbox = {
  window,
  document,
  URLSearchParams,
  fetch: async () => ({ ok: true, json: async () => body }),
  console,
  Object,
  Set,
  String
};
vm.runInNewContext(source, sandbox, { filename: 'capability-ui.js' });

(async () => {
  await window.NebulaCapabilityUI.load('gitlab', 'gitlab.com');
  const nestedButton = control('file.batch');
  const batchContainer = control('file.batch', { native: false, children: [nestedButton] });
  const experimentalBlocked = control('governance');
  const experimentalAllowed = control('governance', { allowExperimental: true });
  const supported = control('file.read');
  const root = {
    querySelectorAll: () => [batchContainer, experimentalBlocked, experimentalAllowed, supported]
  };

  window.NebulaCapabilityUI.apply(root);

  assert.strictEqual(batchContainer.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(nestedButton.disabled, true,
    'blocking a capability container must disable its direct interactive descendants');
  assert.strictEqual(experimentalBlocked.disabled, true);
  assert.strictEqual(experimentalAllowed.disabled, false);
  assert.strictEqual(supported.disabled, false);
  assert.strictEqual(
    batchContainer.dataset.capabilityReason,
    'Atomic batch is not qualified for GitLab.'
  );
  const note = notes.get(batchContainer.dataset.capabilityNoteId);
  assert(note && note.textContent.includes('Unavailable — Atomic batch is not qualified for GitLab.'));
  assert.strictEqual(
    window.NebulaCapabilityUI.decision('unknown.feature').status,
    'Unavailable',
    'unknown features must fail closed'
  );

  console.log('capability UI behavior tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
