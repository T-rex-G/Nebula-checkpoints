'use strict';

/*
 * What an accuracy change may not move silently.
 *
 * A finding's id is what a team's decisions hang on: a false positive marked
 * as one, a waiver with an end date, an alert already sent, the merge gate's
 * count of what is open. So a change to the engine that finds more, or less,
 * must not quietly give a finding it still reports a new id, a new rule or a
 * new verdict. This test holds every finding the whole audit reports on the
 * benchmark corpus -- its rule, its place, its id and its verdict -- against
 * test/oracles/uranus-finding-ids.json:
 *
 *   - a finding reported at the same rule, file and line under another id is
 *     a moved id, and fails on its own, whatever else changed;
 *   - a verdict that changes (confirmed, to confirm) changes what the merge
 *     gate counts, and fails;
 *   - a finding added or gone is an accuracy change: it fails until the
 *     record is written again, on purpose, with
 *     `node test/uranus-finding-ids.test.js --write`, so the diff of the
 *     record shows a reviewer exactly what moved.
 *
 * And the audit is run twice: an id is the same on every run.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyse } = require('../apps/api/src/modules/uranus/index.ts');
const { cases, filesOf } = require('../scripts/uranus-benchmark');

const RECORD = path.join(__dirname, 'oracles', 'uranus-finding-ids.json');

function read() {
  const out = {};
  for (const entry of cases()) {
    const files = filesOf(entry.dir);
    const result = analyse({ files, paths: files.map(file => file.path) });
    out[entry.id] = result.findings.filter(finding => finding.path)
      .map(finding => ({ rule: finding.rule, path: finding.path, line: finding.line || 0, id: finding.id, verdict: finding.verdict || 'confirmed' }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id));
  }
  return out;
}

const now = read();
if (process.argv.includes('--write')) {
  fs.writeFileSync(RECORD, `${JSON.stringify(now, null, 1)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), RECORD)}: ${Object.values(now).flat().length} findings in ${Object.keys(now).length} cases`);
  process.exit(0);
}

const again = read();
assert.deepStrictEqual(again, now, 'the same corpus gives the same findings, ids and verdicts on every run');

const recorded = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
const place = finding => `${finding.rule} ${finding.path}:${finding.line}`;
const moved = [];
const verdicts = [];
const added = [];
const gone = [];
for (const id of new Set([...Object.keys(recorded), ...Object.keys(now)])) {
  const before = recorded[id] || [];
  const after = now[id] || [];
  const beforeIds = new Set(before.map(finding => finding.id));
  const afterIds = new Set(after.map(finding => finding.id));
  for (const finding of after) {
    const earlier = before.find(old => old.id === finding.id);
    if (earlier && earlier.verdict !== finding.verdict) verdicts.push(`${id}: ${place(finding)} ${earlier.verdict} -> ${finding.verdict}`);
    if (earlier) continue;
    const samePlace = before.find(old => place(old) === place(finding) && !afterIds.has(old.id));
    if (samePlace) moved.push(`${id}: ${place(finding)} was ${samePlace.id}, now ${finding.id}`);
    else added.push(`${id}: ${place(finding)} ${finding.verdict}`);
  }
  for (const finding of before) {
    if (afterIds.has(finding.id) || after.some(now => place(now) === place(finding) && !beforeIds.has(now.id))) continue;
    gone.push(`${id}: ${place(finding)} ${finding.verdict}`);
  }
}
assert.deepStrictEqual(moved, [], 'a finding still reported keeps its id: decisions, waivers and alerts are keyed on it');
assert.deepStrictEqual(verdicts, [], 'a finding keeps its verdict unless the record is written again on purpose: the merge gate counts by it');
assert.deepStrictEqual({ added, gone }, { added: [], gone: [] }, 'findings added or gone are an accuracy change: write the record again with --write and review its diff');
const total = Object.values(now).flat().length;
assert(total > 150, `the corpus reports findings to hold (${total})`);
console.log(`uranus finding id tests passed (${total} findings in ${Object.keys(now).length} cases held to the record)`);
