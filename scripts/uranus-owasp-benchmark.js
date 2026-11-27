#!/usr/bin/env node
'use strict';

/*
 * Uranus against the OWASP Benchmark: independently labelled ground truth.
 *
 * The internal corpus (scripts/uranus-benchmark.js) is labelled by the same
 * hands that wrote the engine. The OWASP Benchmark is not: each of its test
 * cases is a small web handler that is or is not vulnerable to one weakness,
 * and its `expectedresults-*.csv` says which. This script scores Uranus on a
 * local checkout of BenchmarkJava or BenchmarkPython; the checkout is read as
 * data and nothing in it is run. It is not vendored here (GPL).
 *
 *   node scripts/uranus-owasp-benchmark.js <checkout> [--json]
 *
 * Each test case is audited as a small repository of its own -- the test
 * file and the corpus's helper code, as a repository would hold them -- with
 * the whole audit, exactly as a repository is. A case is flagged when a
 * finding of the rule matched to its category is reported in its own file.
 * Only the categories a Uranus rule claims, by the same CWE, are scored;
 * the rest are listed as not claimed rather than counted as misses. The
 * Benchmark's own score is the true-positive rate less the false-positive
 * rate (Youden's J), per category and averaged across them.
 */

const fs = require('fs');
const path = require('path');

/* The Benchmark's category, the CWE it labels, and the Uranus rule that claims that weakness. */
const CLAIMED = Object.freeze({
  sqli: { cwe: 89, rule: 'SEC-001' },
  cmdi: { cwe: 78, rule: 'SEC-011' },
  pathtraver: { cwe: 22, rule: 'SEC-022' },
  xss: { cwe: 79, rule: 'SEC-033' },
  codeinj: { cwe: 94, rule: 'SEC-010' },
  redirect: { cwe: 601, rule: 'SEC-020' },
  deserialization: { cwe: 502, rule: 'SEC-024' },
  xxe: { cwe: 611, rule: 'SEC-034' },
  securecookie: { cwe: 614, rule: 'SEC-004' },
  /* SEC-005 claims less than the category: a random number that makes a secret, not every use of a weak generator. */
  weakrand: { cwe: 330, rule: 'SEC-005' }
});
/* Weak hashing (SEC-023 claims only passwords), weak ciphers, LDAP, XPath and trust boundaries: no rule claims the category. */

function layout(checkout) {
  const csv = fs.readdirSync(checkout).find(name => /^expectedresults-[\d.]+\.csv$/.test(name));
  if (!csv) throw new Error(`no expectedresults-*.csv in ${checkout}`);
  const java = fs.existsSync(path.join(checkout, 'src/main/java/org/owasp/benchmark/testcode'));
  const tests = java ? 'src/main/java/org/owasp/benchmark/testcode' : 'testcode';
  const helpers = java ? 'src/main/java/org/owasp/benchmark/helpers' : 'helpers';
  return { csv, language: java ? 'java' : 'python', extension: java ? '.java' : '.py', tests, helpers };
}

function filesUnder(root, base, extension) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(full, base, extension);
    return entry.name.endsWith(extension) ? [{ path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') }] : [];
  });
}

function labels(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const [name, category, real, cwe] = line.split(',').map(part => part.trim());
    return { name, category, real: real === 'true', cwe: Number(cwe) };
  });
}

/* The Benchmark's own score for a set of case outcomes: per category, then averaged across them. */
function tally(outcomes) {
  const byCategory = new Map();
  for (const outcome of outcomes) {
    const row = byCategory.get(outcome.category) || { rule: outcome.rule, cwe: outcome.cwe, tp: 0, fp: 0, fn: 0, tn: 0, missed: [], falseAlarms: [] };
    if (outcome.real && outcome.flagged) row.tp += 1;
    else if (outcome.real) { row.fn += 1; row.missed.push(outcome.name); }
    else if (outcome.flagged) { row.fp += 1; row.falseAlarms.push(outcome.name); }
    else row.tn += 1;
    byCategory.set(outcome.category, row);
  }
  const rows = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, row]) => {
    const tpr = row.tp + row.fn ? row.tp / (row.tp + row.fn) : 0;
    const fpr = row.fp + row.tn ? row.fp / (row.fp + row.tn) : 0;
    const precision = row.tp + row.fp ? row.tp / (row.tp + row.fp) : null;
    return { category, ...row, tpr, fpr, precision, youden: tpr - fpr };
  });
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  return {
    rows,
    total: { tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), tn: sum('tn') },
    averageYouden: rows.length ? rows.reduce((total, row) => total + row.youden, 0) / rows.length : 0
  };
}

/*
 * Each claimed case audited and judged. The cases are also split by the
 * parity of their number -- odd and even -- so a change made while reading
 * one half's misses can be checked on the other half it was not read from.
 */
function score(checkout, { analyse = require('../apps/api/src/modules/uranus/index.ts').analyse } = {}) {
  const where = layout(checkout);
  const helpers = filesUnder(path.join(checkout, where.helpers), checkout, where.extension);
  const notClaimed = new Map();
  const outcomes = [];
  let lines = 0;
  const started = process.hrtime.bigint();
  for (const label of labels(path.join(checkout, where.csv))) {
    const claim = CLAIMED[label.category];
    if (!claim || claim.cwe !== label.cwe) { notClaimed.set(label.category, (notClaimed.get(label.category) || 0) + 1); continue; }
    const own = `${where.tests}/${label.name}${where.extension}`;
    const text = fs.readFileSync(path.join(checkout, own), 'utf8');
    const result = analyse({ files: [{ path: own, text }, ...helpers] });
    lines += text.split('\n').length;
    const matches = (result.findings || []).filter(finding => finding.rule === claim.rule && finding.path === own);
    const flagged = matches.length > 0;
    const confirmed = matches.some(finding => finding.verdict === 'confirmed');
    const number = Number((/(\d+)$/.exec(label.name) || [])[1]);
    outcomes.push({ name: label.name, category: label.category, rule: claim.rule, cwe: claim.cwe, real: label.real, flagged, confirmed, half: Number.isFinite(number) && number % 2 === 1 ? 'odd' : 'even' });
  }
  return {
    language: where.language,
    labels: where.csv,
    cases: outcomes.length,
    lines,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    ...tally(outcomes),
    confirmed: tally(outcomes.map(outcome => ({ ...outcome, flagged: outcome.confirmed }))),
    halves: { odd: tally(outcomes.filter(outcome => outcome.half === 'odd')), even: tally(outcomes.filter(outcome => outcome.half === 'even')) },
    notClaimed: Object.fromEntries([...notClaimed.entries()].sort())
  };
}

const pct = value => (value === null ? '  -  ' : `${(value * 100).toFixed(0).padStart(3)}%`);

function report(result) {
  const out = [];
  out.push(`OWASP Benchmark (${result.language}, ${result.labels}): ${result.cases} claimed cases, ${result.lines} lines, ${(result.ms / 1000).toFixed(1)} s`);
  out.push('category         rule      tp   fn   fp   tn   TPR   FPR  prec  score');
  for (const row of result.rows) {
    out.push(`${row.category.padEnd(16)} ${row.rule}  ${String(row.tp).padStart(4)} ${String(row.fn).padStart(4)} ${String(row.fp).padStart(4)} ${String(row.tn).padStart(4)}  ${pct(row.tpr)} ${pct(row.fpr)} ${pct(row.precision)} ${pct(row.youden)}`);
  }
  const t = result.total;
  out.push(`all claimed      ${' '.repeat(8)}  ${String(t.tp).padStart(4)} ${String(t.fn).padStart(4)} ${String(t.fp).padStart(4)} ${String(t.tn).padStart(4)}  average score ${pct(result.averageYouden)}`);
  if (result.confirmed) {
    const { tp, fp, fn, tn } = result.confirmed.total;
    out.push(`confirmed only   TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`);
  }
  if (result.halves) out.push(`halves by case number: odd ${pct(result.halves.odd.averageYouden)}, even ${pct(result.halves.even.averageYouden)}`);
  out.push(`not claimed (not scored): ${Object.entries(result.notClaimed).map(([category, count]) => `${category} ${count}`).join(', ') || 'none'}`);
  return out.join('\n');
}

if (require.main === module) {
  const checkout = process.argv[2];
  if (!checkout) { console.error('usage: node scripts/uranus-owasp-benchmark.js <BenchmarkJava or BenchmarkPython checkout> [--json]'); process.exit(2); }
  const result = score(path.resolve(checkout));
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 1) : report(result));
}

module.exports = Object.freeze({ score, tally, report, CLAIMED });
