'use strict';

/*
 * The pull-request board's decisions (public/pull-board.js), without a
 * browser: which repositories are read and how many at once, which column a
 * pull request lands in and in what order, what the first line says, and
 * what the card admits about the repositories it could not read.
 */

const assert = require('assert');
const Board = require('../public/pull-board');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const daysAgo = days => new Date(NOW - days * 86400000).toISOString();
const repo = (name, pushedDaysAgo) => ({ full_name: `acme/${name}`, name, owner: 'acme', pushed_at: daysAgo(pushedDaysAgo) });
const pull = (number, fields = {}) => ({
  number, title: `Pull ${number}`, state: 'open', draft: false, user: 'maya', head: `f/${number}`, base: 'main',
  created_at: daysAgo(1), updated_at: daysAgo(0), reviewers: 0, labels: [], ...fields
});

(async () => {
  /* ---- Which repositories one reading asks ---------------------------- */
  const inventory = Array.from({ length: 15 }, (_, i) => repo(`r${i}`, i));
  inventory.push(repo('r0', 99)); // a duplicate never counts twice
  const picked = Board.pickRepositories(inventory);
  assert.strictEqual(picked.length, Board.REPOSITORY_LIMIT);
  assert.deepStrictEqual(picked.slice(0, 3).map(r => r.repo), ['r0', 'r1', 'r2'], 'most recently pushed first');
  assert.deepStrictEqual(Board.pickRepositories([{ full_name: 'a/b' }, null, { name: 'x' }]).map(r => r.key), ['a/b']);

  /* ---- A few at a time, and one failure is one repository's ------------ */
  let inflight = 0;
  let peak = 0;
  const asked = [];
  const results = await Board.readAll(picked, async (owner, name) => {
    asked.push(name);
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inflight -= 1;
    if (name === 'r1') throw Object.assign(new Error('outside'), { status: 403, code: 'ALPHA_REPOSITORY_NOT_ALLOWED' });
    if (name === 'r2') throw Object.assign(new Error('Failed to fetch'), { offline: true });
    if (name === 'r3') throw Object.assign(new Error('bad gateway'), { status: 502, code: 'PROVIDER_UNAVAILABLE' });
    if (name === 'r4') return { not: 'a list' };
    return name === 'r0' ? [pull(1)] : [];
  });
  assert.strictEqual(asked.length, Board.REPOSITORY_LIMIT, 'every picked repository is asked once');
  assert(peak <= Board.CONCURRENCY, `at most ${Board.CONCURRENCY} at once, saw ${peak}`);
  assert.deepStrictEqual(results.map(r => r.repo), picked.map(r => r.repo), 'results keep the asking order');
  assert.strictEqual(results[1].error, 'scope');
  assert.strictEqual(results[2].error, 'offline');
  assert.strictEqual(results[3].error, 'unreadable');
  assert.strictEqual(results[4].error, 'unreadable', 'an answer that is not a list is not a list of nothing');
  assert.deepStrictEqual(results[0].pulls.map(p => p.number), [1]);

  /* ---- States before and without a reading ----------------------------- */
  assert.strictEqual(Board.model({ results: null, repos: [], now: NOW }).state, 'no-repositories');
  const loading = Board.model({ results: null, repos: inventory, now: NOW });
  assert.deepStrictEqual([loading.state, loading.asked, loading.inventory], ['loading', 12, 15]);
  const refusedOnly = Board.model({ results: [{ owner: 'acme', repo: 'r0', error: 'scope' }], repos: [repo('r0', 0)], now: NOW });
  assert.deepStrictEqual([refusedOnly.state, refusedOnly.reason], ['unavailable', 'scope']);
  const offlineOnly = Board.model({ results: [{ owner: 'acme', repo: 'r0', error: 'offline' }], repos: [repo('r0', 0)], now: NOW });
  assert.deepStrictEqual([offlineOnly.state, offlineOnly.reason], ['unavailable', 'offline']);
  const empty = Board.model({ results: [{ owner: 'acme', repo: 'r0', pulls: [] }], repos: [repo('r0', 0)], now: NOW });
  assert.strictEqual(empty.state, 'empty', 'a repository that answered with nothing open is empty, not unavailable');
  assert.strictEqual(Board.sentence(empty), 'No open pull requests in the 1 repository read.');

  /* ---- Columns, order and the first line --------------------------------- */
  const view = Board.model({
    repos: [repo('web', 0), repo('api', 1), repo('docs', 2)],
    now: NOW,
    results: [
      { owner: 'acme', repo: 'web', pulls: [
        pull(10, { reviewers: 2, created_at: daysAgo(3) }),
        pull(11, { reviewers: 1, created_at: daysAgo(9) }),
        pull(12, { created_at: daysAgo(2) }),
        pull(13, { draft: true, updated_at: daysAgo(20), labels: ['a', 'b', 'c', 'd'] }),
        pull(14, { state: 'closed' })
      ] },
      { owner: 'acme', repo: 'api', pulls: [
        pull(20, { created_at: daysAgo(6) }),
        pull(21, { draft: true, reviewers: 3, updated_at: daysAgo(1) })
      ] },
      { owner: 'acme', repo: 'docs', error: 'unreadable' }
    ]
  });
  assert.strictEqual(view.state, 'ready');
  assert.deepStrictEqual(view.columns.map(c => c.id), ['review', 'unrequested', 'draft']);
  assert.deepStrictEqual(view.columns[0].items.map(i => i.number), [11, 10], 'waiting: longest waiting first');
  assert.deepStrictEqual(view.columns[1].items.map(i => i.number), [20, 12], 'nobody asked: oldest first');
  assert.deepStrictEqual(view.columns[2].items.map(i => i.number), [21, 13], 'drafts: most recently updated first, whatever was asked of them');
  assert.strictEqual(view.total, 6, 'a closed pull request in an open list is not counted');
  assert.strictEqual(view.repositories, 2);
  assert.strictEqual(view.idle, 1);
  assert.strictEqual(view.columns[2].items[1].idle, true);
  assert.strictEqual(view.columns[2].items[1].idleDays, 20);
  assert.strictEqual(Board.sentence(view), '6 open pull requests in 2 repositories: 2 waiting on review, the longest for 9 days.');
  assert.deepStrictEqual(Board.notes(view), ['1 repository could not be read just now: acme/docs.']);

  const quiet = Board.model({ repos: [repo('web', 0)], now: NOW, results: [{ owner: 'acme', repo: 'web', pulls: [pull(1)] }] });
  assert.strictEqual(Board.sentence(quiet), '1 open pull request in 1 repository; none waiting on a reviewer.');

  /* ---- What the card admits about coverage ------------------------------- */
  const partial = Board.model({
    repos: inventory,
    now: NOW,
    results: picked.map((r, i) => i === 0 ? { ...r, error: 'scope' } : i < 5 ? { ...r, error: 'unreadable' } : { ...r, pulls: [] })
  });
  assert.deepStrictEqual(Board.notes(partial), [
    'Read from the 12 most recently pushed of 15 repositories.',
    '1 repository is outside this session\'s repository scope: acme/r0.',
    '4 repositories could not be read just now: acme/r1, acme/r2, acme/r3 and 1 more.'
  ]);

  /* ---- A full page is not the whole list -------------------------------- */
  /*
   * The list route answers one page, the most recently updated first. A
   * repository that fills it may hold more, and the ones left out are the
   * least recently touched -- often the longest waiting. So the count is a
   * floor, the longest wait is the longest shown, and the card says which
   * repository was cut.
   */
  assert.strictEqual(Board.LIST_PAGE, 30, 'the board and the list route agree on one page');
  const busy = Array.from({ length: Board.LIST_PAGE }, (_, i) => pull(100 + i, { reviewers: 1, created_at: daysAgo(i + 1) }));
  const capped = Board.model({
    repos: [repo('web', 0), repo('api', 1)],
    now: NOW,
    results: [{ owner: 'acme', repo: 'web', pulls: busy }, { owner: 'acme', repo: 'api', pulls: [pull(7)] }]
  });
  assert.deepStrictEqual(capped.coverage.capped, ['acme/web']);
  assert.strictEqual(Board.sentence(capped), 'At least 31 open pull requests in 2 repositories: 30 waiting on review, the longest shown for 30 days.');
  assert.deepStrictEqual(Board.notes(capped), ['acme/web has more open pull requests than one list holds; these are its 30 most recently updated.']);
  const roomy = Board.model({ repos: [repo('web', 0)], now: NOW, results: [{ owner: 'acme', repo: 'web', pulls: busy.slice(1) }] });
  assert.deepStrictEqual(roomy.coverage.capped, []);
  assert(!/At least|shown/.test(Board.sentence(roomy)), 'a list shorter than a page is the whole list');

  /* A rate limit is not "could not be read just now": it says how long, and it is not offline. */
  const limitedRead = await Board.readAll([{ owner: 'acme', repo: 'a' }, { owner: 'acme', repo: 'b' }, { owner: 'acme', repo: 'c' }], async (owner, name) => {
    if (name === 'a') throw Object.assign(new Error('API rate limit exceeded'), { status: 429, code: 'PROVIDER_RATE_LIMITED', retryAfter: 42 });
    if (name === 'b') throw Object.assign(new Error('secondary'), { status: 429, code: 'PROVIDER_RATE_LIMITED', retryAfter: 90 });
    return [];
  });
  assert.deepStrictEqual(limitedRead.map(r => [r.error || 'read', r.retryAfter || 0]), [['limited', 42], ['limited', 90], ['read', 0]]);
  const someLimited = Board.model({ results: limitedRead, repos: [repo('a', 0), repo('b', 0), repo('c', 0)], now: NOW });
  assert.strictEqual(someLimited.state, 'empty');
  assert.deepStrictEqual(someLimited.coverage.unreadable, [], 'a limited repository is not counted as unreadable');
  assert.deepStrictEqual(someLimited.coverage.limited, ['acme/a', 'acme/b']);
  assert(Board.notes(someLimited).some(line => /GitHub is limiting requests/.test(line) && /acme\/a, acme\/b/.test(line) && /2 minutes/.test(line)),
    `the note says why and for how long, the longer wait: ${JSON.stringify(Board.notes(someLimited))}`);
  const allLimited = Board.model({ results: limitedRead.slice(0, 2), repos: [repo('a', 0), repo('b', 0)], now: NOW });
  assert.deepStrictEqual([allLimited.state, allLimited.reason], ['unavailable', 'limited']);
  assert.strictEqual(Board.waitPhrase(42), '42 seconds');
  assert.strictEqual(Board.waitPhrase(1), 'a second');
  assert.strictEqual(Board.waitPhrase(90), '2 minutes');
  assert.strictEqual(Board.waitPhrase(60), 'a minute');
  assert.strictEqual(Board.waitPhrase(0), 'a minute', 'a limit that named no wait is read again after a minute, as GitHub advises');
  assert.strictEqual(Board.waitPhrase(3600), 'an hour');

  console.log('pull board client tests passed');
})().catch(error => { console.error(error); process.exit(1); });
