'use strict';

/*
 * The Uranus benchmark as a gate. Every finding a case's source says must be
 * found is found, nothing is reported where the source says nothing should
 * be, verdicts match where a case states one, and a known miss or known false
 * positive that no longer holds is promoted rather than left to flatter or
 * slander the engine. The figures the documentation and the landing page
 * publish are the ones the corpus produces today.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runBenchmark, report, markersOf, percent } = require('../scripts/uranus-benchmark');

const result = runBenchmark();
const { totals, outcomes } = result;
const { problems } = report(result);
assert.deepStrictEqual(problems, [], `the benchmark regressed:\n${problems.join('\n')}`);

/* A corpus worth the name: every traced language, safe code beside flawed code, and the rules that judge code. */
assert(totals.cases >= 130, `only ${totals.cases} cases`);
assert(totals.safeCases >= 45, 'safe cases measure precision; too few of them');
for (const language of ['javascript', 'python', 'go', 'java', 'php']) {
  assert(totals.byLanguage[language] && totals.byLanguage[language].cases >= 20, `${language} has fewer than 20 cases`);
}
for (const rule of ['SEC-001', 'SEC-002', 'SEC-010', 'SEC-011', 'SEC-020', 'SEC-021', 'SEC-022', 'SEC-024', 'SEC-028', 'SEC-030', 'SEC-033', 'SEC-034', 'ACC-001', 'ACC-003']) {
  assert(totals.byRule[rule] && totals.byRule[rule].tp > 0, `no case shows ${rule} found`);
}
/* Each case directory holds code. */
for (const outcome of outcomes) assert(outcome.id.includes('/'), outcome.id);

/* The markers read as written, and only measured rules may be named. */
const marks = markersOf([{ path: 'a.js', text: 'x(); // expect: SEC-001 to-confirm\ny(); # known-miss: SEC-010\nz(); // known-fp: SEC-033, SEC-022\n' }]);
assert.deepStrictEqual(marks.map(mark => `${mark.kind} ${mark.rule} ${mark.verdict} ${mark.line}`), [
  'expect SEC-001 to-confirm 1', 'known-miss SEC-010 null 2', 'known-fp SEC-033 null 3', 'known-fp SEC-022 null 3'
]);
assert.throws(() => markersOf([{ path: 'a.js', text: '// expect: HYG-001\n' }]), /not a measured rule/);

/* The figures published elsewhere are today's. */
const capabilities = fs.readFileSync(path.join(__dirname, '..', 'docs', 'current', 'PROVIDER_CAPABILITIES.md'), 'utf8').replace(/\s+/g, ' ');
const stated = /measured on a corpus of (\d+) cases in JavaScript, TypeScript, Python, Go, Java and PHP: (\d+)% precision and (\d+)% recall/.exec(capabilities);
assert(stated, 'PROVIDER_CAPABILITIES.md states the benchmark figures');
assert.strictEqual(Number(stated[1]), totals.cases);
assert.strictEqual(`${stated[2]}%`, percent(totals.precision));
assert.strictEqual(`${stated[3]}%`, percent(totals.recall));

console.log(`uranus benchmark tests passed (${totals.cases} cases, precision ${percent(totals.precision)}, recall ${percent(totals.recall)})`);
