'use strict';

const { RULES } = require('./secret-scanner');
const { KEY_KINDS, KEY_PATTERN, classifyKey } = require('./supabase-key-kinds');

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
 * Rules that belong to a scan rather than to the release gate.
 *
 * The gate asks one question -- is there a secret in this repository -- and
 * every rule it carries has to be a secret, because a rule that is not fails
 * builds for things that are fine. A Supabase anonymous key is published in
 * client bundles by design; putting it in the shared set would break every
 * repository that legitimately ships one, which is why these are not there.
 *
 * A scan asks a wider question: what in this tree decides who can read the
 * data. An anonymous key is the input to that question, not the answer --
 * whether it can read anything is decided by policies this server cannot see
 * from the outside, and the only honest way to find out is to ask. So the key
 * is detected here so it can be asked about, and its narration says plainly
 * that finding one is not itself a leak.
 *
 * The service-role key beside it is the opposite case and is here for the
 * opposite reason: it bypasses every policy, so its presence needs no probe
 * to be serious. Both come out of the same shape, and which is which is
 * decided by decoding the key rather than by where it was found.
 */
const EXPOSURE_RULES = Object.freeze([
  Object.freeze({
    rule: 'supabase-anon-key',
    regex: KEY_PATTERN,
    accept: secret => {
      const kind = classifyKey(secret).kind;
      return kind === KEY_KINDS.ANON || kind === KEY_KINDS.PUBLISHABLE;
    }
  }),
  Object.freeze({
    rule: 'supabase-service-role-key',
    regex: KEY_PATTERN,
    /*
     * `sb_secret_` as well as the JWT, because a project that has migrated to
     * the newer key format has the same credential under a different name and
     * a rule that missed it would report the repository clean.
     */
    accept: secret => {
      const kind = classifyKey(secret).kind;
      return kind === KEY_KINDS.SERVICE_ROLE || kind === KEY_KINDS.SECRET;
    }
  })
]);

/*
 * Both versions are part of a finding's identity, so both are stated rather
 * than derived. The rule-set digest below is checked by this module's test:
 * changing a rule without moving RULES_VERSION would leave two different
 * detections claiming to be the same one, and a finding from each comparing as
 * unchanged.
 *
 * Rule set digest (sha256 over rule name, source and flags, gate rules then
 * scan rules):
 *   0c9d1ba4c9a3e895173c13b15bb6144fa6d4b28d5d65f7fa1b78b40e3da08f8c
 */
const RULES_VERSION = 2;
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

/**
 * The rules a scan runs: the shared release-gate set, then this module's own.
 * Spelled out as a type because the two halves have different shapes -- only
 * the scan's rules carry a predicate -- and a union of the literal shapes
 * would make reading `accept` an error on the half that has none.
 *
 * @typedef {{ rule: string, regex: RegExp, accept?: (secret: string) => boolean }} DetectionRule
 */

/*
 * A fresh expression per file, with the global flag added so `exec` can walk.
 * Recompiling rather than reusing is the whole point: a shared global regex
 * keeps its `lastIndex`, and the bug that causes is invisible in a single-file
 * test.
 */
function compiledRules() {
  /** @type {ReadonlyArray<DetectionRule>} */
  const all = [...RULES, ...EXPOSURE_RULES];
  /*
   * Grouped by expression, so a shape two rules share is walked once.
   *
   * The two Supabase rules are the same pattern -- an anonymous key and a
   * service-role key look almost identical and are told apart by decoding
   * them, not by matching them. Compiling them as two passes would walk every
   * file twice and, worse, spend two of this file's match budget on every
   * key it contains, including keys neither rule wants. A file of unrelated
   * JWTs would then report itself truncated, which is a scan saying it could
   * not read everything about a file where there was nothing to read.
   *
   * A match belongs to the first rule in this pass that accepts it, in
   * declaration order. A rule with no predicate accepts everything, which is
   * correct for the release-gate rules -- each has a pattern of its own -- and
   * is why one would swallow a pass it shared.
   */
  const passes = new Map();
  for (const rule of all) {
    const flags = rule.regex.flags.replace(/[gy]/g, '');
    const key = `${rule.regex.source}\u0000${flags}`;
    let pass = passes.get(key);
    if (!pass) {
      pass = { regex: new RegExp(rule.regex.source, `${flags}g`), rules: [] };
      passes.set(key, pass);
    }
    pass.rules.push({
      rule: rule.rule,
      accept: typeof rule.accept === 'function' ? rule.accept : null
    });
  }
  return [...passes.values()];
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

  for (const { regex, rules } of compiledRules()) {
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
      /*
       * Whose match this is. The first rule in the pass that accepts it, so a
       * service-role key is never also reported as an anonymous one -- and a
       * match no rule in the pass wants becomes no candidate at all, though it
       * still counts against the ceiling, because the bound is on work done.
       */
      const owner = rules.find(candidate => !candidate.accept || candidate.accept(secret));
      if (!owner) continue;
      const rule = owner.rule;
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
  EXPOSURE_RULES,
  DETECTION_ENGINE_VERSION,
  MAX_CANDIDATES_PER_FILE,
  MAX_MATCHES_PER_FILE,
  MAX_OCCURRENCES_PER_CANDIDATE,
  MAX_TEXT_BYTES,
  RULES_VERSION,
  detectInText,
  sanitizeCandidate
});
