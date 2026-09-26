'use strict';

/*
 * The trust score is a number a founder will quote and a tester will trust, so
 * the properties worth guarding are not "does it compute" but "can it ever
 * overstate". Each case below is a way the figure could lie.
 */

const assert = require('assert');
const pulse = require('../public/workspace-pulse.js');

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const DAY = 86400000;

function features(supported, experimental, unavailable) {
  const out = {};
  let index = 0;
  for (const [status, count] of [['Supported', supported], ['Experimental', experimental], ['Unavailable', unavailable]]) {
    for (let i = 0; i < count; i += 1) out[`feature-${index++}`] = { status };
  }
  return out;
}

const REPO = { owner: 'acme', name: 'demo', private: true, pushed_at: '2026-08-23T09:00:00.000Z' };

/* A clean scan and a signed recovery point for every connected repository. */
function posture(overrides = {}) {
  return {
    credential: { kind: 'installation', rating: 1, detail: 'GitHub App installation.' },
    recovery: { available: true, repositories: [{ owner: 'acme', repo: 'demo', latestAt: '2026-08-22T00:00:00.000Z', points: 1 }] },
    exposure: { available: true, repositories: [{ owner: 'acme', repo: 'demo', scannedAt: '2026-08-22T00:00:00.000Z', partial: false, open: { critical: 0, serious: 0, warning: 0 } }] },
    boundary: { state: 'online', database: 'ready', maintenance: false },
    ...overrides
  };
}

function exposureOf(open, extra = {}) {
  return { available: true, repositories: [{ owner: 'acme', repo: 'demo', scannedAt: null, partial: false, open, ...extra }] };
}

const PERFECT = {
  now: NOW,
  features: features(8, 0, 0),
  scanner: { active: true, rulesConfigured: true },
  recoveryStatus: 'Supported',
  identity: { installationId: 42 },
  posture: posture(),
  repos: [REPO]
};

const component = (model, id) => model.trust.components.find(entry => entry.id === id);

/* Nothing measured must not read as a score of zero. */
{
  const empty = pulse.model({ now: NOW });
  assert.strictEqual(empty.trust.score, null, 'an unmeasured workspace has no score, not a score of zero');
  assert.strictEqual(empty.trust.grade, null, 'no score, no grade');
  assert.strictEqual(empty.trust.status, 'unknown');
  assert.strictEqual(empty.trust.measuredCount, 0);
  assert.strictEqual(empty.signals.measured, false);
  assert.strictEqual(empty.activity.measured, false);
  for (const entry of empty.trust.components) {
    assert.strictEqual(entry.status, 'unknown', `${entry.id} must report itself unmeasured`);
    assert.strictEqual(entry.ratio, null);
    assert(entry.detail, `${entry.id} must say why it is unmeasured`);
  }
}

/* A fully satisfied workspace reaches 100 -- the scale has a real top. */
{
  const best = pulse.model(PERFECT);
  assert.strictEqual(best.trust.score, 100);
  assert.strictEqual(best.trust.grade, 'A');
  assert.strictEqual(best.trust.status, 'good');
  assert.strictEqual(best.trust.capped, false);
  assert.strictEqual(best.trust.attention, 0);
  assert.strictEqual(best.trust.measuredCount, best.trust.componentCount);
  const weights = pulse.COMPONENTS.reduce((total, entry) => total + entry.weight, 0);
  assert(Math.abs(weights - 1) < 1e-9, 'the weights must sum to one');
}

/*
 * The property that keeps the figure honest in the common case: a component
 * nobody could measure is excluded, not scored zero. Measuring fewer things
 * must not look like failing them.
 */
{
  const partial = pulse.model({ ...PERFECT, scanner: undefined, recoveryStatus: undefined });
  assert.strictEqual(partial.trust.score, 100, 'unmeasured components must not drag a passing score down');
  assert.strictEqual(partial.trust.measuredCount, 4);
  assert.strictEqual(component(partial, 'scanning').status, 'unknown');

  const failed = pulse.model({ ...PERFECT, scanner: { active: false } });
  assert(failed.trust.score < 100, 'a component that was measured and failed must lower the score');
  assert.notStrictEqual(failed.trust.score, partial.trust.score,
    'measured-and-failing must not score the same as never-measured');
}

/*
 * Capabilities: verified out of what this provider offers. Experimental earns
 * nothing -- the half credit it used to earn is how the dial read 79 over a
 * line that said 20 of 35 -- and a capability the provider does not have is a
 * missing feature, not a weakness of this workspace.
 */
{
  const half = pulse.model({ ...PERFECT, features: features(4, 4, 0) });
  assert.strictEqual(component(half, 'capabilities').ratio, 0.5, 'experimental must not score as verified');
  assert(component(half, 'capabilities').detail.includes('4 of 8'), 'the component must report the count behind its ratio');
  const gitea = pulse.model({ ...PERFECT, features: features(6, 4, 25) });
  const reading = component(gitea, 'capabilities');
  assert.strictEqual(reading.ratio, 0.6, 'the denominator is what the provider offers');
  assert(reading.detail.includes('6 of 10') && reading.detail.includes('4 experimental') && reading.detail.includes('25 not offered'),
    `the detail must say exactly what the ratio is made of: ${reading.detail}`);
  const none = pulse.model({ ...PERFECT, features: features(0, 0, 8) });
  assert.strictEqual(component(none, 'capabilities').ratio, 0);
}

/*
 * The credential is scored from what the provider reported for it, and not
 * scored at all until that report arrives. Calling every token "broader
 * scope" was a guess, and a guess is not a reading.
 */
{
  const unread = pulse.model({ ...PERFECT, identity: { login: 'tester' }, posture: undefined });
  assert.strictEqual(component(unread, 'authentication').status, 'unknown', 'a token is not scored before its report');
  const classic = pulse.model({ ...PERFECT, identity: { login: 'tester' },
    posture: posture({ credential: { kind: 'classic', rating: 0.4, detail: 'Classic token: reaches every repository the account can and never expires.' } }) });
  assert.strictEqual(component(classic, 'authentication').ratio, 0.4);
  assert(classic.trust.score < pulse.model(PERFECT).trust.score, 'a broad token must not score as an installation');
  const unknownKind = pulse.model({ ...PERFECT, posture: posture({ credential: { kind: 'unknown', rating: null, detail: 'Gitea does not report a token\u2019s scope.' } }) });
  assert.strictEqual(component(unknownKind, 'authentication').status, 'unknown', 'an unreadable credential is unmeasured, not failed');
  assert.match(component(unknownKind, 'authentication').detail, /Gitea/);
  const installation = pulse.model({ ...PERFECT, posture: undefined });
  assert.strictEqual(component(installation, 'authentication').ratio, 1, 'an installation is limited by construction');
}

/*
 * Leaked credentials. Severity decides the reading, an open critical finding
 * caps the whole score, and coverage bounds a clean result.
 */
{
  const critical = pulse.model({ ...PERFECT, posture: posture({ exposure: exposureOf({ critical: 1, serious: 0, warning: 0 }) }) });
  assert.strictEqual(component(critical, 'exposure').ratio, 0);
  assert.strictEqual(critical.trust.capped, true);
  assert(critical.trust.score <= pulse.CRITICAL_CAP, 'an open critical leak holds the score below the cap');
  assert.strictEqual(critical.trust.grade, 'F');
  assert.match(component(critical, 'exposure').detail, /1 leaked credential still exposed \(1 critical\)/);

  const serious = pulse.model({ ...PERFECT, posture: posture({ exposure: exposureOf({ critical: 0, serious: 2, warning: 1 }) }) });
  assert.strictEqual(component(serious, 'exposure').ratio, 0.4);
  assert.strictEqual(serious.trust.capped, false, 'only a critical finding caps the score');
  assert.match(component(serious, 'exposure').detail, /3 leaked credentials still exposed \(2 serious, 1 warning\)/);

  const warning = pulse.model({ ...PERFECT, posture: posture({ exposure: exposureOf({ critical: 0, serious: 0, warning: 1 }) }) });
  assert.strictEqual(component(warning, 'exposure').ratio, 0.75);

  const two = [REPO, { owner: 'acme', name: 'other', private: true, pushed_at: REPO.pushed_at }];
  const halfScanned = pulse.model({ ...PERFECT, repos: two });
  const reading = component(halfScanned, 'exposure');
  assert.strictEqual(reading.ratio, 0.8, 'one clean repository of two is not a clean workspace');
  assert.match(reading.detail, /1 of 2 repositories scanned/);

  const partialScan = pulse.model({ ...PERFECT, posture: posture({ exposure: exposureOf({ critical: 0, serious: 0, warning: 0 }, { partial: true }) }) });
  assert.match(component(partialScan, 'exposure').detail, /1 scan partial/);

  const elsewhere = pulse.model({ ...PERFECT, posture: posture({ exposure: { available: true, repositories: [
    { owner: 'someone', repo: 'else', partial: false, open: { critical: 3, serious: 0, warning: 0 } }
  ] } }) });
  assert.strictEqual(component(elsewhere, 'exposure').status, 'unknown', 'a repository that is not connected is not this workspace');
  assert.strictEqual(elsewhere.trust.capped, false);

  const noDatabase = pulse.model({ ...PERFECT, posture: posture({ exposure: { available: false, repositories: [] } }) });
  assert.strictEqual(component(noDatabase, 'exposure').status, 'unknown');
  assert.match(component(noDatabase, 'exposure').detail, /database/);

  const caseBlind = pulse.model({ ...PERFECT, posture: posture({ exposure: { available: true, repositories: [
    { owner: 'ACME', repo: 'Demo', partial: false, open: { critical: 1, serious: 0, warning: 0 } }
  ] } }) });
  assert.strictEqual(caseBlind.trust.capped, true, 'repository names match without regard to case, as the provider does');
}

/*
 * Recovery points that exist, not recovery the provider could offer -- the
 * overview used to say "healthy" beside a topology that said Gap.
 */
{
  const two = [REPO, { owner: 'acme', name: 'other', private: true, pushed_at: REPO.pushed_at }];
  const half = pulse.model({ ...PERFECT, repos: two });
  assert.strictEqual(component(half, 'recovery').ratio, 0.5);
  assert.match(component(half, 'recovery').detail, /1 of 2 repositories have a recovery point/);

  const none = pulse.model({ ...PERFECT, posture: posture({ recovery: { available: true, repositories: [] } }) });
  assert.strictEqual(component(none, 'recovery').ratio, 0, 'no recovery point is no recovery, whatever the provider supports');

  const local = pulse.model({ ...PERFECT, repos: two, localSnapshots: new Set(['acme/other']) });
  assert.strictEqual(component(local, 'recovery').ratio, 1, 'a browser-held reference is a recovery point');
  assert.match(component(local, 'recovery').detail, /1 held only in this browser/);

  const unoffered = pulse.model({ ...PERFECT, recoveryStatus: 'Unavailable' });
  assert.strictEqual(component(unoffered, 'recovery').ratio, 0);
  assert.match(component(unoffered, 'recovery').detail, /not offered/);

  const unread = pulse.model({ ...PERFECT, posture: undefined });
  assert.strictEqual(component(unread, 'recovery').status, 'unknown', 'recovery is not guessed before the posture arrives');
}

/* Grades are fixed bands of the score. */
{
  assert.deepStrictEqual([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(pulse.gradeOf),
    ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  assert.strictEqual(pulse.gradeOf(null), null);
}

/* The score can never leave its scale, whatever the inputs claim. */
{
  const absurd = pulse.model({
    ...PERFECT,
    features: features(50, 0, 0),
    posture: posture({ credential: { kind: 'x', rating: 7, detail: 'x' }, exposure: exposureOf({ critical: -4, serious: 0, warning: 0 }) }),
    repos: [REPO, { owner: 'acme', name: 'b', private: true, pushed_at: 'not a date' }]
  });
  assert(absurd.trust.score >= 0 && absurd.trust.score <= 100);
  for (const entry of absurd.trust.components) {
    if (entry.ratio !== null) assert(entry.ratio >= 0 && entry.ratio <= 1, `${entry.id} ratio out of range`);
  }
}

/* The capability card reports the verified count against the projected total. */
{
  const model = pulse.model({ ...PERFECT, features: features(5, 2, 3) });
  assert.strictEqual(model.signals.live, 5);
  assert.strictEqual(model.signals.total, 10);
  assert.deepStrictEqual(
    model.signals.breakdown.map(entry => [entry.label, entry.count]),
    [['Verified', 5], ['Experimental', 2], ['Not offered', 3]]
  );
  assert.strictEqual(
    model.signals.breakdown.reduce((total, entry) => total + entry.count, 0),
    model.signals.total,
    'the breakdown must account for every projected capability'
  );
}

/* Activity buckets classify by age, and undated repositories are not invented into one. */
{
  const model = pulse.model({
    ...PERFECT,
    repos: [
      { private: true, pushed_at: new Date(NOW - (2 * 3600000)).toISOString() },
      { private: true, pushed_at: new Date(NOW - (3 * DAY)).toISOString() },
      { private: true, pushed_at: new Date(NOW - (20 * DAY)).toISOString() },
      { private: true, pushed_at: new Date(NOW - (60 * DAY)).toISOString() },
      { private: true, pushed_at: new Date(NOW - (400 * DAY)).toISOString() },
      { private: true }
    ]
  });
  assert.deepStrictEqual(
    model.activity.buckets.map(bucket => [bucket.id, bucket.count]),
    [['day', 1], ['week', 1], ['month', 1], ['quarter', 1], ['older', 1]]
  );
  assert.strictEqual(model.activity.total, 5, 'only dated repositories are counted');
  assert.strictEqual(model.activity.unknownCount, 1, 'an undated repository is reported, not silently bucketed');
  assert.strictEqual(
    model.activity.buckets.reduce((total, bucket) => total + bucket.count, 0),
    model.activity.total
  );
}

/*
 * The plotted series is smoothed; the counts beside it are not. The window
 * total must count repositories, never plotted points -- summing a trailing
 * window counts each push once per day it stays in the window, which is how a
 * card ends up claiming more repositories than the workspace has.
 */
{
  const repos = [];
  for (let i = 0; i < 9; i += 1) {
    repos.push({ private: true, pushed_at: new Date(NOW - (i * 3 * DAY)).toISOString() });
  }
  const { activity } = pulse.model({ ...PERFECT, repos });
  assert.strictEqual(activity.total, 9);
  assert.strictEqual(activity.windowTotal, 9, 'the window total counts repositories, not plotted points');
  assert(activity.windowTotal <= activity.total, 'the window can never hold more than the whole');
  assert.strictEqual(activity.series.length, activity.windowDays);
  assert(
    Math.max(...activity.series) <= activity.rollingDays * 9,
    'the smoothed series must stay within what the window can hold'
  );
}

/* The model hands back frozen structures: a view cannot edit the reading. */
{
  const model = pulse.model(PERFECT);
  assert(Object.isFrozen(model) && Object.isFrozen(model.trust) && Object.isFrozen(model.trust.components));
}

console.log('workspace pulse tests passed');
