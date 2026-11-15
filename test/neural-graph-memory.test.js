'use strict';
/*
 * What the browser remembers of the Neural map (features/neural/graph-memory.ts):
 * where the reader put each panel, per view, the most recent forty views
 * kept; and which groups they hid. An arrangement names a repository, so it
 * is the account's: once storage has lost it -- the page purges it when the
 * account changes -- it is gone from memory too, and is never written back
 * for the next account to find.
 */
const assert = require('node:assert/strict');
const G = require('../apps/web/src/features/neural/graph-memory.ts');

/* Storage as a browser gives it; `blocked` throws on every use, `full` on every write. */
function storage(initial = {}, mode = 'ok') {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { if (mode === 'blocked') throw new Error('SecurityError'); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { if (mode !== 'ok') throw new Error('QuotaExceededError'); data.set(key, String(value)); },
    removeItem(key) { if (mode === 'blocked') throw new Error('SecurityError'); data.delete(key); }
  };
}
const stored = store => JSON.parse(store.data.get(G.PLACEMENT_KEY));
const ACME = G.placementKey({ owner: 'acme', repo: 'widget' }, 'security', 'split');

assert.equal(ACME, 'acme/widget|security|split', 'a view is a repository, a mode and a shape of stage');
assert.equal(G.placementKey({ owner: 'acme', repo: 'widget' }, 'security', 'stack'), 'acme/widget|security|stack', 'a tall stage is another view');
assert.equal(G.placementKey(null, 'security', 'split'), '', 'with no repository open there is no view');
assert.deepEqual([G.PLACEMENT_KEY, G.HIDDEN_KEY, G.PLACEMENT_VIEWS], ['nv_neural_layout', 'nv_neural_hidden_groups', 40],
  'the keys the page purges and the browser suite reads');

/* ---- Arrangements ------------------------------------------------------------------------------ */
{
  const store = storage();
  const memory = G.placementMemory(() => store);
  assert.deepEqual(memory.arrangement(ACME), {}, 'nothing moved yet');
  assert.equal(memory.has(ACME), false);
  memory.remember(ACME, 'branch', 10.4, -3.6);
  assert.deepEqual(stored(store), { [ACME]: { branch: { x: 10, y: -4 } } }, 'a panel put down is kept, in whole units');
  assert.deepEqual(memory.arrangement(ACME), { branch: { x: 10, y: -4 } });
  assert.equal(memory.has(ACME), true);
  memory.remember(ACME, 'user', -400, 20);
  assert.deepEqual(memory.arrangement(ACME), { branch: { x: 10, y: -4 }, user: { x: -400, y: 20 } }, 'beside the others in the view');
  assert.deepEqual(memory.arrangement(ACME, { type: 'commit', x: 5.5, y: 6 }), { branch: { x: 10, y: -4 }, user: { x: -400, y: 20 }, commit: { x: 5.5, y: 6 } },
    'a panel being dragged stands where it is now');
  assert.deepEqual(memory.arrangement(ACME, { type: 'branch', x: 1, y: 2 }).branch, { x: 1, y: 2 }, 'over where it was kept');
  assert.equal(stored(store)[ACME].commit, undefined, 'and is not kept until it is put down');
  const other = G.placementKey({ owner: 'acme', repo: 'widget' }, 'activity', 'split');
  assert.deepEqual(memory.arrangement(other), {}, 'another view has its own arrangement');
  assert.equal(memory.has(other), false);
  memory.forget(ACME);
  assert.deepEqual(stored(store), {}, 'Reset layout forgets the view');
  assert.equal(memory.has(ACME), false);

  memory.remember('', 'branch', 1, 1);
  assert.deepEqual(stored(store), {}, 'with no view, nothing is kept');
  assert.deepEqual(memory.arrangement('', { type: 'tag', x: 1, y: 2 }), { tag: { x: 1, y: 2 } }, 'though a panel being dragged still stands where it is');
  memory.forget('');
  assert.equal(memory.has(''), false);
}

/* ---- The views most recently arranged -------------------------------------------------------- */
{
  const store = storage();
  const memory = G.placementMemory(() => store);
  const view = i => `owner${i}/repo|security|split`;
  for (let i = 0; i < 41; i++) memory.remember(view(i), 'branch', i, i);
  assert.equal(Object.keys(stored(store)).length, 40, 'forty views are kept');
  assert.equal(stored(store)[view(0)], undefined, 'the one arranged longest ago goes');
  assert.ok(stored(store)[view(40)]);
  memory.remember(view(1), 'user', 0, 0);
  memory.remember(view(41), 'branch', 0, 0);
  assert.ok(stored(store)[view(1)], 'a view arranged again is recent again');
  assert.equal(stored(store)[view(2)], undefined, 'so the next oldest goes instead');
  assert.deepEqual(Object.keys(stored(store)).slice(-2), [view(1), view(41)]);
}

/* ---- What storage holds is what counts --------------------------------------------------------- */
{
  /* The account changes: the page removes the arrangements from storage. */
  const store = storage();
  const memory = G.placementMemory(() => store);
  memory.remember(ACME, 'branch', 10, 20);
  store.removeItem(G.PLACEMENT_KEY);
  assert.deepEqual(memory.arrangement(ACME), {}, 'the next account is not shown the last one\'s arrangement');
  assert.equal(memory.has(ACME), false, 'nor offered a reset for it');
  const next = G.placementKey({ owner: 'next', repo: 'account' }, 'security', 'split');
  memory.remember(next, 'user', 1, 2);
  assert.deepEqual(stored(store), { [next]: { user: { x: 1, y: 2 } } }, 'and what it arranges is written alone: the last account\'s is not written back');
  memory.remember(ACME, 'tag', 3, 4);
  assert.deepEqual(stored(store)[ACME], { tag: { x: 3, y: 4 } }, 'the same repository arranged again starts afresh');

  /* Another tab arranges something meanwhile. */
  store.data.set(G.PLACEMENT_KEY, JSON.stringify({ [next]: { user: { x: 9, y: 9 } }, 'elsewhere/x|security|split': { tag: { x: 0, y: 0 } } }));
  assert.deepEqual(memory.arrangement(next), { user: { x: 9, y: 9 } }, 'what another tab kept is read');
  memory.remember(next, 'branch', 5, 5);
  assert.deepEqual(Object.keys(stored(store)), ['elsewhere/x|security|split', next], 'and kept: nothing it wrote is lost to this tab\'s write');
}
{
  for (const raw of ['{', '[]', '[{"branch":{"x":1,"y":1}}]', '5', 'null', '"text"', '']) {
    const store = storage({ [G.PLACEMENT_KEY]: raw });
    const memory = G.placementMemory(() => store);
    assert.deepEqual(memory.arrangement(ACME), {}, `storage holding ${JSON.stringify(raw)} is no arrangement`);
    memory.remember(ACME, 'branch', 1, 2);
    assert.deepEqual(stored(store), { [ACME]: { branch: { x: 1, y: 2 } } }, 'and is replaced by one');
  }
  for (const entry of ['abc', 7, [1, 2], null, true]) {
    const store = storage({ [G.PLACEMENT_KEY]: JSON.stringify({ [ACME]: entry }) });
    const memory = G.placementMemory(() => store);
    assert.deepEqual(memory.arrangement(ACME), {}, `an arrangement stored as ${JSON.stringify(entry)} is none`);
    assert.equal(memory.has(ACME), false, 'and offers no reset');
    memory.remember(ACME, 'tag', 0, 0);
    assert.deepEqual(stored(store)[ACME], { tag: { x: 0, y: 0 } });
  }
  const proto = storage({ [G.PLACEMENT_KEY]: '{"__proto__":{"branch":{"x":1,"y":1}}}' });
  const memory = G.placementMemory(() => proto);
  assert.deepEqual(memory.arrangement('__proto__'), { branch: { x: 1, y: 1 } }, 'a stored name like "__proto__" is only a name');
  assert.deepEqual(memory.arrangement('constructor'), {}, 'and one every object inherits is not an arrangement');
  assert.equal({}.branch, undefined, 'nothing reached a prototype');
  const named = storage();
  const plain = G.placementMemory(() => named);
  plain.remember('__proto__', 'branch', 3, 4);
  plain.remember('constructor', 'tag', 5, 6);
  assert.deepEqual(JSON.parse(named.data.get(G.PLACEMENT_KEY), (k, v) => v), JSON.parse('{"__proto__":{"branch":{"x":3,"y":4}},"constructor":{"tag":{"x":5,"y":6}}}'),
    'a view named "__proto__" or "constructor" is kept as a view like any other');
  assert.deepEqual(plain.arrangement('__proto__'), { branch: { x: 3, y: 4 } });
  assert.equal(plain.has('constructor'), true);
  assert.equal({}.branch, undefined, 'and no prototype was touched');
}
{
  /* Storage that cannot be reached, or will not take more: what this page arranged still stands. */
  for (const source of [() => storage({}, 'blocked'), () => null, () => undefined, () => { throw new Error('SecurityError'); }]) {
    let store = null;
    const memory = G.placementMemory(() => { store = store || source(); return store; });
    assert.doesNotThrow(() => memory.remember(ACME, 'branch', 1, 2));
    assert.deepEqual(memory.arrangement(ACME), { branch: { x: 1, y: 2 } }, 'storage out of reach: the page still remembers until it is closed');
    assert.equal(memory.has(ACME), true);
    memory.forget(ACME);
    assert.equal(memory.has(ACME), false);
  }
  const full = storage({ [G.PLACEMENT_KEY]: JSON.stringify({ [ACME]: { user: { x: 0, y: 0 } } }) }, 'full');
  const memory = G.placementMemory(() => full);
  memory.remember(ACME, 'branch', 1, 2);
  assert.deepEqual(memory.arrangement(ACME), { user: { x: 0, y: 0 }, branch: { x: 1, y: 2 } }, 'storage full: kept for this page, over what storage had');
  assert.deepEqual(JSON.parse(full.data.get(G.PLACEMENT_KEY)), { [ACME]: { user: { x: 0, y: 0 } } }, 'and storage unchanged');
}

/* ---- Hidden groups -------------------------------------------------------------------------------- */
{
  const read = raw => G.readHiddenGroups(() => storage(raw === undefined ? {} : { [G.HIDDEN_KEY]: raw }));
  assert.deepEqual([...read(JSON.stringify(['branch', 'repo', 'bogus', 7, null, 'user', 'constructor', '__proto__', 'toString', 'branch']))], ['branch', 'user'],
    'only the groups the map knows; never the hub, never a name every object inherits');
  assert.deepEqual([...read(undefined)], [], 'nothing kept: nothing hidden');
  for (const raw of ['{', '{}', '"branch"', '5']) assert.equal(read(raw), null, `${raw} is not a list: the map keeps what it has`);
  assert.equal(G.readHiddenGroups(() => storage({}, 'blocked')), null, 'storage out of reach: likewise');
  assert.equal(G.readHiddenGroups(() => { throw new Error('SecurityError'); }), null);

  const store = storage();
  G.writeHiddenGroups(() => store, new Set(['tag', 'user']));
  assert.equal(store.data.get(G.HIDDEN_KEY), '["tag","user"]', 'kept as a list, in the order hidden');
  assert.deepEqual([...G.readHiddenGroups(() => store)], ['tag', 'user'], 'and read back as it was');
  G.forgetHiddenGroups(() => store);
  assert.equal(store.data.has(G.HIDDEN_KEY), false, 'Show all forgets them');
  for (const source of [() => storage({}, 'blocked'), () => null, () => { throw new Error('SecurityError'); }]) {
    assert.doesNotThrow(() => G.writeHiddenGroups(source, new Set(['tag'])), 'out of reach, not remembered, and no error');
    assert.doesNotThrow(() => G.forgetHiddenGroups(source));
  }
}

console.log('neural graph memory: ok');
