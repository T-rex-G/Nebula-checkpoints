'use strict';

const { RULES } = require('./secret-scanner');

/*
 * Finding every credential in a file, rather than proving one exists.
 *
 * `src/secret-scanner.js` already answers the release gate's question -- is
 * there a secret in this repository -- and stops at the first match per rule
 * per file, because one is enough to fail a build. That is the right shape for
 * a gate and the wrong shape for a reader triaging an exposure, who needs to
 * know which credentials, how many times each, and where. A scan reporting one
 * token in a file holding four has told them the repository is clean three
 * times over.
 *
 * The rules themselves are not re-stated here. They are imported, so there is
 * one definition of what a credential looks like in this repository and a rule
 * improved for the gate improves the scan. What this module adds is
 * enumeration, and enumeration brings two hazards worth naming.
 *
 * A global regular expression carries `lastIndex` across calls. Sharing one
 * compiled rule between files means the second file is searched from wherever
 * the first one finished, which skips its beginning -- and skipping the
 * beginning of a file is how a scan reports a repository clean. So every rule
 * is recompiled per file and never reused.
 *
 * Enumeration is also unbounded by nature. A generated lockfile or a test
 * fixture can hold thousands of matches, and this server has one process and
 * one free web service. Every dimension is therefore capped -- bytes read,
 * matches walked, candidates kept, locations per candidate -- and a result that
 * hit a cap says so. `truncated` is the honest answer; an empty list would be a
 * false all-clear.
 *
 * Nothing exported carries a credential. The bytes live on the internal
 * candidate object for as long as a verification probe needs them and leave
 * through `src/exposure-findings.js`. This module does not pretend they can be
 * erased afterwards: a JavaScript string is immutable and copied by the engine
 * at will, so the claim made here is the weaker true one -- as few copies as
 * possible, and never one that is stored.
 */

/*
 * Both versions are part of a finding's identity, so both are stated rather
 * than derived. The rule-set digest below is checked by this module's test:
 * changing a rule without moving RULES_VERSION would leave two different
 * detections claiming to be the same one, and a finding from each comparing as
 * unchanged.
 *
 * Rule set digest (sha256 over rule name, source and flags):
 *   37a790d120acd31fc814c7fc4c1d9dbe130da2743bc3edef9b01aabeba145f92
 */
const RULES_VERSION = 1;
const DETECTION_ENGINE_VERSION = 1;

/* A file this server will read at all. Past it the file is not scanned and the
   result says so. */
const MAX_TEXT_BYTES = 1024 * 1024;

/* Matches walked in one file, across all rules. A file needing more than this
   is a generated file, and a reader does not triage a generated file
   line by line. */
const MAX_MATCHES_PER_FILE = 200;

/* Distinct credentials kept from one file. */
const MAX_CANDIDATES_PER_FILE = 50;

/* Locations kept for one credential. The count is not capped with the list:
   "found 400 times, here are the first 20" is useful, "found 20 times" is
   wrong. */
const MAX_OCCURRENCES_PER_CANDIDATE = 20;

/*
 * A line ending is \n, \r\n or a bare \r. The last one is why this is a
 * function rather than a split: a legacy Mac-encoded file counted by \n alone
 * reports every credential on line 1, which sends a reader to the wrong place
 * in a file they may not be able to open.
 */
function locationAt(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (code === 10) {
      line += 1;
      lineStart = cursor + 1;
    } else if (code === 13) {
      line += 1;
      /* \r\n is one ending, not two. */
      if (text.charCodeAt(cursor + 1) === 10) cursor += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

/*
 * A fresh expression per file, with the global flag added so `exec` can walk.
 * Recompiling rather than reusing is the whole point: a shared global regex
 * keeps its `lastIndex`, and the bug that causes is invisible in a single-file
 * test.
 */
function compiledRules() {
  return RULES.map(rule => ({
    rule: rule.rule,
    regex: new RegExp(rule.regex.source, `${rule.regex.flags.replace(/[gy]/g, '')}g`)
  }));
}

function sanitizeCandidate(candidate) {
  return Object.freeze({
    rule: candidate.rule,
    placeholder: candidate.placeholder,
    occurrences: candidate.occurrences,
    occurrenceCount: candidate.occurrenceCount,
    truncated: candidate.truncated
  });
}

/*
 * A generated label, not a redaction. Showing the first characters of a token
 * is the usual instinct and it publishes the part that identifies the provider
 * and often the account -- most of what the leak was worth. The number is the
 * order this rule's credentials appear in this file, which makes the label
 * readable and deliberately says nothing about the bytes.
 */
function placeholderFor(rule, ordinal) {
  return `<${rule} #${ordinal}>`;
}

/*
 * Returns { scanned, truncated, matchCount, candidates }. A candidate carries
 * `secret`; `sanitizeCandidate` is what anything outside this file and
 * `exposure-findings` should be looking at.
 */
function detectInText(input = {}) {
  const text = typeof input.text === 'string' ? input.text : '';

  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return Object.freeze({
      scanned: false, truncated: true, matchCount: 0, candidates: Object.freeze([])
    });
  }

  const byKey = new Map();
  const ordinals = new Map();
  let matchCount = 0;
  let truncated = false;

  for (const { rule, regex } of compiledRules()) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      /*
       * A rule whose expression can match nothing would loop forever on a
       * zero-width match, since `lastIndex` would not advance. None does
       * today; the guard is here so adding one is a bounded mistake rather
       * than a hung process.
       */
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      if (matchCount >= MAX_MATCHES_PER_FILE) {
        truncated = true;
        break;
      }
      matchCount += 1;

      const secret = match[0];
      const key = `${rule}\u0000${secret}`;
      let candidate = byKey.get(key);
      if (!candidate) {
        if (byKey.size >= MAX_CANDIDATES_PER_FILE) {
          truncated = true;
          continue;
        }
        const ordinal = (ordinals.get(rule) || 0) + 1;
        ordinals.set(rule, ordinal);
        candidate = {
          rule,
          secret,
          placeholder: placeholderFor(rule, ordinal),
          occurrences: [],
          occurrenceCount: 0,
          truncated: false
        };
        byKey.set(key, candidate);
      }

      candidate.occurrenceCount += 1;
      if (candidate.occurrences.length < MAX_OCCURRENCES_PER_CANDIDATE) {
        candidate.occurrences.push(Object.freeze(locationAt(text, match.index)));
      } else {
        candidate.truncated = true;
      }
    }
    if (matchCount >= MAX_MATCHES_PER_FILE) {
      truncated = true;
      break;
    }
  }

  const candidates = [...byKey.values()].map(candidate => Object.freeze({
    ...candidate,
    occurrences: Object.freeze(candidate.occurrences)
  }));

  return Object.freeze({
    scanned: true,
    truncated,
    matchCount,
    candidates: Object.freeze(candidates)
  });
}

module.exports = Object.freeze({
  DETECTION_ENGINE_VERSION,
  MAX_CANDIDATES_PER_FILE,
  MAX_MATCHES_PER_FILE,
  MAX_OCCURRENCES_PER_CANDIDATE,
  MAX_TEXT_BYTES,
  RULES_VERSION,
  detectInText,
  sanitizeCandidate
});
