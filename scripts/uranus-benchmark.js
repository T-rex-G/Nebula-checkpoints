#!/usr/bin/env node
'use strict';

/*
 * The Uranus benchmark: a corpus of small applications in every language the
 * engine traces, each run through the whole audit exactly as a repository
 * would be, and scored against what its own source says should be found.
 *
 * A case is a directory under test/fixtures/uranus-benchmark/<language>/.
 * Its files carry their expectations as comments on the line a finding
 * belongs to:
 *
 *   expect: SEC-001               a finding of this rule must be reported here
 *   expect: SEC-001 to-confirm    ... and with this verdict (or `confirmed`)
 *   known-miss: SEC-022           a real flaw the engine does not find yet
 *   known-fp: SEC-033             a line the engine reports and should not
 *
 * A case with no markers is safe code: anything the engine reports of a
 * measured rule there is a false positive. Known misses and known false
 * positives count against recall and precision as they would against a
 * user; they are written down so the numbers are honest, and so a change
 * that fixes one is noticed and the marker promoted.
 *
 * Only the rules that judge code are measured -- traced flows and the
 * endpoint checks. Repository hygiene, manifests and secrets have their own
 * fixtures elsewhere.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'test', 'fixtures', 'uranus-benchmark');
const LANGUAGES = Object.freeze(['javascript', 'python', 'go', 'java', 'php']);
const MEASURED = new Set([
  'SEC-001', 'SEC-002', 'SEC-010', 'SEC-011', 'SEC-020', 'SEC-021', 'SEC-022', 'SEC-024', 'SEC-026', 'SEC-027',
  'SEC-028', 'SEC-029', 'SEC-030', 'SEC-033', 'SEC-034', 'ACC-001', 'ACC-002', 'ACC-003', 'ACC-004', 'ACC-005'
]);
const MARKER = /\b(expect|known-miss|known-fp):\s*((?:[A-Z]{3}-\d{3}(?:\s+(?:confirmed|to-confirm))?[\s,]*)+)/g;
const RULE = /([A-Z]{3}-\d{3})(?:\s+(confirmed|to-confirm))?/g;

function filesOf(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...filesOf(full, base));
    else out.push({ path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

/* The expectations a case's files state, one per rule and line. */
function markersOf(files) {
  const marks = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(MARKER)) {
        for (const rule of match[2].matchAll(RULE)) {
          if (!MEASURED.has(rule[1])) throw new Error(`${file.path}:${index + 1}: ${rule[1]} is not a measured rule`);
          marks.push({ kind: match[1], rule: rule[1], verdict: rule[2] || null, path: file.path, line: index + 1 });
        }
      }
    });
  }
  return marks;
}

function cases(root = ROOT) {
  const out = [];
  for (const language of LANGUAGES) {
    const dir = path.join(root, language);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      out.push({ id: `${language}/${name}`, language, dir: full });
    }
  }
  return out;
}

const key = item => `${item.rule}\0${item.path}\0${item.line}`;

/* One case through the audit: what was expected, found, missed and reported wrongly. */
function scoreCase(entry, analyse) {
  const files = filesOf(entry.dir);
  const marks = markersOf(files);
  const result = analyse({ files, paths: files.map(file => file.path) });
  const found = result.findings.filter(finding => MEASURED.has(finding.rule) && finding.path);
  const byKey = new Map(found.map(finding => [key(finding), finding]));
  const outcome = { id: entry.id, language: entry.language, tp: [], fn: [], fp: [], knownMiss: [], knownFp: [], verdicts: [], promoted: [] };
  const claimed = new Set();
  for (const mark of marks) {
    const hit = byKey.get(key(mark));
    if (hit) claimed.add(key(mark));
    const verdict = hit ? (hit.verdict === 'needs-validation' ? 'to-confirm' : 'confirmed') : null;
    if (mark.kind === 'expect') {
      if (!hit) outcome.fn.push(mark);
      else {
        outcome.tp.push(mark);
        if (mark.verdict && mark.verdict !== verdict) outcome.verdicts.push({ ...mark, got: verdict });
      }
    } else if (mark.kind === 'known-miss') {
      /* still missed: a false negative, as it is to a user; found: the marker should become `expect` */
      if (hit) { outcome.tp.push(mark); outcome.promoted.push(mark); } else outcome.knownMiss.push(mark);
    } else if (mark.kind === 'known-fp') {
      if (hit) outcome.knownFp.push(mark); else outcome.promoted.push(mark);
    }
  }
  for (const finding of found) {
    if (!claimed.has(key(finding))) outcome.fp.push({ rule: finding.rule, path: finding.path, line: finding.line, verdict: finding.verdict });
  }
  return outcome;
}

function tally(outcomes) {
  const sum = list => list.reduce((acc, item) => {
    acc.tp += item.tp.length;
    acc.fn += item.fn.length + item.knownMiss.length;
    acc.fp += item.fp.length + item.knownFp.length;
    return acc;
  }, { tp: 0, fn: 0, fp: 0 });
  const rate = ({ tp, fn, fp }) => ({ tp, fn, fp, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 });
  const byLanguage = {};
  for (const language of LANGUAGES) {
    const own = outcomes.filter(item => item.language === language);
    if (own.length) byLanguage[language] = { cases: own.length, ...rate(sum(own)) };
  }
  const byRule = {};
  for (const outcome of outcomes) {
    const add = (rule, field) => {
      byRule[rule] = byRule[rule] || { tp: 0, fn: 0, fp: 0 };
      byRule[rule][field] += 1;
    };
    outcome.tp.forEach(mark => add(mark.rule, 'tp'));
    [...outcome.fn, ...outcome.knownMiss].forEach(mark => add(mark.rule, 'fn'));
    [...outcome.fp, ...outcome.knownFp].forEach(mark => add(mark.rule, 'fp'));
  }
  for (const rule of Object.keys(byRule)) byRule[rule] = rate(byRule[rule]);
  const total = sum(outcomes);
  return {
    cases: outcomes.length,
    safeCases: outcomes.filter(item => !item.tp.length && !item.fn.length && !item.knownMiss.length).length,
    ...rate(total),
    byLanguage,
    byRule
  };
}

function runBenchmark({ root = ROOT, analyse = require('../src/code-audit').analyse } = {}) {
  const outcomes = cases(root).map(entry => scoreCase(entry, analyse));
  return { outcomes, totals: tally(outcomes) };
}

/* The figure as the documentation states it: a whole percentage, rounded down. */
const percent = value => `${Math.floor(value * 100)}%`;

function report({ outcomes, totals }) {
  const lines = [];
  lines.push(`Uranus benchmark: ${totals.cases} cases (${totals.safeCases} safe), ${totals.tp + totals.fn} expected findings`);
  lines.push(`precision ${percent(totals.precision)} (${totals.tp} of ${totals.tp + totals.fp} reported), recall ${percent(totals.recall)} (${totals.tp} of ${totals.tp + totals.fn} expected)`);
  lines.push('');
  lines.push('language     cases  tp  fn  fp  precision  recall');
  for (const [language, row] of Object.entries(totals.byLanguage)) {
    lines.push(`${language.padEnd(12)} ${String(row.cases).padStart(5)} ${String(row.tp).padStart(3)} ${String(row.fn).padStart(3)} ${String(row.fp).padStart(3)}  ${percent(row.precision).padStart(9)}  ${percent(row.recall).padStart(6)}`);
  }
  lines.push('');
  lines.push('rule      tp  fn  fp  precision  recall');
  for (const rule of Object.keys(totals.byRule).sort()) {
    const row = totals.byRule[rule];
    lines.push(`${rule.padEnd(8)} ${String(row.tp).padStart(3)} ${String(row.fn).padStart(3)} ${String(row.fp).padStart(3)}  ${percent(row.precision).padStart(9)}  ${percent(row.recall).padStart(6)}`);
  }
  const problems = [];
  for (const outcome of outcomes) {
    for (const mark of outcome.fn) problems.push(`MISSED     ${outcome.id}: ${mark.rule} at ${mark.path}:${mark.line}`);
    for (const item of outcome.fp) problems.push(`UNEXPECTED ${outcome.id}: ${item.rule} at ${item.path}:${item.line} (${item.verdict})`);
    for (const item of outcome.verdicts) problems.push(`VERDICT    ${outcome.id}: ${item.rule} at ${item.path}:${item.line} is ${item.got}, expected ${item.verdict}`);
    for (const mark of outcome.promoted) problems.push(`PROMOTE    ${outcome.id}: the ${mark.kind} ${mark.rule} at ${mark.path}:${mark.line} no longer holds`);
  }
  const known = [];
  for (const outcome of outcomes) {
    for (const mark of outcome.knownMiss) known.push(`known miss ${outcome.id}: ${mark.rule} at ${mark.path}:${mark.line}`);
    for (const mark of outcome.knownFp) known.push(`known fp   ${outcome.id}: ${mark.rule} at ${mark.path}:${mark.line}`);
  }
  if (known.length) lines.push('', ...known);
  if (problems.length) lines.push('', ...problems);
  return { text: lines.join('\n'), problems };
}

module.exports = Object.freeze({ runBenchmark, report, markersOf, percent, MEASURED, ROOT });

if (require.main === module) {
  const result = runBenchmark();
  const { text, problems } = report(result);
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result.totals, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
  process.exitCode = problems.length ? 1 : 0;
}
