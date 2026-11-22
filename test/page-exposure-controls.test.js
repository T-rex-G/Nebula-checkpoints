'use strict';

/*
 * The Exposure screen's controls, asked directly
 * (features/exposure/exposure-controls.ts): each button calls its action,
 * retry follows a running scan or reads the view again, the history-depth
 * choice is kept where it can be, a scan's report is read once when its
 * disclosure opens, a finding is remembered open or closed, the two-press
 * controls are pressed through the list, and a typed question is kept in the
 * screen's state under its own finding and its own two names only.
 */

const assert = require('assert');
const { bindExposureControls } = require('../apps/web/src/features/exposure/exposure-controls.ts');
const { freshExposureState } = require('../apps/web/src/features/exposure/exposure-controller.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const IDS = ['#exposureScanBtn', '#exposureRefreshBtn', '#exposureCancelBtn', '#exposureExpandAllBtn', '#exposureClearBtn', '#exposureHistoryMoreBtn', '#exposureHistoryToggle', '#exposureHistory', '#exposureList'];

class Details { constructor(dataset, open) { this.dataset = dataset; this.open = open; } }

function setup({ missing = [], storageFails = false } = {}) {
  const log = [];
  const hosts = {};
  const listened = [];
  for (const id of IDS) {
    if (missing.includes(id)) continue;
    hosts[id] = { checked: false, listeners: [], addEventListener(type, run, capture) { this.listeners.push({ type, run, capture }); listened.push([id, type, capture]); } };
  }
  const page = { exposure: freshExposureState('k') };
  const call = name => (...args) => { log.push([name, ...args]); };
  bindExposureControls({
    $: selector => hosts[selector] || null,
    current: () => page.exposure,
    mutate: change => { log.push(['mutate']); change(page.exposure); },
    tally: current => log.push(['tally', current === page.exposure]),
    request: call('request'), refreshScan: call('refreshScan'), load: call('load'), cancel: call('cancel'), toggleAll: call('toggleAll'),
    clearHistory: call('clearHistory'), loadHistory: call('loadHistory'), loadReport: call('loadReport'),
    verify: call('verify'), accept: call('accept'), probe: call('probe'),
    remember: (key, value) => { if (storageFails) throw new Error('blocked'); log.push(['remember', key, value]); },
    isDisclosure: target => target instanceof Details
  });
  const fire = (id, type, target) => { for (const l of hosts[id].listeners) if (l.type === type) l.run({ target: target || hosts[id] }); };
  const calls = () => log.filter(entry => entry[0] !== 'mutate');
  return { log, hosts, listened, page, fire, calls };
}
const input = (fingerprint, field, value) => ({ closest: selector => (selector === '.exposure-probe-input' ? { dataset: { fingerprint, field }, value } : null) });
const pressed = (kind, fingerprint) => ({ closest: selector => (selector === `.exposure-${kind}` ? { dataset: { fingerprint } } : null) });

check('every control is bound once, in order, the disclosures in the capture phase, and a missing one is skipped', () => {
  const page = setup();
  assert.deepStrictEqual(page.listened, [
    ['#exposureScanBtn', 'click', undefined], ['#exposureRefreshBtn', 'click', undefined], ['#exposureCancelBtn', 'click', undefined], ['#exposureExpandAllBtn', 'click', undefined],
    ['#exposureClearBtn', 'click', undefined], ['#exposureHistoryMoreBtn', 'click', undefined], ['#exposureHistoryToggle', 'change', undefined], ['#exposureHistory', 'toggle', true],
    ['#exposureList', 'toggle', true], ['#exposureList', 'click', undefined], ['#exposureList', 'input', undefined]]);
  const partial = setup({ missing: ['#exposureCancelBtn', '#exposureList'] });
  assert.deepStrictEqual(partial.listened.map(([id, type]) => `${id} ${type}`), ['#exposureScanBtn click', '#exposureRefreshBtn click', '#exposureExpandAllBtn click', '#exposureClearBtn click',
    '#exposureHistoryMoreBtn click', '#exposureHistoryToggle change', '#exposureHistory toggle']);
});

check('each button calls its action, and retry follows a running scan or reads the view again', () => {
  const page = setup();
  for (const id of ['#exposureScanBtn', '#exposureCancelBtn', '#exposureExpandAllBtn', '#exposureClearBtn', '#exposureHistoryMoreBtn']) page.fire(id, 'click');
  assert.deepStrictEqual(page.calls(), [['request'], ['cancel'], ['toggleAll'], ['clearHistory'], ['loadHistory', { more: true }]]);
  const retries = [];
  for (const scan of [null, { state: 'queued' }, { state: 'running' }, { state: 'complete' }, { state: 'failed' }, { state: 'constructor' }]) {
    page.page.exposure.scan = scan;
    page.log.length = 0;
    page.fire('#exposureRefreshBtn', 'click');
    retries.push(page.calls()[0]);
  }
  assert.deepStrictEqual(retries, [['load', { filterOnly: true }], ['refreshScan'], ['refreshScan'], ['load', { filterOnly: true }], ['load', { filterOnly: true }], ['load', { filterOnly: true }]]);
});

check('the history depth chosen is kept where the page can keep it, and nothing breaks where it cannot', () => {
  const page = setup();
  page.hosts['#exposureHistoryToggle'].checked = false;
  page.fire('#exposureHistoryToggle', 'change');
  page.hosts['#exposureHistoryToggle'].checked = true;
  page.fire('#exposureHistoryToggle', 'change');
  assert.deepStrictEqual(page.calls(), [['remember', 'nv_exposure_history', '0'], ['remember', 'nv_exposure_history', '1']]);
  const blocked = setup({ storageFails: true });
  assert.doesNotThrow(() => blocked.fire('#exposureHistoryToggle', 'change'));
  assert.deepStrictEqual(blocked.calls(), []);
});

check('a scan opened is remembered and its report read once; closed, it is forgotten; anything else is ignored', () => {
  const page = setup();
  const current = page.page.exposure;
  current.reports = { held: { loading: false } };
  page.fire('#exposureHistory', 'toggle', new Details({ scanId: 'new' }, true));
  page.fire('#exposureHistory', 'toggle', new Details({ scanId: 'held' }, true));
  page.fire('#exposureHistory', 'toggle', new Details({ scanId: 'constructor' }, true));
  assert.deepStrictEqual([...current.openScans], ['new', 'held', 'constructor']);
  assert.deepStrictEqual(page.calls(), [['loadReport', 'new'], ['loadReport', 'constructor']], 'a report held is not read again; one under a name every object has is read');
  page.fire('#exposureHistory', 'toggle', new Details({ scanId: 'new' }, false));
  assert.deepStrictEqual([...current.openScans], ['held', 'constructor']);
  page.log.length = 0;
  page.fire('#exposureHistory', 'toggle', { dataset: { scanId: 'x' }, open: true });
  page.fire('#exposureHistory', 'toggle', new Details({ fingerprint: 'f' }, true));
  assert.deepStrictEqual(page.log, [], 'not a disclosure, or a finding inside a report');
  page.page.exposure = freshExposureState('other');
  page.fire('#exposureHistory', 'toggle', new Details({ scanId: 'later' }, true));
  assert.deepStrictEqual([...page.page.exposure.openScans], ['later'], 'the screen\u2019s state now, not the one bound');
});

check('a finding opened or closed is remembered and the tally redrawn; anything else is ignored', () => {
  const page = setup();
  page.fire('#exposureList', 'toggle', new Details({ fingerprint: 'a' }, true));
  page.fire('#exposureList', 'toggle', new Details({ fingerprint: 'b' }, true));
  page.fire('#exposureList', 'toggle', new Details({ fingerprint: 'a' }, false));
  assert.deepStrictEqual([...page.page.exposure.expanded], ['b']);
  assert.deepStrictEqual(page.calls(), [['tally', true], ['tally', true], ['tally', true]]);
  page.log.length = 0;
  page.fire('#exposureList', 'toggle', new Details({}, true));
  page.fire('#exposureList', 'toggle', { dataset: { fingerprint: 'c' }, open: true });
  assert.deepStrictEqual(page.log, []);
});

check('the two-press controls are pressed through the list, each for its own finding', () => {
  const page = setup();
  page.fire('#exposureList', 'click', pressed('verify', 'a'));
  page.fire('#exposureList', 'click', pressed('accept', 'b'));
  page.fire('#exposureList', 'click', pressed('probe', 'c'));
  page.fire('#exposureList', 'click', pressed('other', 'd'));
  page.fire('#exposureList', 'click', {});
  assert.deepStrictEqual(page.calls(), [['verify', 'a'], ['accept', 'b'], ['probe', 'c']]);
  page.log.length = 0;
  page.fire('#exposureList', 'click', { closest: () => ({ dataset: { fingerprint: 'e' } }) });
  page.fire('#exposureList', 'click', { closest: selector => (selector === '.exposure-verify' ? null : { dataset: { fingerprint: 'f' } }) });
  assert.deepStrictEqual(page.calls(), [['verify', 'e'], ['accept', 'f']], 'one press, one action, the first that matches');
});

check('a typed question is kept under its own finding and its own two names, and never reaches any other object', () => {
  const page = setup();
  const current = page.page.exposure;
  page.fire('#exposureList', 'input', input('a', 'relation', 'prof'));
  page.fire('#exposureList', 'input', input('a', 'relation', 'profiles'));
  page.fire('#exposureList', 'input', input('a', 'columns', 'id'));
  assert.deepStrictEqual(current.probeDrafts, { a: { relation: 'profiles', columns: 'id' } });
  const kept = current.probeDrafts.a;
  page.fire('#exposureList', 'input', input('a', 'columns', 'id, email'));
  assert.strictEqual(current.probeDrafts.a, kept, 'the same draft, changed in place');
  for (const fingerprint of ['__proto__', 'constructor', 'toString']) {
    page.fire('#exposureList', 'input', input(fingerprint, 'relation', 'leak'));
  }
  assert.strictEqual(({}).relation, undefined, 'no object gained the field');
  assert.strictEqual(Object.relation, undefined);
  assert.strictEqual(Object.getPrototypeOf(current.probeDrafts), Object.prototype);
  assert.deepStrictEqual(Object.keys(current.probeDrafts), ['a', '__proto__', 'constructor', 'toString']);
  for (const fingerprint of ['__proto__', 'constructor', 'toString']) assert.deepStrictEqual(Object.getOwnPropertyDescriptor(current.probeDrafts, fingerprint).value, { relation: 'leak', columns: '' });
  const before = JSON.stringify(current.probeDrafts);
  page.fire('#exposureList', 'input', input('a', '__proto__', 'x'));
  page.fire('#exposureList', 'input', input('a', 'constructor', 'x'));
  page.fire('#exposureList', 'input', input(undefined, 'relation', 'x'));
  page.fire('#exposureList', 'input', { closest: () => null });
  page.fire('#exposureList', 'input', {});
  assert.strictEqual(JSON.stringify(current.probeDrafts), before, 'a field the question has not, a field with no finding, or no field at all');
  assert.strictEqual(page.log.filter(entry => entry[0] === 'mutate').length, 7, 'every kept keystroke goes through the store, and nothing else does');
});

(async () => {
  let failed = 0;
  let finished = false;
  process.on('exit', () => { if (!finished) { console.error('not ok - a check never settled'); process.exitCode = 1; } });
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  finished = true;
  if (failed) process.exit(1);
  console.log(`page exposure controls: ${checks.length} checks passed`);
})();
