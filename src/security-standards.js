'use strict';

/*
 * Where each rule sits in the vocabularies a security team already reports
 * in: the CWE weakness it is an instance of, the OWASP Top 10:2025 category
 * that weakness belongs to, and its rank in the 2025 CWE Top 25 Most
 * Dangerous Software Weaknesses when it has one. Findings carry all three,
 * the SARIF export tags results with them, and a rule without an entry fails
 * the audit's own test -- a finding a team cannot file under anything is a
 * finding that gets argued about instead of fixed.
 *
 * How a category is chosen, so any placement can be checked:
 *
 *   'cwe'   OWASP's own mapping. Each 2025 category publishes the CWEs it
 *           covers (OWASP_2025_CWES below, copied from the category pages);
 *           the rule's CWE is on that list. The test suite proves it.
 *   'text'  OWASP's own words. A02:2025 names the case outright -- "the
 *           server does not send security headers or directives, or they
 *           are not set to secure values" -- so a missing or weak security
 *           header is filed there, whichever list its CWE appears on.
 *   'scope' The CWE is on no 2025 list, so the category is the one whose
 *           description covers the rule. Few rules need it, and each says so.
 *
 * `owasp` is null where no Top 10 category honestly applies (a missing README
 * is a maintainability weakness, not an application risk).
 *
 * Sources: https://top10.owasp.org/2025/ (the categories and their mapped
 * CWEs) and https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html
 * (published 15 December 2025).
 */

const OWASP_EDITION = '2025';

const OWASP_2025 = Object.freeze({
  A01: 'Broken Access Control',
  A02: 'Security Misconfiguration',
  A03: 'Software Supply Chain Failures',
  A04: 'Cryptographic Failures',
  A05: 'Injection',
  A06: 'Insecure Design',
  A07: 'Authentication Failures',
  A08: 'Software or Data Integrity Failures',
  A09: 'Security Logging and Alerting Failures',
  A10: 'Mishandling of Exceptional Conditions'
});

/* Each category's "List of Mapped CWEs", as OWASP publishes it. */
const OWASP_2025_CWES = Object.freeze({
  A01: Object.freeze([22, 23, 36, 59, 61, 65, 200, 201, 219, 276, 281, 282, 283, 284, 285, 352, 359, 377, 379, 402, 424, 425, 441, 497, 538, 540, 548, 552, 566, 601, 615, 639, 668, 732, 749, 862, 863, 918, 922, 1275]),
  A02: Object.freeze([5, 11, 13, 15, 16, 260, 315, 489, 526, 547, 611, 614, 776, 942, 1004, 1174]),
  A03: Object.freeze([447, 1035, 1104, 1329, 1357, 1395]),
  A04: Object.freeze([261, 296, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 334, 335, 336, 337, 338, 340, 342, 347, 523, 757, 759, 760, 780, 916, 1240, 1241]),
  A05: Object.freeze([20, 74, 76, 77, 78, 79, 80, 83, 86, 88, 89, 90, 91, 93, 94, 95, 96, 97, 98, 99, 103, 104, 112, 113, 114, 115, 116, 129, 159, 470, 493, 500, 564, 610, 643, 644, 917]),
  A06: Object.freeze([73, 183, 256, 266, 269, 286, 311, 312, 313, 316, 362, 382, 419, 434, 436, 444, 451, 454, 472, 501, 522, 525, 539, 598, 602, 628, 642, 646, 653, 656, 657, 676, 693, 799, 807, 841, 1021, 1022, 1125]),
  A07: Object.freeze([258, 259, 287, 288, 289, 290, 291, 293, 294, 295, 297, 298, 299, 300, 302, 303, 304, 305, 306, 307, 308, 309, 346, 350, 384, 521, 613, 620, 640, 798, 940, 941, 1390, 1391, 1392, 1393]),
  A08: Object.freeze([345, 353, 426, 427, 494, 502, 506, 509, 565, 784, 829, 830, 915, 926]),
  A09: Object.freeze([117, 221, 223, 532, 778]),
  A10: Object.freeze([209, 215, 234, 235, 248, 252, 274, 280, 369, 390, 391, 394, 396, 397, 460, 476, 478, 484, 550, 636, 703, 754, 755, 756])
});

/* The 2025 CWE Top 25, by CWE number. */
const CWE_TOP25_2025 = Object.freeze({
  79: 1, 89: 2, 352: 3, 862: 4, 787: 5, 22: 6, 416: 7, 125: 8, 78: 9, 94: 10,
  120: 11, 434: 12, 476: 13, 121: 14, 502: 15, 122: 16, 863: 17, 20: 18, 284: 19, 200: 20,
  306: 21, 918: 22, 77: 23, 639: 24, 770: 25
});

const CWE_NAMES = Object.freeze({
  22: 'Path Traversal',
  78: 'OS Command Injection',
  79: 'Cross-site Scripting',
  89: 'SQL Injection',
  94: 'Code Injection',
  95: 'Eval Injection',
  200: 'Exposure of Sensitive Information to an Unauthorized Actor',
  209: 'Error Message Containing Sensitive Information',
  250: 'Execution with Unnecessary Privileges',
  284: 'Improper Access Control',
  290: 'Authentication Bypass by Spoofing',
  295: 'Improper Certificate Validation',
  306: 'Missing Authentication for Critical Function',
  307: 'Excessive Authentication Attempts',
  311: 'Missing Encryption of Sensitive Data',
  319: 'Cleartext Transmission of Sensitive Information',
  321: 'Use of Hard-coded Cryptographic Key',
  324: 'Use of a Key Past its Expiration Date',
  327: 'Use of a Broken or Risky Cryptographic Algorithm',
  338: 'Weak PRNG',
  345: 'Insufficient Verification of Data Authenticity',
  347: 'Improper Verification of Cryptographic Signature',
  353: 'Missing Support for Integrity Check',
  489: 'Active Debug Code',
  494: 'Download of Code Without Integrity Check',
  497: 'Exposure of Sensitive System Information',
  502: 'Deserialization of Untrusted Data',
  506: 'Embedded Malicious Code',
  527: 'Exposure of Version-Control Repository',
  538: 'Sensitive Information in an Externally-Accessible File',
  540: 'Inclusion of Sensitive Information in Source Code',
  546: 'Suspicious Comment',
  548: 'Exposure of Information Through Directory Listing',
  601: 'Open Redirect',
  611: 'Improper Restriction of XML External Entity Reference',
  614: 'Sensitive Cookie Without Secure Attribute',
  639: 'Authorization Bypass Through User-Controlled Key',
  693: 'Protection Mechanism Failure',
  710: 'Improper Adherence to Coding Standards',
  732: 'Incorrect Permission Assignment for Critical Resource',
  798: 'Use of Hard-coded Credentials',
  829: 'Inclusion of Functionality from Untrusted Control Sphere',
  862: 'Missing Authorization',
  863: 'Incorrect Authorization',
  915: 'Improperly Controlled Modification of Dynamically-Determined Object Attributes',
  916: 'Password Hash With Insufficient Computational Effort',
  918: 'Server-Side Request Forgery',
  942: 'Permissive Cross-domain Policy',
  943: 'Improper Neutralization of Special Elements in Data Query Logic',
  1004: 'Sensitive Cookie Without HttpOnly',
  1021: 'Improper Restriction of Rendered UI Layers',
  1059: 'Insufficient Technical Documentation',
  1321: 'Prototype Pollution',
  1333: 'Inefficient Regular Expression Complexity',
  1357: 'Reliance on Insufficiently Trustworthy Component',
  1395: 'Dependency on Vulnerable Third-Party Component',
  1426: 'Improper Validation of Generative AI Output',
  1427: 'Improper Neutralization of Input Used for LLM Prompting'
});

/*
 * rule: [CWE, OWASP 2025 category, basis]. The basis is 'cwe' unless stated;
 * see the header for what each basis means.
 */
const MAP = Object.freeze({
  /* Supply chain in the repository's own scripts and workflows. */
  'SUP-001': [829, 'A08'], 'SUP-002': [494, 'A08'], 'SUP-003': [506, 'A08'], 'SUP-004': [506, 'A08'],
  'SUP-005': [506, 'A08'], 'SUP-006': [829, 'A08'], 'SUP-007': [829, 'A08'], 'SUP-008': [829, 'A08'],
  'SUP-009': [78, 'A05'],
  /* Code. */
  'SEC-001': [89, 'A05'], 'SEC-002': [79, 'A05'], 'SEC-003': [942, 'A02'], 'SEC-004': [1004, 'A02'],
  'SEC-005': [338, 'A04'], 'SEC-006': [200, 'A01'], 'SEC-007': [345, 'A08'], 'SEC-008': [295, 'A07'],
  'SEC-009': [347, 'A04'], 'SEC-010': [95, 'A05'], 'SEC-011': [78, 'A05'], 'SEC-012': [307, 'A07'],
  'SEC-013': [489, 'A02'],
  /* Row level security switched off or never enabled: no authorization check at all. */
  'SEC-014': [862, 'A01'], 'SEC-015': [862, 'A01'],
  /* A policy or rule that exists but lets everyone through: the check decides wrongly. */
  'SEC-016': [863, 'A01'], 'SEC-017': [863, 'A01'], 'SEC-018': [863, 'A01'],
  'SEC-019': [200, 'A01'], 'SEC-020': [601, 'A01'], 'SEC-021': [918, 'A01'], 'SEC-022': [22, 'A01'],
  'SEC-023': [916, 'A04'], 'SEC-024': [502, 'A08'], 'SEC-025': [321, 'A04'],
  /*
   * Regular-expression complexity, prototype pollution, NoSQL operators and
   * the two language-model weaknesses have CWEs on no 2025 list; each is
   * filed where its description sits. Prototype pollution's parent, CWE-915,
   * is on A08's list, and mass assignment is filed under it directly.
   */
  'SEC-026': [1333, 'A05', 'scope'], 'SEC-027': [1321, 'A08', 'scope'], 'SEC-028': [915, 'A08'], 'SEC-029': [943, 'A05', 'scope'],
  'SEC-030': [94, 'A05'], 'SEC-031': [209, 'A10'], 'SEC-032': [546, null], 'SEC-033': [79, 'A05'], 'SEC-034': [611, 'A02'],
  /* Access: no authorization, a key the caller chooses, no authentication for a critical function. */
  'ACC-001': [862, 'A01'], 'ACC-002': [639, 'A01'], 'ACC-003': [306, 'A07'], 'ACC-004': [862, 'A01'], 'ACC-005': [306, 'A07'],
  /* Language models. */
  'AI-001': [1426, 'A05', 'scope'], 'AI-002': [1427, 'A05', 'scope'], 'AI-003': [200, 'A01'],
  /* Secrets. */
  'SCR-001': [798, 'A07'],
  /* Dependencies: A03:2025 is the old "Vulnerable and Outdated Components", widened. */
  'DEP-001': [1357, 'A03'], 'DEP-002': [1357, 'A03'], 'DEP-003': [1395, 'A03'], 'DEP-004': [1357, 'A03'],
  'DEP-005': [1395, 'A03'], 'DEP-006': [506, 'A08'],
  /* Infrastructure. CWE-250 is on no 2025 list; running with more privilege than needed is a hardening failure (A02). */
  'IAC-001': [250, 'A02', 'scope'], 'IAC-002': [494, 'A08'], 'IAC-003': [798, 'A07'], 'IAC-004': [732, 'A01'],
  'IAC-005': [732, 'A01'], 'IAC-006': [284, 'A01'], 'IAC-007': [311, 'A06'], 'IAC-008': [284, 'A01'],
  'IAC-009': [250, 'A02', 'scope'], 'IAC-010': [250, 'A02', 'scope'],
  /* Hygiene. */
  'HYG-001': [538, 'A01'], 'HYG-002': [538, 'A01'], 'HYG-003': [1357, 'A03'], 'HYG-004': [1357, 'A03'],
  'HYG-005': [1357, 'A03'], 'HYG-006': [1357, 'A03'], 'HYG-007': [710, null], 'HYG-008': [1059, null],
  'HYG-009': [710, null],
  /* The site check. Security headers are filed by A02's own text. */
  'WEB-001': [538, 'A01'],
  /* CWE-527 is on no 2025 list; its parent, CWE-538, is A01. */
  'WEB-002': [527, 'A01', 'scope'],
  'WEB-003': [319, 'A02', 'text'], 'WEB-004': [319, 'A02', 'text'], 'WEB-005': [693, 'A02', 'text'],
  'WEB-006': [693, 'A02', 'text'], 'WEB-007': [1021, 'A02', 'text'], 'WEB-008': [693, 'A02', 'text'],
  'WEB-009': [200, 'A02', 'text'], 'WEB-010': [942, 'A02'], 'WEB-011': [614, 'A02'], 'WEB-012': [1004, 'A02'],
  'WEB-013': [497, 'A01'], 'WEB-014': [1059, null], 'WEB-015': [538, 'A01'], 'WEB-016': [693, 'A02', 'text'],
  'WEB-017': [693, 'A02', 'text'], 'WEB-018': [319, 'A04'], 'WEB-019': [353, 'A08'],
  /* The deeper site check: the connection, what errors and listings give away, what the JavaScript ships, email. */
  'WEB-020': [319, 'A04'], 'WEB-021': [209, 'A10'], 'WEB-022': [548, 'A01'], 'WEB-023': [798, 'A07'],
  'WEB-024': [540, 'A01'], 'WEB-025': [1395, 'A03'], 'WEB-026': [1059, null], 'WEB-027': [290, 'A07'],
  'WEB-028': [290, 'A07'], 'WEB-029': [324, 'A04'], 'WEB-030': [324, 'A04'], 'WEB-031': [327, 'A04'],
  'WEB-032': [693, 'A02', 'text'], 'WEB-033': [319, 'A04'], 'WEB-034': [497, 'A01'], 'WEB-035': [538, 'A01'],
  /* CWE-527's parent is CWE-538, as for the Git directory. */
  'WEB-036': [527, 'A01', 'scope'],
  'WEB-037': [693, 'A02', 'text']
});

/* The labels for one rule, or null when the rule is not mapped. */
function standardsFor(rule) {
  const entry = MAP[rule];
  if (!entry) return null;
  const [cwe, owasp, basis = 'cwe'] = entry;
  const rank = CWE_TOP25_2025[cwe] || null;
  return Object.freeze({
    cwe: `CWE-${cwe}`,
    cweName: CWE_NAMES[cwe] || null,
    owasp: owasp ? `${owasp}:${OWASP_EDITION}` : null,
    owaspName: owasp ? OWASP_2025[owasp] : null,
    owaspBasis: owasp ? basis : null,
    top25: rank ? Object.freeze({ rank, year: 2025 }) : null
  });
}

module.exports = Object.freeze({
  standardsFor, OWASP_EDITION, OWASP_2025, OWASP_2025_CWES, CWE_TOP25_2025, CWE_NAMES,
  MAP, MAPPED_RULES: Object.freeze(Object.keys(MAP))
});
