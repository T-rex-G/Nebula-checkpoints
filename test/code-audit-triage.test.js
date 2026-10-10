'use strict';

/*
 * Triage laid over an audit, the grade worked out again, and the merge gate.
 *
 * The overlay is checked against the engine itself: a triaged audit must read
 * exactly as the same audit would had the finding never been reported --
 * the same score, the same cap, the same fix-first list, the same ledger --
 * while the decision stays listed with who made it and why. The gate is
 * checked state by state and reason by reason, and against the governance
 * template that acts on it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyse, score, priorities } = require('../src/code-audit');
const {
  VOCABULARY, REASONS, DISPOSITIONS, GATE_REASONS, GATE_STATES, normalizeDecision, inForce, applyTriage, rescore,
  openRows, evaluateMergeGate, unavailableGate, gateAttributes, mergeAttributes, previewMergePolicies, summarizeDecisions
} = require('../src/code-audit-triage');
const { getPolicyTemplate } = require('../src/governance-templates');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

/* ---- The vocabulary is the schema's, value for value --------------------------- */
{
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '030_code_audit_triage.sql'), 'utf8');
  const reasonList = [...REASONS['false-positive'], ...REASONS['accepted-risk']];
  const checked = /reason text NOT NULL CHECK \(reason IN \(([^)]+)\)\)/.exec(sql);
  assert(checked, 'the migration constrains the reason');
  assert.deepStrictEqual(checked[1].match(/'[^']+'/g).map(value => value.slice(1, -1)).sort(), reasonList.slice().sort());
  const fpCheck = /CHECK \(\(disposition = 'false-positive'\) = \(reason IN \(([^)]+)\)\)\)/.exec(sql);
  assert.deepStrictEqual(fpCheck[1].match(/'[^']+'/g).map(value => value.slice(1, -1)), [...REASONS['false-positive']]);
  assert.deepStrictEqual(VOCABULARY.reasons.map(reason => reason.id).sort(), reasonList.slice().sort(), 'every reason has its words');
  for (const reason of VOCABULARY.reasons) assert(REASONS[reason.disposition].includes(reason.id), `${reason.id} is filed under its disposition`);
  assert.deepStrictEqual(VOCABULARY.dispositions.map(item => item.id).sort(), [...DISPOSITIONS].sort());
  assert(VOCABULARY.acceptDays.choices.every(days => days >= VOCABULARY.acceptDays.min && days <= VOCABULARY.acceptDays.max));
  assert(VOCABULARY.acceptDays.choices.includes(VOCABULARY.acceptDays.default));
  assert(Object.isFrozen(VOCABULARY) && Object.isFrozen(VOCABULARY.reasons[0]));
}

/* ---- A decision as asked for ------------------------------------------------- */
assert.deepStrictEqual(normalizeDecision({ disposition: 'false-positive', reason: 'misread', expiresInDays: 30 }), { disposition: 'false-positive', reason: 'misread', days: null }, 'a false positive takes no date');
assert.deepStrictEqual(normalizeDecision({ disposition: 'accepted-risk', reason: 'third-party', expiresInDays: 180 }), { disposition: 'accepted-risk', reason: 'third-party', days: 180 });
for (const input of [{}, { disposition: 'accepted-risk', reason: 'misread', expiresInDays: 30 }, { disposition: 'accepted-risk', reason: 'third-party', expiresInDays: '30' }, { disposition: 'false-positive', reason: '__proto__' }]) {
  assert.throws(() => normalizeDecision(input), error => error.status === 400, JSON.stringify(input));
}
assert.strictEqual(inForce({ disposition: 'false-positive' }), true);
assert.strictEqual(inForce({ disposition: 'accepted-risk', expiresAt: new Date(T0 + DAY).toISOString() }, T0), true);
assert.strictEqual(inForce({ disposition: 'accepted-risk', expiresAt: new Date(T0).toISOString() }, T0), false, 'it lapses at its date');
assert.strictEqual(inForce(null), false);

/* ---- Laid over a real audit ---------------------------------------------------- */
const files = [
  { path: 'package.json', text: JSON.stringify({ name: 'x', dependencies: { express: '4.18.2' } }) },
  { path: 'server.js', text: [
    "const express = require('express');",
    "const { exec } = require('child_process');",
    "const db = require('./db');",
    'const app = express();',
    "app.get('/u', (req, res) => { db.query(`SELECT * FROM users WHERE id = ${req.query.id}`); res.end(); });",
    "app.get('/r', (req, res) => { res.redirect(req.query.next); });",
    "app.post('/x', (req, res) => { exec('ls ' + req.body.dir); res.end(); });",
    'app.listen(3000);'
  ].join('\n') }
];
const audit = analyse({ files, paths: files.map(file => file.path) });
const sql = audit.findings.find(finding => finding.rule === 'SEC-001');
const shell = audit.findings.find(finding => finding.rule === 'SEC-011');
assert(sql && shell && audit.capped, 'the fixture has two confirmed criticals, and is capped for them');
{
  const decisions = new Map([
    [sql.id, { findingId: sql.id, rule: 'SEC-001', disposition: 'false-positive', reason: 'validated', decidedBy: 'alice', decidedAt: new Date(T0).toISOString(), expiresAt: null }],
    [shell.id, { findingId: shell.id, rule: 'SEC-011', disposition: 'accepted-risk', reason: 'compensating-control', decidedBy: 'bob', decidedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 30 * DAY).toISOString() }]
  ]);
  const triaged = applyTriage(audit, decisions, { now: T0 + DAY });
  const left = audit.findings.filter(finding => finding.id !== sql.id && finding.id !== shell.id);
  const expected = score(left);
  assert.deepStrictEqual(triaged.findings.map(finding => finding.id), left.map(finding => finding.id));
  assert.deepStrictEqual([triaged.score, triaged.grade, triaged.capped, triaged.capReason], [expected.score, expected.grade, expected.capped, expected.capReason], 'the grade is the engine\'s for what is left');
  assert.deepStrictEqual(triaged.categories, expected.categories);
  assert.deepStrictEqual(triaged.priorities, priorities(left));
  assert.strictEqual(triaged.capped, false, 'with both criticals decided, nothing holds the grade down');
  assert.strictEqual(triaged.ledger.find(entry => entry.id === 'injection').confirmed, 0, 'the ledger counts what is left');
  const moved = triaged.suppressed.filter(finding => finding.suppression && finding.suppression.triage);
  assert.deepStrictEqual(moved.map(finding => [finding.rule, finding.suppression.triage.disposition, finding.suppression.triage.decidedBy]).sort(),
    [['SEC-001', 'false-positive', 'alice'], ['SEC-011', 'accepted-risk', 'bob']]);
  assert(moved.every(finding => !('findingId' in finding.suppression.triage)), 'the decision carries its words, not its keys');
  assert.deepStrictEqual(triaged.triage, { triaged: 2, lapsed: 0, decisions: 2 });
  assert.strictEqual(audit.findings.length, left.length + 2, 'the audit it was laid over is not changed');

  /* The acceptance lapses: the finding is open again, and says it was accepted. */
  const later = applyTriage(audit, decisions, { now: T0 + 31 * DAY });
  const lapsed = later.findings.find(finding => finding.id === shell.id);
  assert(lapsed && lapsed.triage.lapsed === true && lapsed.triage.reason === 'compensating-control');
  assert.strictEqual(later.capped, true, 'and holds the grade down again');
  assert.deepStrictEqual(later.triage, { triaged: 1, lapsed: 1, decisions: 2 });

  /* A decision under another rule is about a different finding. */
  const wrongRule = applyTriage(audit, new Map([[sql.id, { ...decisions.get(sql.id), rule: 'SEC-011' }]]), { now: T0 });
  assert.strictEqual(wrongRule.findings.length, audit.findings.length);
  assert.strictEqual(applyTriage(audit, new Map(), { now: T0 }).score, audit.score);
  assert.strictEqual(applyTriage(null, decisions), null);
}

/* ---- Worked out again from what the page holds -------------------------------- */
{
  const page = audit.findings.filter(finding => finding.id !== sql.id).map(finding => ({
    id: finding.id, rule: finding.rule, category: finding.category, severity: finding.severity, verdict: finding.verdict,
    open: Boolean(finding.reach && finding.reach.auth === 'open'), exploited: false, tier: null, risk: null, direct: false
  }));
  const again = rescore(page);
  const expected = score(audit.findings.filter(finding => finding.id !== sql.id));
  assert.deepStrictEqual([again.score, again.grade, again.capped], [expected.score, expected.grade, expected.capped]);
  assert(Array.isArray(again.ledger) && again.ledger.find(entry => entry.id === 'injection').confirmed === 1);
  /* What does not fit is left out rather than trusted. */
  const junk = rescore([{ id: 'x', rule: 'SEC-001', category: 'code', severity: 'critical' }, { id: sql.id, rule: 'SEC-001', category: 'code', severity: 'fatal' }, { id: sql.id, rule: 'SEC-001', category: '<b>', severity: 'critical' }, null]);
  assert.strictEqual(junk.grade, 'A', 'nothing valid, nothing found');
  assert.strictEqual(rescore('nonsense').grade, 'A');
  assert.strictEqual(rescore(Array.from({ length: 6000 }, () => ({ id: sql.id, rule: 'SEC-001', category: 'code', severity: 'warning', verdict: 'confirmed' }))).categories.length > 0, true, 'a long list is bounded, not refused');
}

/* ---- The merge gate ------------------------------------------------------------ */
const row = (seed, extra = {}) => ({
  id: String(seed).padEnd(24, '0').slice(0, 24), rule: 'SEC-001', category: 'code', severity: 'serious', verdict: 'confirmed',
  reach: null, exploited: false, waived: null, firstSeenAt: new Date(T0).toISOString(), ...extra
});
const kept = (commit, rows, extra = {}) => ({
  audit: { commitSha: commit, grade: 'C', auditedAt: new Date(T0).toISOString(), files: { complete: true }, analysisComplete: true, sla: null, ...extra },
  findings: rows
});
const HEAD = 'a'.repeat(40);
{
  assert.deepStrictEqual({ ...evaluateMergeGate({ headSha: HEAD, head: null, base: null }) }, { ...unavailableGate(), state: 'missing' });
  const stale = evaluateMergeGate({ headSha: HEAD, head: kept('b'.repeat(40), [row('a1', { severity: 'critical' })]), base: null });
  assert.deepStrictEqual([stale.state, [...stale.blocking], stale.commitSha], ['stale', [], 'b'.repeat(40)], 'an audit of another commit judges nothing');
  assert.strictEqual(unavailableGate().state, 'unavailable');
  assert.deepStrictEqual([...GATE_STATES].sort(), ['current', 'missing', 'stale', 'unavailable']);

  const clean = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, [row('w1', { severity: 'warning' })]), base: kept('c'.repeat(40), []), now: T0 + DAY });
  assert.deepStrictEqual([clean.state, [...clean.blocking], clean.open.warning, clean.base, clean.introduced], ['current', [], 1, 'audited', 0]);

  for (const extra of [
    { analysisComplete: null },
    { analysisComplete: undefined },
    { analysisComplete: false },
    { files: { complete: false } },
    { findings: { total: 1501, stored: 1500 } },
    { watch: { state: 'partial' } },
    { watch: { state: 'unavailable' } }
  ]) {
    const incomplete = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, [], extra), base: null, now: T0 });
    assert.strictEqual(incomplete.state, 'unavailable', 'an exact commit does not make incomplete audit evidence current');
    const template = getPolicyTemplate('audit-merge-gate');
    const actions = previewMergePolicies([{ policyKey: 'audit-gate', document: { ...template.document, enforcement: { mode: 'block' } } }],
      { branch: 'main', audit: gateAttributes(incomplete) });
    assert.deepStrictEqual(actions.map(item => item.effect), ['require-approval'], 'the existing template holds incomplete evidence');
  }

  /* Every reason, each for what it says. */
  const now = T0 + 40 * DAY;
  const rows = [
    row('c1', { severity: 'critical' }),
    row('c2', { severity: 'critical', verdict: 'needs-validation' }),
    row('s1', { severity: 'serious', firstSeenAt: new Date(now - DAY).toISOString() }),
    row('k1', { rule: 'SEC-005', category: 'secrets', severity: 'serious', firstSeenAt: new Date(now - DAY).toISOString() }),
    row('e1', { rule: 'DEP-003', category: 'dependencies', severity: 'warning', exploited: true, reach: 'imported', firstSeenAt: new Date(now - DAY).toISOString() }),
    row('e2', { rule: 'DEP-003', category: 'dependencies', severity: 'warning', exploited: true, reach: 'dev', firstSeenAt: new Date(now - DAY).toISOString() })
  ];
  const full = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, rows), base: kept('c'.repeat(40), [row('c1', { severity: 'critical' })]), now });
  assert.deepStrictEqual([...full.blocking], ['critical', 'serious', 'exploited', 'secret', 'overdue', 'introduced']);
  assert.deepStrictEqual([...GATE_REASONS], ['critical', 'serious', 'exploited', 'secret', 'overdue', 'introduced'], 'the gate gives exactly the reasons it documents');
  assert.strictEqual(full.exploited, 1, 'a dev-only dependency does not ship');
  assert.strictEqual(full.overdue, 2, 'the confirmed critical and the lead are both past seven days');
  assert.strictEqual(full.introduced, 2, 'the serious finding and the credential are not on the base; the base\'s critical is not new');

  /* The clock is the base's: the head cannot lengthen its own deadline. */
  const sla = { critical: 60, serious: 60, warning: 60 };
  const lenient = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, rows.slice(0, 2), { sla: { critical: 365, serious: 365, warning: 365 } }), base: kept('c'.repeat(40), [], { sla }), now });
  assert.strictEqual(lenient.overdue, 0, 'the base allows sixty days');
  assert.strictEqual(lenient.sla.source, 'base');
  const ownClock = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, rows.slice(0, 2), { sla: { critical: 365, serious: 365, warning: 365 } }), base: null, now });
  assert.strictEqual(ownClock.overdue, 2, 'without a base audit, the defaults, never the head\'s own file');
  assert.strictEqual(ownClock.introduced, null, 'and nothing is compared');

  /* The team's decisions: in force they take a finding out; taken back, it is open again; a waiver in code stays waived. */
  const decided = new Map([[row('c1').id, { rule: 'SEC-001', disposition: 'false-positive' }]]);
  const after = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, [row('c1', { severity: 'critical' })]), base: null, decisions: decided, now: T0 + DAY });
  assert.deepStrictEqual([...after.blocking], []);
  const reopened = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, [row('c1', { severity: 'critical', waived: 'triage' })]), base: null, decisions: new Map(), now: T0 + DAY });
  assert.deepStrictEqual([...reopened.blocking], ['critical'], 'a decision taken back since the audit counts the finding again');
  const inCode = evaluateMergeGate({ headSha: HEAD, head: kept(HEAD, [row('c1', { severity: 'critical', waived: 'code' })]), base: null, now: T0 + DAY });
  assert.deepStrictEqual([...inCode.blocking], [], 'a waiver in the code is part of the commit');
  assert.strictEqual(openRows([row('x', { waived: 'policy' })], new Map(), T0).length, 0);

  /* What a policy sees, and what the merge carries. */
  assert.deepStrictEqual(gateAttributes(full), {
    state: 'current', grade: 'C', blocking: ['critical', 'serious', 'exploited', 'secret', 'overdue', 'introduced'], base: 'audited',
    open: { critical: 2, serious: 2, warning: 2 }, overdue: 2, introduced: 2
  });
  assert.deepStrictEqual(mergeAttributes({ base: 'main', head: 'feature' }, clean), { branch: 'main', head: 'feature', audit: gateAttributes(clean) });
}

/* ---- The template that acts on it, previewed as the gateway would apply it ------- */
{
  const template = getPolicyTemplate('audit-merge-gate');
  const policies = [{ policyKey: 'audit-gate', document: { ...template.document, enforcement: { mode: 'block' } } }];
  const failing = previewMergePolicies(policies, { branch: 'main', audit: { state: 'current', blocking: ['overdue'] } });
  assert.deepStrictEqual(failing.map(item => [item.policyKey, item.mode, item.effect, item.rules.map(rule => rule.id)]), [['audit-gate', 'block', 'deny', ['audit-gate-findings']]]);
  assert(failing[0].rules[0].description && failing[0].rules[0].audit === true);
  const missing = previewMergePolicies(policies, { branch: 'main', audit: { state: 'missing', blocking: [] } });
  assert.deepStrictEqual(missing.map(item => item.effect), ['require-approval']);
  assert.deepStrictEqual(previewMergePolicies(policies, { branch: 'main', audit: { state: 'current', blocking: ['serious', 'introduced'] } }), [], 'the template leaves serious and introduced to a stricter policy');
  assert.deepStrictEqual(previewMergePolicies(policies, { branch: 'main', audit: gateAttributes(unavailableGate()) }).map(item => item.effect), ['require-approval'], 'an unreadable gate is held, not waved through');
  assert.deepStrictEqual(previewMergePolicies(null, {}), []);
}

/* ---- The decisions, counted ----------------------------------------------------- */
assert.deepStrictEqual(summarizeDecisions(new Map([
  ['a', { disposition: 'false-positive' }],
  ['b', { disposition: 'accepted-risk', expiresAt: new Date(T0 + 10 * DAY).toISOString() }],
  ['c', { disposition: 'accepted-risk', expiresAt: new Date(T0 + 60 * DAY).toISOString() }],
  ['d', { disposition: 'accepted-risk', expiresAt: new Date(T0 - DAY).toISOString() }]
]), T0), { falsePositive: 1, acceptedRisk: 2, expiringSoon: 1, lapsed: 1 });
assert.deepStrictEqual(summarizeDecisions(null), { falsePositive: 0, acceptedRisk: 0, expiringSoon: 0, lapsed: 0 });

console.log('code audit triage tests passed');
