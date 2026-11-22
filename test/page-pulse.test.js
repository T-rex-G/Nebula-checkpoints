'use strict';

/*
 * The overview's pulse and core, asked directly: the rail, the line, the
 * greeting, the recovery references and the pointer light
 * (features/overview/overview-core.ts); the summary row's measures
 * (overview-pulse.ts); and the overview at work (overview-controller.ts).
 */

const assert = require('assert');
const { connected, paintCoreState, coreLineText, paintCoreLine, greeting, localSnapshotKeys, wireCorePointer, FINE_POINTER } = require('../apps/web/src/features/overview/overview-core.ts');
const { PULSE_ICONS, pulseMeasures } = require('../apps/web/src/features/overview/overview-pulse.ts');
const { createOverview } = require('../apps/web/src/features/overview/overview-controller.ts');
const WorkspacePulse = require('../apps/web/src/features/overview/workspace-pulse.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

check('only a GitHub identity is a connection; the rail says so and nothing more', () => {
  assert.strictEqual(connected({ provider: 'github' }), true);
  for (const me of [null, undefined, {}, { provider: 'gitea' }, { provider: 'gitlab' }, 'github', { provider: 'GitHub' }]) assert.strictEqual(connected(me), false, JSON.stringify(me));
  const scope = { textContent: '' };
  const toggles = [];
  const live = { textContent: '', classList: { toggle: (name, on) => toggles.push([name, on]) } };
  paintCoreState(scope, live, { provider: 'github', login: 'ada' });
  assert.deepStrictEqual([scope.textContent, live.textContent, toggles.at(-1)], ['github.com', 'Connected', ['is-idle', false]]);
  paintCoreState(scope, live, { provider: 'gitea', authority: 'git.example.org' });
  assert.deepStrictEqual([scope.textContent, live.textContent, toggles.at(-1)], ['Not connected', 'Not connected', ['is-idle', true]]);
  paintCoreState(scope, live, null);
  assert.deepStrictEqual([scope.textContent, live.textContent, toggles.at(-1)], ['Not connected', 'Not connected', ['is-idle', true]]);
  paintCoreState(scope, null, { provider: 'github' });
  assert.strictEqual(scope.textContent, 'github.com', 'no dot is no trouble');
  const untouched = { textContent: 'x', classList: { toggle: () => assert.fail('no rail, nothing painted') } };
  paintCoreState(null, untouched, { provider: 'github' });
  assert.strictEqual(untouched.textContent, 'x');
});

check('the line states the reading: signed out, measuring, a grade with what needs attention, and a cap', () => {
  const trust = over => ({ trust: { score: 82, grade: 'B', attention: 0, capped: false, ...over } });
  assert.strictEqual(coreLineText(trust(), null), 'Sign in to measure this workspace.');
  assert.strictEqual(coreLineText(null, { login: 'a' }), 'Measuring this workspace\u2026');
  assert.strictEqual(coreLineText({}, { login: 'a' }), 'Measuring this workspace\u2026');
  assert.strictEqual(coreLineText(trust({ score: null }), { login: 'a' }), 'Measuring this workspace\u2026');
  assert.strictEqual(coreLineText(trust(), { login: 'a' }), 'Grade B \u00b7 82/100 \u00b7 every measured signal healthy.');
  assert.strictEqual(coreLineText(trust({ score: 0, grade: 'F' }), { login: 'a' }), 'Grade F \u00b7 0/100 \u00b7 every measured signal healthy.', 'a score of nought is a reading');
  assert.strictEqual(coreLineText(trust({ attention: 1 }), { login: 'a' }), 'Grade B \u00b7 82/100 \u00b7 1 signal needs attention.');
  assert.strictEqual(coreLineText(trust({ attention: 3, capped: true }), { login: 'a' }), 'Grade B \u00b7 82/100 \u00b7 3 signals need attention \u00b7 capped by a critical leak.');
});

check('the line is drawn through the page\'s repaint, held for a press, and never without a line', () => {
  const line = { textContent: 'old' };
  const held = [];
  paintCoreLine(line, null, { login: 'a' }, (host, draw) => held.push([host, draw]));
  assert.strictEqual(line.textContent, 'old', 'nothing written until the repaint draws it');
  assert.strictEqual(held.length, 1);
  assert.strictEqual(held[0][0], line);
  held[0][1]();
  assert.strictEqual(line.textContent, 'Measuring this workspace\u2026');
  paintCoreLine(null, null, null, () => assert.fail('no line, nothing to repaint'));
});

check('the greeting is the reader\'s name, their login, or a tester', () => {
  assert.strictEqual(greeting({ name: 'Ada Lovelace', login: 'ada' }), 'Ada Lovelace');
  assert.strictEqual(greeting({ name: '', login: 'ada' }), 'ada');
  assert.strictEqual(greeting({}), 'tester');
  assert.strictEqual(greeting(null), 'tester');
  assert.strictEqual(greeting('x'), 'tester');
});

check('the browser\'s recovery references are counted by repository, once, and a refusing storage counts none', () => {
  const keys = localSnapshotKeys(() => ({ nv_snap_Octo: 1, 'nv_snap_octo': 2, 'nv_snap_a/B': 3, nv_snaps: 4, other: 5, 'x-nv_snap_y': 6 }));
  assert.deepStrictEqual([...keys].sort(), ['a/b', 'octo']);
  assert.deepStrictEqual([...localSnapshotKeys(() => { throw new Error('denied'); })], []);
  assert.deepStrictEqual([...localSnapshotKeys(() => null)], []);
});

check('the pointer light follows a fine pointer, only where one can hover, never by touch and never with motion off', () => {
  const asked = [];
  let listener = null;
  let options = null;
  const written = [];
  const panel = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    style: { setProperty: (name, value) => written.push([name, value]) },
    addEventListener: (type, run, opts) => { assert.strictEqual(type, 'pointermove'); listener = run; options = opts; }
  };
  let motion = true;
  wireCorePointer(panel, query => { asked.push(query); return { matches: true }; }, () => motion);
  assert.deepStrictEqual(asked, [FINE_POINTER]);
  assert.strictEqual(FINE_POINTER, '(hover:hover) and (pointer:fine)');
  assert.deepStrictEqual(options, { passive: true });
  listener({ clientX: 150, clientY: 75, pointerType: 'mouse' });
  assert.deepStrictEqual(written, [['--nv-px', '25%'], ['--nv-py', '25%']]);
  written.length = 0;
  listener({ clientX: 300, clientY: 60, pointerType: 'pen' });
  assert.deepStrictEqual(written, [['--nv-px', '100%'], ['--nv-py', '10%']]);
  written.length = 0;
  listener({ clientX: 150, clientY: 75, pointerType: 'touch' });
  motion = false;
  listener({ clientX: 150, clientY: 75, pointerType: 'mouse' });
  assert.deepStrictEqual(written, [], 'touch and motion off write nothing');
  motion = true;
  const flat = { ...panel, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 10 }) };
  wireCorePointer(flat, () => ({ matches: true }), () => true);
  listener({ clientX: 1, clientY: 1, pointerType: 'mouse' });
  assert.deepStrictEqual(written, [], 'a panel with no size writes nothing');
  let added = 0;
  const counted = { ...panel, addEventListener: () => { added += 1; } };
  wireCorePointer(counted, () => ({ matches: false }), () => true);
  wireCorePointer(counted, null, () => true);
  wireCorePointer(null, () => ({ matches: true }), () => true);
  assert.strictEqual(added, 0, 'a device that cannot hover, or has no media queries, is not listened to');
});

check('the row\'s five measures: nought is a measure, absence is none, and unknowns are not counted as flagged', () => {
  const list = [{ private: true }, { private: false }, null, 'x', { private: 1 }];
  const pulse = {
    trust: { score: 0, grade: 'F', measuredCount: 3, componentCount: 6, components: [{ status: 'warning' }, { status: 'critical' }, { status: 'unknown' }, { status: 'good' }, { status: 'muted' }] },
    signals: { measured: true, providerVerified: 0, total: 4 }
  };
  assert.deepStrictEqual(pulseMeasures(list, pulse), [
    { icon: 'repositories', label: 'Galaxies', value: 5, note: 'repositories connected' },
    { icon: 'private', label: 'Private', value: 2, note: 'of the connected set' },
    { icon: 'trust', label: 'Trust score', value: 0, note: 'Grade F \u00b7 3 of 6 measured' },
    { icon: 'signals', label: 'Provider-verified', value: 0, note: 'of 4 \u00b7 registry evidence' },
    { icon: 'attention', label: 'Needs attention', value: 2, note: 'components flagged' }
  ]);
  const one = pulseMeasures([], { trust: { score: 50, grade: 'D', measuredCount: 1, componentCount: 6, components: [{ status: 'warning' }] }, signals: { measured: false, providerVerified: 3, total: 3 } });
  assert.deepStrictEqual(one.slice(2).map(m => [m.value, m.note]), [[50, 'Grade D \u00b7 1 of 6 measured'], [null, 'Not measured'], [1, 'component flagged']]);
  for (const nothing of [null, undefined, {}, { trust: { score: null, components: 'x' }, signals: null }, { trust: { score: undefined } }]) {
    const row = pulseMeasures([], nothing);
    assert.deepStrictEqual(row.slice(2).map(m => [m.value, m.note]), [[null, 'Not measured'], [null, 'Not measured'], [null, 'Not measured']], JSON.stringify(nothing));
  }
  assert.deepStrictEqual(Object.keys(PULSE_ICONS), ['repositories', 'private', 'trust', 'signals', 'attention']);
  assert.deepStrictEqual(pulseMeasures([], null).map(m => PULSE_ICONS[m.icon]), Object.values(PULSE_ICONS), 'each measure its own icon, in order');
});

/* ---- The overview at work ---------------------------------------------------------------- */

function world(over = {}) {
  const log = [];
  const state = { me: { login: 'ada', provider: 'github' }, repos: [{ full_name: 'octo/a', private: true }], scanner: { active: true, rulesConfigured: false }, posture: null, ...over.state };
  const section = { hidden: true };
  let visible = over.visible || false;
  const overview = createOverview({
    state,
    capabilities: {
      features: 'features' in over ? over.features : () => ({ 'workspace.posture': { status: 'Supported' } }),
      decision: name => { log.push(['decision', name]); return { status: 'Supported' }; }
    },
    localSnapshots: () => new Set(['octo/a']),
    greet: () => log.push(['greet']),
    paintCoreState: () => log.push(['core']),
    paintCoreLine: pulse => log.push(['line', pulse]),
    row: () => ('row' in over ? over.row : { section, grid: 'grid' }),
    drawRow: (sec, grid, measures) => log.push(['row', grid, measures]),
    cards: () => ('cards' in over ? over.cards : { trust: 'trust', signals: 'signals', activity: 'activity' }),
    drawCards: (hosts, pulse) => log.push(['cards', hosts, pulse]),
    readings: {
      scanner: () => log.push(['scanner']), posture: () => log.push(['posture']), security: () => log.push(['security']), feed: () => log.push(['feed']),
      renderSecurity: () => log.push(['renderSecurity'])
    },
    board: { watch: () => log.push(['watch']), visible: () => visible, load: () => { log.push(['boardLoad']); return Promise.resolve(); }, render: () => log.push(['boardRender']) },
    showPage: name => log.push(['page', name])
  });
  return { log, state, overview, section, see: v => { visible = v; } };
}
const kinds = log => log.map(e => e[0]);

check('the overview is shown for the reader: greeted, its readings asked, the reader taken there, the board watched', () => {
  const w = world();
  w.overview.show();
  assert.deepStrictEqual(kinds(w.log), ['greet', 'core', 'decision', 'row', 'line', 'cards', 'renderSecurity', 'boardRender', 'scanner', 'posture', 'security', 'feed', 'page', 'watch']);
  assert.deepStrictEqual(w.log.find(e => e[0] === 'page'), ['page', 'overview']);
  const quiet = world();
  quiet.overview.show(false);
  assert.ok(!quiet.log.some(e => e[0] === 'page'), 'drawn without arriving');
  const seen = world({ visible: true });
  seen.overview.show();
  assert.deepStrictEqual(kinds(seen.log).slice(-2), ['watch', 'boardLoad'], 'a board already in view is read');
});

check('the pulse is measured once from the held list, a handed one, or none, and drawn into what is there', () => {
  const w = world();
  w.overview.renderPulse();
  const [, , measures] = w.log.find(e => e[0] === 'row');
  const [, , cardsPulse] = w.log.find(e => e[0] === 'cards');
  const [, linePulse] = w.log.find(e => e[0] === 'line');
  assert.strictEqual(cardsPulse, linePulse, 'the row, the line and the cards read one measurement');
  assert.deepStrictEqual(measures.slice(0, 2).map(m => m.value), [1, 1]);
  assert.deepStrictEqual(cardsPulse, WorkspacePulse.model({ repos: w.state.repos, features: { 'workspace.posture': { status: 'Supported' } }, recoveryStatus: 'Supported', scanner: w.state.scanner, identity: w.state.me, posture: null, localSnapshots: new Set(['octo/a']) }));
  w.log.length = 0;
  w.overview.renderPulse([{}, {}, { private: true }]);
  assert.deepStrictEqual(w.log.find(e => e[0] === 'row')[2].slice(0, 2).map(m => m.value), [3, 1], 'a handed list is measured instead');
  w.log.length = 0;
  w.overview.renderPulse('not a list');
  assert.deepStrictEqual(w.log.find(e => e[0] === 'row')[2].slice(0, 2).map(m => m.value), [1, 1], 'anything else is not a list: the held one is measured');
  const none = world({ state: { repos: null } });
  none.overview.renderPulse();
  assert.deepStrictEqual(none.log.find(e => e[0] === 'row')[2].slice(0, 2).map(m => m.value), [0, 0], 'no list holds nothing');
  const noFeatures = world({ features: null });
  noFeatures.overview.renderPulse();
  assert.strictEqual(noFeatures.log.find(e => e[0] === 'cards')[2].signals.measured, false);
});

check('the row and the cards are drawn only where they are', () => {
  for (const row of [{ section: null, grid: 'grid' }, { section: { hidden: true }, grid: null }]) {
    const w = world({ row });
    w.overview.renderPulse();
    assert.ok(!w.log.some(e => e[0] === 'row'));
    assert.ok(w.log.some(e => e[0] === 'line'));
  }
  const none = world({ cards: { trust: null, signals: null, activity: null } });
  none.overview.renderPulse();
  assert.ok(!none.log.some(e => e[0] === 'cards'));
  const one = world({ cards: { trust: null, signals: null, activity: 'activity' } });
  one.overview.renderPulse();
  assert.deepStrictEqual(one.log.find(e => e[0] === 'cards')[1], { trust: null, signals: null, activity: 'activity' });
});

check('what the pulse is handed of the page\'s state is read and never changed', () => {
  const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); } return value; };
  const state = deepFreeze({ me: { login: 'ada', provider: 'github' }, repos: [{ full_name: 'octo/a', private: true, language: 'Go', pushed_at: '2026-11-01T00:00:00Z' }], scanner: { active: true, rulesConfigured: true }, posture: { boundary: { state: 'online' }, credential: { kind: 'fine-grained' }, recovery: { repositories: ['octo/a'] } } });
  const w = world({ state });
  assert.doesNotThrow(() => { w.overview.renderPulse(); w.overview.show(); });
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
  console.log(`page pulse: ${checks.length} checks passed`);
})();
