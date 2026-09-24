'use strict';

/*
 * Saying what a finding means, in words, without a model.
 *
 * A finding is a rule name, a path, a line and three or four version numbers.
 * That is enough to act on if you already know what `contextual-provider-secret`
 * implies, and useless otherwise -- and the person who most needs to act is
 * the one least likely to know.
 *
 * So there is an explanation per rule and per outcome, and it is a lookup
 * table rather than a generator. A generator would be shorter and would drift:
 * the same finding would be described differently between runs, a reader
 * comparing two scans could not tell whether the wording or the world had
 * changed, and nobody could review the sentences because nobody could
 * enumerate them. A table can be read end to end by a person, and a rule added
 * without an entry fails this test rather than producing a finding that says
 * nothing.
 *
 * And no narration may quote the credential or its fingerprint. The whole
 * point of the placeholder is that a finding can be read aloud, pasted into a
 * ticket and shown on a screen in an open-plan office.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { RULES: GATE_RULES } = require('../src/secret-scanner');
const { EXPOSURE_RULES, PATH_RULES } = require('../src/exposure-detection');
/*
 * Every rule a scan actually runs: the gate's, the scan's own, and the rules
 * that recognise a file by its name. A narration table checked against only
 * the shared gate rules would let the scan's own rules -- the ones whose
 * wording matters most, because they are the ones a reader has never seen
 * before -- ship with no sentence at all.
 */
const RULES = Object.freeze([...GATE_RULES, ...EXPOSURE_RULES, ...PATH_RULES]);
const { REASONS: VERIFICATION_REASONS, VERIFICATION_STATES } = require('../src/credential-verification');
const { REASONS: PROBE_REASONS, PROBE_STATES } = require('../src/anonymous-readability-probe');
const { DISPOSITIONS } = require('../src/exposure-store');
const {
  NARRATION_VERSION,
  describeDisposition,
  describeFinding,
  describeLocation,
  describeProbe,
  describeVerification,
  narrationForRule,
  safeDisplayPath
} = require('../src/exposure-narration');

const finding = Object.freeze({
  fingerprint: 'f'.repeat(64),
  fingerprintKeyVersion: 1,
  rulesVersion: 1,
  engineVersion: 1,
  rule: 'github-token',
  path: 'app/config.js',
  placeholder: '<github-token #1>',
  occurrences: Object.freeze([Object.freeze({ line: 4, column: 11 })]),
  occurrenceCount: 1,
  truncated: false,
  scope: Object.freeze({ provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo' }),
  commit: 'c'.repeat(40),
  disposition: 'open'
});

/* ---- Every rule has an entry, and adding one without an entry fails --- */

{
  assert(Number.isInteger(NARRATION_VERSION) && NARRATION_VERSION >= 1);
  assert(RULES.length >= 70, 'the rule set must be non-trivial for this to mean anything');

  for (const { rule } of RULES) {
    const narration = narrationForRule(rule);
    assert(narration, `no narration for rule: ${rule}`);
    /*
     * The consequence first, in the reader's terms. "A GitHub personal access
     * token" is what it is; "anyone holding this can act as you on GitHub" is
     * what it means, and only the second tells somebody whether to stop what
     * they are doing.
     */
    assert(narration.consequence.length > 40, `${rule}: the consequence must be a sentence`);
    assert(narration.action.length > 20, `${rule}: a reader must be told what to do`);
    assert.match(narration.severity, /^(critical|serious|warning)$/, rule);
    assert(Object.isFrozen(narration), rule);
  }

  /* A rule that does not exist has no narration, rather than a generic one. */
  for (const unknown of ['not-a-rule', '', null, 'github-token ']) {
    assert.strictEqual(narrationForRule(unknown), null, JSON.stringify(unknown));
  }

  /*
   * And the table has no entries for rules that do not exist. An orphan entry
   * is a sentence nobody will ever read and, worse, a sentence a reviewer will
   * assume is reachable.
   */
  const ruleNames = new Set(RULES.map(entry => entry.rule));
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-narration.js'), 'utf8');
  const table = source.match(/const RULE_NARRATION = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert(table, 'the narration table must be declared in one place');
  const declared = [...table[0].matchAll(/^\s{2}'([a-z][a-z0-9-]*)':/gm)].map(match => match[1]);
  assert.strictEqual(declared.length, RULES.length, `the table must have one entry per rule: ${declared.join(', ')}`);
  assert.deepStrictEqual(
    declared.filter(name => !ruleNames.has(name)), [],
    'the table must not describe a rule that does not exist'
  );
  assert.deepStrictEqual(
    [...ruleNames].filter(name => !declared.includes(name)), [],
    'and must describe every rule that does'
  );
}

/* ---- Every verification and probe outcome has an entry ---------------- */

{
  for (const reason of Object.values(VERIFICATION_REASONS)) {
    const sentence = describeVerification({ state: VERIFICATION_STATES.UNVERIFIABLE, reason });
    assert(sentence, `no narration for verification reason: ${reason}`);
    assert(sentence.length > 25, `${reason}: too short to explain anything`);
  }
  /* The three states are described distinctly: a reader must be able to tell
     "we asked and it works" from "we could not ask". */
  const verified = describeVerification({ state: VERIFICATION_STATES.VERIFIED, reason: VERIFICATION_REASONS.IDENTITY_CONFIRMED });
  const rejected = describeVerification({ state: VERIFICATION_STATES.REJECTED, reason: VERIFICATION_REASONS.CREDENTIAL_REFUSED });
  const throttled = describeVerification({ state: VERIFICATION_STATES.UNVERIFIABLE, reason: VERIFICATION_REASONS.PROVIDER_THROTTLED });
  assert.strictEqual(new Set([verified, rejected, throttled]).size, 3);
  /*
   * And the unverifiable ones never imply safety. "We could not tell" and "it
   * is harmless" are different sentences and only one of them is true.
   */
  for (const reason of Object.values(VERIFICATION_REASONS)) {
    if (reason === VERIFICATION_REASONS.CREDENTIAL_REFUSED) continue;
    const sentence = describeVerification({ state: VERIFICATION_STATES.UNVERIFIABLE, reason });
    assert.strictEqual(
      /\bno longer works\b|\bis safe\b|\bharmless\b|\brevoked\b/.test(sentence), false,
      `an unverifiable outcome must not read as safe: ${reason} -> ${sentence}`
    );
  }
  assert.strictEqual(describeVerification(null), null, 'no record, no sentence');
  assert.strictEqual(describeVerification({ state: 'invented', reason: 'nope' }), null);

  for (const reason of Object.values(PROBE_REASONS)) {
    const sentence = describeProbe({ state: PROBE_STATES.UNVERIFIABLE, reason });
    assert(sentence, `no narration for probe reason: ${reason}`);
  }
  /*
   * The two that matter most. An empty result and a refusal must both read as
   * "this is not an answer about the table", because a reader told "protected"
   * stops looking.
   */
  for (const [state, reason] of [
    [PROBE_STATES.UNVERIFIABLE, PROBE_REASONS.NO_VISIBLE_ROWS],
    [PROBE_STATES.DENIED, PROBE_REASONS.ACCESS_DENIED_FOR_TESTED_REQUEST]
  ]) {
    const sentence = describeProbe({ state, reason });
    assert.strictEqual(
      /\bprotected\b|\bsecure\b|\bis safe\b|row-level security is on/.test(sentence), false,
      `${reason} must not read as proof of protection: ${sentence}`
    );
  }
  const readable = describeProbe({ state: PROBE_STATES.READABLE, reason: PROBE_REASONS.ROWS_VISIBLE });
  assert(readable.length > 40);
}

/* ---- Every disposition has an entry ----------------------------------- */

{
  for (const disposition of DISPOSITIONS) {
    const sentence = describeDisposition(disposition);
    assert(sentence, `no narration for disposition: ${disposition}`);
  }
  /*
   * `removed-from-tree` is the one that has to be careful. The credential is
   * still in the repository's history, reachable by anybody with a clone, so
   * the sentence must say so rather than reading as resolved.
   */
  const removed = describeDisposition('removed-from-tree');
  assert.match(removed, /history/i, 'a credential gone from HEAD is still in history and the words must say it');
  assert.strictEqual(/\bresolved\b|\bfixed\b|no longer a problem/.test(removed), false, removed);
  assert.strictEqual(describeDisposition('invented'), null);
}

/* ---- A narration is a pure function of the record --------------------- */

{
  const first = describeFinding(finding);
  const second = describeFinding(finding);
  const third = describeFinding({ ...finding, occurrences: [{ line: 4, column: 11 }] });
  assert.deepStrictEqual(first, second, 'the same record produces the same words, every run');
  assert.deepStrictEqual(first, third, 'and a structurally equal record produces them too');
  assert(Object.isFrozen(first));

  /* Nothing in it depends on the clock, the environment or a counter. */
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-narration.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(source.includes('function describeFinding'), 'the comment strip must leave the code behind');
  for (const forbidden of [/Date\.now|new Date/, /Math\.random/, /process\.env/, /require\('crypto'\)/]) {
    assert.strictEqual(
      forbidden.test(source), false,
      `narration must be a pure function of the record: ${forbidden}`
    );
  }

  /* The location is stated, and the placeholder rather than the credential. */
  assert.match(first.where, /app\/config\.js/);
  assert.match(first.where, /line 4/);
  assert(first.what.includes('<github-token #1>'), 'the placeholder is how a finding is referred to');
  assert.strictEqual(first.severity, 'critical');

  /* Several occurrences are counted rather than listed forever. */
  const many = describeFinding({
    ...finding,
    occurrences: [{ line: 4, column: 1 }, { line: 9, column: 1 }, { line: 12, column: 1 }],
    occurrenceCount: 3
  });
  assert.match(many.where, /3 places/);
  const truncated = describeFinding({ ...finding, occurrenceCount: 400, truncated: true });
  assert.match(truncated.where, /400/);
  assert.match(truncated.where, /first/i, 'a cut list must say it was cut');

  /* An unknown rule is described as unknown rather than silently omitted. */
  const unknown = describeFinding({ ...finding, rule: 'not-a-rule' });
  assert(unknown, 'a finding with no narration must still be describable');
  assert.match(unknown.what, /not-a-rule/);
  assert.strictEqual(unknown.severity, 'serious', 'an unexplained credential is not downgraded');
}

/* ---- No narration carries the secret or the fingerprint --------------- */

{
  const SECRET = `gh${'p'}_${'N'.repeat(36)}`;
  const records = [
    finding,
    { ...finding, path: `secrets/${SECRET}.js`, placeholder: '<github-token #2>' },
    { ...finding, rule: 'private-key' },
    { ...finding, rule: 'authenticated-url' },
    { ...finding, occurrenceCount: 400, truncated: true }
  ];
  const surfaces = [];
  for (const record of records) surfaces.push(JSON.stringify(describeFinding(record)));
  for (const reason of Object.values(VERIFICATION_REASONS)) {
    surfaces.push(String(describeVerification({ state: VERIFICATION_STATES.UNVERIFIABLE, reason })));
  }
  for (const disposition of DISPOSITIONS) surfaces.push(String(describeDisposition(disposition)));

  assert(surfaces.length > 10);
  for (const surface of surfaces) {
    assert.strictEqual(surface.includes(SECRET), false, `a credential reached narration: ${surface.slice(0, 90)}`);
    assert.strictEqual(
      surface.includes(finding.fingerprint), false,
      'and neither does the fingerprint: it is an identifier for the machine, not a thing to read out'
    );
    assert.strictEqual(surface.includes('f'.repeat(32)), false);
  }
  /*
   * The path is quoted, and a path can contain anything a repository chose to
   * name a file -- including something shaped like a credential. So the one
   * case where a secret could reach a sentence is asserted directly rather
   * than reasoned about.
   */
  const viaPath = JSON.stringify(describeFinding(records[1]));
  assert.strictEqual(viaPath.includes(SECRET), false, 'a credential in a file name must not be quoted back');
  assert.match(viaPath, /secrets\//, 'while the path is still identified well enough to find');
}

/* ---- The reference document restates the code, so it is checked ------ */

/*
 * The document is where somebody goes to find out what a word in a finding
 * means, which makes it a second statement of the same vocabulary -- and a
 * restatement drifts. The capability document in this repository already
 * taught that lesson: prose describing a registry went stale while every gate
 * stayed green.
 *
 * So the tables that enumerate something the code also enumerates are compared
 * against it, and the sentences that must not appear are checked by pattern.
 */
{
  const reference = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'reference', 'exposure-findings.md'), 'utf8'
  );

  /*
   * A row of its own, not merely a mention. Every disposition is also listed
   * in the finding-shape table at the top, so checking for the word alone
   * passes when the row explaining it has been deleted -- which is exactly the
   * drift this guard is for.
   */
  function rowsUnder(heading) {
    const section = reference.split(`\n## `).find(part => part.startsWith(heading));
    assert(section, `the reference document has no ${heading} section`);
    return section.split('\n').filter(line => line.startsWith('| `'));
  }

  const dispositionRows = rowsUnder('Dispositions');
  assert.strictEqual(
    dispositionRows.length, DISPOSITIONS.length,
    `the dispositions table must have one row per disposition: ${dispositionRows.length}`
  );
  for (const disposition of DISPOSITIONS) {
    assert(
      dispositionRows.some(row => row.startsWith(`| \`${disposition}\` |`)),
      `the dispositions table has no row for ${disposition}`
    );
  }

  const stateRows = rowsUnder('Liveness is not severity');
  assert.strictEqual(stateRows.length, Object.values(VERIFICATION_STATES).length);
  for (const state of Object.values(VERIFICATION_STATES)) {
    assert(
      stateRows.some(row => row.startsWith(`| \`${state}\` |`)),
      `the verification table has no row for ${state}`
    );
  }

  /*
   * And the claims it must never make. These are the four sentences that would
   * quietly turn an honest product into a dishonest one, so they are asserted
   * absent rather than trusted to nobody's pen.
   */
  const paragraphs = reference.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const compact = paragraph.replace(/\s+/g, ' ');
    if (/removed-from-tree/.test(compact) && /^\|/.test(paragraph.trim()) === false) {
      assert.strictEqual(
        /is resolved|no longer a problem|nothing further/.test(compact), false,
        `a paragraph about removed-from-tree reads as resolved: ${compact.slice(0, 100)}`
      );
    }
  }
  assert.match(reference, /still in the repository's history/i, 'the history caveat must be stated');
  assert.match(reference, /Partial coverage is not an all-clear/i, 'partial coverage must be explained');
  assert.match(
    reference, /Not that the table is protected/i,
    'the document must say what a refused probe does not prove'
  );
  assert.match(
    reference, /only.{0,20}outcome that means the exposure is over/i,
    'the document must name the one outcome that ends an exposure'
  );

  /* The document is registered, and under the lifecycle a reader expects. */
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'docs', 'DOCUMENTATION_MANIFEST.json'), 'utf8')
  );
  const entry = manifest.documents.find(item => item.path === 'docs/reference/exposure-findings.md');
  assert(entry, 'the reference document must be registered in the manifest');
  assert.strictEqual(entry.lifecycle, 'current');
  assert.strictEqual(entry.releaseIncluded, true);
}

/* ---- Showing a path ----------------------------------------------------- */

/*
 * A path is shown as it is, because "where" is the half of a finding a reader
 * acts on. Only a part that could itself be a credential is withheld. The old
 * test withheld any name with twenty word characters in a row, which is most
 * of an ordinary repository's test files and workflows.
 */
{
  for (const ordinary of [
    'test/anonymous-readability-probe.test.js',
    '.github/workflows/public-alpha-alpha17.yml',
    '.github/workflows/ci.yml',
    'db/migrations/026_exposure_scan_history.sql',
    'src/ExposureFindingsReportController.js',
    'cache/351a023f-2c99-42a7-8c14-3fff04c0bbfa.json',
    'release/nebulaverse-x-v5.3.0-alpha.17.0.zip'
  ]) {
    assert.strictEqual(safeDisplayPath(ordinary), ordinary, `${ordinary} is an ordinary name and is shown`);
  }

  /* Built from parts so no token is written in this file. */
  const githubToken = ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5b'].join('');
  const awsKeyId = ['AK', 'IA', 'Q3EGT5XRZ7W2PL4M'].join('');
  const unnamedToken = ['k7Qm2Xp9', 'Lr4Tz8Vw'].join('');
  /* Hyphenated into short pieces, so only a rule can recognise it. */
  const slackToken = ['xo', 'xb-', '284619370452-', '573920184657-', 'qWkRmTzPvLxNcBhJdGfSaYeU'].join('');
  const cases = [
    /* Named by a rule: withheld, and the file keeps what kind of file it is. */
    [`secrets/${githubToken}.txt`, 'secrets/‹hidden›.txt'],
    [`keys/${awsKeyId}.pem`, 'keys/‹hidden›.pem'],
    /* A directory can be the credential too. */
    [`${githubToken}/config.json`, '‹hidden›/config.json'],
    /* A token no rule names still has a token's shape. */
    [`tmp/${unnamedToken}`, 'tmp/‹hidden›']
  ];
  for (const [raw, shown] of cases) {
    const displayed = safeDisplayPath(raw);
    assert.strictEqual(displayed, shown, `${shown} is what a reader sees`);
    for (const secret of [githubToken, awsKeyId, unnamedToken, slackToken]) {
      assert(!displayed.includes(secret), 'a withheld part never reaches the display');
    }
  }
  assert.strictEqual(safeDisplayPath(''), 'an unnamed file');

  /* The sentence names the line and says why part of the path is missing. */
  const where = describeLocation({
    path: `secrets/${githubToken}.txt`, occurrences: [{ line: 3, column: 1 }], occurrenceCount: 1
  });
  assert.strictEqual(
    where,
    'In secrets/‹hidden›.txt, at line 3. Part of the file\'s path is not shown, because it is itself credential-shaped.'
  );
  assert(!where.includes(githubToken));
  assert.strictEqual(
    describeLocation({ path: '.github/workflows/ci.yml', occurrences: [{ line: 57, column: 9 }], occurrenceCount: 1 }),
    'In .github/workflows/ci.yml, at line 57.',
    'an ordinary path is not followed by an explanation it does not need'
  );
}

console.log('exposure narration tests passed');
