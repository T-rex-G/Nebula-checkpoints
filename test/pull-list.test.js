'use strict';

/*
 * One open pull request as the list route answers it (the posture module's pull list).
 * The workbench's fields keep their names and meaning; the board's three
 * come from the list itself, read defensively, and nothing beyond them --
 * no body, no reviewer identity -- leaves the route.
 */

const assert = require('assert');
const express = require('express');
const { pullListItem, MAX_LABELS, MAX_LABEL_LENGTH } = require('../apps/api/src/modules/posture/index.ts');
const workbench = require('../apps/api/src/modules/workbench/index.ts');
const { LIST_PAGE } = require('../apps/web/src/features/posture/pull-board.ts');

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
/* Two labels that read the same once cut to length are one name on the board. */
const twins = pullListItem({ number: 3, labels: [{ name: `${'a'.repeat(MAX_LABEL_LENGTH)}-one` }, { name: `${'a'.repeat(MAX_LABEL_LENGTH)}-two` }, { name: 'b' }] });
assert.deepStrictEqual(twins.labels, ['a'.repeat(MAX_LABEL_LENGTH), 'b']);

/*
 * The list route answers through this function, so the board and the
 * workbench read one shape. It asks GitHub for one page of the board's size,
 * the most recently updated first, in the state asked for -- open unless
 * closed or all -- and only once the session, the repository scope and
 * pulls.read have each let the request through.
 */
(async () => {
  const ran = [];
  const asked = [];
  const guard = name => (req, res, next) => { ran.push(name); next(); };
  const app = express();
  workbench.registerCollaborationRoutes(app, {
    providerSessionAccess: guard('providerSessionAccess'),
    alphaRepositoryAccess: guard('alphaRepositoryAccess'),
    capabilityAccess: feature => guard(`capabilityAccess('${feature}')`),
    githubSearchAccess: guard('githubSearchAccess'),
    auth: guard('auth'),
    mutationContext: action => guard(`mutationContext('${action}')`),
    account: () => ({ provider: 'github', login: 'maya', token: 'tok' }),
    fail: (res, error) => res.status(error.status || 500).json({ error: error.message }),
    gh: async (account, apiPath) => { asked.push([account.login, apiPath]); return [listed, { ...listed, number: 43, merged_at: '2026-10-10T00:00:00Z' }, null]; },
    alphaRepositories: () => null,
    protectedPatternsForReq: () => [],
    enforceProtectedPaths: () => {}
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [query, state] of [['', 'open'], ['?state=closed', 'closed'], ['?state=all', 'all'], ['?state=merged', 'open']]) {
      ran.length = 0;
      asked.length = 0;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/repo/acme/demo/pulls${query}`);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(),
        JSON.parse(JSON.stringify([listed, { ...listed, number: 43, merged_at: '2026-10-10T00:00:00Z' }, null].map(pullListItem))));
      assert.deepStrictEqual(ran, ['providerSessionAccess', 'alphaRepositoryAccess', "capabilityAccess('pulls.read')", 'auth']);
      assert.strictEqual(asked.length, 1);
      const [login, apiPath] = asked[0];
      const url = new URL(apiPath, 'https://api.github.com');
      assert.deepStrictEqual([login, url.pathname], ['maya', '/repos/acme/demo/pulls']);
      assert.deepStrictEqual(Object.fromEntries(url.searchParams), { state, per_page: String(LIST_PAGE), sort: 'updated', direction: 'desc' },
        `one page of the board's size -- it reads a full page as "at least this many" -- newest first, in the state asked for (${query || 'no state'})`);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('pull list tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
