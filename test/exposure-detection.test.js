'use strict';

/*
 * Finding every credential in a file, not the first one.
 *
 * The release gate that already exists answers a different question. It asks
 * "is there a secret in this repository" and stops at the first match per rule
 * per file, because one is enough to fail a build. A reader triaging an
 * exposure needs the other answer: which credentials, how many times each, and
 * where -- and a scanner that reports one github token in a file holding four
 * has told them the repository is clean three times over.
 *
 * Two hazards come with enumerating rather than sampling. A global regex
 * carries `lastIndex` between calls, so a rule object shared across files
 * silently skips the beginning of the second file. And enumeration is
 * unbounded by nature: a generated file with ten thousand matches is a
 * denial-of-service against one free web service. Both are tested here rather
 * than commented on.
 *
 * Everything this module exports is sanitized. The bytes exist for exactly as
 * long as a verification probe needs them and leave by one documented door.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  DETECTION_ENGINE_VERSION,
  MAX_CANDIDATES_PER_FILE,
  MAX_MATCHES_PER_FILE,
  MAX_OCCURRENCES_PER_CANDIDATE,
  MAX_TEXT_BYTES,
  RULES_VERSION,
  detectInText,
  sanitizeCandidate
} = require('../src/exposure-detection');

/* Split prefixes: this file is scanned by the gate it is testing. */
const TOKEN_A = `gh${'p'}_${'A'.repeat(36)}`;
const TOKEN_B = `gh${'p'}_${'B'.repeat(36)}`;
const SLACK = `xo${'xb'}-${'C'.repeat(24)}`;
const GITLAB = `gl${'pat'}-${'D'.repeat(24)}`;

function candidatesOf(text, filePath = 'app/config.js') {
  return detectInText({ text, path: filePath });
}

function bytesOf(result, secret) {
  return result.candidates.find(candidate => candidate.secret === secret);
}

/* ---- Enumeration ------------------------------------------------------- */

/*
 * The defect this module exists to fix. Two different tokens under one rule
 * are two candidates; the existing gate reports one and is right to, for its
 * own purpose.
 */
{
  const result = candidatesOf(`first=${TOKEN_A}\nsecond=${TOKEN_B}\n`);
  assert.strictEqual(result.candidates.length, 2, 'two different credentials are two candidates');
  assert.deepStrictEqual(
    result.candidates.map(candidate => candidate.rule), ['github-token', 'github-token']
  );
  assert(bytesOf(result, TOKEN_A) && bytesOf(result, TOKEN_B));
  assert.strictEqual(result.truncated, false);
}

/* The same credential in four places is one candidate with four locations.
   It is one exposure, and reporting it four times would make a reader
   revoke one key four times. */
{
  const text = [`a=${TOKEN_A}`, 'unrelated', `b=${TOKEN_A}`, `c=${TOKEN_A}`, '', `d=${TOKEN_A}`].join('\n');
  const result = candidatesOf(text);
  assert.strictEqual(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.strictEqual(candidate.occurrenceCount, 4);
  assert.deepStrictEqual(candidate.occurrences.map(item => item.line), [1, 3, 4, 6]);
  assert.deepStrictEqual(candidate.occurrences.map(item => item.column), [3, 3, 3, 3]);
  assert.strictEqual(candidate.truncated, false);
}

/*
 * Rules do not share regex state, and the case that proves it is specifically
 * the one after a truncated file.
 *
 * A global expression carries `lastIndex` between calls. An `exec` loop that
 * runs to completion resets it on the way out, so sharing a compiled rule
 * across two ordinary files happens to be harmless -- which is exactly why
 * this is worth a deliberate fixture rather than the obvious two-file check
 * that passes either way. The match ceiling exits the loop early and leaves
 * `lastIndex` pointing into the middle of the previous file. The next file is
 * then searched from that offset, so its beginning is never looked at, and a
 * file whose only credential is on line one is reported clean.
 */
{
  const flood = Array.from({ length: MAX_MATCHES_PER_FILE + 20 }, () => TOKEN_A).join('\n');
  const truncatedFirst = candidatesOf(flood, 'generated.lock');
  assert.strictEqual(truncatedFirst.truncated, true, 'the fixture must actually hit the ceiling');

  const afterwards = candidatesOf(`${TOKEN_A}\n`, 'small.txt');
  assert.strictEqual(
    afterwards.candidates.length, 1,
    'a file scanned after a truncated one starts at its own beginning'
  );
  assert.strictEqual(afterwards.candidates[0].occurrences[0].line, 1);

  /* The ordinary sequence too, and repeating a detection gives the same
     answer -- which is what makes a finding reproducible from a commit. */
  const first = candidatesOf(`${TOKEN_A}\n`, 'one.txt');
  const second = candidatesOf(`${TOKEN_A}\n`, 'two.txt');
  const repeated = candidatesOf(`${TOKEN_A}\n`, 'one.txt');
  assert.strictEqual(second.candidates.length, 1);
  assert.deepStrictEqual(
    repeated.candidates.map(sanitizeCandidate), first.candidates.map(sanitizeCandidate)
  );
}

/* Several rules in one file, each enumerated independently. */
{
  const result = candidatesOf([`${TOKEN_A}`, `${SLACK}`, `${GITLAB}`, `${TOKEN_B}`].join('\n'));
  assert.deepStrictEqual(
    result.candidates.map(candidate => candidate.rule).sort(),
    ['github-token', 'github-token', 'gitlab-token', 'slack-token']
  );
}

/* ---- Locations --------------------------------------------------------- */

/*
 * A line number is where a credential is, not what it is. It moves when
 * somebody adds an import above it, and a finding that changed identity every
 * time a file was reformatted would be a new finding every commit.
 */
{
  const plain = candidatesOf(`${TOKEN_A}\n`);
  const shifted = candidatesOf(`// a comment\n// another\n${TOKEN_A}\n`);
  assert.strictEqual(plain.candidates[0].occurrences[0].line, 1);
  assert.strictEqual(shifted.candidates[0].occurrences[0].line, 3);
  assert.strictEqual(
    plain.candidates[0].secret, shifted.candidates[0].secret,
    'the credential is the same credential wherever it sits'
  );
}

/* CRLF and LF describe the same lines. A Windows checkout must not report
   different locations for the same file. */
{
  const unix = candidatesOf(['one', `two=${TOKEN_A}`, 'three'].join('\n'));
  const windows = candidatesOf(['one', `two=${TOKEN_A}`, 'three'].join('\r\n'));
  assert.deepStrictEqual(
    windows.candidates.map(sanitizeCandidate), unix.candidates.map(sanitizeCandidate)
  );
  assert.strictEqual(windows.candidates[0].occurrences[0].line, 2);
  assert.strictEqual(windows.candidates[0].occurrences[0].column, 5);
  assert.strictEqual(
    windows.candidates[0].secret, unix.candidates[0].secret,
    'and the bytes are not normalised on the way in'
  );
}

/* A lone carriage return is a line ending too, and miscounting it would put a
   reader on the wrong line of a legacy file. */
{
  const result = candidatesOf(['one', 'two', `three=${TOKEN_A}`].join('\r'));
  assert.strictEqual(result.candidates[0].occurrences[0].line, 3);
}

/* ---- Bounds ------------------------------------------------------------ */

/* One credential repeated past the ceiling: the locations stop, the count
   does not lie, and the candidate says it was cut. */
{
  const copies = MAX_OCCURRENCES_PER_CANDIDATE + 12;
  const result = candidatesOf(Array.from({ length: copies }, () => `k=${TOKEN_A}`).join('\n'));
  const [candidate] = result.candidates;
  assert.strictEqual(candidate.occurrences.length, MAX_OCCURRENCES_PER_CANDIDATE);
  assert.strictEqual(candidate.occurrenceCount, copies, 'a bounded list is not a bounded count');
  assert.strictEqual(candidate.truncated, true);
}

/* Many distinct credentials: the candidate list is bounded and says so.
   Partial coverage is an honest answer; silently dropping the tail is not. */
{
  const many = Array.from(
    { length: MAX_CANDIDATES_PER_FILE + 10 },
    (_value, index) => `gh${'p'}_${String(index).padStart(36, '0')}`
  );
  const result = candidatesOf(many.join('\n'));
  assert.strictEqual(result.candidates.length, MAX_CANDIDATES_PER_FILE);
  assert.strictEqual(result.truncated, true);
}

/* A generated file with more matches than anyone will read stops at the match
   ceiling rather than walking all of it. */
{
  const flood = Array.from({ length: MAX_MATCHES_PER_FILE + 50 }, () => TOKEN_A).join('\n');
  const result = candidatesOf(flood);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.matchCount, MAX_MATCHES_PER_FILE);
}

/* Text past the size ceiling is not scanned, and the result says that rather
   than reporting an empty file as clean. */
{
  const huge = `${'x'.repeat(MAX_TEXT_BYTES + 1)}\n${TOKEN_A}`;
  const result = candidatesOf(huge);
  assert.strictEqual(result.scanned, false);
  assert.strictEqual(result.truncated, true);
  assert.deepStrictEqual(result.candidates, []);
}

/* And the ordinary cases do not claim to be partial. */
{
  for (const text of ['', 'nothing here\n', `${TOKEN_A}\n`]) {
    const result = candidatesOf(text);
    assert.strictEqual(result.scanned, true, JSON.stringify(text.slice(0, 20)));
    assert.strictEqual(result.truncated, false, JSON.stringify(text.slice(0, 20)));
  }
}

/* ---- What comes out ---------------------------------------------------- */

/*
 * The sanitized form is what everything downstream sees. The bytes stay on the
 * internal candidate, which exists for as long as a verification probe needs
 * it -- and this file does not pretend that a JavaScript string can be wiped
 * afterwards, only that it is copied as little as possible and never stored.
 */
{
  const neighbours = `${TOKEN_A} ${TOKEN_B} ${SLACK}\n`;
  const result = candidatesOf(neighbours);
  const sanitized = result.candidates.map(sanitizeCandidate);

  for (const candidate of sanitized) {
    assert.strictEqual('secret' in candidate, false, 'a sanitized candidate carries no bytes');
    assert(Object.isFrozen(candidate));
    assert.deepStrictEqual(Object.keys(candidate).sort(), [
      'occurrenceCount', 'occurrences', 'placeholder', 'rule', 'truncated'
    ]);
  }

  const serialized = JSON.stringify(sanitized);
  for (const secret of [TOKEN_A, TOKEN_B, SLACK, TOKEN_A.slice(4, 24)]) {
    assert.strictEqual(
      serialized.includes(secret), false,
      'no credential, and no neighbouring credential, reaches the sanitized form'
    );
  }

  /*
   * A placeholder is a generated label, not a redacted secret. A partial
   * redaction publishes a prefix, and a prefix of a token is the part that
   * says which provider and which account -- which is most of what an
   * attacker wanted from the leak.
   */
  for (const candidate of sanitized) {
    assert.match(candidate.placeholder, /^<[a-z-]+ #\d+>$/);
    for (const secret of [TOKEN_A, TOKEN_B, SLACK]) {
      for (let length = 4; length <= 12; length += 1) {
        assert.strictEqual(
          candidate.placeholder.includes(secret.slice(0, length)), false,
          'a placeholder never carries any prefix of a credential'
        );
      }
    }
  }
}

/* Locations are bounded integers, not offsets a caller could use to slice the
   file back out of a finding. */
{
  const result = candidatesOf(`  key = ${TOKEN_A}\n`);
  const [occurrence] = sanitizeCandidate(result.candidates[0]).occurrences;
  assert.deepStrictEqual(Object.keys(occurrence).sort(), ['column', 'line']);
  assert.strictEqual(occurrence.line, 1);
  assert.strictEqual(occurrence.column, 9);
  assert(Object.isFrozen(occurrence));
}

/* ---- Versions ---------------------------------------------------------- */

/*
 * Both versions are part of a finding's identity, so they have to be values
 * this module states rather than something derived at read time. The rules
 * version is checked against the rule set it describes: adding a rule without
 * moving the version would leave two different detections claiming to be the
 * same one.
 */
{
  assert(Number.isInteger(DETECTION_ENGINE_VERSION) && DETECTION_ENGINE_VERSION >= 1);
  assert(Number.isInteger(RULES_VERSION) && RULES_VERSION >= 1);

  const { RULES } = require('../src/secret-scanner');
  const digest = crypto.createHash('sha256')
    .update(RULES.map(rule => `${rule.rule}\u0000${rule.regex.source}\u0000${rule.regex.flags}`).join('\u0001'))
    .digest('hex');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-detection.js'), 'utf8');
  assert(
    source.includes(digest),
    `the rule set changed without RULES_VERSION moving: record ${digest} and raise the version`
  );
}

console.log('exposure detection tests passed');
