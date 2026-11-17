'use strict';

/*
 * The Neural command center's panels: what each decides, asked of its model
 * (features/neural/graph-summary.ts, graph-timeline.ts, graph-legend.ts,
 * graph-card.ts), and what each draws, rendered to the markup the reader's
 * browser receives and pressed through the handlers the page passes
 * (features/neural/NeuralPanels.tsx). Nothing of the page's text is read.
 */

const assert = require('node:assert/strict');
const { createElement, isValidElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { timeAgo, dataGaps, summarize, streamLabel } = require('../apps/web/src/features/neural/graph-summary.ts');
const { timelineIndex, timelineCaption, eventStrip } = require('../apps/web/src/features/neural/graph-timeline.ts');
const { legendModel, GROUP_CATEGORIES } = require('../apps/web/src/features/neural/graph-legend.ts');
const card = require('../apps/web/src/features/neural/graph-card.ts');
const { addNode, addEdge, TYPE_STYLE } = require('../apps/web/src/features/neural/graph-model.ts');
const { TYPE_ICON, MARK_PATHS } = require('../apps/web/src/features/neural/graph-marks.ts');
const { loadPageModule } = require('./helpers/page-module');

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const S = 1000, MIN = 60 * S, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ago = ms => new Date(NOW - ms).toISOString();

/* ---- How long ago --------------------------------------------------------------------- */
{
  assert.equal(timeAgo('', NOW), 'unknown time');
  assert.equal(timeAgo(null, NOW), 'unknown time');
  assert.equal(timeAgo(0, NOW), 'unknown time', 'a zero time is no time');
  assert.equal(timeAgo('not a time', NOW), 'not a time', 'what is no time is said as it came');
  assert.equal(timeAgo(ago(0), NOW), '0s ago');
  assert.equal(timeAgo(ago(59.9 * S), NOW), '59s ago', 'whole seconds, rounded down');
  assert.equal(timeAgo(ago(60 * S), NOW), '1m ago');
  assert.equal(timeAgo(ago(HOUR - S), NOW), '59m ago');
  assert.equal(timeAgo(ago(HOUR), NOW), '1h ago');
  assert.equal(timeAgo(ago(DAY - S), NOW), '23h ago');
  assert.equal(timeAgo(ago(DAY), NOW), '1d ago');
  assert.equal(timeAgo(ago(30 * DAY - S), NOW), '29d ago');
  assert.equal(timeAgo(ago(30 * DAY), NOW), new Date(NOW - 30 * DAY).toLocaleDateString(), 'past a month, the date');
  assert.equal(timeAgo(NOW - 5 * MIN, NOW), '5m ago', 'a time as milliseconds');
  const date = new Date(NOW - 2 * HOUR);
  assert.equal(timeAgo(date, NOW), '2h ago', 'a Date');
  assert.equal(date.getTime(), NOW - 2 * HOUR, 'and the Date is left as it was');
  assert.equal(timeAgo(ago(-5 * MIN), NOW), '0s ago', 'a time ahead of the clock is now, not negative');
}

/* ---- What the map could not read whole ----------------------------------------------------- */
{
  assert.deepEqual(dataGaps(null, false), ['Map data']);
  assert.deepEqual(dataGaps(undefined, true), ['Map data'], 'nothing read is the one gap, whatever else failed');
  assert.deepEqual(dataGaps({}, false), []);
  assert.deepEqual(dataGaps({}, true), ['Event history'], 'a failed catch-up');
  assert.deepEqual(dataGaps({ unavailable: ['Safety', 'Activity'] }, false), ['Safety', 'Activity'], 'the sources that failed, by name');
  assert.deepEqual(dataGaps({ unavailable: 'Safety' }, false), [], 'a list of failures that is no list names none');
  const flags = ['available', 'partial', 'truncated', 'hasMore', 'truncatedBefore'];
  const readings = [['Activity', 'activity'], ['References', 'refs'], ['Dependencies', 'deps'], ['Sessions', 'sessions'], ['Live events', 'live'],
    ['Event history', 'intelligence'], ['Recovery', 'signedSnapshots'], ['Access', 'access'], ['Exposure', 'exposure']];
  for (const [name, key] of readings) {
    for (const flag of flags) {
      const reading = flag === 'available' ? { available: false } : { [flag]: true };
      assert.deepEqual(dataGaps({ [key]: reading }, false), [name], `${key} ${flag} is a gap in ${name}`);
    }
    assert.deepEqual(dataGaps({ [key]: { available: true, partial: false } }, false), [], `${key} whole is no gap`);
    assert.deepEqual(dataGaps({ [key]: { available: undefined } }, false), [], `${key} without word of availability is no gap`);
  }
  assert.deepEqual(dataGaps({ deps: { osv: { available: false } } }, false), ['Dependencies'], 'the advisory database out of reach');
  assert.deepEqual(dataGaps({ deps: { osv: { available: true } } }, false), []);
  assert.deepEqual(dataGaps({ deps: { partial: true, osv: { available: false } } }, false), ['Dependencies'], 'named once');
  assert.deepEqual(dataGaps({ activity: { sources: { commits: { available: false } } } }, false), ['Activity'], 'a source of activity out of reach');
  assert.deepEqual(dataGaps({ activity: { sources: { commits: { truncated: true } } } }, false), ['Activity'], 'or cut short');
  assert.deepEqual(dataGaps({ activity: { sources: { commits: { requested: false, available: false } } } }, false), [], 'a source not asked for is no gap');
  assert.deepEqual(dataGaps({ activity: { sources: { commits: null, pulls: { available: true } } } }, false), []);
  assert.deepEqual(dataGaps({ activity: { sources: 'all' } }, false), [], 'sources that are no table name nothing');
  for (const [kind, at] of [['commits', 'date'], ['pulls', 'updated'], ['issues', 'updated'], ['releases', 'published']]) {
    assert.deepEqual(dataGaps({ activity: { [kind]: [{ [at]: ago(HOUR) }] } }, false), [], `${kind} with times`);
    assert.deepEqual(dataGaps({ activity: { [kind]: [{ [at]: ago(HOUR) }, {}] } }, false), ['Activity timestamps'], `${kind} without a time`);
    assert.deepEqual(dataGaps({ activity: { [kind]: [{ [at]: 'yesterday' }] } }, false), ['Activity timestamps'], `${kind} with a time that is no time`);
  }
  assert.deepEqual(dataGaps({ activity: { commits: [{ updated: ago(HOUR) }] } }, false), ['Activity timestamps'], 'each kind is dated by its own field');
  assert.deepEqual(dataGaps({ activity: { commits: [{ date: 0 }] } }, false), ['Activity timestamps'], 'a zero time is no time (though "0" parses as the year 2000)');
  assert.deepEqual(
    dataGaps({ unavailable: ['Safety'], exposure: { truncated: true }, activity: { partial: true, commits: [{}] }, deps: { osv: { available: false } } }, true),
    ['Safety', 'Activity', 'Exposure', 'Dependencies', 'Activity timestamps', 'Event history'],
    'the failed sources, the readings in the map\'s order, then the advisory database, the activity\'s times and the catch-up'
  );
}

/* ---- The summary cards --------------------------------------------------------------------- */
const WORK = { owner: 'acme', repo: 'widget' };
const nodesOf = (...specs) => specs.flatMap(([type, severity, n = 1]) => Array.from({ length: n }, () => ({ type, severity })));
const sum = (data, extra = {}) => summarize({ data, nodes: [], events: 0, work: WORK, catchUpError: false, now: NOW, ...extra });
const SNAP = { signedSnapshots: { snapshots: [{ signatureValid: true, createdAt: ago(3 * HOUR) }] } };
const GUARDED = { ...SNAP, safety: { protected: { 'acme/widget': ['a'] } } };
{
  /* Nothing read but the map itself: the floor, and nudges for no snapshot and nothing protected. */
  const bare = sum({});
  assert.deepEqual(bare.risk, { text: 'Guarded · 28', level: 'good', hint: 'No critical signals in the observed data', score: 28 });
  assert.equal(bare.signals, '0');
  assert.equal(bare.protectedCount, '0');
  assert.deepEqual(bare.recovery, { text: 'Gap', level: 'warning', hint: 'Capture refs before an incident' });
  assert.equal(bare.emergency, false);
  assert.equal(bare.readOnlyLabel, 'Enable read-only');
  assert.deepEqual(bare.live, { disabled: true, label: 'Connect verified live events', short: 'Live events', title: 'Neon and GitHub are required' });

  /* With a verified snapshot and a protected file the floor stands alone. */
  const calm = sum(GUARDED, { events: 7 });
  assert.deepEqual(calm.risk, { text: 'Low · 12', level: 'good', hint: 'No critical signals in the observed data', score: 12 });
  assert.equal(calm.signals, '7');
  assert.equal(calm.protectedCount, '1');
  assert.deepEqual(calm.recovery, { text: 'Captured', level: 'good', hint: 'Verified snapshot 3h ago' });

  /* What is protected: the repository's own files, and its protected branches. */
  const refs = { refs: [{ protected: true }, { protected: false }, { protected: true }, {}] };
  assert.equal(sum({ safety: { protected: { 'acme/widget': ['a', 'b', 'c'], 'acme/other': ['x'] } }, refs }).protectedCount, '5');
  assert.equal(sum({ safety: { protected: { 'acme/other': ['x'] } } }).protectedCount, '0', 'another repository protects nothing here');
  assert.equal(sum({ safety: { protected: { 'acme/widget': 'abc' } } }).protectedCount, '0', 'a reading that is no list protects nothing');
  assert.equal(sum({ safety: { protected: { 'acme/widget': { length: 4 } } } }).protectedCount, '0');
  assert.equal(sum({ refs }).risk.score, 21, 'protected branches alone lift the nudge');
  assert.equal(sum({ safety: { protected: { 'acme/widget': ['a'] } } }).risk.score, 21, 'as do protected files');

  /* Each reading the graph shows adds its weight. */
  assert.equal(sum(GUARDED, { nodes: nodesOf(['vulnerability', 'critical']) }).risk.score, 34);
  assert.equal(sum(GUARDED, { nodes: nodesOf(['vulnerability', 'warning']) }).risk.score, 21);
  assert.equal(sum({ ...GUARDED, actions: [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'success' }, { conclusion: null }] }).risk.score, 24);
  assert.equal(sum({ ...GUARDED, sessions: { sessions: [{ current: true }, {}, { current: false }] } }).risk.score, 18);
  assert.equal(sum(GUARDED, { nodes: nodesOf(['vulnerability', 'normal'], ['package', 'critical']) }).risk.score, 12, 'only advisories count, and only at warning or worse');

  /* The highest verified event, or the access surface's score, where either is worse. */
  assert.equal(sum({ ...GUARDED, intelligence: { events: [{ score: 30 }, { score: '55' }, { score: 'x' }, {}] } }).risk.score, 55);
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 47 } } }).risk.score, 47);
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 9 } } }).risk.score, 12);
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 'high' } }, intelligence: { events: [{ score: Infinity }] } }).risk.score, 12, 'a score that is no number counts nothing');

  /* Read-only takes ten off; an exposed credential holds it at critical; the score stays within 0 and 100. */
  assert.equal(sum({ ...GUARDED, safety: { ...GUARDED.safety, readOnly: true } }).risk.score, 2);
  assert.equal(sum({ ...GUARDED, safety: { ...GUARDED.safety, readOnly: true }, intelligence: { events: [{ score: 5 }] } }).risk.score, 2);
  assert.equal(sum(GUARDED, { nodes: nodesOf(['leak', 'critical']) }).risk.score, 75);
  assert.equal(sum(GUARDED, { nodes: nodesOf(['leak', 'warning']) }).risk.score, 12, 'a leak only at critical');
  assert.equal(sum(GUARDED, { nodes: nodesOf(['vulnerability', 'critical', 6]) }).risk.score, 100);
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 140 } } }).risk.score, 100);
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 30.6 } } }).risk.score, 31, 'rounded');

  /* The label and level at each threshold. */
  const at = score => sum({ ...GUARDED, access: { risk: { score } } }).risk;
  assert.deepEqual([27, 28, 39, 40, 49, 50, 74, 75].map(s => [at(s).text, at(s).level]), [
    ['Low · 27', 'good'], ['Guarded · 28', 'good'], ['Guarded · 39', 'good'], ['Guarded · 40', 'warning'],
    ['Guarded · 49', 'warning'], ['Elevated · 50', 'warning'], ['Elevated · 74', 'warning'], ['Critical · 75', 'critical']
  ]);

  /* The hint names the worst thing found, in this order. */
  const verifiedCritical = { events: [{ severity: 'critical', summary: 'Force push', score: 81, reasons: [{ message: 'history rewritten' }] }, { severity: 'warning', summary: 'later' }] };
  assert.equal(sum(GUARDED, { nodes: nodesOf(['leak', 'critical', 2]) }).risk.hint, '2 critical exposed credential signal(s)');
  assert.equal(sum({ ...GUARDED, intelligence: verifiedCritical }, { nodes: nodesOf(['leak', 'critical']) }).risk.hint, '1 critical exposed credential signal(s)');
  assert.equal(sum({ ...GUARDED, intelligence: verifiedCritical }).risk.hint, 'Force push · history rewritten');
  assert.equal(sum({ ...GUARDED, intelligence: { events: [{ severity: 'critical', summary: 'A', score: 90 }, { severity: 'critical', summary: 'B', score: 80 }] } }).risk.hint, 'B · risk 80', 'the latest critical, its score where it gives no reason');
  assert.equal(sum({ ...GUARDED, intelligence: verifiedCritical, access: { risk: { score: 95 } } }).risk.hint, 'Force push · history rewritten');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 70, reasons: [{ message: 'admin deploy key' }] } } }).risk.hint, 'Critical access path · admin deploy key');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 70 } } }).risk.hint, 'Critical access path · risk 70');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 70 } } }, { nodes: nodesOf(['vulnerability', 'critical']) }).risk.hint, 'Critical access path · risk 70');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 69 } } }, { nodes: nodesOf(['vulnerability', 'critical', 3]) }).risk.hint, '3 critical vulnerability signal(s)');
  assert.equal(sum({ ...GUARDED, actions: [{ conclusion: 'failure' }], access: { risk: { score: 69 } } }).risk.hint, '1 failed workflow run(s)');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 35, reasons: [{ message: 'outside collaborator' }] } } }).risk.hint, 'Access posture warning · outside collaborator');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 34 } } }).risk.hint, 'No critical signals in the observed data');

  /* Where the readings were incomplete the card says so rather than scoring what it could not see. */
  const partial = sum({ ...GUARDED, exposure: { truncated: true } });
  assert.deepEqual(partial.risk, { text: 'Incomplete', level: 'warning', hint: 'Incomplete sources: Exposure', score: 12 });
  const partialCritical = sum({ ...GUARDED, exposure: { truncated: true } }, { nodes: nodesOf(['leak', 'critical']) });
  assert.deepEqual(partialCritical.risk, { text: 'Critical · Incomplete', level: 'critical', hint: '1 critical exposed credential signal(s) · Incomplete: Exposure', score: 75 });
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 35 } } }, { catchUpError: true }).risk.hint, 'Access posture warning · risk 35 · Incomplete: Event history');
  assert.equal(sum({ ...GUARDED, actions: [{ conclusion: 'cancelled' }] }, { catchUpError: true }).risk.hint, '1 failed workflow run(s) · Incomplete: Event history');
  assert.equal(sum(GUARDED, { nodes: nodesOf(['vulnerability', 'critical']), catchUpError: true }).risk.hint, '1 critical vulnerability signal(s) · Incomplete: Event history');
  assert.equal(sum({ ...GUARDED, intelligence: verifiedCritical }, { catchUpError: true }).risk.hint, 'Force push · history rewritten · Incomplete: Event history');
  assert.equal(sum({ ...GUARDED, access: { risk: { score: 34 } } }, { catchUpError: true }).risk.hint, 'Incomplete sources: Event history');
  assert.deepEqual(sum(null).risk, { text: 'Incomplete', level: 'warning', hint: 'Incomplete sources: Map data', score: 28 });

  /* Recovery: verified, local, unverified, unreadable, or a gap. */
  assert.deepEqual(sum({ storedSnapshot: { capturedAt: ago(2 * DAY) } }).recovery, { text: 'Captured', level: 'good', hint: 'Local snapshot 2d ago' });
  assert.deepEqual(sum({ signedSnapshots: { snapshots: [{ signatureValid: false, createdAt: ago(HOUR) }] } }).recovery, { text: 'Unverified', level: 'warning', hint: 'Retained snapshot signature could not be verified' });
  assert.deepEqual(sum({ signedSnapshots: { snapshots: [{ createdAt: ago(HOUR) }] }, storedSnapshot: { capturedAt: ago(HOUR) } }).recovery,
    { text: 'Unverified', level: 'warning', hint: 'Retained snapshot signature could not be verified' }, 'an unverified signature outranks a local copy');
  assert.deepEqual(sum({ signedSnapshots: { available: false } }).recovery, { text: 'Unknown', level: 'warning', hint: 'Recovery evidence could not be read' });
  assert.deepEqual(sum({ signedSnapshots: { available: false }, storedSnapshot: { capturedAt: ago(MIN) } }).recovery, { text: 'Captured', level: 'good', hint: 'Local snapshot 1m ago' });
  assert.deepEqual(sum({ signedSnapshots: { snapshots: [] } }).recovery, { text: 'Gap', level: 'warning', hint: 'Capture refs before an incident' });
  assert.equal(sum({ signedSnapshots: { snapshots: [{ signatureValid: false }] } }).risk.score, 28, 'an unverified snapshot is no snapshot to the risk');
  assert.equal(sum({ storedSnapshot: {} }).risk.score, 19, 'a local copy is one');

  /* The emergency containment is read-only and frozen sync together. */
  assert.equal(sum({ safety: { readOnly: true, freezeSync: true } }).emergency, true);
  assert.equal(sum({ safety: { readOnly: true } }).emergency, false);
  assert.equal(sum({ safety: { freezeSync: true } }).emergency, false);
  assert.equal(sum({ safety: { readOnly: true } }).readOnlyLabel, 'Disable read-only');

  /* The live control. */
  assert.deepEqual(sum({ live: { available: true, connected: false } }).live, { disabled: false, label: 'Connect verified live events', short: 'Live events', title: '' });
  assert.deepEqual(sum({ live: { available: true, connected: true } }).live, { disabled: false, label: 'Disconnect verified live events', short: 'Disconnect', title: '' });
  assert.deepEqual(sum({ live: { available: false, reason: 'Neon is not configured' } }).live.title, 'Neon is not configured');
  assert.deepEqual(sum({ live: { available: false, reason: '' } }).live.title, 'Neon and GitHub are required');

  /* Readings that are not the shape promised say nothing, rather than stopping the summary. */
  const odd = sum({ actions: 'x', refs: 5, sessions: [], intelligence: { events: {} }, access: 'high', signedSnapshots: { snapshots: 'x' }, safety: 'on', live: 1 });
  assert.equal(odd.risk.score, 28);
  assert.equal(odd.protectedCount, '0');
}

/* ---- The stream's state ------------------------------------------------------------------- */
{
  const at = (state = {}) => streamLabel({ paused: false, catchUpError: false, data: {}, liveStatus: 'disconnected', ...state });
  assert.equal(at({ paused: true, catchUpError: true, liveStatus: 'live' }), 'PAUSED');
  assert.equal(at({ catchUpError: true, liveStatus: 'live' }), 'EVENT HISTORY UNAVAILABLE');
  assert.equal(at({ data: { intelligence: { hasMore: true } }, liveStatus: 'live' }), 'LIVE CATCHING UP');
  assert.equal(at({ liveStatus: 'live' }), 'VERIFIED LIVE');
  assert.equal(at({ liveStatus: 'connecting' }), 'LIVE CONNECTING');
  assert.equal(at({ liveStatus: 'reconnecting' }), 'LIVE RECONNECTING');
  assert.equal(at(), 'POLLING TOPOLOGY');
  assert.equal(at({ data: { exposure: { partial: true } } }), 'PARTIAL TOPOLOGY');
  assert.equal(at({ data: null }), 'PARTIAL TOPOLOGY');
}

/* ---- The history under the stage --------------------------------------------------------------- */
{
  assert.equal(timelineIndex(4, 0, false), -1, 'no events, nowhere');
  assert.equal(timelineIndex(-1, 0, true), -1);
  assert.equal(timelineIndex(2, 10, false), 2);
  assert.equal(timelineIndex(2, 10, true), 9, 'to the latest');
  assert.equal(timelineIndex(-1, 10, false), 0, 'within the events');
  assert.equal(timelineIndex(40, 10, false), 9);
  assert.equal(timelineCaption(undefined, NOW), 'No activity events available');
  assert.equal(timelineCaption({ label: 'Pushed to main', type: 'push', time: ago(2 * MIN), nodeId: 'x' }, NOW), 'Pushed to main · 2m ago');
  assert.equal(timelineCaption({ label: 42, type: 'push', time: '', nodeId: 'x' }, NOW), '42 · unknown time');

  const events = Array.from({ length: 10 }, (_, i) => ({ label: `e${i}`, type: i % 2 ? 'push' : 'commit', time: ago((10 - i) * MIN), nodeId: `n${i}` }));
  const indices = (index, list = events) => eventStrip(list, index, NOW).map(c => c.index);
  assert.deepEqual(indices(0), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(indices(3), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(indices(4), [1, 2, 3, 4, 5, 6], 'three before the one pointed at');
  assert.deepEqual(indices(7), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(indices(9), [4, 5, 6, 7, 8, 9], 'never past the end');
  assert.deepEqual(indices(-1), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(indices(2, events.slice(0, 4)), [0, 1, 2, 3], 'fewer than six, all of them');
  assert.deepEqual(eventStrip([], -1, NOW), []);
  assert.deepEqual(eventStrip(events, 5, NOW)[3], { index: 5, label: 'e5', detail: 'push · 5m ago', active: true });
  assert.deepEqual(eventStrip(events, 5, NOW).filter(c => c.active).map(c => c.index), [5], 'one card is the one pointed at');
  assert.deepEqual(eventStrip([{ label: null, type: 'alert', time: 'soon', nodeId: '' }], 0, NOW), [{ index: 0, label: 'null', detail: 'alert · soon', active: true }]);
}

/* ---- The groups list --------------------------------------------------------------------- */
{
  const node = (type, severity = 'normal', inScope = true) => ({ type, severity, inScope });
  const input = extra => ({ nodes: [], panels: [], expanded: new Set(), hidden: new Set(), focusGroup: null, totals: {}, moved: false, ...extra });
  assert.deepEqual(legendModel(input()), { tools: [], categories: [], focusGroup: null, empty: true });
  assert.equal(legendModel(input({ nodes: [node('repo'), node('branch', 'normal', false)] })).empty, true, 'the hub and what is out of scope are no groups');

  const nodes = [node('repo'), node('branch'), node('branch', 'critical'), node('branch', 'warning'), node('branch', 'warning'), node('commit'), node('leak', 'critical'),
    node('workflow', 'warning'), node('snapshot'), node('mystery'), node('commit', 'critical', false)];
  const legend = legendModel(input({ nodes, focusGroup: 'branch', totals: { branch: 40, commit: 1, leak: 0, mystery: 9 } }));
  assert.equal(legend.empty, false);
  assert.deepEqual(legend.categories.map(c => [c.name, c.rows.map(r => r.type)]), [
    ['Access', ['leak']], ['Code', ['branch', 'commit']], ['Delivery', ['workflow']], ['Protection', ['snapshot']], ['Other', ['mystery']]
  ], 'by what each is about, in the categories\' order, and nothing for a category with nothing in scope');
  const row = type => legend.categories.flatMap(c => c.rows).find(r => r.type === type);
  assert.deepEqual(row('branch'), { type: 'branch', color: TYPE_STYLE.branch.color, name: TYPE_STYLE.branch.plural, plural: TYPE_STYLE.branch.plural, count: 4, total: 40, critical: 1, warning: 2, hidden: false, on: true });
  assert.equal(row('commit').count, 1, 'what is out of scope is not counted');
  assert.equal(row('commit').total, null, 'a total no larger than the count is not said');
  assert.equal(row('leak').name, 'Leaked keys', 'the short name where there is one');
  assert.equal(row('leak').plural, 'Leaked credentials');
  assert.deepEqual([row('mystery').color, row('mystery').plural, row('mystery').total], [TYPE_STYLE.repo.color, TYPE_STYLE.repo.plural, 9], 'a type the map does not know is drawn as the hub');
  assert.equal(legend.focusGroup, 'branch');
  assert.deepEqual(legend.categories.flatMap(c => c.rows).filter(r => r.on).map(r => r.type), ['branch']);
  assert.equal(legendModel(input({ nodes, focusGroup: 'tag' })).focusGroup, null, 'a lit group that has left the graph is let go');
  assert.equal(legendModel(input({ nodes, focusGroup: 'branch', hidden: new Set(['branch']) })).focusGroup, null, 'as is one that was hidden');
  assert.equal(legendModel(input({ nodes, totals: Object.create({ branch: 99 }) })).categories[1].rows[0].total, null, 'a total is the readings\' own');
  assert.equal(legendModel(input({ nodes, totals: { branch: '99' } })).categories[1].rows[0].total, null, 'and a number');

  const many = Array(7).fill(null);
  const tools = extra => legendModel(input({ nodes, ...extra })).tools;
  assert.deepEqual(tools({ panels: [{ type: 'branch', members: Array(6).fill(null) }] }), [], 'nothing to fold where every group fits');
  assert.deepEqual(tools({ panels: [{ type: 'branch', members: many }, { type: 'commit', members: many }], expanded: new Set(['branch']) }), [{ action: 'open', label: 'Open all' }]);
  assert.deepEqual(tools({ panels: [{ type: 'branch', members: many }, { type: 'commit', members: [] }], expanded: new Set(['branch']) }), [{ action: 'fold', label: 'Fold all' }]);
  assert.deepEqual(tools({ hidden: new Set(['branch', 'leak', 'tag']) }), [{ action: 'show', label: 'Show all (2 hidden)' }], 'only the hidden groups in the graph');
  assert.deepEqual(tools({ moved: true }), [{ action: 'reset-layout', label: 'Reset layout' }]);
  assert.deepEqual(tools({ panels: [{ type: 'branch', members: many }], hidden: new Set(['commit']), moved: true }).map(t => t.action), ['open', 'show', 'reset-layout']);
  assert.deepEqual(legendModel(input({ nodes, hidden: new Set(['commit']) })).categories[1].rows.map(r => r.hidden), [false, true]);
  assert.ok(Object.isFrozen(GROUP_CATEGORIES));
}

/* ---- The card ----------------------------------------------------------------------------- */
{
  assert.equal(card.cardMode(719, false, 2000), 'sheet', 'a phone page');
  assert.equal(card.cardMode(719, true, 2000), 'float', 'unless the stage fills it');
  assert.equal(card.cardMode(720, false, card.CARD_WIDTH + 299), 'docked', 'a narrow stage');
  assert.equal(card.cardMode(720, false, card.CARD_WIDTH + 300), 'float');
  assert.equal(card.cardMode(500, true, 400), 'docked');

  assert.match(card.describe({ type: 'leak' }), /never stored or shown/);
  assert.equal(card.describe({ type: 'tag' }), 'Repository intelligence object correlated by the Neural Command Center.');
  assert.equal(card.describe({ type: 'constructor' }), 'Repository intelligence object correlated by the Neural Command Center.', 'a name every object inherits is no kind');

  assert.equal(card.factValue(true, NOW), 'Yes');
  assert.equal(card.factValue(false, NOW), 'No');
  assert.equal(card.factValue(0, NOW), '0');
  assert.equal(card.factValue(ago(3 * HOUR), NOW), '3h ago');
  assert.equal(card.factValue('2026-13-45T00:00:00Z', NOW), '2026-13-45T00:00:00Z', 'a time that is no time is said as it came');
  assert.equal(card.factValue(`2026-13-45T00:00:00Z ${'z'.repeat(30)}`, NOW), `2026-13-45T00:00:00Z ${'z'.repeat(18)}…`, 'and cut like any text');
  assert.equal(card.factValue('2026-11-15 10:00', NOW), '2026-11-15 10:00', 'a time without its T is text');
  assert.equal(card.factValue('x'.repeat(41), NOW), `${'x'.repeat(39)}…`);
  assert.equal(card.factValue('x'.repeat(40), NOW), 'x'.repeat(40));
  assert.equal(card.factLabel('lastPushedAt'), 'last pushed at');
  assert.equal(card.factLabel('ip'), 'ip');

  const actions = (type, meta = {}, label = 'main', explaining = false) => card.cardActions({ type, label, meta }, explaining);
  const explain = { action: 'explain', label: 'Use for connection path' };
  assert.deepEqual(actions('protected', { path: 'deploy/key.yml' }), [{ action: 'open-file', label: 'Open protected file', path: 'deploy/key.yml' }, { action: 'safeguards', label: 'Open safeguards' }, explain]);
  assert.deepEqual(actions('protected'), [{ action: 'safeguards', label: 'Open safeguards' }, explain], 'no file to open without its path');
  assert.deepEqual(actions('branch', {}, 'feature/x'), [{ action: 'branch', label: 'Switch to this branch', branch: 'feature/x' }, explain]);
  assert.deepEqual(actions('commit'), [{ action: 'commits', label: 'Open commit history' }, explain]);
  assert.deepEqual(actions('pull'), [{ action: 'pulls', label: 'Open pull requests' }, explain]);
  assert.deepEqual(actions('issue'), [{ action: 'issues', label: 'Open issues' }, explain]);
  assert.deepEqual(actions('workflow', { url: 'https://example.test/run/1' }), [{ action: 'actions', label: 'Open workflow runs' }, { action: 'external-url', label: 'Open on provider', url: 'https://example.test/run/1' }, explain]);
  assert.deepEqual(actions('workflow'), [{ action: 'actions', label: 'Open workflow runs' }, explain]);
  for (const type of ['package', 'vulnerability', 'scan']) assert.deepEqual(actions(type), [{ action: 'security-scan', label: 'Run full dependency scan' }, explain]);
  assert.deepEqual(actions('snapshot').map(a => a.action), ['snapshot', 'recovery-preview', 'recovery', 'explain']);
  assert.deepEqual(actions('snapshot').map(a => a.label), ['Capture fresh references', 'Preview recovery impact', 'Open recovery workflow', 'Use for connection path']);
  for (const type of ['safety', 'repo']) assert.deepEqual(actions(type), [{ action: 'safeguards', label: 'Open safeguards' }, explain]);
  assert.deepEqual(actions('leak'), [{ action: 'exposure', label: 'Open in Exposure' }, explain]);
  for (const type of ['session', 'user']) assert.deepEqual(actions(type), [{ action: 'revoke', label: 'Revoke other sessions' }, explain]);
  assert.deepEqual(actions('tag', {}, 'v1', true), [{ action: 'explain', label: 'Explain from selected start' }]);

  /* What the card says about a node and what it is connected to. */
  const map = new Map();
  const hub = addNode(map, 'repo:current', 'repo', 'acme/widget', { description: 'The repository.', branch: 'main', isProtected: true, lastPushedAt: ago(2 * HOUR), url: 'https://x', summary: 's', nested: { a: 1 }, empty: '', none: null, count: 0, extra1: 'a', extra2: 'b', extra3: 'c' });
  const edges = [];
  const names = ['delta', 'alpha', 'charlie', 'bravo', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  names.forEach((name, i) => {
    addNode(map, `branch:${name}`, 'branch', name);
    addEdge(edges, i % 2 ? `branch:${name}` : 'repo:current', i % 2 ? 'repo:current' : `branch:${name}`, `rel ${name}`, name === 'charlie' ? 'critical' : name === 'india' ? 'warning' : 'normal');
  });
  addNode(map, 'branch:hidden', 'branch', 'aardvark');
  addEdge(edges, 'repo:current', 'branch:hidden', 'rel hidden');
  addEdge(edges, 'repo:current', 'gone:1', 'rel gone');
  addEdge(edges, 'branch:alpha', 'branch:bravo', 'not mine');
  for (const e of edges) e.visible = e.target !== 'branch:hidden';
  const nodeById = id => map.get(id);
  const model = card.cardModel({ node: hub, edges, nodeById, explaining: false, now: NOW });
  assert.equal(model.type, 'repo');
  assert.equal(model.mark, 'star');
  assert.equal(model.glyph, '');
  assert.equal(model.color, TYPE_STYLE.repo.color);
  assert.equal(model.kicker, 'Repository');
  assert.equal(model.title, 'acme/widget');
  assert.equal(model.severity, 'normal');
  assert.equal(model.status, 'Normal');
  assert.equal(model.description, 'The repository.');
  assert.deepEqual(model.facts, [['branch', 'main'], ['is protected', 'Yes'], ['last pushed at', '2h ago'], ['count', '0'], ['extra1', 'a'], ['extra2', 'b']],
    'six facts at most; not its prose, its link, a table, or what is empty');
  assert.equal(model.connected, 10, 'the relations drawn in this mode whose other end is in the graph');
  assert.deepEqual(model.links.map(l => l.label), ['charlie', 'india', 'alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'golf'], 'the most severe first, then by name, eight of them');
  assert.equal(model.more, 2);
  assert.deepEqual(model.links[0], { id: 'branch:charlie', type: 'branch', color: TYPE_STYLE.branch.color, label: 'charlie', relation: 'rel charlie', severity: 'critical' });
  assert.deepEqual(model.actions, [{ action: 'safeguards', label: 'Open safeguards' }, explain]);

  const lone = addNode(map, 'tag:v1', 'tag', 'x'.repeat(50), {}, 'warning');
  const tagCard = card.cardModel({ node: lone, edges, nodeById, explaining: true, now: NOW });
  assert.deepEqual([tagCard.mark, tagCard.glyph, tagCard.status, tagCard.connected, tagCard.more, tagCard.links, tagCard.facts], [undefined, TYPE_STYLE.tag.glyph, 'Review recommended', 0, 0, [], []]);
  assert.equal(tagCard.description, card.describe({ type: 'tag' }));
  assert.deepEqual(tagCard.actions, [{ action: 'explain', label: 'Explain from selected start' }]);
  addNode(map, 'branch:long', 'branch', 'y'.repeat(40));
  addEdge(edges, 'tag:v1', 'branch:long', 'points at', 'warning');
  edges[edges.length - 1].visible = true;
  assert.equal(card.cardModel({ node: lone, edges, nodeById, explaining: true, now: NOW }).links[0].label, `${'y'.repeat(29)}…`, 'a linked name is cut to 30');
  const odd = { id: 'odd:1', type: 'odd', label: 'odd', meta: {}, color: '#fff', severity: 'critical' };
  const oddCard = card.cardModel({ node: odd, edges: [], nodeById, explaining: false, now: NOW });
  assert.deepEqual([oddCard.kicker, oddCard.status, oddCard.severity, oddCard.glyph], ['Repository', 'Critical signal', 'critical', '']);

  /* What a screen reader hears. The page draws a relation only when both its ends are drawn (applyFilters). */
  const drawn = edges.filter(e => e.target !== 'gone:1');
  assert.equal(card.announcement(hub, drawn), 'Repository: acme/widget. normal. 10 connections.');
  assert.equal(card.announcement({ id: 'branch:long', type: 'branch', label: 'b', severity: 'critical' }, drawn), 'Branch: b. critical signal. 1 connection.');
  assert.equal(card.announcement({ id: 'none', type: 'odd', label: 'o', severity: 'warning' }, drawn), 'Node: o. review recommended. 0 connections.');
  assert.equal(card.announcement({ id: 'branch:hidden', type: 'branch', label: 'h', severity: 'normal' }, drawn), 'Branch: h. normal. 0 connections.', 'only the relations drawn');

  /* Where a floating card stands. */
  const place = extra => card.cardPlacement({ width: 1280, height: 720, size: { w: 312, h: 260 }, at: { x: 400, y: 300 }, span: { left: 380, right: 420 }, insets: { left: 16, top: 64, bottom: 20 }, ...extra });
  assert.deepEqual(place(), { left: 436, top: 256, side: 'right' }, 'beside the node, level with it');
  assert.deepEqual(place({ span: { left: 600, right: 892 } }), { left: 908, top: 256, side: 'right' }, 'to the right while it fits, 60 clear of the edge');
  assert.deepEqual(place({ span: { left: 600, right: 893 } }), { left: 272, top: 256, side: 'left' }, 'else to the left');
  assert.deepEqual(place({ span: { left: 100, right: 1100 } }), { left: 12, top: 256, side: 'left' }, 'inside the stage');
  assert.deepEqual(place({ width: 300, span: { left: 100, right: 1100 } }), { left: 12, top: 256, side: 'left' }, 'and never off its left edge');
  assert.deepEqual(place({ at: { x: 400, y: 10 } }), { left: 436, top: 62, side: 'right' }, 'below what covers its top');
  assert.deepEqual(place({ at: { x: 400, y: 700 } }), { left: 436, top: 448, side: 'right' }, 'above its foot');
  assert.deepEqual(place({ height: 200, at: { x: 400, y: 700 } }), { left: 436, top: 62, side: 'right' }, 'its top kept where the stage is too short');

  /* The line to it. */
  const right = { left: 500, top: 100, side: 'right', w: 312, h: 260 };
  assert.deepEqual(card.leaderLine({ x: 400, y: 200 }, 10, right, { x: 450, y: 200 }), { from: { x: 450, y: 200 }, to: { x: 500, y: 200 } }, 'from the end of the row');
  assert.deepEqual(card.leaderLine({ x: 400, y: 200 }, 10, right, null), { from: { x: 413, y: 200 }, to: { x: 500, y: 200 } }, 'or from just outside the disc');
  assert.deepEqual(card.leaderLine({ x: 400, y: 0 }, 10, right, { x: 1, y: 2 }).to, { x: 500, y: 118 }, 'meeting the card within its height');
  assert.deepEqual(card.leaderLine({ x: 400, y: 900 }, 10, right, { x: 1, y: 2 }).to, { x: 500, y: 342 });
  assert.deepEqual(card.leaderLine({ x: 900, y: 200 }, 10, { ...right, side: 'left' }, null), { from: { x: 887, y: 200 }, to: { x: 812, y: 200 } }, 'to the near edge of a card on the left');
  const slant = card.leaderLine({ x: 400, y: 400 }, 7, right, null);
  assert.ok(Math.abs(Math.hypot(slant.from.x - 400, slant.from.y - 400) - 10) < 1e-9, 'leaving the disc toward the card');
  assert.ok(slant.from.x > 400 && slant.from.y < 400);
}

/* ---- The panels drawn ------------------------------------------------------------------------ */
const view = loadPageModule('apps/web/src/features/neural/NeuralPanels.tsx', {}, {});

/* Every element a panel draws, its components run, so a press can be put to each control. */
function controls(element) {
  const found = [];
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement(node)) return;
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    if (node.props.onClick) found.push(node.props);
    walk(node.props.children);
  };
  walk(element);
  return found;
}
function clean(html, label) {
  for (const word of ['undefined', 'NaN', '[object Object]', 'null']) assert(!html.includes(word), `${label}: says ${word}`);
}
{
  /* A type's icon, the hub's filled; nothing for a type without one. */
  assert.equal(renderToStaticMarkup(createElement(view.TypeIcon, { type: 'repo' })), `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="${TYPE_ICON.repo}"></path></svg>`);
  assert.equal(renderToStaticMarkup(createElement(view.TypeIcon, { type: 'branch' })), `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TYPE_ICON.branch}"></path></svg>`);
  assert.equal(renderToStaticMarkup(createElement(view.TypeIcon, { type: 'odd' })), '');
  assert.equal(renderToStaticMarkup(createElement(view.TypeIcon, { type: 'constructor' })), '');

  const base = {
    type: 'branch', mark: undefined, glyph: 'B', color: '#123456', kicker: 'Branch', title: 'main <x>', severity: 'warning', status: 'Review recommended',
    description: 'A branch.', facts: [['is protected', 'Yes'], ['last pushed at', '2h ago']], connected: 10,
    links: [{ id: 'commit:1', type: 'commit', color: '#abcdef', label: 'fix & test', relation: 'contains', severity: 'critical' },
      { id: 'workflow:1', type: 'workflow', color: '#fedcba', label: 'ci', relation: 'runs', severity: 'warning' },
      { id: 'odd:1', type: 'odd', color: '#000000', label: 'odd', relation: 'near', severity: 'normal' }],
    more: 2, actions: [{ action: 'branch', label: 'Switch to this branch', branch: 'main' }, { action: 'open-file', label: 'Open protected file', path: 'a/b' },
      { action: 'external-url', label: 'Open on provider', url: 'https://x/1' }, { action: 'explain', label: 'Use for connection path' }]
  };
  const pressed = [];
  const handlers = { onClose: () => pressed.push(['close']), onGoto: id => pressed.push(['goto', id]), onAction: action => pressed.push(['action', action]) };
  const html = renderToStaticMarkup(createElement(view.NeuralCard, { card: base, handlers }));
  clean(html, 'card');
  assert.ok(html.startsWith(`<header class="neural-card-head"><span class="neural-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TYPE_ICON.branch}"></path></svg></span>`), 'the kind\'s icon first');
  assert.ok(html.includes('<div class="neural-card-title"><span class="neural-card-kicker">Branch</span><h3 id="neuralCardTitle">main &lt;x&gt;</h3></div>'), 'its name, as text');
  assert.ok(html.includes('<button type="button" class="neural-card-close" data-neural-card-close="" aria-label="Close details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"></path></svg></button></header>'));
  assert.ok(html.includes('<span class="neural-card-status" data-severity="warning"><i aria-hidden="true"></i>Review recommended</span><p class="neural-card-copy">A branch.</p>'));
  assert.ok(html.includes('<dl class="neural-card-facts"><div><dt>is protected</dt><dd>Yes</dd></div><div><dt>last pushed at</dt><dd>2h ago</dd></div></dl>'));
  assert.ok(html.includes('<h4 class="neural-card-section">Connected <span>10</span></h4>'));
  assert.ok(html.includes(`<li><button type="button" data-neural-goto="commit:1" style="--node:#abcdef"><i aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TYPE_ICON.commit}"></path></svg></i><span><b>fix &amp; test</b><small>contains</small></span><em data-severity="critical" aria-label="critical"></em></button></li>`));
  assert.ok(html.includes('<em data-severity="warning" aria-label="warning"></em>'));
  assert.ok(html.includes('<li><button type="button" data-neural-goto="odd:1" style="--node:#000000"><i aria-hidden="true"></i><span><b>odd</b><small>near</small></span></button></li>'), 'no mark for a normal link, no icon for an unknown kind');
  assert.ok(html.includes('<p class="neural-card-more">2 more in the graph</p>'));
  assert.ok(html.endsWith('<div class="neural-card-actions"><button class="btn btn-ghost small" data-neural-action="branch" data-branch="main">Switch to this branch</button>'
    + '<button class="btn btn-ghost small" data-neural-action="open-file" data-path="a/b">Open protected file</button>'
    + '<button class="btn btn-ghost small" data-neural-action="external-url" data-url="https://x/1">Open on provider</button>'
    + '<button class="btn btn-ghost small" data-neural-action="explain">Use for connection path</button></div></div>'), 'each action carrying only what it needs');

  /* The kind's drawn mark, else its letter; no facts, no links. */
  const marked = renderToStaticMarkup(createElement(view.NeuralCard, { card: { ...base, type: 'snapshot2', mark: 'restore', facts: [], links: [], more: 0, connected: 0 }, handlers }));
  assert.ok(marked.includes(`<span class="neural-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MARK_PATHS.restore.paths[0]}"></path><path d="${MARK_PATHS.restore.paths[1]}"></path></svg></span>`));
  assert.ok(!marked.includes('neural-card-facts'), 'no list of facts without facts');
  assert.ok(marked.includes('<h4 class="neural-card-section">Connected <span>0</span></h4><p class="neural-card-more">Nothing connected in this mode.</p><div class="neural-card-actions">'));
  const both = renderToStaticMarkup(createElement(view.NeuralCard, { card: { ...base, type: 'snapshot', mark: 'shield' }, handlers }));
  assert.ok(both.includes(`<span class="neural-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TYPE_ICON.snapshot}"></path></svg></span>`), 'the icon before the mark');
  assert.ok(!both.includes(MARK_PATHS.shield.paths[0]));
  const star = renderToStaticMarkup(createElement(view.NeuralCard, { card: { ...base, type: 'odd', mark: 'star' }, handlers }));
  assert.ok(star.includes(`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="${MARK_PATHS.star.paths[0]}"></path></svg>`), 'a filled mark filled');
  const lettered = renderToStaticMarkup(createElement(view.NeuralCard, { card: { ...base, type: 'odd', links: base.links.slice(0, 1), more: 0 }, handlers }));
  assert.ok(lettered.includes('<span class="neural-card-icon" aria-hidden="true">B</span>'));
  assert.ok(!lettered.includes('more in the graph'), 'no word of more where there are none');

  /* Each control answers through its handler. */
  const cardControls = controls(createElement(view.NeuralCard, { card: base, handlers }));
  assert.equal(cardControls.length, 1 + 3 + 4);
  for (const control of cardControls) control.onClick();
  assert.deepEqual(pressed, [['close'], ['goto', 'commit:1'], ['goto', 'workflow:1'], ['goto', 'odd:1'], ...base.actions.map(a => ['action', a])]);
}
{
  const legend = legendModel({
    nodes: [{ type: 'branch', severity: 'critical', inScope: true }, { type: 'branch', severity: 'warning', inScope: true }, { type: 'leak', severity: 'normal', inScope: true }, { type: 'mystery', severity: 'normal', inScope: true },
      { type: 'commit', severity: 'critical', inScope: true }, { type: 'workflow', severity: 'warning', inScope: true }],
    panels: [{ type: 'branch', members: Array(7).fill(null) }], expanded: new Set(), hidden: new Set(['leak']), focusGroup: 'branch', totals: { branch: 12 }, moved: true
  });
  const pressed = [];
  const handlers = { onTool: a => pressed.push(['tool', a]), onToggle: t => pressed.push(['toggle', t]), onGroup: t => pressed.push(['group', t]) };
  const html = renderToStaticMarkup(createElement(view.NeuralLegend, { legend, handlers }));
  clean(html, 'legend');
  assert.ok(html.startsWith('<div class="neural-groups-tools"><button type="button" class="neural-groups-tool" data-neural-groups="open">Open all</button>'
    + '<button type="button" class="neural-groups-tool" data-neural-groups="show">Show all (1 hidden)</button>'
    + '<button type="button" class="neural-groups-tool" data-neural-groups="reset-layout">Reset layout</button></div>'));
  assert.ok(html.includes('<section class="neural-group-cat" aria-label="Access"><h4>Access</h4><div class="neural-group-row is-hidden" style="--node:#ff8a5c">'
    + '<button type="button" class="neural-chip" data-neural-group="leak" aria-pressed="false" aria-disabled="true"><span class="ng-icon" aria-hidden="true">'));
  assert.ok(html.includes('<span class="ng-name" title="Leaked credentials">Leaked keys</span><b>1</b></button>'
    + '<button type="button" class="neural-eye" data-neural-toggle="leak" aria-pressed="false" aria-label="Show leaked credentials" title="Show leaked credentials">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16'), 'a hidden group: its eye shut, offering to show it');
  assert.ok(html.includes(`<div class="neural-group-row" style="--node:${TYPE_STYLE.branch.color}"><button type="button" class="neural-chip is-on" data-neural-group="branch" aria-pressed="true">`), 'the lit group pressed');
  assert.ok(html.includes('<i class="ng-pip is-critical" title="1 critical">1</i><i class="ng-pip is-warning" title="1 to review">1</i><b>2</b><small>of 12</small></button>'));
  assert.ok(html.includes('aria-pressed="true" aria-label="Hide branches" title="Hide branches"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5'), 'a shown group: its eye open, offering to hide it');
  assert.ok(html.endsWith('</section>') && html.includes('<section class="neural-group-cat" aria-label="Other"><h4>Other</h4>'));
  assert.ok(html.includes('data-neural-group="commit" aria-pressed="false"><span class="ng-icon" aria-hidden="true">') && /data-neural-group="commit"[^]*?<i class="ng-pip is-critical" title="1 critical">1<\/i><b>1<\/b><\/button>/.test(html), 'a critical pip alone');
  assert.ok(/data-neural-group="workflow"[^]*?<\/span><i class="ng-pip is-warning" title="1 to review">1<\/i><b>1<\/b><\/button>/.test(html), 'a warning pip alone');
  assert.equal(renderToStaticMarkup(createElement(view.NeuralLegend, { legend: { tools: [], categories: [], focusGroup: null, empty: true }, handlers })), '', 'nothing in scope, nothing drawn');

  for (const control of controls(createElement(view.NeuralLegend, { legend, handlers }))) control.onClick();
  assert.deepEqual(pressed, [['tool', 'open'], ['tool', 'show'], ['tool', 'reset-layout'], ['group', 'leak'], ['toggle', 'leak'], ['group', 'branch'], ['toggle', 'branch'],
    ['group', 'commit'], ['toggle', 'commit'], ['group', 'workflow'], ['toggle', 'workflow'], ['group', 'mystery'], ['toggle', 'mystery']]);
}
{
  const picked = [];
  assert.equal(renderToStaticMarkup(createElement(view.NeuralEvents, { cards: [], onPick: i => picked.push(i) })), '<div class="neural-event-card"><b>No events</b><small>Refresh or use demo mode</small></div>');
  const cards = [{ index: 4, label: 'Push <main>', detail: 'push · 2m ago', active: false }, { index: 5, label: 'CI', detail: 'workflow · 1m ago', active: true }];
  assert.equal(renderToStaticMarkup(createElement(view.NeuralEvents, { cards, onPick: i => picked.push(i) })),
    '<button class="neural-event-card " data-event-index="4"><b>Push &lt;main&gt;</b><small>push · 2m ago</small></button>'
    + '<button class="neural-event-card active" data-event-index="5"><b>CI</b><small>workflow · 1m ago</small></button>');
  for (const control of controls(createElement(view.NeuralEvents, { cards, onPick: i => picked.push(i) }))) control.onClick();
  assert.deepEqual(picked, [4, 5]);
}

console.log('neural graph panels: ok');
