'use strict';

/*
 * Every placement can be checked against what OWASP and MITRE publish. A
 * rule filed by OWASP's mapping must have its CWE on that category's list; a
 * rule filed by A02's own words must be a security header; a rule filed by
 * scope must have a CWE that no 2025 list carries. A reviewer can recheck any
 * line here against https://top10.owasp.org/2025/ and the 2025 CWE Top 25.
 */

const assert = require('assert');
const standards = require('../src/security-standards');
const audit = require('../src/code-audit');
const site = require('../src/site-check');

const { MAP, OWASP_2025, OWASP_2025_CWES, CWE_TOP25_2025, CWE_NAMES, standardsFor } = standards;

/* The edition and its ten categories, as published. */
assert.strictEqual(standards.OWASP_EDITION, '2025');
assert.deepStrictEqual(Object.values(OWASP_2025), [
  'Broken Access Control', 'Security Misconfiguration', 'Software Supply Chain Failures', 'Cryptographic Failures',
  'Injection', 'Insecure Design', 'Authentication Failures', 'Software or Data Integrity Failures',
  'Security Logging and Alerting Failures', 'Mishandling of Exceptional Conditions'
]);
/* The published list sizes: 40, 16, 6, 32, 37, 39, 36, 14, 5 and 24 CWEs. */
assert.deepStrictEqual(Object.values(OWASP_2025_CWES).map(list => list.length), [40, 16, 6, 32, 37, 39, 36, 14, 5, 24]);

/* The 2025 Top 25: twenty-five weaknesses, ranked one to twenty-five. */
assert.deepStrictEqual(Object.values(CWE_TOP25_2025).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
assert.strictEqual(CWE_TOP25_2025[79], 1, 'cross-site scripting leads the 2025 list');
assert.strictEqual(CWE_TOP25_2025[862], 4, 'missing authorization is fourth');

/* Every rule of both engines is placed. */
const rules = [...Object.keys(audit.RULES), ...Object.keys(site.RULES)];
assert.deepStrictEqual(rules.filter(rule => !MAP[rule]), [], 'every rule sits under a CWE');
assert.deepStrictEqual(Object.keys(MAP).filter(rule => !rules.includes(rule)), [], 'no mapping for a rule that does not exist');

const onList = cwe => Object.keys(OWASP_2025_CWES).filter(category => OWASP_2025_CWES[category].includes(cwe));
const HEADER_RULES = new Set(['WEB-003', 'WEB-004', 'WEB-005', 'WEB-006', 'WEB-007', 'WEB-008', 'WEB-009', 'WEB-016', 'WEB-017', 'WEB-032']);

for (const [rule, [cwe, category, basis = 'cwe']] of Object.entries(MAP)) {
  assert(CWE_NAMES[cwe], `${rule}: CWE-${cwe} has a name`);
  if (category === null) {
    assert.deepStrictEqual(onList(cwe), [], `${rule}: left out of the Top 10 only when its CWE is on no list`);
    continue;
  }
  assert(OWASP_2025[category], `${rule}: ${category} is a 2025 category`);
  if (basis === 'cwe') {
    assert(OWASP_2025_CWES[category].includes(cwe), `${rule}: OWASP maps CWE-${cwe} to ${onList(cwe).join(', ') || 'nothing'}, not ${category}`);
  } else if (basis === 'text') {
    assert.strictEqual(category, 'A02', `${rule}: only A02 names security headers`);
    assert(HEADER_RULES.has(rule), `${rule}: filed by A02's text but is not a security header`);
  } else {
    assert.strictEqual(basis, 'scope', `${rule}: unknown basis ${basis}`);
    assert.deepStrictEqual(onList(cwe), [], `${rule}: CWE-${cwe} is on ${onList(cwe).join(', ')}, so filing it by scope would overrule OWASP`);
  }
}
/* A header rule is always filed by A02's text, never by a list that happens to carry its CWE. */
for (const rule of HEADER_RULES) assert.strictEqual(MAP[rule][2], 'text', `${rule} is a security header`);

/* What a finding carries. */
assert.deepStrictEqual(standardsFor('SEC-001'), {
  cwe: 'CWE-89', cweName: 'SQL Injection', owasp: 'A05:2025', owaspName: 'Injection', owaspBasis: 'cwe', top25: { rank: 2, year: 2025 }
});
assert.deepStrictEqual(standardsFor('SEC-021'), {
  cwe: 'CWE-918', cweName: 'Server-Side Request Forgery', owasp: 'A01:2025', owaspName: 'Broken Access Control', owaspBasis: 'cwe', top25: { rank: 22, year: 2025 }
}, 'server-side request forgery joined Broken Access Control in 2025');
assert.strictEqual(standardsFor('DEP-003').owasp, 'A03:2025', 'a published vulnerability is a supply chain failure');
assert.strictEqual(standardsFor('WEB-005').owaspBasis, 'text');
assert.strictEqual(standardsFor('IAC-001').owaspBasis, 'scope');
assert.strictEqual(standardsFor('HYG-008').owasp, null);
assert.strictEqual(standardsFor('HYG-008').owaspBasis, null);
assert.strictEqual(standardsFor('SEC-013').top25, null, 'a weakness outside the Top 25 carries no rank');
assert.strictEqual(standardsFor('NOPE-1'), null);

console.log('security standards tests passed');
