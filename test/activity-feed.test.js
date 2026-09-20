'use strict';

const assert = require('assert');
const { selectRepositories, feed, instant, MAX_REPOSITORIES, MAX_EVENTS } = require('../src/activity-feed');

let failures = 0;
function check(name, run) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error && error.message}`);
  }
}

const T = iso => Date.parse(iso);

/* ------------------------------------------------------------ timestamps */

check('an unreadable date is null rather than NaN', () => {
  assert.strictEqual(instant('not a date'), null);
  assert.strictEqual(instant(''), null);
  assert.strictEqual(instant(null), null);
  assert.strictEqual(instant(undefined), null);
  /*
   * The whole point. Date.parse returns NaN for junk, and NaN in a comparator
   * does not throw -- every comparison against it is false, so the entry lands
   * wherever the sort happens to leave it. An unorderable value has to be
   * caught here or it silently corrupts the order downstream.
   */
  assert.ok(!Number.isNaN(instant('not a date')));
  assert.strictEqual(instant('2026-09-20T10:00:00Z'), T('2026-09-20T10:00:00Z'));
});

/* ---------------------------------------------------------- the selection */

check('the most recently pushed repositories are asked first', () => {
  const picked = selectRepositories([
    { full_name: 'a/old', owner: 'a', name: 'old', pushed_at: '2026-01-01T00:00:00Z' },
    { full_name: 'a/new', owner: 'a', name: 'new', pushed_at: '2026-09-19T00:00:00Z' },
    { full_name: 'a/mid', owner: 'a', name: 'mid', pushed_at: '2026-05-01T00:00:00Z' }
  ]);
  assert.deepStrictEqual(picked.map(r => r.full_name), ['a/new', 'a/mid', 'a/old']);
});

check('a repository with no push time sorts last rather than first', () => {
  const picked = selectRepositories([
    { full_name: 'a/unknown', owner: 'a', name: 'unknown', pushed_at: null },
    { full_name: 'a/known', owner: 'a', name: 'known', pushed_at: '2026-01-01T00:00:00Z' }
  ]);
  assert.deepStrictEqual(picked.map(r => r.full_name), ['a/known', 'a/unknown']);
});

check('the ordering of unknowns is decided, not inherited from arithmetic', () => {
  /*
   * This is the one the obvious test misses.
   *
   * With the null branches deleted the comparator still gets this right, by
   * accident: `null - 1767225600000` coerces the null to zero, which is 1970,
   * which is old, which sorts last. Deleting them is therefore invisible --
   * the first version of this guard passed with them gone.
   *
   * What they actually buy is that the ordering never depends on that
   * coercion. Every pair of repositories must yield a finite comparison, and
   * an unknown must lose to a known in both directions regardless of the order
   * they arrived in. A comparator that returns NaN does not throw; it silently
   * leaves the list in whatever order the sort happened to walk.
   */
  const unknown = { full_name: 'a/unknown', owner: 'a', name: 'unknown', pushed_at: null };
  const known = { full_name: 'a/known', owner: 'a', name: 'known', pushed_at: '2026-01-01T00:00:00Z' };
  assert.deepStrictEqual(selectRepositories([unknown, known]).map(r => r.full_name), ['a/known', 'a/unknown']);
  assert.deepStrictEqual(selectRepositories([known, unknown]).map(r => r.full_name), ['a/known', 'a/unknown'],
    'the answer changed when the same two repositories arrived the other way round');

  /* Two unknowns still have to order against each other deterministically. */
  const other = { full_name: 'a/another', owner: 'a', name: 'another', pushed_at: '' };
  assert.deepStrictEqual(selectRepositories([unknown, other]).map(r => r.full_name), ['a/another', 'a/unknown']);
  assert.deepStrictEqual(selectRepositories([other, unknown]).map(r => r.full_name), ['a/another', 'a/unknown'],
    'two undated repositories order differently depending on which was first');
});

check('the fan-out is bounded whatever the caller asks for', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    full_name: `a/r${i}`, owner: 'a', name: `r${i}`, pushed_at: '2026-09-01T00:00:00Z'
  }));
  assert.strictEqual(selectRepositories(many).length, MAX_REPOSITORIES);
  assert.strictEqual(selectRepositories(many, 999).length, MAX_REPOSITORIES,
    'a caller asking for 999 repositories got 999 provider round trips');
  assert.strictEqual(selectRepositories(many, 2).length, 2, 'a smaller request was not honoured');
  assert.strictEqual(selectRepositories(many, 0).length, 1, 'a zero limit produced an unbounded or empty fan-out');
});

check('a repository missing an owner or a name is never asked about', () => {
  const picked = selectRepositories([
    { full_name: 'a/good', owner: 'a', name: 'good', pushed_at: '2026-09-01T00:00:00Z' },
    { full_name: '', owner: 'a', name: 'nameless', pushed_at: '2026-09-02T00:00:00Z' },
    { full_name: 'a/ownerless', owner: '', name: 'ownerless', pushed_at: '2026-09-03T00:00:00Z' }
  ]);
  assert.deepStrictEqual(picked.map(r => r.full_name), ['a/good'],
    'an incomplete repository reached the fan-out and would be requested as a malformed path');
});

/* --------------------------------------------------------------- the feed */

const sample = () => ([
  {
    repo: 'a/one',
    commits: [
      { sha: 'abc1234567', message: 'Fix the thing', author: 'Ada', date: '2026-09-20T10:00:00Z' }
    ],
    pulls: [{ number: 7, title: 'Add a guard', state: 'merged', updated: '2026-09-20T12:00:00Z' }],
    issues: [],
    releases: []
  },
  {
    repo: 'a/two',
    commits: [{ sha: 'def7654321', message: 'Tidy', author: 'Lin', date: '2026-09-20T11:00:00Z' }],
    pulls: [],
    issues: [{ number: 3, title: 'Crash on open', state: 'open', updated: '2026-09-19T09:00:00Z' }],
    releases: [{ tag: 'v2', name: 'Version two', published: '2026-09-18T09:00:00Z' }]
  }
]);

check('events from every repository are merged newest first', () => {
  const result = feed(sample());
  assert.deepStrictEqual(
    result.events.map(e => [e.repo, e.kind]),
    [
      ['a/one', 'pull'],
      ['a/two', 'commit'],
      ['a/one', 'commit'],
      ['a/two', 'issue'],
      ['a/two', 'release']
    ],
    'the feed is not in one order across repositories, so it reads as two lists interleaved'
  );
  assert.strictEqual(result.measured, true);
  assert.deepStrictEqual([...result.repositories], ['a/one', 'a/two']);
});

check('a commit carries its short sha and its author, a pull its number and state', () => {
  const result = feed(sample());
  const commit = result.events.find(e => e.kind === 'commit' && e.repo === 'a/one');
  assert.strictEqual(commit.detail, 'abc1234', 'the commit lost its short sha, so nothing can be looked up');
  assert.strictEqual(commit.actor, 'Ada');
  assert.strictEqual(commit.title, 'Fix the thing');
  const pull = result.events.find(e => e.kind === 'pull');
  assert.strictEqual(pull.ref, '#7');
  assert.strictEqual(pull.detail, 'merged');
});

check('a multi-line commit message is reduced to its subject', () => {
  const result = feed([{
    repo: 'a/one',
    commits: [{ sha: 'aaaaaaa', message: 'Subject line\n\nA body that goes on\nand on', author: 'Ada', date: '2026-09-20T10:00:00Z' }]
  }]);
  assert.strictEqual(result.events[0].title, 'Subject line', 'the body reached the feed');
  assert.ok(!result.events[0].title.includes('\n'), 'a newline reached the feed and will break the row');
});

check('an undated event is counted, not placed at the top and not silently dropped', () => {
  const result = feed([{
    repo: 'a/one',
    commits: [
      { sha: 'aaaaaaa', message: 'Dated', author: 'Ada', date: '2026-09-20T10:00:00Z' },
      { sha: 'bbbbbbb', message: 'Undated', author: 'Ada', date: null }
    ]
  }]);
  assert.strictEqual(result.events.length, 1, 'an event with no time was given a place in a time-ordered list');
  assert.strictEqual(result.events[0].title, 'Dated');
  assert.strictEqual(result.undated, 1, 'the undated event vanished without the reader being told');
});

check('a failed repository is named rather than read as a quiet one', () => {
  const result = feed([
    { repo: 'a/one', commits: [{ sha: 'aaaaaaa', message: 'Fine', author: 'Ada', date: '2026-09-20T10:00:00Z' }] },
    { repo: 'a/two', error: 'rate limit exceeded' }
  ]);
  assert.strictEqual(result.measured, true);
  assert.deepStrictEqual([...result.repositories], ['a/one']);
  assert.deepStrictEqual(result.failed.map(f => [f.repo, f.reason]), [['a/two', 'rate limit exceeded']],
    'the failure was swallowed, so the card claims the workspace was quiet when it was not readable');
});

check('a feed where nothing could be read is not measured', () => {
  const result = feed([
    { repo: 'a/one', error: 'not found' },
    { repo: 'a/two', error: 'rate limit exceeded' }
  ]);
  assert.strictEqual(result.measured, false,
    'a card with no readable repository claims to be a measurement');
  assert.strictEqual(result.events.length, 0);
  assert.strictEqual(result.failed.length, 2);
});

check('a repository that answered with nothing is measured and empty', () => {
  const result = feed([{ repo: 'a/quiet', commits: [], pulls: [], issues: [], releases: [] }]);
  assert.strictEqual(result.measured, true,
    'a genuinely quiet week is reported as a failure to read');
  assert.strictEqual(result.events.length, 0);
  assert.strictEqual(result.failed.length, 0);
});

check('the feed is capped and says when it was', () => {
  const commits = Array.from({ length: 60 }, (_, i) => ({
    sha: `sha${i}`.padEnd(7, '0'),
    message: `Commit ${i}`,
    author: 'Ada',
    date: new Date(Date.parse('2026-09-20T10:00:00Z') - i * 60000).toISOString()
  }));
  const result = feed([{ repo: 'a/one', commits }]);
  assert.strictEqual(result.events.length, MAX_EVENTS);
  assert.strictEqual(result.totalEvents, 60);
  assert.strictEqual(result.truncated, true, 'the feed was cut without the reader being told');
  /* Cut from the bottom: the newest survive. */
  assert.strictEqual(result.events[0].title, 'Commit 0');
});

check('a limit above the cap cannot widen the feed', () => {
  const commits = Array.from({ length: 60 }, (_, i) => ({
    sha: `sha${i}`.padEnd(7, '0'), message: `C${i}`, author: 'A',
    date: new Date(Date.parse('2026-09-20T10:00:00Z') - i * 60000).toISOString()
  }));
  assert.strictEqual(feed([{ repo: 'a/one', commits }], { limit: 500 }).events.length, MAX_EVENTS);
  assert.strictEqual(feed([{ repo: 'a/one', commits }], { limit: 5 }).events.length, 5);
});

check('an entry with neither a title nor a reference is not a feed row', () => {
  const result = feed([{
    repo: 'a/one',
    commits: [{ sha: '', message: '', author: 'Ada', date: '2026-09-20T10:00:00Z' }],
    issues: [{ number: 4, title: '', state: 'open', updated: '2026-09-20T09:00:00Z' }]
  }]);
  /* The issue keeps its number, so it is still something a reader can open.
     The commit has neither a message nor a sha and is nothing at all. */
  assert.deepStrictEqual(result.events.map(e => e.kind), ['issue'],
    'an empty row reached the feed');
});

check('the result and every event in it are frozen', () => {
  const result = feed(sample());
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.events));
  assert.ok(result.events.every(event => Object.isFrozen(event)));
  assert.ok(Object.isFrozen(result.failed));
});

check('long commit subjects stay bounded independently of their bodies', () => {
  const result = feed([{ repo: 'a/one', commits: [{
    sha: 'a'.repeat(40), message: 'x'.repeat(180) + '\n\nA long body that belongs on the commit.',
    author: 'Ada', date: '2026-09-20T10:00:00Z'
  }] }]);
  assert.strictEqual(result.events[0].title, 'x'.repeat(119) + '…');
});

check('junk in is an empty feed, not a crash', () => {
  for (const input of [null, undefined, 'nonsense', 42, {}, [null], [{}], [{ repo: 'a/b', commits: 'no' }]]) {
    const result = feed(input);
    assert.ok(Object.isFrozen(result), `feed(${JSON.stringify(input)}) did not return a frozen result`);
    assert.ok(Array.isArray(result.events));
  }
  assert.deepStrictEqual(selectRepositories(null), []);
  assert.deepStrictEqual(selectRepositories('nonsense'), []);
});

if (failures) {
  console.error(`\nactivity feed tests failed: ${failures}`);
  process.exit(1);
}
console.log('activity feed tests passed');
