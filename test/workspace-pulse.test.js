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

const PERFECT = {
  now: NOW,
  features: features(8, 0, 0),
  scanner: { active: true, rulesConfigured: true },
  recoveryStatus: 'Supported',
  identity: { installationId: 42 },
  repos: [{ private: true, pushed_at: '2026-08-23T09:00:00.000Z' }]
};

/* Nothing measured must not read as a score of zero. */
{
  const empty = pulse.model({ now: NOW });
  assert.strictEqual(empty.trust.score, null, 'an unmeasured workspace has no score, not a score of zero');
  assert.strictEqual(empty.trust.status, 'unknown');
  assert.strictEqual(empty.trust.measuredCount, 0);
  assert.strictEqual(empty.signals.measured, false);
  assert.strictEqual(empty.activity.measured, false);
  for (const component of empty.trust.components) {
    assert.strictEqual(component.status, 'unknown', `${component.id} must report itself unmeasured`);
    assert.strictEqual(component.ratio, null);
    assert(component.detail, `${component.id} must say why it is unmeasured`);
  }
}

/* A fully satisfied workspace reaches 100 -- the scale has a real top. */
{
  const best = pulse.model(PERFECT);
  assert.strictEqual(best.trust.score, 100);
  assert.strictEqual(best.trust.status, 'good');
  assert.strictEqual(best.trust.measuredCount, best.trust.componentCount);
}

/*
 * The property that keeps the figure honest in the common case: a component
 * nobody could measure is excluded, not scored zero. Measuring fewer things
 * must not look like failing them.
 */
{
  const partial = pulse.model({ ...PERFECT, scanner: undefined, recoveryStatus: undefined });
  assert.strictEqual(partial.trust.score, 100, 'unmeasured components must not drag a passing score down');
  assert.strictEqual(partial.trust.measuredCount, 3);
  const scanning = partial.trust.components.find(component => component.id === 'scanning');
  assert.strictEqual(scanning.status, 'unknown');

  const failed = pulse.model({ ...PERFECT, scanner: { active: false } });
  assert(failed.trust.score < 100, 'a component that was measured and failed must lower the score');
  assert.notStrictEqual(
    failed.trust.score,
    partial.trust.score,
    'measured-and-failing must not score the same as never-measured'
  );
}

/* Experimental is reachable but unevidenced, so it earns partial credit only. */
{
  const all = pulse.model({ ...PERFECT, features: features(8, 0, 0) });
  const half = pulse.model({ ...PERFECT, features: features(4, 4, 0) });
  const none = pulse.model({ ...PERFECT, features: features(0, 0, 8) });
  assert(half.trust.score < all.trust.score, 'experimental capabilities must not score as verified');
  assert(none.trust.score < half.trust.score);
  const component = half.trust.components.find(entry => entry.id === 'capabilities');
  assert.strictEqual(component.ratio, 0.75);
  assert(component.detail.includes('4 of 8'), 'the component must report the count behind its ratio');
}

/* A token is weaker than an installation, and the score must say so. */
{
  const token = pulse.model({ ...PERFECT, identity: { login: 'tester' } });
  const app = pulse.model(PERFECT);
  assert(token.trust.score < app.trust.score, 'a personal token must not score as an installation');
}

/* The score can never leave its scale, whatever the inputs claim. */
{
  const absurd = pulse.model({
    ...PERFECT,
    features: features(50, 0, 0),
    repos: [{ private: true, pushed_at: '2026-08-23T09:00:00.000Z' }, { private: true, pushed_at: 'not a date' }]
  });
  assert(absurd.trust.score >= 0 && absurd.trust.score <= 100);
  for (const component of absurd.trust.components) {
    if (component.ratio !== null) assert(component.ratio >= 0 && component.ratio <= 1, `${component.id} ratio out of range`);
  }
}

/* Live signals report the verified count against the projected total. */
{
  const model = pulse.model({ ...PERFECT, features: features(5, 2, 3) });
  assert.strictEqual(model.signals.live, 5);
  assert.strictEqual(model.signals.total, 10);
  assert.deepStrictEqual(
    model.signals.breakdown.map(entry => [entry.label, entry.count]),
    [['Verified', 5], ['Experimental', 2], ['Unavailable', 3]]
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

/* The model hands back frozen structures: a view cannot edit the reading. */
{
  const model = pulse.model(PERFECT);
  assert(Object.isFrozen(model) && Object.isFrozen(model.trust) && Object.isFrozen(model.trust.components));
}

console.log('workspace pulse tests passed');
