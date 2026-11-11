'use strict';

/*
 * The Overview's charts and feed, decided before anything is drawn: where
 * every mark of the area chart and the radar goes, what the feed's answer
 * says, and what the pulse over the repository list counts. Each is a claim
 * a reader takes at face value -- a curve that dips below zero draws a count
 * as negative, a reveal shorter than its line shows the line before it is
 * revealed, a feed that could read nothing must not say it was quiet.
 */

const assert = require('node:assert/strict');
const charts = require('../apps/web/src/features/overview/pulse-charts.ts');
const pulse = require('../apps/web/src/features/overview/workspace-pulse.ts');
const { galaxyPulse } = require('../apps/web/src/features/repositories/galaxy-pulse.ts');

const cases = [];
const check = (name, run) => cases.push([name, run]);

/* The curve's points, sampled finely along each cubic of a monotonePath. */
function sample(path, segments = 400) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const points = [];
  let x = numbers[0];
  let y = numbers[1];
  let length = 0;
  points.push({ x, y });
  for (let index = 2; index + 5 < numbers.length; index += 6) {
    const [c1x, c1y, c2x, c2y, ex, ey] = numbers.slice(index, index + 6);
    let px = x;
    let py = y;
    for (let step = 1; step <= segments; step += 1) {
      const t = step / segments;
      const u = 1 - t;
      const qx = u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
      const qy = u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
      length += Math.hypot(qx - px, qy - py);
      points.push({ x: qx, y: qy });
      px = qx;
      py = qy;
    }
    x = ex;
    y = ey;
  }
  return { points, length };
}

check('the curve passes through every reading and never leaves the interval its readings define', () => {
  const series = [0, 0, 5, 9, 9, 1, 0, 0, 12, 0, 3, 3, 3, 0];
  const plan = charts.areaPlan(series, { width: 600 });
  const { points } = sample(plan.curve);
  const top = Math.min(...plan.points.map(point => point.y));
  for (const point of points) {
    assert.ok(point.y <= plan.baseY + 0.05, `the curve dips below the baseline at ${point.y}`);
    assert.ok(point.y >= top - 0.05, `the curve overshoots the peak at ${point.y}`);
  }
  for (const reading of plan.points) assert.ok(plan.curve.includes(`${reading.x},${reading.y}`), 'a reading the curve does not pass through');
  assert.equal(charts.monotonePath([]), '');
  assert.equal(charts.monotonePath([{ x: 1, y: 2 }]), 'M1,2');
  /* A flat run is flat: its control points sit on the line. */
  const flat = charts.monotonePath([{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }]);
  assert.ok(sample(flat).points.every(point => Math.abs(point.y - 10) < 1e-9), flat);
});

check('the chart is drawn at the width it is given, within bounds, and grows taller only in step', () => {
  const values = Array.from({ length: 60 }, (_, index) => index % 7);
  for (const [asked, width, height] of [[0, 380, 128], [100, 280, 128], [500, 500, 132], [1000, 1000, 208], [5000, 1600, 208]]) {
    const plan = charts.areaPlan(values, { width: asked });
    assert.deepEqual([plan.width, plan.height], [width, height], `asked ${asked}`);
    assert.equal(plan.points[0].x, plan.padX);
    assert.equal(plan.points.at(-1).x, plan.width - plan.padX);
    assert.deepEqual(plan.grid, [plan.padTop, (plan.padTop + plan.baseY) / 2, plan.baseY].map(y => Math.round(y * 10) / 10));
  }
  assert.ok(charts.areaPlan(values, { width: 800 }).area.endsWith(` L${800 - 16},${charts.areaPlan(values, { width: 800 }).baseY} L16,${charts.areaPlan(values, { width: 800 }).baseY} Z`), 'the fill closes along the baseline');
});

check('dots only where they can be read as dots, and the latest reading named only where nothing else names it', () => {
  const dense = charts.areaPlan(Array.from({ length: 60 }, () => 1), { width: 600 });
  assert.equal(dense.dots, false, 'sixty readings across 568 units are a bead chain');
  const sparse = charts.areaPlan([1, 4, 2, 7, 3, 5, 8], { width: 600 });
  assert.equal(sparse.dots, true);
  assert.equal(sparse.step >= charts.DOT_SPACING, true);
  assert.deepEqual(sparse.readout, { x: 600 - 16 - 2, y: Math.max(sparse.points.at(-1).y - 10, 10), anchor: 'end', text: '8' });
  assert.equal(charts.areaPlan([1, 4, 2], { width: 600, headline: true }).readout, null, 'the header already says it');
  const axis = charts.areaPlan([1, 2, 3, 4], { width: 600, axis: [{ index: 0, label: '4d ago' }, { index: 1, label: 'mid' }, { index: 3, label: 'today' }] }).axis;
  assert.deepEqual(axis.map(mark => [mark.anchor, mark.label]), [['start', '4d ago'], ['middle', 'mid'], ['end', 'today']]);
});

check('a pointer anywhere over the plot names the reading nearest it', () => {
  const plan = charts.areaPlan([1, 2, 3, 4, 5], { width: 400 });
  assert.equal(charts.readingAt(plan, -50), 0);
  assert.equal(charts.readingAt(plan, plan.points[2].x + plan.step * 0.4), 2);
  assert.equal(charts.readingAt(plan, plan.points[2].x + plan.step * 0.6), 3);
  assert.equal(charts.readingAt(plan, 10000), 4);
});

check('the reveal hides the whole line: its dash is never shorter than the curve', () => {
  for (const series of [[0, 0, 9, 0, 0], Array.from({ length: 60 }, (_, index) => (index * 7) % 11), [3, 3]]) {
    for (const width of [280, 640, 1600]) {
      const plan = charts.areaPlan(series, { width });
      const truth = sample(plan.curve, 4000).length;
      const dash = charts.curveLength(plan.curve);
      assert.ok(dash >= truth, `a dash of ${dash} leaves the tail of a ${truth} line drawn`);
      assert.ok(dash <= truth * 1.003 + 2, `a dash of ${dash} on a ${truth} line delays the reveal`);
    }
  }
  assert.equal(charts.curveLength('M1,2'), 0);
});

check('the radar starts at twelve o\'clock, anchors each label away from its web, and elides only what is too long', () => {
  const axes = [
    { label: 'TypeScript', count: 8 }, { label: 'Go', count: 4 }, { label: 'A language with a long name', count: 2 },
    { label: 'Other', count: 3, folded: 4 }
  ];
  const plan = charts.radarPlan(axes);
  assert.deepEqual([plan.width, plan.height], [340, 214]);
  const [top, right, bottom, left] = plan.spokes;
  assert.ok(Math.abs(top.outer.x - plan.centre.x) < 0.1 && top.outer.y < plan.centre.y, 'the first spoke points up');
  assert.deepEqual([top.label.anchor, right.label.anchor, bottom.label.anchor, left.label.anchor], ['middle', 'start', 'middle', 'end']);
  assert.equal(top.vertex.y, top.outer.y, 'the largest reaches the outer ring');
  assert.ok(Math.abs(right.vertex.x - plan.centre.x - (right.outer.x - plan.centre.x) / 2) < 0.2, 'half the largest reaches half way');
  assert.deepEqual([bottom.label.text, bottom.label.elided], [`${'A language with a long name'.slice(0, charts.RADAR_LABEL_MAX - 1)}…`, true]);
  assert.deepEqual([top.label.text, top.label.elided], ['TypeScript', false]);
  assert.equal(left.title, 'Other: 3 repositories across 4 languages');
  assert.equal(charts.radarPlan([{ label: 'Go', count: 1 }, { label: 'C', count: 1 }, { label: 'R', count: 1 }]).spokes[0].title, 'Go: 1 repository');
  assert.equal(plan.rings.length, 4);
  assert.ok(plan.collapsed.split(' ').every(point => point === `${plan.centre.x},${plan.centre.y}`), 'the reveal grows from the centre');
  assert.equal(plan.full.split(' ').length, axes.length);
});

check('the feed\'s answer is read into one of its states, and never says quiet for nothing read', () => {
  assert.deepEqual(pulse.feedView(null), { state: 'loading' });
  assert.deepEqual(pulse.feedView({ loading: true }), { state: 'loading' });
  assert.deepEqual(pulse.feedView({ loading: false, error: 'Recent activity could not be read: offline' }), { state: 'error', message: 'Recent activity could not be read: offline' });
  const base = { loading: false, now: 1_700_000_000_000, days: 7, inventoryCount: 3, repositories: [{}, {}], measured: true, events: [], failed: [] };
  assert.equal(pulse.feedView({ ...base, inventoryCount: 0 }).body, 'no-repositories');
  assert.equal(pulse.feedView({ ...base, inventoryCount: 0, measured: false, failed: [{ repo: 'a/b', reason: 'forbidden' }] }).body, 'unmeasured',
    'a repository that could not be read is a repository: not "no repositories"');
  assert.equal(pulse.feedView({ ...base, measured: false }).body, 'unmeasured');
  assert.equal(pulse.feedView(base).body, 'quiet');
  const read = pulse.feedView({
    ...base,
    generatedAt: '2026-11-11T10:00:00.000Z',
    perRepositoryLimit: 0,
    events: [
      { kind: 'commit', repo: 'acme/web', at: 1_699_999_000_000, title: 'Fix', ref: 'abc1234', detail: 'abc', actor: 'maya' },
      { kind: 'commit', at: 'yesterday' }, { kind: 'commit', at: '2026-11-10T08:00:00.000Z' }, { kind: 'commit', at: null }
    ]
  });
  assert.equal(read.body, 'events');
  assert.equal(read.repositories, 2);
  assert.equal(read.perRepositoryLimit, 20, 'the server\'s limit when it says none');
  assert.equal(read.generatedAt, Date.parse('2026-11-11T10:00:00.000Z'));
  assert.equal(read.now, base.now, 'the moment the answer arrived, not the moment it is drawn');
  assert.ok(Number.isNaN(read.events[1].at), 'words that are not a date are no time');
  assert.equal(read.events[2].at, Date.parse('2026-11-10T08:00:00.000Z'), 'a date in words is that time');
  assert.ok(Number.isNaN(read.events[3].at));
  assert.equal(read.events[1].repo, '');
  assert.equal(pulse.feedView({ ...base, generatedAt: 'not a date' }).generatedAt, null);
});

check('the evidence line keeps the actor, and the reference once', () => {
  const event = pulse.feedEvent({ ref: 'abc1234', detail: 'abc', actor: 'abc' });
  assert.deepEqual(pulse.feedMarks(event), ['abc1234', 'abc'], 'a detail inside the reference is not said twice; an actor named like a hash is still the actor');
  assert.deepEqual(pulse.feedMarks(pulse.feedEvent({ ref: '#42', detail: 'merged', actor: '' })), ['#42', 'merged']);
  assert.deepEqual(pulse.feedMarks(pulse.feedEvent({})), []);
  assert.equal(pulse.repositories(1), 'repository');
  assert.equal(pulse.repositories(2), 'repositories');
});

check('how long ago, in words, and an absolute date past a month', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');
  assert.deepEqual([0, 59, 60, 3599, 3600, 86399, 86400, 2591999].map(seconds => pulse.since(now - seconds * 1000, now)),
    ['just now', 'just now', '1m ago', '59m ago', '1h ago', '23h ago', '1d ago', '29d ago']);
  assert.equal(pulse.since(now - 2592000 * 1000, now), new Date(now - 2592000 * 1000).toLocaleDateString());
  assert.equal(pulse.since(Number.NaN, now), '');
  assert.equal(pulse.since(now + 60000, now), 'just now', 'a clock a little ahead is not the future');
});

check('the pulse over the repository list counts what it was given, and keeps its tile when there is no shape to draw', () => {
  const repos = [
    { name: 'a', private: true, language: 'Go' }, { name: 'b', private: false, language: 'Go' },
    { name: 'c', language: 'TypeScript' }, null
  ];
  const few = galaxyPulse(repos);
  assert.equal(few.spread, null, 'two languages are no polygon');
  assert.deepEqual(few.measures.map(measure => [measure.label, measure.value, measure.note]), [
    ['Galaxies', 4, 'repositories connected'], ['Private', 1, 'of the connected set'], ['Public', 1, 'readable by anyone'], ['Languages', 2, 'across the set']
  ]);
  assert.equal(galaxyPulse([{ language: 'Go' }]).measures.at(-1).note, 'in use');
  const eight = pulse.languageSpread(Array.from({ length: 8 }, (_, index) => ({ language: `L${index}` })));
  assert.deepEqual([eight.length, eight.some(axis => axis.folded)], [8, false], 'eight languages are eight spokes');
  const nine = pulse.languageSpread(Array.from({ length: 9 }, (_, index) => ({ language: `L${index}` })));
  assert.deepEqual([nine.length, nine.at(-1).label, nine.at(-1).folded, nine.at(-1).count], [8, 'Other', 2, 2], 'a ninth folds the smallest two into Other');
  const many = galaxyPulse([...repos, { language: 'Rust' }, { language: 'C' }]);
  assert.deepEqual(many.spread.map(axis => axis.label), ['Go', 'C', 'Rust', 'TypeScript']);
  assert.equal(many.languages, 4);
  assert.ok(!many.measures.some(measure => measure.label === 'Languages'), 'the radar replaces the tile');
  assert.deepEqual(galaxyPulse('not a list').measures.map(measure => measure.value), [0, 0, 0, 0]);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} pulse chart checks failed`);
  process.exit(1);
}
console.log(`pulse charts: ${cases.length} checks passed`);
