'use strict';

/*
 * The findings inbox, decided before it is drawn: filters read from and
 * written to the address, views and facets counted from what the server
 * sent, and a store that did not answer kept apart from an empty inbox.
 */

const assert = require('assert');
const ui = require('../public/findings-inbox-ui');

const item = (key, overrides = {}) => ({
  key, source: 'audit', id: key, owner: 'Acme', repo: 'Shop', ref: 'main', rule: 'SEC-011', title: `Title ${key}`,
  kind: 'code', severity: 'serious', state: 'open', path: `src/${key}.js`, line: 3, package: null, cves: [],
  exploited: false, firstSeenAt: '2026-09-01T00:00:00.000Z', ageDays: 40, timesFixed: 0, regressedAfter: null,
  decision: null, historyOnly: false, ...overrides
});
const inbox = {
  available: true,
  sources: { audit: 'measured', exposure: 'measured' },
  truncated: false,
  vocabulary: { dispositions: [], reasons: [], acceptDays: { min: 7, max: 365, choices: [30, 90, 180], default: 90 } },
  findings: [
    item('a', { severity: 'critical', state: 'new', ageDays: 2 }),
    item('b', { state: 'regressed', timesFixed: 1, regressedAfter: '2026-08-20T00:00:00.000Z' }),
    item('c', { kind: 'dependencies', package: { name: 'jquery', version: '3.4.1', fixed: '3.5.0' }, cves: ['CVE-2020-11023'] }),
    item('d', { source: 'exposure', owner: 'Acme', repo: 'Api', title: null, rule: 'github-token', kind: 'leaked-credentials', severity: 'critical', historyOnly: true }),
    item('e', { state: 'accepted-risk', decision: { disposition: 'accepted-risk', reason: 'low-impact', expiresAt: '2026-12-01T00:00:00.000Z' } })
  ]
};
const labelOf = entry => (entry.rule === 'github-token' ? 'GitHub token' : entry.rule);

/* Filters round-trip through the address, and nonsense is dropped. */
{
  assert.deepStrictEqual(ui.parseFilters(''), { severities: [], view: 'open', kind: '', repo: '', q: '', pages: 1 });
  const filters = ui.parseFilters('?view=decided&severity=critical,bogus,critical&kind=code&repo=Acme/Shop&q=jquery&pages=3');
  assert.deepStrictEqual(filters, { severities: ['critical'], view: 'decided', kind: 'code', repo: 'Acme/Shop', q: 'jquery', pages: 3 });
  assert.strictEqual(ui.serializeFilters(filters), '?view=decided&severity=critical&kind=code&repo=Acme%2FShop&q=jquery&pages=3');
  assert.deepStrictEqual(ui.parseFilters(ui.serializeFilters(filters)), filters);
  assert.strictEqual(ui.serializeFilters(ui.parseFilters('')), '', 'the default view writes nothing to the address');
  const hostile = ui.parseFilters('?view=<script>&repo=../../etc&kind=Drop Table&pages=9999');
  assert.deepStrictEqual([hostile.view, hostile.repo, hostile.kind, hostile.pages], ['open', '', '', 40]);
}

/* Views, facets and the list. */
{
  const view = ui.model(inbox, ui.parseFilters(''), { labelOf, ownersOf: entry => (entry.repo === 'Shop' ? ['@acme/web'] : []) });
  assert.strictEqual(view.state, 'ready');
  assert.deepStrictEqual(view.views.map(entry => [entry.id, entry.count]), [['open', 4], ['regressed', 1], ['new', 1], ['decided', 1], ['all', 5]]);
  assert.deepStrictEqual(view.shown.map(entry => entry.key), ['a', 'b', 'c', 'd'], 'open work leaves decided findings out');
  assert.strictEqual(view.shown.find(entry => entry.key === 'd').label, 'GitHub token', 'an exposure finding is named as the findings screen names it');
  assert.deepStrictEqual(view.shown.find(entry => entry.key === 'a').owners, ['@acme/web']);
  assert.deepStrictEqual(view.severities.map(entry => [entry.id, entry.count]), [['critical', 2], ['serious', 2], ['warning', 0]],
    'facets count within the chosen view');
  assert.deepStrictEqual(view.repositories, [{ id: 'Acme/Shop', count: 3 }, { id: 'Acme/Api', count: 1 }]);
  assert.strictEqual(view.matching, 4);
  assert.strictEqual(view.more, 0);
}
{
  const view = ui.model(inbox, ui.parseFilters('?severity=critical&repo=acme/api'), { labelOf });
  assert.deepStrictEqual(view.shown.map(entry => entry.key), ['d'], 'severity and repository narrow together, whatever the case');
  assert.deepStrictEqual(ui.model(inbox, ui.parseFilters('?q=CVE-2020-11023'), { labelOf }).shown.map(entry => entry.key), ['c'], 'a CVE finds its package');
  assert.deepStrictEqual(ui.model(inbox, ui.parseFilters('?q=github token'), { labelOf }).shown.map(entry => entry.key), ['d'], 'every word must match');
  assert.deepStrictEqual(ui.model(inbox, ui.parseFilters('?view=decided'), { labelOf }).shown.map(entry => entry.key), ['e']);
}

/* Pages of fifty. */
{
  const many = { ...inbox, findings: Array.from({ length: 120 }, (_, index) => item(`k${String(index).padStart(3, '0')}`)) };
  const first = ui.model(many, ui.parseFilters(''), { labelOf });
  assert.deepStrictEqual([first.shown.length, first.more], [ui.PAGE, 120 - ui.PAGE]);
  const third = ui.model(many, ui.parseFilters('?pages=3'), { labelOf });
  assert.deepStrictEqual([third.shown.length, third.more], [120, 0]);
}

/* The record of a finding, oldest first. */
{
  assert.deepStrictEqual(ui.timelineEvents(inbox.findings[1]).map(event => event.text), ['Fixed', 'Seen again after the fix'],
    'a finding that came back: fixed, then seen again -- its clock restarted at the second sighting');
  assert.deepStrictEqual(ui.timelineEvents(inbox.findings[2]).map(event => event.text), ['First seen by an audit of main']);
  assert.deepStrictEqual(ui.timelineEvents(inbox.findings[3]).map(event => event.text), ['First found by an exposure scan']);
  assert.deepStrictEqual(ui.timelineEvents({ ...inbox.findings[1], timesFixed: 3 })[0].text, 'Fixed 3 times, most recently here');
  const decided = ui.timelineEvents(inbox.findings[4]);
  assert.ok(decided.some(event => /^Risk accepted until .+ — low impact$/.test(event.text)));
}

/* Unread, empty and unanswered are three different things. */
{
  assert.deepStrictEqual(ui.model(null, ui.parseFilters('')), { state: 'loading' });
  assert.match(ui.model({ available: false, reason: 'not-configured' }, ui.parseFilters('')).reason, /has none/);
  assert.strictEqual(ui.model({ ...inbox, findings: [] }, ui.parseFilters('')).state, 'empty');
  assert.strictEqual(ui.model({ ...inbox, findings: [], sources: { audit: 'unavailable', exposure: 'unavailable' } }, ui.parseFilters('')).state, 'unmeasured');
  const truncated = ui.model({ ...inbox, truncated: true, sources: { audit: 'measured', exposure: 'unavailable' } }, ui.parseFilters(''), { labelOf });
  assert.ok(truncated.notes.some(note => /more findings than one list holds/.test(note)));
  assert.ok(truncated.notes.some(note => /Exposure scans could not be read/.test(note)));
}

console.log('findings inbox client tests passed');
