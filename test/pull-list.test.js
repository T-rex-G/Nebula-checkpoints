'use strict';

/*
 * One open pull request as the list route answers it (src/pull-list.js).
 * The workbench's fields keep their names and meaning; the board's three
 * come from the list itself, read defensively, and nothing beyond them --
 * no body, no reviewer identity -- leaves the route.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pullListItem, MAX_LABELS, MAX_LABEL_LENGTH } = require('../src/pull-list');

/* A list entry in the shape GitHub documents for GET /repos/{owner}/{repo}/pulls. */
const listed = {
  number: 42,
  title: 'Pin the release workflow',
  state: 'open',
  draft: false,
  merged_at: null,
  body: 'A body the list route must not pass on.',
  user: { login: 'maya', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  head: { ref: 'feature/pin', sha: 'a'.repeat(40) },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  created_at: '2026-10-01T09:30:00Z',
  updated_at: '2026-10-09T12:00:00Z',
  requested_reviewers: [{ login: 'jon' }, { login: 'ana' }],
  requested_teams: [{ slug: 'security' }],
  labels: [{ name: 'security', color: 'd73a4a' }, { name: 'ci' }, { name: 'security' }, { name: '  ' }]
};

const item = pullListItem(listed);
assert.deepStrictEqual(item, {
  number: 42,
  title: 'Pin the release workflow',
  state: 'open',
  draft: false,
  merged: false,
  user: 'maya',
  avatar: 'https://avatars.githubusercontent.com/u/1',
  head: 'feature/pin',
  base: 'main',
  updated_at: '2026-10-09T12:00:00Z',
  created_at: '2026-10-01T09:30:00.000Z',
  reviewers: 3,
  labels: ['security', 'ci']
});
assert(!('body' in item), 'the list never carries a pull request body');
assert(!JSON.stringify(item).includes('jon'), 'who was asked to review is counted, not named');

/* A merged entry and a draft keep the workbench's meaning. */
assert.strictEqual(pullListItem({ ...listed, merged_at: '2026-10-10T00:00:00Z' }).merged, true);
assert.strictEqual(pullListItem({ ...listed, draft: true }).draft, true);
assert.strictEqual(pullListItem({ ...listed, draft: 'yes' }).draft, false, 'only a real true is a draft');

/* Missing or malformed fields read as nothing, never as a throw. */
const bare = pullListItem({ number: 7, title: 'fixture', state: 'open', head: { ref: 'x' }, base: { ref: 'main' } });
assert.strictEqual(bare.reviewers, 0);
assert.deepStrictEqual(bare.labels, []);
assert.strictEqual(bare.created_at, null);
assert.strictEqual(bare.user, undefined);
assert.doesNotThrow(() => pullListItem(null));
assert.doesNotThrow(() => pullListItem({ number: 1 }));
assert.strictEqual(pullListItem({ number: 1, created_at: 'not a date' }).created_at, null);
assert.strictEqual(pullListItem({ number: 1, requested_reviewers: 'many', requested_teams: [null, 3, { slug: 'a' }] }).reviewers, 1);

/* Labels are bounded in number and length. */
const many = pullListItem({ number: 2, labels: Array.from({ length: 20 }, (_, i) => ({ name: `label-${i}-${'x'.repeat(80)}` })) });
assert.strictEqual(many.labels.length, MAX_LABELS);
assert(many.labels.every(name => name.length <= MAX_LABEL_LENGTH));

/* The route answers through this function, so the board and the workbench read one shape. */
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = server.slice(server.indexOf("app.get('/api/repo/:owner/:repo/pulls',"), server.indexOf("app.get('/api/repo/:owner/:repo/pulls/:num',"));
assert(route.includes('res.json(pulls.map(pullListItem))'), 'the list route maps through pullListItem');
assert(/capabilityAccess\('pulls\.read'\)/.test(route), 'the list route stays behind pulls.read');
assert(/alphaRepositoryAccess/.test(route), 'the list route stays inside the repository scope');
/* The board reads a full page as "at least this many": its page size is the route's. */
const page = route.match(/per_page=(\d+)/);
assert(page, 'the list route names its page size');
assert.strictEqual(Number(page[1]), require('../public/pull-board').LIST_PAGE, 'the board and the list route disagree about one page');

console.log('pull list tests passed');
