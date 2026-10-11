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
  provider: 'github',
  authority: 'github.com',
  deployment: 'hosted-alpha',
  features: {
    'file.batch': {
      feature: 'file.batch', provider: 'github', authority: 'github.com', deployment: 'hosted-alpha',
      status: 'Unavailable', evidenceState: 'Unavailable', reason: 'Atomic batch is unavailable for this GitHub account.'
    },
    governance: {
      feature: 'governance', provider: 'github', authority: 'github.com', deployment: 'hosted-alpha',
      status: 'Experimental', evidenceState: 'Deterministic', reason: 'Policy views have narrower mutation coverage.'
    },
    'file.read': {
      feature: 'file.read', provider: 'github', authority: 'github.com', deployment: 'hosted-alpha',
      status: 'Supported', evidenceState: 'Provider-verified', reason: 'Qualified GitHub file reads.'
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
  await window.NebulaCapabilityUI.load('github', 'github.com');
  const nestedButton = control('file.batch');
  const batchContainer = control('file.batch', { native: false, children: [nestedButton] });
  const experimental = control('governance');
  const supported = control('file.read');
  const unavailableButton = control('file.batch', { tagName: 'BUTTON' });
  let controls = [batchContainer, experimental, supported, unavailableButton];
  const root = { querySelectorAll: () => controls };

  window.NebulaCapabilityUI.apply(root);

  /*
   * Only what is Supported is rendered. A control for anything else is taken
   * out of the page and the accessibility tree -- not dimmed, not labelled
   * Experimental or Unavailable -- and the server refuses it regardless.
   */
  for (const blocked of [batchContainer, experimental, unavailableButton]) {
    assert.strictEqual(blocked.hidden, true, `${blocked.dataset.feature} must not be rendered`);
    assert.strictEqual(blocked.getAttribute('data-capability-blocked'), 'true');
    assert.strictEqual(blocked.dataset.capabilityNoteId, undefined, 'a control that is not rendered carries no status note');
  }
  assert.strictEqual(nestedButton.getAttribute('data-capability-blocked'), 'true', 'what is inside a removed control is refused too');
  assert.notStrictEqual(supported.hidden, true);
  assert.strictEqual(supported.getAttribute('data-capability-blocked'), 'false');
  assert.strictEqual(supported.disabled, false);
  assert.strictEqual(
    window.NebulaCapabilityUI.decision('unknown.feature').status,
    'Unavailable',
    'unknown features must fail closed'
  );
  assert(![...notes.values()].some(note => /Experimental|Unavailable/.test(note.textContent)),
    'no Experimental or Unavailable label is drawn anywhere');

  /* A capability that becomes Supported comes back, exactly as it was. */
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ...body, features: { ...body.features,
    governance: { ...body.features.governance, status: 'Supported', evidenceState: 'Deterministic' } } }) });
  await window.NebulaCapabilityUI.load('github', 'github.com');
  window.NebulaCapabilityUI.apply(root);
  assert.strictEqual(experimental.hidden, false, 'a control hidden for its capability is shown again once Supported');
  assert.strictEqual(experimental.getAttribute('data-capability-blocked'), 'false');
  assert.strictEqual(batchContainer.hidden, true);

  /*
   * A projection that could not be loaded is an outage, not a verdict. Nothing
   * is hidden for it: the controls stay where they are, refused and saying why,
   * so the person can see that something is wrong and retry.
   */
  sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
  await window.NebulaCapabilityUI.load('github', 'github.com');
  const field = control('file.batch', { tagName: 'INPUT' });
  const pressable = control('file.batch', { tagName: 'BUTTON' });
  controls = [field, pressable];
  window.NebulaCapabilityUI.apply(root);
  assert.notStrictEqual(field.hidden, true);
  assert.notStrictEqual(pressable.hidden, true);
  assert.strictEqual(field.disabled, true, 'a refused field must not accept input it will discard');
  assert.strictEqual(pressable.disabled, false, 'a refused button stays pressable so that the refusal can be voiced');
  assert.strictEqual(pressable.getAttribute('data-capability-blocked'), 'true');
  const outage = notes.get(field.dataset.capabilityNoteId);
  assert(outage && String(outage.getAttribute('aria-label') || '').includes('could not be loaded'), 'the outage is explained');
  sandbox.fetch = async () => ({ ok: true, json: async () => body });
  await window.NebulaCapabilityUI.load('github', 'github.com');

  // An older account response must never overwrite the latest projection.
  const pending = [];
  sandbox.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const firstAccount = window.NebulaCapabilityUI.load('github', 'github.com', { connected: true });
  const secondAccount = window.NebulaCapabilityUI.load('github', 'github.com', { connected: true });
  assert(pending.every(call => call.url.startsWith('/api/account/capabilities?')));
  assert(pending.every(call => call.options.cache === 'no-store' && call.options.credentials === 'same-origin'));
  pending[1].resolve({ ok: true, json: async () => body });
  await secondAccount;
  pending[0].resolve({ ok: false, json: async () => ({}) });
  await firstAccount;
  assert.strictEqual(window.NebulaCapabilityUI.decision('file.read').status, 'Supported');
  for (const retiredProvider of ['gitlab', 'gitea', 'unknown']) {
    let fetched = false;
    sandbox.fetch = async () => { fetched = true; return { ok: true, json: async () => body }; };
    await window.NebulaCapabilityUI.load(retiredProvider, 'github.com', { connected: true });
    assert.strictEqual(fetched, false, 'unsupported identities must not request GitHub capabilities');
    assert.strictEqual(window.NebulaCapabilityUI.decision('file.read').status, 'Unavailable');
  }
  let fetchedCustomHost = false;
  sandbox.fetch = async () => { fetchedCustomHost = true; return { ok: true, json: async () => body }; };
  await window.NebulaCapabilityUI.load('github', 'git.example.org', { connected: true });
  assert.strictEqual(fetchedCustomHost, false, 'custom hosts are not supported GitHub identities');
  assert.strictEqual(window.NebulaCapabilityUI.decision('file.read').status, 'Unavailable');
  console.log('capability UI behavior tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
