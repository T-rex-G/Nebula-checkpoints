'use strict';

const assert = require('assert');
const { loadPageModule } = require('./helpers/page-module');

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
    removeAttribute(name) { this.attributes.delete(name); },
    querySelectorAll() { return this.children; },
    insertAdjacentElement(_position, note) { notes.set(note.id, note); }
  };
  if (options.native !== false) element.disabled = !!options.disabled;
  if (options.hidden) element.hidden = true;
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

/* What the page announces, and the listeners the module puts on the document before any of the page's own. */
const announced = [];
const window = { dispatchEvent: event => { announced.push(event); return true; } };
const captured = [];
const document = {
  addEventListener: (type, listener, capture) => { captured.push({ type, listener, capture }); },
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
      getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
      remove() { notes.delete(this.id); }
    };
  }
};
/* A press, as the browser hands it to a listener: what it was, where, and whether anything stopped it. */
class Event {
  constructor(type, target) { this.type = type; this.target = target; this.prevented = false; this.stopped = false; }
  preventDefault() { this.prevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
class KeyboardEvent extends Event {
  constructor(type, target, key) { super(type, target); this.key = key; }
}
class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
}
const sandbox = {
  window,
  document,
  KeyboardEvent,
  CustomEvent,
  URLSearchParams,
  fetch: async () => ({ ok: true, json: async () => body }),
  console,
  Object,
  Set,
  String
};
const CapabilityUI = loadPageModule('apps/web/src/features/capabilities/capability-ui.ts', sandbox).default;

(async () => {
  /* Asked of the server for the provider, fresh, with the page's own header, before anything is decided. */
  assert.strictEqual(CapabilityUI.decision('file.read').status, 'Unavailable', 'nothing is offered before the server answers');
  assert.strictEqual(CapabilityUI.withheld('file.read'), false, 'and nothing is withheld for an answer not yet given');
  const asked = [];
  const answer = sandbox.fetch;
  sandbox.fetch = async (url, options) => { asked.push({ url, options }); return answer(); };
  await CapabilityUI.load('github', 'github.com');
  sandbox.fetch = answer;
  assert.deepStrictEqual(asked.map(call => call.url), ['/api/capabilities?provider=github&authority=github.com']);
  /* Read as plain data: the module's objects are made in the page's realm, not this one. */
  assert.deepStrictEqual(JSON.parse(JSON.stringify(asked[0].options)), { credentials: 'same-origin', cache: 'no-store', headers: { 'x-nv': '1' } });
  /* What it answers cannot be changed by whoever asked. */
  assert.ok(Object.isFrozen(CapabilityUI.decision('file.read')));
  assert.ok(Object.isFrozen(CapabilityUI.features()) && Object.isFrozen(CapabilityUI.features()['file.read']));
  assert.strictEqual(CapabilityUI.explain('file.batch'), 'Unavailable: Atomic batch is unavailable for this GitHub account.');
  assert.deepStrictEqual(['file.batch', 'governance', 'file.read', 'unknown.feature'].map(CapabilityUI.withheld), [true, true, false, true],
    'once the server has answered, anything not Supported is withheld, an unknown feature included');
  /* There is no opt-in for anything less than Supported: a control that asks for one is withheld all the same. */
  const optingIn = control('governance', { allowExperimental: true });
  CapabilityUI.apply({ querySelectorAll: () => [optingIn] });
  assert.strictEqual(optingIn.hidden, true, 'an experimental opt-in is not honoured');

  const nestedButton = control('file.batch');
  const batchContainer = control('file.batch', { native: false, children: [nestedButton] });
  const experimental = control('governance');
  const supported = control('file.read');
  const unavailableButton = control('file.batch', { tagName: 'BUTTON' });
  let controls = [batchContainer, experimental, supported, unavailableButton];
  const root = { querySelectorAll: () => controls };

  CapabilityUI.apply(root);

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
  /* Each control says what it is and why, in the attributes a reader's tools announce. */
  assert.strictEqual(supported.getAttribute('aria-disabled'), 'false');
  assert.strictEqual(experimental.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(experimental.getAttribute('data-capability-reason'), 'Policy views have narrower mutation coverage.');
  assert.strictEqual(supported.getAttribute('data-capability-reason'), 'Qualified GitHub file reads.');
  assert.strictEqual(
    CapabilityUI.decision('unknown.feature').status,
    'Unavailable',
    'unknown features must fail closed'
  );
  assert(![...notes.values()].some(note => /Experimental|Unavailable/.test(note.textContent)),
    'no Experimental or Unavailable label is drawn anywhere');

  /* A capability that becomes Supported comes back, exactly as it was. */
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ...body, features: { ...body.features,
    governance: { ...body.features.governance, status: 'Supported', evidenceState: 'Deterministic' } } }) });
  await CapabilityUI.load('github', 'github.com');
  CapabilityUI.apply(root);
  assert.strictEqual(experimental.hidden, false, 'a control hidden for its capability is shown again once Supported');
  assert.strictEqual(experimental.getAttribute('data-capability-blocked'), 'false');
  assert.strictEqual(batchContainer.hidden, true);

  /*
   * A projection that could not be loaded is an outage, not a verdict. Nothing
   * is hidden for it: the controls stay where they are, refused and saying why,
   * so the person can see that something is wrong and retry.
   */
  sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
  await CapabilityUI.load('github', 'github.com');
  const field = control('file.batch', { tagName: 'INPUT' });
  const pressable = control('file.batch', { tagName: 'BUTTON' });
  controls = [field, pressable];
  CapabilityUI.apply(root);
  assert.notStrictEqual(field.hidden, true);
  assert.notStrictEqual(pressable.hidden, true);
  assert.strictEqual(field.disabled, true, 'a refused field must not accept input it will discard');
  assert.strictEqual(pressable.disabled, false, 'a refused button stays pressable so that the refusal can be voiced');
  assert.strictEqual(pressable.getAttribute('data-capability-blocked'), 'true');
  const outage = notes.get(field.dataset.capabilityNoteId);
  assert(outage && String(outage.getAttribute('aria-label') || '').includes('could not be loaded'), 'the outage is explained');
  sandbox.fetch = async () => ({ ok: true, json: async () => body });
  await CapabilityUI.load('github', 'github.com');

  // An older account response must never overwrite the latest projection.
  const pending = [];
  sandbox.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const firstAccount = CapabilityUI.load('github', 'github.com', { connected: true });
  const secondAccount = CapabilityUI.load('github', 'github.com', { connected: true });
  assert(pending.every(call => call.url.startsWith('/api/account/capabilities?')));
  assert(pending.every(call => call.options.cache === 'no-store' && call.options.credentials === 'same-origin'));
  pending[1].resolve({ ok: true, json: async () => body });
  await secondAccount;
  pending[0].resolve({ ok: false, json: async () => ({}) });
  await firstAccount;
  assert.strictEqual(CapabilityUI.decision('file.read').status, 'Supported');
  for (const retiredProvider of ['gitlab', 'gitea', 'unknown']) {
    let fetched = false;
    sandbox.fetch = async () => { fetched = true; return { ok: true, json: async () => body }; };
    await CapabilityUI.load(retiredProvider, 'github.com', { connected: true });
    assert.strictEqual(fetched, false, 'unsupported identities must not request GitHub capabilities');
    assert.strictEqual(CapabilityUI.decision('file.read').status, 'Unavailable');
  }
  let fetchedCustomHost = false;
  sandbox.fetch = async () => { fetchedCustomHost = true; return { ok: true, json: async () => body }; };
  await CapabilityUI.load('github', 'git.example.org', { connected: true });
  assert.strictEqual(fetchedCustomHost, false, 'custom hosts are not supported GitHub identities');
  assert.strictEqual(CapabilityUI.decision('file.read').status, 'Unavailable');

  /* ---- What the earlier checks never pressed, asked or answered twice. ---- */
  const answering = features => async () => ({ ok: true, json: async () => ({ ...body, features: { ...body.features, ...features } }) });
  const feature = (name, status, extra = {}) => ({ [name]: { feature: name, provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', status, evidenceState: 'Deterministic', reason: `${name} is ${status}.`, ...extra } });

  /* A status the registry does not name is not an offer: it is withheld as Unavailable. */
  sandbox.fetch = answering({ ...feature('pulls.read', 'Supported'), ...feature('pulls.merge', 'Beta'), ...feature('pulls.label', 'Unavailable', { reason: '' }) });
  await CapabilityUI.load('github', 'github.com');
  assert.strictEqual(CapabilityUI.decision('pulls.merge').status, 'Unavailable');
  assert.strictEqual(CapabilityUI.withheld('pulls.merge'), true);
  /* A refusal sent without a reason is still explained. */
  assert.strictEqual(CapabilityUI.explain('pulls.label'), 'Unavailable: Capability status could not be loaded. Retry after the service is ready.');
  /* A feature named like the object prototype is a feature nobody offered, under its own name. */
  for (const name of ['constructor', 'toString', '__proto__']) {
    const decided = CapabilityUI.decision(name);
    assert.deepStrictEqual([decided.feature, decided.status], [name, 'Unavailable'], name);
  }

  /* Two controls for one capability on one screen share one note; a Supported one says only that. */
  const first = control('pulls.read');
  const second = control('pulls.read', { tagName: 'BUTTON' });
  controls = [first, second];
  CapabilityUI.apply(root);
  const shared = first.dataset.capabilityNoteId;
  assert.ok(shared && notes.has(shared), 'the first control owns the note');
  assert.strictEqual(second.dataset.capabilityNoteId, undefined, 'the second draws none of its own');
  assert.strictEqual(second.getAttribute('aria-describedby'), shared, 'and is described by the first one\'s');
  assert.strictEqual(notes.get(shared).getAttribute('aria-label'), 'Supported');

  /* A control its page had hidden is the page's to show: a capability that comes and goes does not show it. */
  const hiddenByPage = control('pulls.merge', { hidden: true });
  controls = [hiddenByPage];
  CapabilityUI.apply(root);
  sandbox.fetch = answering({ ...feature('pulls.read', 'Supported'), ...feature('pulls.merge', 'Supported') });
  await CapabilityUI.load('github', 'github.com');
  CapabilityUI.apply(root);
  assert.strictEqual(hiddenByPage.hidden, true, 'hidden by its page, it stays hidden');

  /* An outage refuses a field and notes why; a verdict that withholds it takes the note away; one that offers it gives the field back. */
  sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
  await CapabilityUI.load('github', 'github.com');
  const input = control('pulls.label', { tagName: 'INPUT' });
  const typed = control('pulls.read', { tagName: 'INPUT' });
  controls = [input, typed];
  CapabilityUI.apply(root);
  const outageNote = input.dataset.capabilityNoteId;
  assert.ok(outageNote && notes.has(outageNote));
  assert.strictEqual(typed.disabled, true);
  sandbox.fetch = answering({ ...feature('pulls.read', 'Supported'), ...feature('pulls.label', 'Unavailable') });
  await CapabilityUI.load('github', 'github.com');
  CapabilityUI.apply(root);
  assert.strictEqual(input.hidden, true);
  assert.strictEqual(notes.has(outageNote), false, 'a withheld control keeps no note');
  assert.strictEqual(input.dataset.capabilityNoteId, undefined);
  assert.strictEqual(input.getAttribute('aria-describedby'), null);
  assert.strictEqual(typed.disabled, false, 'a field refused for an outage is given back once its capability is Supported');
  assert.strictEqual(typed.dataset.capabilityDisabled, undefined);

  /* An answer about another provider is not this provider's verdict: it is an outage, and hides nothing. */
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ...body, provider: 'gitlab' }) });
  await CapabilityUI.load('github', 'github.com');
  assert.strictEqual(CapabilityUI.decision('file.read').status, 'Unavailable');
  assert.strictEqual(CapabilityUI.withheld('file.batch'), false, 'nothing is withheld for an answer that was not about this provider');

  /* Of two answers, the later question's stands, even when the earlier one arrives last and succeeds. */
  const asking = [];
  sandbox.fetch = () => new Promise(resolve => asking.push(resolve));
  const earlier = CapabilityUI.load('github', 'github.com', { connected: true });
  const later = CapabilityUI.load('github', 'github.com', { connected: true });
  asking[1]({ ok: true, json: async () => ({ ...body, features: feature('pulls.read', 'Supported') }) });
  await later;
  asking[0]({ ok: true, json: async () => ({ ...body, features: feature('pulls.read', 'Unavailable') }) });
  await earlier;
  assert.strictEqual(CapabilityUI.decision('pulls.read').status, 'Supported', 'a stale answer does not overwrite a newer one');

  /*
   * Pressing a refused control. The module listens on the document in the
   * capture phase, for clicks and for the keys that press a button, before
   * any handler of the page: the press goes no further, and is announced once.
   */
  assert.deepStrictEqual(captured.map(entry => `${entry.type}:${entry.capture}`), ['click:true', 'keydown:true', 'keyup:true']);
  const listener = type => captured.find(entry => entry.type === type).listener;
  const refused = { dataset: { feature: 'file.batch', capabilityBlocked: 'true' }, parentElement: null };
  const insideRefused = { dataset: {}, parentElement: refused };
  const press = (type, target, key) => {
    const event = key === undefined ? new Event(type, target) : new KeyboardEvent(type, target, key);
    listener(type)(event);
    return event;
  };
  announced.length = 0;
  const click = press('click', insideRefused);
  assert.deepStrictEqual([click.prevented, click.stopped], [true, true], 'a click inside a refused control reaches nothing of the page');
  assert.strictEqual(announced.length, 1);
  assert.deepStrictEqual([announced[0].type, announced[0].detail.feature], ['nebula:capability-refused', 'file.batch']);
  const down = press('keydown', refused, 'Enter');
  const up = press('keyup', refused, 'Enter');
  assert.deepStrictEqual([down.prevented, down.stopped, up.prevented, up.stopped], [true, true, true, true]);
  assert.strictEqual(announced.length, 2, 'a key press is announced once, on its way down');
  press('keydown', refused, ' ');
  assert.strictEqual(announced.length, 3, 'Space presses a button as Enter does');
  const tab = press('keydown', refused, 'Tab');
  assert.deepStrictEqual([tab.prevented, tab.stopped, announced.length], [false, false, 3], 'moving past a refused control is not pressing it');
  const allowed = press('click', { dataset: { feature: 'file.read', capabilityBlocked: 'false' }, parentElement: null });
  assert.deepStrictEqual([allowed.prevented, allowed.stopped, announced.length], [false, false, 3], 'an offered control is left alone');

  console.log('capability UI behavior tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
