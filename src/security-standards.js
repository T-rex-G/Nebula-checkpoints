'use strict';

/*
 * Where each rule sits in the vocabularies a security team already reports
 * in: the CWE weakness it is an instance of, and the OWASP Top 10 (2021)
 * category that weakness belongs to. Findings carry both, the SARIF export
 * tags results with them, and a rule without an entry fails the audit's own
 * test -- a finding a team cannot file under anything is a finding that gets
 * argued about instead of fixed.
 *
 * `owasp` is null where no Top 10 category honestly applies (a missing README
 * is a maintainability weakness, not an application risk).
 */

const OWASP_2021 = Object.freeze({
  A01: 'Broken Access Control',
  A02: 'Cryptographic Failures',
  A03: 'Injection',
  A04: 'Insecure Design',
  A05: 'Security Misconfiguration',
  A06: 'Vulnerable and Outdated Components',
  A07: 'Identification and Authentication Failures',
  A08: 'Software and Data Integrity Failures',
  A09: 'Security Logging and Monitoring Failures',
  A10: 'Server-Side Request Forgery'
});

const CWE_NAMES = Object.freeze({
  22: 'Path Traversal',
  78: 'OS Command Injection',
  79: 'Cross-site Scripting',
  89: 'SQL Injection',
  95: 'Eval Injection',
  200: 'Exposure of Sensitive Information',
  201: 'Insertion of Sensitive Information Into Sent Data',
  250: 'Execution with Unnecessary Privileges',
  284: 'Improper Access Control',
  285: 'Improper Authorization',
  295: 'Improper Certificate Validation',
  307: 'Excessive Authentication Attempts',
  311: 'Missing Encryption of Sensitive Data',
  319: 'Cleartext Transmission of Sensitive Information',
  321: 'Use of Hard-coded Cryptographic Key',
  338: 'Weak PRNG',
  345: 'Insufficient Verification of Data Authenticity',
  347: 'Improper Verification of Cryptographic Signature',
  353: 'Missing Support for Integrity Check',
  489: 'Active Debug Code',
  494: 'Download of Code Without Integrity Check',
  502: 'Deserialization of Untrusted Data',
  506: 'Embedded Malicious Code',
  522: 'Insufficiently Protected Credentials',
  527: 'Exposure of Version-Control Repository',
  538: 'Sensitive Information in an Externally-Accessible File',
  601: 'Open Redirect',
  614: 'Sensitive Cookie Without Secure Attribute',
  693: 'Protection Mechanism Failure',
  710: 'Improper Adherence to Coding Standards',
  732: 'Incorrect Permission Assignment for Critical Resource',
  798: 'Use of Hard-coded Credentials',
  829: 'Inclusion of Functionality from Untrusted Control Sphere',
  916: 'Password Hash With Insufficient Computational Effort',
  918: 'Server-Side Request Forgery',
  942: 'Permissive Cross-domain Policy',
  1004: 'Sensitive Cookie Without HttpOnly',
  1021: 'Improper Restriction of Rendered UI Layers',
  1059: 'Insufficient Technical Documentation',
  1357: 'Reliance on Insufficiently Trustworthy Component',
  1395: 'Dependency on Vulnerable Third-Party Component'
});

const MAP = Object.freeze({
  'SUP-001': [829, 'A08'], 'SUP-002': [494, 'A08'], 'SUP-003': [506, 'A08'], 'SUP-004': [506, 'A08'],
  'SUP-005': [201, 'A08'], 'SUP-006': [829, 'A08'], 'SUP-007': [829, 'A08'], 'SUP-008': [829, 'A08'],
  'SUP-009': [78, 'A03'],
  'SEC-001': [89, 'A03'], 'SEC-002': [79, 'A03'], 'SEC-003': [942, 'A05'], 'SEC-004': [1004, 'A05'],
  'SEC-005': [338, 'A02'], 'SEC-006': [200, 'A01'], 'SEC-007': [345, 'A08'], 'SEC-008': [295, 'A07'],
  'SEC-009': [347, 'A02'], 'SEC-010': [95, 'A03'], 'SEC-011': [78, 'A03'], 'SEC-012': [307, 'A07'],
  'SEC-013': [489, 'A05'], 'SEC-014': [284, 'A01'], 'SEC-015': [284, 'A01'], 'SEC-016': [285, 'A01'],
  'SEC-017': [284, 'A01'], 'SEC-018': [284, 'A01'], 'SEC-019': [522, 'A07'], 'SEC-020': [601, 'A01'],
  'SEC-021': [918, 'A10'], 'SEC-022': [22, 'A01'], 'SEC-023': [916, 'A02'], 'SEC-024': [502, 'A08'],
  'SEC-025': [321, 'A02'],
  'SCR-001': [798, 'A07'],
  'DEP-001': [1357, 'A08'], 'DEP-002': [1357, 'A08'], 'DEP-003': [1395, 'A06'], 'DEP-004': [1357, 'A08'],
  'DEP-005': [1395, 'A06'], 'DEP-006': [506, 'A08'],
  'IAC-001': [250, 'A05'], 'IAC-002': [494, 'A08'], 'IAC-003': [798, 'A07'], 'IAC-004': [732, 'A01'],
  'IAC-005': [732, 'A01'], 'IAC-006': [284, 'A05'], 'IAC-007': [311, 'A02'], 'IAC-008': [284, 'A05'],
  'IAC-009': [250, 'A05'], 'IAC-010': [250, 'A05'],
  'HYG-001': [538, 'A01'], 'HYG-002': [538, 'A05'], 'HYG-003': [1357, 'A08'], 'HYG-004': [1357, 'A08'],
  'HYG-005': [1357, 'A06'], 'HYG-006': [1357, 'A08'], 'HYG-007': [710, null], 'HYG-008': [1059, null],
  'HYG-009': [710, null],
  'WEB-001': [538, 'A05'], 'WEB-002': [527, 'A05'], 'WEB-003': [319, 'A05'], 'WEB-004': [319, 'A05'],
  'WEB-005': [693, 'A05'], 'WEB-006': [693, 'A05'], 'WEB-007': [1021, 'A05'], 'WEB-008': [693, 'A05'],
  'WEB-009': [200, 'A05'], 'WEB-010': [942, 'A05'], 'WEB-011': [614, 'A05'], 'WEB-012': [1004, 'A05'],
  'WEB-013': [200, 'A05'], 'WEB-014': [1059, null], 'WEB-015': [538, 'A05'], 'WEB-016': [693, 'A05'],
  'WEB-017': [693, 'A05'], 'WEB-018': [319, 'A02'], 'WEB-019': [353, 'A08']
});

/* The CWE and OWASP labels for one rule, or null when the rule is not mapped. */
function standardsFor(rule) {
  const entry = MAP[rule];
  if (!entry) return null;
  const [cwe, owasp] = entry;
  return Object.freeze({
    cwe: `CWE-${cwe}`,
    cweName: CWE_NAMES[cwe] || null,
    owasp: owasp ? `${owasp}:2021` : null,
    owaspName: owasp ? OWASP_2021[owasp] : null
  });
}

module.exports = Object.freeze({ standardsFor, OWASP_2021, CWE_NAMES, MAPPED_RULES: Object.freeze(Object.keys(MAP)) });
