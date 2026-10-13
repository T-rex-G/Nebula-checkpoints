'use strict';

/*
 * The Overview's posture card, decided before it is drawn. The server says
 * what the stores hold; this module adds the one thing only the browser
 * knows -- which repositories in the inventory neither system has read -- and
 * chooses between a reading, an empty workspace and an unanswered one, which
 * must never look alike.
 */

const assert = require('assert');
const posture = require('../public/security-posture');

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
  assert.match(posture.model({ available: false, reason: 'not-configured' }, repos).reason, /has none/);
  assert.match(posture.model({ available: false, reason: 'database-unavailable' }, repos).reason, /did not answer/);
  assert.match(posture.model({ available: false, reason: 'offline' }, repos).reason, /offline/);
  assert.match(posture.model({ available: false, reason: 'unreadable' }, repos).reason, /could not be read just now/);
}

console.log('security posture client tests passed');
