'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPropertyTests, sha256 } = require('../scripts/uranus-framework-inputs');
const { scoreCases, PROTOCOL_SHA256 } = require('../scripts/uranus-framework-benchmark');

assert.equal(sha256(fs.readFileSync(path.join(__dirname, 'oracles/uranus-framework-protocol.txt'))), PROTOCOL_SHA256);

// Fixture modules and expressions supplied as test data must never be run.
const fixture = `
  throw new Error("do not execute fixtures");
  suite.run("property", rule, {
    valid: [
      { code: "x.innerHTML = ''" },
      { code: "x.innerHTML = ''" },
      { code: dynamic(), options: [] },
      { code: dynamic() },
      { code: "x.textContent = ''" }
    ],
    invalid: [
      { code: "x!" + ".innerHTML = text", ...TYPESCRIPT_OPTIONS, errors: [{line: 1}] }
    ]
  });
`;
const extracted = readPropertyTests(fixture);
assert.equal(extracted.cases.length, 2);
assert.deepEqual(extracted.excluded.map(row => row.reason), [
  'duplicate labelled source', 'custom configuration or parser', 'computed source', 'outside the property target'
]);
const positive = extracted.cases[1];
assert.equal(positive.path, 'src/sample.ts');
assert.equal(positive.text, 'x!.innerHTML = text');
assert.deepEqual(positive.locations, [1]);
assert.throws(() => readPropertyTests(fixture.replace('x!" + ".innerHTML = text', "x.innerHTML = ''").replace('...TYPESCRIPT_OPTIONS,', '')),
  /Conflicting upstream labels/);

const file = 'src/sample.ts';
const base = { path: file, rule: 'SEC-002', cwe: 79, language: 'typescript', start: 2, end: 3 };
const cases = [
  { ...base, id: 'issue', positive: true, locations: [2, 3], text: 'const id = 1;\n1;\n2;\n3;' },
  { ...base, id: 'control', positive: false, locations: [], text: 'const id = 2;\n1;\n2;\n3;' }
];
const result = scoreCases(cases, ({ files }) => {
  assert.deepEqual(Object.keys(files[0]).sort(), ['path', 'text']);
  const hit = { path: file, rule: 'SEC-002', line: 2, verdict: 'confirmed' };
  const findings = [
    { ...hit, line: 4 }, { ...hit, rule: 'SEC-001' }, { ...hit, path: 'other.ts' }
  ];
  if (files[0].text.startsWith('const id = 1;')) findings.push({ ...hit, verdict: 'needs-validation' });
  return { findings, engine: { version: 'example', ruleset: 'example', traced: {} }, capped: false };
});
const { all, confirmed } = result.overall;
assert.deepEqual([all.tp, all.fp, all.fn, all.tn, all.matchedPositiveLines, all.labelledPositiveLines], [1, 0, 0, 1, 1, 2]);
assert.deepEqual([confirmed.tp, confirmed.fp, confirmed.fn, confirmed.tn, confirmed.precision], [0, 0, 1, 1, null]);
assert.equal(result.cases[0].sameRuleOutsideInterval, 1);
assert.equal(result.cases[1].findings.length, 0);
assert.deepEqual(result.byLanguageAndCwe['typescript/CWE-79'], result.overall);
console.log('uranus framework benchmark scorer tests passed');
