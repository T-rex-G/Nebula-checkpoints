'use strict';

/*
 * The page's one store (apps/web/src/platform/store.ts and page-state.ts,
 * ADR-092).
 *
 * What the store promises: a slice replaced by an equal value announces
 * nothing; one replaced by another value, or changed in place through
 * `mutate`, announces once and moves the stamp of every reader that reads
 * it, and of no other; and a React component that reads it through useStore
 * renders again when, and only when, a slice it reads has changed, and stops
 * listening when it is removed. The workbench's `state` is the store's: a
 * slice read is the store's slice, a slice assigned is set in the store, and
 * a name the store does not have cannot be made. The page starts from what
 * it started from before the store.
 *
 * The component is rendered by React's own client renderer into a document
 * made here: enough of one for React to make, fill and remove elements.
 */

const assert = require('assert');
const { loadPageModule } = require('./helpers/page-module');

/* Enough of a document for React's client renderer. */
function documentStandIn() {
  class Node {
    constructor(document, nodeType, nodeName) {
      this.ownerDocument = document;
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.parentNode = null;
      this.childNodes = [];
      this.listening = new Map();
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = before ? this.childNodes.indexOf(before) : -1;
      if (at < 0) this.childNodes.push(child);
      else this.childNodes.splice(at, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) {
      const at = this.childNodes.indexOf(child);
      if (at < 0) throw new Error('not a child');
      this.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    }
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
    set textContent(text) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (text !== '' && text !== null && text !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(text)));
    }
    addEventListener(type, listener) {
      if (!this.listening.has(type)) this.listening.set(type, new Set());
      this.listening.get(type).add(listener);
    }
    removeEventListener(type, listener) {
      if (this.listening.has(type)) this.listening.get(type).delete(listener);
    }
  }
  class Text extends Node {
    constructor(document, data) { super(document, 3, '#text'); this.nodeValue = data; }
    get textContent() { return this.nodeValue; }
    set textContent(text) { this.nodeValue = String(text); }
    get data() { return this.nodeValue; }
    set data(text) { this.nodeValue = String(text); }
  }
  class Element extends Node {
    constructor(document, name) {
      super(document, 1, name.toUpperCase());
      this.tagName = name.toUpperCase();
      this.localName = name;
      this.namespaceURI = 'http://www.w3.org/1999/xhtml';
      this.attributes = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
  }
  class IFrame {}
  const window = { HTMLIFrameElement: IFrame, event: undefined };
  const document = {
    nodeType: 9,
    nodeName: '#document',
    defaultView: window,
    activeElement: null,
    createElement: name => new Element(document, name),
    createElementNS: (_namespace, name) => new Element(document, name),
    createTextNode: data => new Text(document, String(data)),
    addEventListener() {},
    removeEventListener() {}
  };
  document.documentElement = new Element(document, 'html');
  document.body = document.documentElement.appendChild(new Element(document, 'body'));
  window.document = document;
  return { window, document };
}

/* React's client renderer, in a world whose document is the stand-in. */
const dom = documentStandIn();
globalThis.window = dom.window;
globalThis.document = dom.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');

const { createStore, useStore } = loadPageModule('apps/web/src/platform/store.ts');
const pageState = () => loadPageModule('apps/web/src/platform/page-state.ts');

function counted(store) {
  const heard = [];
  store.subscribe(() => heard.push(store.get()));
  return heard;
}

const cases = [];
const check = (name, run) => cases.push([name, run]);

check('a slice replaced by another value is announced once, and by an equal value not at all', () => {
  const store = createStore({ count: 0, name: 'a', list: [], ratio: 0 });
  const heard = counted(store);
  store.set('count', 1);
  assert.strictEqual(store.get().count, 1);
  assert.strictEqual(heard.length, 1);
  store.set('count', 1);
  store.set('name', 'a');
  assert.strictEqual(heard.length, 1, 'an equal value announces nothing');
  const list = store.get().list;
  store.set('list', list);
  assert.strictEqual(heard.length, 1, 'the same record announces nothing');
  store.set('list', []);
  assert.strictEqual(heard.length, 2, 'an equal-looking record is another record');
  store.set('ratio', -0);
  assert.strictEqual(heard.length, 3, 'zero and negative zero are not the same value');
  store.set('ratio', NaN);
  store.set('ratio', NaN);
  assert.strictEqual(heard.length, 4, 'not-a-number is one value');
});

check('a slice changed in place stays the same record and is announced, whatever moved', () => {
  const store = createStore({ work: { branch: 'main' }, other: 1 });
  const heard = counted(store);
  const work = store.get().work;
  let given = null;
  store.mutate('work', slice => { given = slice; slice.branch = 'next'; });
  assert.strictEqual(given, work, 'the change is handed the slice itself');
  assert.strictEqual(store.get().work, work);
  assert.strictEqual(work.branch, 'next');
  store.mutate('work', () => {});
  assert.strictEqual(heard.length, 2, 'a change that moved nothing measurable is announced all the same');
});

check('the store starts from its own copy of the slices it is given', () => {
  const initial = { a: 1, b: { deep: true } };
  const store = createStore(initial);
  initial.a = 2;
  initial.c = 3;
  assert.strictEqual(store.get().a, 1);
  assert.ok(!('c' in store.get()));
  assert.strictEqual(store.get().b, initial.b, 'the slices are the records given, not copies of them');
});

check('a listener hears every change until it stops, and one added while others hear joins at the next', () => {
  const store = createStore({ a: 0 });
  const order = [];
  let late = 0;
  const stopFirst = store.subscribe(() => {
    order.push('first');
    store.subscribe(() => { late += 1; });
  });
  store.subscribe(() => order.push('second'));
  store.set('a', 1);
  assert.deepStrictEqual(order, ['first', 'second']);
  assert.strictEqual(late, 0, 'a listener added during an announcement hears the next one');
  stopFirst();
  store.set('a', 2);
  assert.deepStrictEqual(order, ['first', 'second', 'second']);
  assert.strictEqual(late, 1);
  const stopSelf = store.subscribe(() => { stopSelf(); order.push('once'); });
  store.set('a', 3);
  store.set('a', 4);
  assert.strictEqual(order.filter(entry => entry === 'once').length, 1);
});

check('a stamp moves when, and only when, a slice its reader reads has changed', () => {
  const store = createStore({ work: { branch: 'main' }, file: null, epoch: 0 });
  const readsWork = slices => slices.work.branch;
  const readsBoth = slices => [slices.work, slices.file];
  const readsNothing = () => 42;
  const before = [store.stamp(readsWork), store.stamp(readsBoth), store.stamp(readsNothing)];
  assert.strictEqual(before[2], '', 'a reader of no slice stamps nothing');
  assert.strictEqual(store.stamp(readsWork), before[0], 'nothing changed, nothing moved');

  store.set('epoch', 1);
  assert.deepStrictEqual([store.stamp(readsWork), store.stamp(readsBoth), store.stamp(readsNothing)], before, 'a slice nobody reads');

  store.mutate('work', work => { work.branch = 'next'; });
  const afterWork = [store.stamp(readsWork), store.stamp(readsBoth)];
  assert.notStrictEqual(afterWork[0], before[0], 'changed in place');
  assert.notStrictEqual(afterWork[1], before[1]);

  store.set('file', { path: 'README.md' });
  assert.strictEqual(store.stamp(readsWork), afterWork[0], 'the file is not read by the first reader');
  assert.notStrictEqual(store.stamp(readsBoth), afterWork[1], 'replaced');

  /* A reader that reads one slice or another as the page stands is known by what it read this time. */
  const either = slices => (slices.file ? slices.file.path : slices.work.branch);
  const stampFile = store.stamp(either);
  store.mutate('work', work => { work.branch = 'third'; });
  assert.strictEqual(store.stamp(either), stampFile, 'while the file is open the branch is not read');
  store.set('file', null);
  const stampWork = store.stamp(either);
  store.mutate('work', work => { work.branch = 'fourth'; });
  assert.notStrictEqual(store.stamp(either), stampWork);
});

check('a reader reads the slices through a view it cannot change', () => {
  const store = createStore({ a: 1 });
  assert.throws(() => store.stamp(slices => { slices.a = 2; }), TypeError);
  assert.throws(() => store.stamp(slices => { slices.b = 2; }), TypeError);
  assert.strictEqual(store.get().a, 1);
  assert.deepStrictEqual(store.stamp(slices => Object.keys(slices)), '', 'listing the names reads no slice');
  assert.notStrictEqual(store.stamp(slices => ({ ...slices })), '', 'copying the view reads every slice');
});

check('a component renders again when, and only when, a slice it reads changes, and stops listening when removed', async () => {
  const store = createStore({ work: { branch: 'main' }, file: null, epoch: 0 });
  let listening = 0;
  const watched = Object.freeze({
    ...store,
    subscribe(listener) {
      listening += 1;
      const stop = store.subscribe(listener);
      return () => { listening -= 1; stop(); };
    }
  });
  let renders = 0;
  function Branch() {
    renders += 1;
    const branch = useStore(watched, slices => slices.work.branch);
    /* A selection built afresh each time is no reason to render again. */
    const pair = useStore(watched, slices => ({ file: slices.file }));
    return React.createElement('output', null, `${branch}${pair.file ? ` ${pair.file.path}` : ''}`);
  }
  const host = dom.document.body.appendChild(dom.document.createElement('div'));
  const root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(Branch)); });
  const shown = () => host.textContent;
  assert.strictEqual(shown(), 'main');
  assert.ok(listening > 0, 'the component listens');
  const settled = renders;

  await React.act(async () => { store.set('epoch', 1); });
  await React.act(async () => { store.set('work', store.get().work); });
  assert.strictEqual(renders, settled, 'a slice it does not read, and an unchanged one, cost no render');

  await React.act(async () => { store.mutate('work', work => { work.branch = 'next'; }); });
  assert.strictEqual(shown(), 'next', 'changed in place');
  assert.strictEqual(renders, settled + 1);

  await React.act(async () => { store.set('file', { path: 'README.md' }); });
  assert.strictEqual(shown(), 'next README.md', 'replaced');
  assert.strictEqual(renders, settled + 2);

  await React.act(async () => { root.unmount(); });
  assert.strictEqual(listening, 0, 'a removed component listens no more');
  store.set('work', { branch: 'after' });
  assert.strictEqual(renders, settled + 2);
});

check('the workbench state is the store: read from it, assigned through it, and no slice made by assigning', () => {
  const { pageStore, state, PAGE_SLICES } = pageState();
  const heard = counted(pageStore);
  assert.deepStrictEqual(Object.keys(state), [...PAGE_SLICES]);
  assert.deepStrictEqual(Object.keys(pageStore.get()), [...PAGE_SLICES]);
  assert.ok(Object.isFrozen(PAGE_SLICES));

  const identity = { login: 'reader' };
  const stamp = pageStore.stamp(slices => slices.me);
  state.me = identity;
  assert.strictEqual(pageStore.get().me, identity, 'an assigned slice is set in the store');
  assert.strictEqual(state.me, identity, 'a read slice is the store\'s');
  assert.strictEqual(heard.length, 1);
  assert.notStrictEqual(pageStore.stamp(slices => slices.me), stamp);
  state.me = identity;
  assert.strictEqual(heard.length, 1, 'the same identity again announces nothing');
  state.uiEpoch++;
  assert.strictEqual(pageStore.get().uiEpoch, 1);
  assert.strictEqual(heard.length, 2);

  const record = { full_name: 'sandbox/demo' };
  pageStore.mutate('repos', repos => { repos.push(record); });
  assert.strictEqual(state.repos[0], record);
  assert.strictEqual(heard.length, 3);

  assert.throws(() => { state.unknownSlice = 1; }, TypeError, 'a slice the store does not have cannot be made');
  assert.throws(() => { delete state.me; }, TypeError, 'nor taken away');
  assert.ok(!('unknownSlice' in pageStore.get()));
});

check('the page starts from what it started from before the store', () => {
  const { pageStore } = pageState();
  /* The workbench's own state object before the store, as the oracle. */
  const before = {
    me: null,
    posture: null,
    uiEpoch: 0,
    repos: [], repoPage: 1, repoSort: 'pushed',
    work: null, opening: null, file: null, cm: null,
    commitsPage: 1,
    staged: [],
    fileIndex: null,
    prState: 'open', issueState: 'open',
    settings: { fontSize: 14, wrap: true, motion: true, editorTheme: 'material-ocean', editorFont: 'DM Mono', design: 'nebula' },
    governance: { digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '', decisionPages: [], delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' } },
    runtime: { uploadMaxMb: null, gitDataMaxMb: null, nativePushMaxMb: null, contentsMaxMb: null, githubApp: { enabled: false, webhookConfigured: false } }
  };
  const now = { ...pageStore.get() };
  /* The slices the page made later, by assigning them, start unset. */
  const later = ['safety', 'caps', 'exposure', 'securityPosture', 'pendingPull', 'pendingFind', 'scanner'];
  for (const name of later) {
    assert.strictEqual(now[name], undefined, name);
    delete now[name];
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(now)), before);
  assert.deepStrictEqual(Object.keys(now), Object.keys(before), 'in the same order');
});

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${cases.length} page store checks failed`);
    process.exit(1);
  }
  console.log(`page store: ${cases.length} checks passed`);
})();
