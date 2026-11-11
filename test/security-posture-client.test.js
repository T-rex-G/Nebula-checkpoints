'use strict';

/*
 * The Overview's posture card, decided before it is drawn. The server says
 * what the stores hold; this module adds the one thing only the browser
 * knows -- which repositories in the inventory neither system has read -- and
 * chooses between a reading, an empty workspace and an unanswered one, which
 * must never look alike.
 */

const assert = require('assert');
const posture = require('../apps/web/src/features/posture/security-posture.ts');

const repos = [
  { name: 'Shop', owner: { login: 'Acme' }, pushed_at: '2026-10-09T00:00:00Z' },
  { name: 'Api', owner: { login: 'acme' }, pushed_at: '2026-10-08T00:00:00Z' },
  { full_name: 'Acme/Docs', pushed_at: '2026-10-07T00:00:00Z' },
  { name: 'Old', owner: { login: 'Acme' }, pushed_at: '2025-01-01T00:00:00Z' },
  { name: 'Shop', owner: { login: 'Acme' } },
  null
];
const trend = Array.from({ length: 12 }, (_, index) => ({ weeksAgo: 11 - index, opened: index === 11 ? 3 : 0, fixed: index === 11 ? 1 : 0 }));
const summary = {
  available: true,
  weeks: 12,
  sources: { audit: 'measured', exposure: 'measured', governance: 'measured' },
  open: { critical: 1, serious: 2, warning: 0, total: 3 },
  triaged: { acceptedRisk: 2, falsePositive: 1 },
  week: { opened: 3, fixed: 1, gated: 2, warned: 0 },
  window: { opened: 3, fixed: 1 },
  trend,
  timeToFix: { windowDays: 90, all: { count: 4, medianDays: 2.5 } },
  categories: [{ category: 'code', critical: 1, serious: 0, warning: 0, total: 1 }, { category: 'leaked-credentials', critical: 0, serious: 2, warning: 0, total: 2 }, { category: 'hygiene', total: 0 }],
  top: [{ owner: 'Acme', repo: 'Shop', open: { critical: 1, serious: 2, warning: 0, total: 3 } }],
  repositories: [
    { owner: 'acme', repo: 'shop', open: { critical: 1, serious: 2, warning: 0, total: 3 } },
    { owner: 'Acme', repo: 'Gone', open: { critical: 0, serious: 0, warning: 0, total: 0 } }
  ]
};

{
  assert.deepStrictEqual(posture.model(null, repos), { state: 'loading' });
  const view = posture.model(summary, repos);
  assert.strictEqual(view.state, 'ready');
  assert.deepStrictEqual([view.covered, view.inventory], [1, 4], 'Shop is read, whatever case either side wrote it in; duplicates and blanks are not counted');
  assert.deepStrictEqual(view.unread.map(entry => `${entry.owner}/${entry.repo}`), ['acme/Api', 'Acme/Docs', 'Acme/Old'],
    'never read, most recently pushed first');
  assert.deepStrictEqual(view.categories.map(entry => entry.category), ['code', 'leaked-credentials'], 'a kind with nothing open is not drawn');
  assert.deepStrictEqual(view.notes, []);
  assert.strictEqual(posture.weekSentence(view), 'This week: 3 new findings, 1 fixed and 2 merge attempts gated.');
  assert.strictEqual(posture.categoryLabel('leaked-credentials'), 'Leaked credentials');
  assert.strictEqual(posture.categoryLabel('ai'), 'AI and model output');
  assert.strictEqual(posture.categoryLabel('new-kind'), 'New kind');
}

/* A system that did not answer is said, and its part is not drawn as zero. */
{
  const view = posture.model({ ...summary, sources: { audit: 'measured', exposure: 'partial', governance: 'unavailable' }, week: { opened: 1, fixed: 0, gated: null } }, repos);
  assert.strictEqual(view.week.gated, null);
  assert.strictEqual(posture.weekSentence(view), 'This week: 1 new finding and 0 fixed.', 'no claim about merges governance could not count');
  assert.deepStrictEqual(view.notes, [
    'The exposure trend could not be read; credentials are counted, not charted.',
    'Governance decisions could not be read; gated merges are not counted.'
  ]);
}

/* Nothing read is not the same as nothing answered, and neither is a clean workspace. */
{
  const many = Array.from({ length: posture.UNREAD_SHOWN + 4 }, (_, index) => ({ name: `R${index}`, owner: { login: 'Acme' } }));
  const empty = posture.model({ ...summary, repositories: [], top: [] }, many);
  assert.strictEqual(empty.state, 'empty');
  assert.strictEqual(empty.unread.length, posture.UNREAD_SHOWN);
  assert.strictEqual(empty.unreadMore, 4);
  const unanswered = posture.model({ ...summary, repositories: [], top: [], sources: { audit: 'unavailable', exposure: 'unavailable', governance: 'unavailable' } }, many);
  assert.strictEqual(unanswered.state, 'unmeasured');
  const partly = posture.model({ ...summary, repositories: [], top: [], sources: { audit: 'unavailable', exposure: 'partial', governance: 'unavailable' } }, many);
  assert.strictEqual(partly.state, 'empty', 'a partial reading is a reading: nothing in it is nothing found, not nothing answered');
  assert.match(posture.model({ available: false, reason: 'not-configured' }, repos).reason, /has none/);
  assert.match(posture.model({ available: false, reason: 'database-unavailable' }, repos).reason, /did not answer/);
  assert.match(posture.model({ available: false, reason: 'offline' }, repos).reason, /offline/);
  assert.match(posture.model({ available: false, reason: 'unreadable' }, repos).reason, /could not be read just now/);
}

/* The answer's figures are read as numbers, whatever arrived; a part that did not arrive reads as none. */
{
  const view = posture.model({
    ...summary,
    open: { critical: '1', serious: null, total: 1 },
    triaged: undefined,
    week: { opened: '2' },
    timeToFix: { all: { count: 3, medianDays: 0.4 } },
    categories: [{ category: 'licences', total: '2' }, 'junk'],
    top: [{ owner: 'Acme', repo: 'Shop', open: null }]
  }, repos);
  assert.deepStrictEqual(view.open, { critical: 1, serious: 0, warning: 0, total: 1 });
  assert.deepStrictEqual(view.triaged, { acceptedRisk: 0, falsePositive: 0 });
  assert.deepStrictEqual(view.week, { opened: 2, fixed: 0, gated: null });
  assert.deepStrictEqual(view.timeToFix, { windowDays: 90, all: { count: 3, medianDays: 0.4 } }, 'the window the server uses, when it is not said');
  assert.deepStrictEqual(view.categories.map(entry => [entry.category, entry.total]), [['licences', 2]]);
  assert.deepStrictEqual(view.top, [{ owner: 'Acme', repo: 'Shop', open: { critical: 0, serious: 0, warning: 0, total: 0 } }]);
  assert.strictEqual(posture.model({ ...summary, timeToFix: 'soon' }, repos).timeToFix, null);
  assert.strictEqual(posture.model({ ...summary, categories: Array.from({ length: 9 }, (_, i) => ({ category: `k${i}`, total: 1 })) }, repos).categories.length, 6);
  assert.strictEqual(posture.model({ ...summary, weeks: undefined }, repos).weeks, 12, 'the weeks the trend has, when the answer does not say');
}

/* Words a reader can repeat. */
{
  assert.strictEqual(posture.severityWords({ critical: 1, serious: 0, warning: 2, total: 3 }), '1 critical · 2 warning');
  assert.strictEqual(posture.severityWords({ critical: 0, serious: 0, warning: 0, total: 0 }), 'nothing open');
  assert.deepStrictEqual([0, 1, 5].map(posture.weekName), ['This week', 'Last week', '5 weeks ago']);
  assert.deepStrictEqual([null, undefined, 'x', 0.5, 1, 2, 4.25].map(posture.days), [null, null, null, 'under a day', '1 day', '2 days', '4.3 days']);
  assert.strictEqual(posture.categoryLabel(undefined), 'Other');
  assert.strictEqual(posture.plural(1, 'week', 'weeks'), '1 week');
  assert.strictEqual(posture.plural(0, 'week', 'weeks'), '0 weeks');
}

/* The x of every point a bar's outline passes through: M x,y · V y · Q x,y x,y · H x. */
function xsOf(d) {
  const tokens = d.match(/[MVQHZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g);
  const xs = [];
  let command = '';
  let operand = 0;
  for (const token of tokens) {
    if (/[MVQHZ]/.test(token)) { command = token; operand = 0; continue; }
    const value = Number(token);
    if (command === 'H' || ((command === 'M' || command === 'Q') && operand % 2 === 0)) xs.push(value);
    operand += 1;
  }
  return xs;
}

/* The chart: whole steps from zero, every bar standing on the baseline inside the plot, one hit target a week. */
{
  const view = posture.model(summary, repos);
  for (const width of [0, 240, 300, 419, 420, 640, 1200]) {
    const plan = posture.chartPlan(view, width);
    assert.strictEqual(plan.width, Math.max(240, width || 480));
    assert.strictEqual(plan.height, plan.width < 420 ? 150 : 180);
    assert.match(plan.label, /last 12 weeks: 3 opened and 1 fixed in all\.$/);
    assert.deepStrictEqual(plan.ticks.map(tick => tick.value), [0, 1, 2, 3]);
    assert.strictEqual(plan.ticks[0].y, plan.height - 22, 'zero is the baseline');
    assert.strictEqual(plan.weeks.length, 12);
    let previous = plan.left - 1;
    for (const week of plan.weeks) {
      assert.ok(week.hit.x > previous, 'weeks run left to right');
      previous = week.hit.x;
      assert.ok(week.hit.x >= plan.left && week.hit.x + week.hit.width <= plan.right + 1e-9);
      assert.ok(week.share > 0 && week.share < 1);
      for (const bar of week.bars) {
        const xs = xsOf(bar.d);
        assert.ok(Math.min(...xs) >= week.hit.x && Math.max(...xs) <= week.hit.x + week.hit.width, `${bar.kind} stays in its week at ${width}`);
        assert.ok(bar.d.startsWith('M') && bar.d.endsWith(`V${plan.ticks[0].y}Z`), 'stands on the baseline');
      }
    }
    const latest = plan.weeks[11];
    assert.strictEqual(latest.weeksAgo, 0);
    assert.strictEqual(latest.label, 'This week: 3 opened, 1 fixed');
    assert.deepStrictEqual(latest.bars.map(bar => bar.kind), ['opened', 'fixed']);
    assert.deepStrictEqual(plan.weeks[0].bars, [], 'a week with nothing has no bar');
  }
  const five = posture.chartPlan({ trend: [{ weeksAgo: 0, opened: 5, fixed: 0 }], window: { opened: 5, fixed: 0 } }, 480);
  assert.deepStrictEqual(five.ticks.map(tick => tick.value), [0, 2, 4, 6]);
  const twelve = posture.chartPlan({ trend: [{ weeksAgo: 0, opened: 12, fixed: 0 }], window: { opened: 12, fixed: 0 } }, 480);
  assert.deepStrictEqual(twelve.ticks.map(tick => tick.value), [0, 5, 10, 15]);
  const big = posture.chartPlan({ trend: [{ weeksAgo: 0, opened: 230, fixed: 7 }], window: { opened: 230, fixed: 7 } }, 480);
  assert.deepStrictEqual(big.ticks.map(tick => tick.value), [0, 100, 200, 300], 'steps of 1, 2 or 5 times a power of ten');
  const tall = posture.chartPlan({ trend: [{ weeksAgo: 0, opened: 1, fixed: 0 }], window: { opened: 1, fixed: 0 } }, 480);
  const top = tall.ticks[tall.ticks.length - 1];
  assert.ok(tall.weeks[0].bars[0].d.includes(`,${top.y}H`), 'the tallest bar reaches the top gridline');
}

console.log('security posture client tests passed');
