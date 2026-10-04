'use strict';

/*
 * The clock: what a repository's .nebulaverse/audit.json may set, what it
 * may not, and where a finding stands against its deadline. Pure, so every
 * edge is pinned with a fixed now.
 */

const assert = require('assert');
const { readAuditPolicy, clockOf, daysFor, slaOf, DEFAULT_SLA, POLICY_PATH } = require('../src/code-audit-policy');
const { analyse, selectFiles } = require('../src/code-audit');

const file = text => [{ path: POLICY_PATH, text }];
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

/* ---- What the file may set ------------------------------------------------ */
{
  const none = readAuditPolicy([]);
  assert.deepStrictEqual({ ...none, sla: { ...none.sla } }, { path: null, source: 'default', sla: { critical: 7, serious: 30, warning: 90 }, problems: [] });
  assert(Object.isFrozen(none) && Object.isFrozen(none.sla));

  const set = readAuditPolicy(file('{ "sla": { "critical": 3, "serious": 14, "warning": 60 } }'));
  assert.strictEqual(set.source, 'repository');
  assert.strictEqual(set.path, POLICY_PATH);
  assert.deepStrictEqual({ ...set.sla }, { critical: 3, serious: 14, warning: 60 });
  assert.deepStrictEqual([...set.problems], []);

  /* The words most programmes use, read as the engine's; the engine's own word wins when both are given. */
  const aliased = readAuditPolicy(file('{ "sla": { "high": 21, "medium": 45 } }'));
  assert.deepStrictEqual({ ...aliased.sla }, { critical: 7, serious: 21, warning: 45 });
  const both = readAuditPolicy(file('{ "sla": { "serious": 10, "high": 21 } }'));
  assert.strictEqual(both.sla.serious, 10);
  const reversed = readAuditPolicy(file('{ "sla": { "high": 21, "serious": 10 } }'));
  assert.strictEqual(reversed.sla.serious, 10, 'whichever order the keys come in');

  /* A file without an sla sets nothing, and says nothing is wrong with it. */
  const empty = readAuditPolicy(file('{}'));
  assert.deepStrictEqual([empty.source, { ...empty.sla }, [...empty.problems]], ['repository', { ...DEFAULT_SLA }, []]);
}

/* ---- What it may not, and how that is said ---------------------------------- */
{
  const broken = readAuditPolicy(file('{ "sla": '));
  assert.strictEqual(broken.source, 'invalid');
  assert.deepStrictEqual({ ...broken.sla }, { ...DEFAULT_SLA });
  assert.strictEqual(broken.problems.length, 1);
  assert.strictEqual(readAuditPolicy(file('[1, 2]')).source, 'invalid');
  assert.strictEqual(readAuditPolicy(file('"sla"')).source, 'invalid');

  const wrong = readAuditPolicy(file(JSON.stringify({ sla: { critical: 0, serious: 400, warning: 7.5, 'ignore-this-line(); // secret': 3 } })));
  assert.strictEqual(wrong.source, 'repository');
  assert.deepStrictEqual({ ...wrong.sla }, { ...DEFAULT_SLA }, 'a refused value keeps the default');
  assert.strictEqual(wrong.problems.length, 4);
  for (const problem of wrong.problems) {
    assert(!problem.includes('ignore-this-line') && !problem.includes('secret') && !problem.includes('400'), 'nothing the file wrote is echoed back');
  }
  assert.strictEqual(readAuditPolicy(file('{ "sla": { "critical": "7" } }')).sla.critical, 7, 'a string is not a number of days');
  assert.strictEqual(readAuditPolicy(file('{ "sla": { "critical": "7" } }')).problems.length, 1);
  assert.strictEqual(readAuditPolicy(file('{ "sla": [7, 30, 90] }')).problems.length, 1);
  /* A prototype key is a key like any other, and not a severity. */
  const proto = readAuditPolicy(file('{ "sla": { "__proto__": { "critical": 1 }, "constructor": 2 } }'));
  assert.deepStrictEqual({ ...proto.sla }, { ...DEFAULT_SLA });
  assert.strictEqual(DEFAULT_SLA.critical, 7, 'the defaults are never written through');
}

/* ---- Where a finding stands ------------------------------------------------- */
{
  const sla = { critical: 7, serious: 30, warning: 90 };
  const at = (severity, days, extra = {}) => clockOf({ severity, ...extra }, { firstSeenAt: new Date(T0).toISOString(), sla, now: T0 + days * DAY });
  assert.deepStrictEqual({ ...at('critical', 1) }, {
    days: 7, firstSeenAt: new Date(T0).toISOString(), dueAt: new Date(T0 + 7 * DAY).toISOString(),
    state: 'on-track', daysLeft: 6, clock: 'severity'
  });
  /* Due soon is the last quarter of the window, a day at least and a week at most. */
  assert.strictEqual(at('critical', 4.9).state, 'on-track');
  assert.strictEqual(at('critical', 5).state, 'due-soon', 'two days left of seven');
  assert.strictEqual(at('critical', 5.5).state, 'due-soon');
  assert.strictEqual(at('serious', 22.9).state, 'on-track');
  assert.strictEqual(at('serious', 23).state, 'due-soon');
  assert.strictEqual(at('warning', 82.9).state, 'on-track', 'a ninety-day clock is due soon for a week, not three');
  assert.strictEqual(at('warning', 83).state, 'due-soon');
  assert.strictEqual(at('critical', 7).state, 'due-soon', 'due at the deadline itself');
  assert.strictEqual(at('critical', 7 + 1 / 24).state, 'overdue');
  assert.strictEqual(at('critical', 7 + 1 / 24).daysLeft, -1, 'an hour late reads as a day overdue');
  assert.strictEqual(at('critical', 12).daysLeft, -5);
  assert.strictEqual(at('critical', 5.5).daysLeft, 2, 'a day and a half left reads as two');
  /* Exploited in the wild: the critical clock, whatever the severity. */
  const exploited = at('warning', 10, { exploited: true });
  assert.deepStrictEqual([exploited.days, exploited.state, exploited.clock], [7, 'overdue', 'exploited']);
  assert.strictEqual(at('critical', 1, { exploited: true }).clock, 'severity', 'a critical one was on that clock already');
  assert.strictEqual(daysFor({ severity: 'serious' }, sla), 30);
  assert.strictEqual(daysFor({ severity: 'info' }, sla), null);
  assert.strictEqual(daysFor({ severity: 'serious' }), 30, 'the defaults without a policy');
  /* No date, no clock: nothing is invented. */
  assert.strictEqual(clockOf({ severity: 'critical' }, { firstSeenAt: null, sla, now: T0 }), null);
  assert.strictEqual(clockOf({ severity: 'critical' }, { firstSeenAt: 'yesterday', sla, now: T0 }), null);
  assert.strictEqual(clockOf({ severity: 'nonsense' }, { firstSeenAt: new Date(T0).toISOString(), sla, now: T0 }), null);
}

/* ---- What a kept audit's stored clock reads as ------------------------------ */
assert.deepStrictEqual(slaOf({ sla: { critical: 3, serious: 14, warning: 60, source: 'repository' } }), { critical: 3, serious: 14, warning: 60 });
assert.strictEqual(slaOf({ sla: null }), null, 'an audit kept before clocks has none');
assert.strictEqual(slaOf({ sla: { critical: 0, serious: 14, warning: 60 } }), null);
assert.strictEqual(slaOf(null), null);

/* ---- The engine reads the file, first, and reports its clock ----------------- */
{
  const selected = selectFiles([
    { path: 'src/index.js', size: 100 }, { path: POLICY_PATH, size: 60 }, { path: 'README.md', size: 10 }
  ]).selected.map(entry => entry.path);
  assert.strictEqual(selected[0], POLICY_PATH, 'the clock is read before the code it times');
  const files = [
    { path: POLICY_PATH, text: '{ "sla": { "critical": 2 } }' },
    { path: 'src/index.js', text: 'module.exports = 1;\n' }
  ];
  const result = analyse({ files, paths: files.map(item => item.path) });
  assert.deepStrictEqual([result.policy.source, { ...result.policy.sla }], ['repository', { critical: 2, serious: 30, warning: 90 }]);
  const plain = analyse({ files: files.slice(1), paths: ['src/index.js'] });
  assert.strictEqual(plain.policy.source, 'default');
}

console.log('code audit policy tests passed');
