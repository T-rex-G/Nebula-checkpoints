'use strict';

/*
 * The OWASP Benchmark scorer: what it counts, and how it reads a checkout.
 *
 * The scorer is the instrument behind Uranus's independent qualification, so
 * it is tested before its figures are believed: a case is flagged only by a
 * finding of the rule its category claims, in its own file; a category no
 * rule claims -- or a claim under another CWE -- is listed and not scored;
 * the score is the Benchmark's own (true-positive rate less false-positive
 * rate), per category and averaged; and the cases split by the parity of
 * their number into two halves scored the same way. The checkouts here are a
 * miniature in the Benchmark's layout, written for this test.
 */

const assert = require('assert');
const path = require('path');
const { score, tally, report, CLAIMED } = require('../scripts/uranus-owasp-benchmark');

const MINI = path.join(__dirname, 'fixtures', 'owasp-mini');

/* Counting, with outcomes given: no engine involved. */
{
  const outcomes = [
    { name: 'BenchmarkTest00001', category: 'sqli', rule: 'SEC-001', cwe: 89, real: true, flagged: true },
    { name: 'BenchmarkTest00002', category: 'sqli', rule: 'SEC-001', cwe: 89, real: true, flagged: false },
    { name: 'BenchmarkTest00003', category: 'sqli', rule: 'SEC-001', cwe: 89, real: false, flagged: true },
    { name: 'BenchmarkTest00004', category: 'sqli', rule: 'SEC-001', cwe: 89, real: false, flagged: false },
    { name: 'BenchmarkTest00005', category: 'sqli', rule: 'SEC-001', cwe: 89, real: false, flagged: false },
    { name: 'BenchmarkTest00006', category: 'xss', rule: 'SEC-033', cwe: 79, real: true, flagged: true }
  ];
  const { rows, total, averageYouden } = tally(outcomes);
  const sqli = rows.find(row => row.category === 'sqli');
  assert.deepStrictEqual([sqli.tp, sqli.fn, sqli.fp, sqli.tn], [1, 1, 1, 2]);
  assert.strictEqual(sqli.tpr, 0.5);
  assert.strictEqual(Math.round(sqli.fpr * 1000), 333);
  assert.strictEqual(Math.round(sqli.youden * 1000), 167, 'the Benchmark score is TPR less FPR');
  assert.deepStrictEqual(sqli.missed, ['BenchmarkTest00002']);
  assert.deepStrictEqual(sqli.falseAlarms, ['BenchmarkTest00003']);
  const xss = rows.find(row => row.category === 'xss');
  assert.strictEqual(xss.fpr, 0, 'a category with no safe cases has no false-positive rate, not a division by zero');
  assert.strictEqual(Math.round(averageYouden * 1000), Math.round(((0.5 - 1 / 3) + 1) / 2 * 1000), 'the average is across categories, not cases');
  assert.deepStrictEqual(total, { tp: 2, fp: 1, fn: 1, tn: 2 });
  assert.deepStrictEqual(tally([]).rows, []);
  assert.strictEqual(tally([]).averageYouden, 0);
}

/* Reading a checkout: which cases are scored, which file is the case's own, and the halves. */
{
  const seen = [];
  const fake = ({ files }) => {
    seen.push(files.map(file => file.path));
    const own = files[0].path;
    /* a finding of the claimed rule in another file, and one of another rule in the case's own file: neither flags it */
    return { findings: [{ rule: 'SEC-001', path: files[1] ? files[1].path : 'elsewhere' }, { rule: 'SEC-033', path: own.endsWith('00001.java') ? own : 'elsewhere' }] };
  };
  const java = score(path.join(MINI, 'java'), { analyse: fake });
  assert.strictEqual(java.language, 'java');
  assert.strictEqual(java.labels, 'expectedresults-1.2.csv');
  assert.strictEqual(java.cases, 3, 'hash is not claimed, and sqli under CWE 90 is not the claim');
  assert.deepStrictEqual(java.notClaimed, { hash: 1, sqli: 1 });
  assert(seen.every(paths => paths.length === 2 && paths[1] === 'src/main/java/org/owasp/benchmark/helpers/Store.java'), 'each case is audited with the corpus helpers beside it');
  assert.strictEqual(java.total.tp + java.total.fn + java.total.fp + java.total.tn, 3);
  assert.strictEqual(java.total.tp, 0, 'only the claimed rule, in the case\'s own file, flags a case');
  assert.deepStrictEqual(Object.keys(java.halves), ['odd', 'even']);
  const mixed = score(path.join(MINI, 'java'), { analyse: ({ files }) => ({
    findings: [{ path: files[0].path, rule: 'SEC-001', verdict: 'needs-validation' },
      { path: files[1].path, rule: 'SEC-001', verdict: 'confirmed' },
      { path: files[0].path, rule: 'SEC-033', verdict: 'confirmed' }]
  }) });
  assert.deepStrictEqual(mixed.total, { tp: 2, fp: 1, fn: 0, tn: 0 });
  assert.deepStrictEqual(mixed.confirmed.total, { tp: 1, fp: 0, fn: 1, tn: 1 });
  assert.match(report(mixed), /confirmed only\s+TP 1\s+FP 0\s+FN 1\s+TN 1/);
  assert.strictEqual(java.halves.odd.total.fn + java.halves.odd.total.tp, 2, 'cases 1 and 3 are the odd half');
  assert.strictEqual(java.halves.even.total.tn + java.halves.even.total.fp, 1, 'case 2 is the even half');
  assert.throws(() => score(path.join(MINI)), /no expectedresults/);
}

/* With the engine: the miniature's vulnerable cases are found and its safe one is not. */
{
  const java = score(path.join(MINI, 'java'));
  const sqli = java.rows.find(row => row.category === 'sqli');
  const xss = java.rows.find(row => row.category === 'xss');
  assert.deepStrictEqual([sqli.tp, sqli.fn, sqli.fp, sqli.tn], [1, 0, 0, 1], 'a concatenated query is found; a placeholder is not');
  assert.deepStrictEqual([xss.tp, xss.fn], [1, 0], 'a request value printed to an HTML response is found');
  const python = score(path.join(MINI, 'python'));
  assert.strictEqual(python.language, 'python');
  const cmdi = python.rows.find(row => row.category === 'cmdi');
  assert.deepStrictEqual([cmdi.tp, cmdi.fn, cmdi.fp, cmdi.tn], [1, 0, 0, 1], 'a shell string is found; an argument list is not');
  assert.match(report(python), /cmdi\s+SEC-011\s+1\s+0\s+0\s+1/);
  assert.match(report(python), /halves by case number: odd 100%, even\s+0%/);
}

assert.strictEqual(CLAIMED.sqli.rule, 'SEC-001');
assert(!CLAIMED.hash && !CLAIMED.crypto && !CLAIMED.ldapi && !CLAIMED.xpathi && !CLAIMED.trustbound, 'no rule claims these categories, so they are not scored');
console.log('uranus OWASP Benchmark scorer tests passed');
