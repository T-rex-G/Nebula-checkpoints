'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'capability-ui.js'), 'utf8');
const notes = new Map();

function control(feature, options = {}) {
  const element = {
    /*
     * Modelled because the module now asks: a refused <button> keeps its
     * native property and is answered when it is pressed, while a refused
     * field is taken out of the reader's hands. A stub with no tagName is
     * neither, and stands for the div a palette entry is drawn as.
     */
    tagName: options.tagName || '',
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
  createElement: () => {
    /*
     * Models the surface the module uses on a created node. setAttribute is
     * here because the capability note carries its reason in an accessible
     * name rather than in visible prose.
     */
    const attributes = {};
    return {
      id: '', className: '', textContent: '', title: '', dataset: {}, attributes,
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; }
    };
  }
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
  const refusedButton = control('file.batch', { tagName: 'BUTTON' });
  const refusedField = control('file.batch', { tagName: 'INPUT' });
  const root = {
    querySelectorAll: () => [
      batchContainer, experimentalBlocked, experimentalAllowed, supported,
      refusedButton, refusedField
    ]
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
  /*
   * A refused button is not handed to the browser to silence. `disabled` stops
   * the press before any handler runs, so nothing is left to say why the
   * action was refused, and it takes the control out of the tab order, which
   * takes the reason's own accessible description with it. It stays pressable
   * and is answered out loud instead -- which is what the same action drawn as
   * a palette entry has always done, for no better reason than that a div has
   * no property to set.
   */
  assert.strictEqual(refusedButton.disabled, false,
    'a refused button must stay pressable so that the refusal can be voiced');
  assert.strictEqual(refusedButton.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(refusedButton.getAttribute('data-capability-blocked'), 'true',
    'the press has to be interceptable from outside the control');
  /*
   * A field is the other case. Accepting typing it will discard is a worse
   * answer than refusing the keystroke.
   */
  assert.strictEqual(refusedField.disabled, true,
    'a refused field must not accept input it will discard');
  assert.strictEqual(supported.getAttribute('data-capability-blocked'), 'false',
    'an allowed control must not be marked as refused');
  /*
   * The reason must reach the reader; where it lives is the note's business.
   * It used to be printed inline, which put a sentence beside every control
   * carrying the feature -- six of them for one capability. The status is
   * shown and the reason travels in the accessible name and the tooltip, so
   * this asserts that it is reachable rather than that it is rendered as prose.
   */
  const note = notes.get(batchContainer.dataset.capabilityNoteId);
  assert(note, 'an unavailable control must carry a note');
  assert.strictEqual(note.textContent, 'Unavailable', 'the note shows the status');
  const reason = 'Atomic batch is not qualified for GitLab.';
  assert(
    String(note.getAttribute('aria-label') || '').includes(reason),
    'the reason must reach a screen reader through the note'
  );
  assert(String(note.title || '').includes(reason), 'the reason must be reachable by pointer');
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
