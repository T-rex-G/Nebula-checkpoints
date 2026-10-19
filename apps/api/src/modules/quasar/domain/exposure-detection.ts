import { RULES } from '../../../platform/release/secret-rules.ts';
import { EXPOSURE_RULES, PATH_RULES } from './exposure-rules.ts';
import { isCommitSha, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';

export { EXPOSURE_RULES, PATH_RULES };

/*
 * Finding every credential in a file, rather than proving one exists.
 *
 * The release gate's scanner (`platform/release/secret-scanner.ts`) already
 * answers the release gate's question -- is there a secret in this
 * repository -- and stops at the first match per rule
 * per file, because one is enough to fail a build. That is the right shape for
 * a gate and the wrong shape for a reader triaging an exposure, who needs to
 * know which credentials, how many times each, and where. A scan reporting one
 * token in a file holding four has told them the repository is clean three
 * times over.
 *
 * The rules themselves are not re-stated here. They are imported from
 * `platform/release/secret-rules.ts`, the gate's own list, so there is
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
 * through the findings module (`exposure-findings.ts`). This module does not pretend they can be
 * erased afterwards: a JavaScript string is immutable and copied by the engine
 * at will, so the claim made here is the weaker true one -- as few copies as
 * possible, and never one that is stored.
 */

/*
 * The scan's own rules live in `exposure-rules.ts`: the gate's set asks
 * whether there is a secret at all and must never be noisy, while a scan asks
 * which credentials and where, and can afford more rules as long as each one
 * is precise. Both sets run here, gate rules first.
 */

/*
 * Both versions are part of a finding's identity, so both are stated rather
 * than derived. The rule-set digest below is checked by this module's test:
 * changing a rule without moving RULES_VERSION would leave two different
 * detections claiming to be the same one, and a finding from each comparing as
 * unchanged.
 *
 * Rule set digest (sha256 over rule name, source and flags, gate rules then
 * scan rules, then each path rule's name and extensions):
 *   a96561b4616b0f5422d6835e1198c8c48cca85650d70d09987f6d77fc9763dcb
 */
/*
 * 3: the scan's own catalogue -- cloud, CI, AI, payments, messaging, key files
 * and connection strings -- with a plausibility check that refuses
 * placeholders, and rules that recognise a credential container by its name.
 */
/*
 * 4: thirty-one more -- package registries, AI providers, infrastructure,
 * collaboration tools, the Supabase management token, Docker and npm
 * configuration -- with the prefix-less ones recognised only beside a name
 * that says what they are.
 */
export const RULES_VERSION = 4;
/*
 * 2: base64 runs are decoded and scanned, and a commit's hunks can be scanned
 * for what that commit added.
 */
export const DETECTION_ENGINE_VERSION = 3;

/* A file this server will read at all. Past it the file is not scanned and the
   result says so. */
export const MAX_TEXT_BYTES = 1024 * 1024;

/* Matches walked in one file, across all rules. A file needing more than this
   is a generated file, and a reader does not triage a generated file
   line by line. */
export const MAX_MATCHES_PER_FILE = 200;

/* Distinct credentials kept from one file. */
export const MAX_CANDIDATES_PER_FILE = 50;

/* Locations kept for one credential. The count is not capped with the list:
   "found 400 times, here are the first 20" is useful, "found 20 times" is
   wrong. */
export const MAX_OCCURRENCES_PER_CANDIDATE = 20;


/*
 * The rules a scan runs: the shared release-gate set, then this module's own.
 * Spelled out as a type because the two halves have different shapes -- only
 * the scan's rules carry a predicate and keywords.
 */
interface DetectionRule {
  readonly rule: string;
  readonly regex: RegExp;
  readonly accept?: (secret: string) => boolean;
  readonly keywords?: readonly string[];
}

/* One walk of one expression over a text, and the rules that share it. */
interface Pass {
  readonly regex: RegExp;
  readonly rules: readonly { readonly rule: string; readonly accept: ((secret: string) => boolean) | null }[];
  readonly keywords: readonly string[] | null;
}

/*
 * A fresh expression per file, with the global flag added so `exec` can walk.
 * Recompiling rather than reusing is the whole point: a shared global regex
 * keeps its `lastIndex`, and the bug that causes is invisible in a single-file
 * test.
 */
function compiledRules(): Pass[] {
  const all: readonly DetectionRule[] = [...RULES, ...EXPOSURE_RULES];
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
  const passes = new Map<string, { regex: RegExp; rules: { rule: string; accept: ((secret: string) => boolean) | null }[]; always?: boolean; keywords?: string[] }>();
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
    /*
     * A pass is skipped for a file containing none of its keywords, so a pass
     * any of whose rules names none must always run -- a rule without
     * keywords is a rule that could match anywhere.
     */
    const keywords = rule.keywords && Array.isArray(rule.keywords) && rule.keywords.length ? rule.keywords : null;
    if (!keywords) pass.always = true;
    else pass.keywords = [...new Set([...(pass.keywords || []), ...keywords.map(item => item.toLowerCase())])];
  }
  return [...passes.values()].map(pass => ({
    regex: pass.regex,
    rules: pass.rules,
    keywords: pass.always ? null : pass.keywords ?? null
  }));
}

/*
 * A line ending is \n, \r\n or a bare \r. The last one is why this is not a
 * split: a legacy Mac-encoded file counted by \n alone reports every
 * credential on line 1, which sends a reader to the wrong place in a file they
 * may not be able to open.
 *
 * Where each line starts, computed once per file and only when something was
 * found in it. `locationAt` walked from the start of the file for every match,
 * which for a large file with many matches is the file read hundreds of times
 * over. The line endings are the same three -- \n, \r\n and a bare \r -- and
 * a test holds this to the walk it replaces on every offset of a mixed file.
 */
export interface Location {
  readonly line: number;
  readonly column: number;
}

export function createLocator(text: string): (index: number) => Location {
  let starts: number[] | null = null;
  return function locate(index: number): Location {
    if (!starts) {
      starts = [0];
      for (let cursor = 0; cursor < text.length; cursor += 1) {
        const code = text.charCodeAt(cursor);
        if (code === 10) {
          starts.push(cursor + 1);
        } else if (code === 13) {
          if (text.charCodeAt(cursor + 1) === 10) cursor += 1;
          starts.push(cursor + 1);
        }
      }
    }
    const lineStarts: readonly number[] = starts;
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: index - (lineStarts[low] ?? 0) + 1 };
  };
}

/* A credential found in a file. It carries the bytes; `sanitizeCandidate` is what anything outside detection and findings reads. */
export interface DetectedCandidate {
  readonly rule: string;
  readonly secret: string;
  readonly placeholder: string;
  readonly occurrences: readonly Location[];
  readonly occurrenceCount: number;
  readonly truncated: boolean;
  readonly decodedFrom?: string | null;
}

export interface SanitizedCandidate {
  readonly rule: string;
  readonly placeholder: string;
  readonly occurrences: readonly Location[];
  readonly occurrenceCount: number;
  readonly truncated: boolean;
  readonly decodedFrom: string | null;
}

export function sanitizeCandidate(candidate: DetectedCandidate): SanitizedCandidate {
  return Object.freeze({
    rule: candidate.rule,
    placeholder: candidate.placeholder,
    occurrences: candidate.occurrences,
    occurrenceCount: candidate.occurrenceCount,
    truncated: candidate.truncated,
    decodedFrom: candidate.decodedFrom || null
  });
}

/*
 * A generated label, not a redaction. Showing the first characters of a token
 * is the usual instinct and it publishes the part that identifies the provider
 * and often the account -- most of what the leak was worth. The number is the
 * order this rule's credentials appear in this file, which makes the label
 * readable and deliberately says nothing about the bytes.
 */
function placeholderFor(rule: string, ordinal: number): string {
  return `<${rule} #${ordinal}>`;
}

interface CandidateDraft {
  readonly rule: string;
  readonly secret: string;
  readonly placeholder: string;
  readonly occurrences: Location[];
  occurrenceCount: number;
  truncated: boolean;
  readonly decodedFrom: string | null;
}

interface DetectionState {
  readonly byKey: Map<string, CandidateDraft>;
  readonly ordinals: Map<string, number>;
  matchCount: number;
  truncated: boolean;
  decodedAttempts: number;
  decodedBytes: number;
  readonly decodedLimit: number;
}

export interface DetectionInput {
  readonly text?: unknown;
  readonly hunks?: unknown;
  readonly prefilter?: unknown;
  readonly decode?: unknown;
  readonly maxDecodedBytes?: unknown;
}

function newDetectionState(input: DetectionInput = {}): DetectionState {
  const requested = input.maxDecodedBytes;
  const decodedLimit = typeof requested === 'number' && Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, MAX_DECODED_BYTES) : MAX_DECODED_BYTES;
  return { byKey: new Map(), ordinals: new Map(), matchCount: 0, truncated: false,
    decodedAttempts: 0, decodedBytes: 0, decodedLimit };
}

/*
 * One walk of every rule over one text, adding what it finds to `state`.
 *
 * `locateAt` turns an offset into a location, or returns null for a match
 * that is not this caller's to report -- a history read passes the context
 * lines around each change so a credential recognised by the words beside it
 * is still recognised, and refuses any match that does not start on a line
 * the commit added. `decodedFrom` marks a candidate first seen inside an
 * encoded run, so a reader is told why the line shows no credential.
 */
type Locate = (index: number) => Location | null;

function scanInto(state: DetectionState, text: string, locateAt: Locate, prefilter: boolean, decodedFrom: string | null): void {
  const lower = prefilter ? text.toLowerCase() : '';
  for (const { regex, rules, keywords } of compiledRules()) {
    if (prefilter && keywords && !keywords.some(keyword => lower.includes(keyword))) continue;
    let match: RegExpExecArray | null;
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

      if (state.matchCount >= MAX_MATCHES_PER_FILE) {
        state.truncated = true;
        break;
      }
      state.matchCount += 1;

      const secret = match[0];
      /*
       * Whose match this is. The first rule in the pass that accepts it, so a
       * service-role key is never also reported as an anonymous one -- and a
       * match no rule in the pass wants becomes no candidate at all, though it
       * still counts against the ceiling, because the bound is on work done.
       */
      const owner = rules.find(candidate => !candidate.accept || candidate.accept(secret));
      if (!owner) continue;
      const location = locateAt(match.index);
      if (!location) continue;
      const rule = owner.rule;
      const key = `${rule}\u0000${secret}`;
      let candidate = state.byKey.get(key);
      if (!candidate) {
        if (state.byKey.size >= MAX_CANDIDATES_PER_FILE) {
          state.truncated = true;
          continue;
        }
        const ordinal = (state.ordinals.get(rule) || 0) + 1;
        state.ordinals.set(rule, ordinal);
        candidate = {
          rule,
          secret,
          placeholder: placeholderFor(rule, ordinal),
          occurrences: [],
          occurrenceCount: 0,
          truncated: false,
          decodedFrom: decodedFrom || null
        };
        state.byKey.set(key, candidate);
      }

      candidate.occurrenceCount += 1;
      if (candidate.occurrences.length < MAX_OCCURRENCES_PER_CANDIDATE) {
        candidate.occurrences.push(Object.freeze({ line: location.line, column: location.column }));
      } else {
        candidate.truncated = true;
      }
    }
    if (state.matchCount >= MAX_MATCHES_PER_FILE) {
      state.truncated = true;
      break;
    }
  }
}

/*
 * Credentials committed in base64 -- a Kubernetes secret, a Docker config's
 * `auth`, a key pasted as one encoded line -- are invisible to a pattern that
 * reads the text as written. Each run that is plausibly base64 is decoded and,
 * when what comes out is text, every rule is run over that too, and whatever
 * it finds is reported at the run's own line.
 *
 * A run may follow `=` -- `KEY=<base64>` in an env file is the commonest
 * place one is written -- but not a character that could belong to it.
 *
 * One level only, and bounded: a run is standard base64 of at least 24
 * characters with the right padding, mixing cases and digits the way encoded
 * text does; at most MAX_DECODED_RUNS are tried and MAX_DECODED_BYTES decoded
 * per file; and only output that is almost entirely printable UTF-8 is read,
 * so an image, a hash or a compressed blob decodes to nothing and costs
 * nothing further.
 */
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{4}){6,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/=_-])/g;
const MAX_DECODED_RUNS = 200;
const MAX_DECODED_BYTES = 256 * 1024;
const MIN_DECODED_BYTES = 16;

function decodedText(run: string): string | null {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9+/]/.test(run)) return null;
  const bytes = Buffer.from(run, 'base64');
  if (bytes.length < MIN_DECODED_BYTES) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let printable = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if ((code >= 32 && code < 127) || code === 9 || code === 10 || code === 13) printable += 1;
  }
  return printable / decoded.length >= 0.9 ? decoded : null;
}

function decodeInto(state: DetectionState, text: string, locateAt: Locate, prefilter: boolean): void {
  const runs = new RegExp(BASE64_RUN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = runs.exec(text)) !== null) {
    if (state.matchCount >= MAX_MATCHES_PER_FILE) { state.truncated = true; break; }
    const location = locateAt(match.index);
    if (!location) continue;
    if (state.decodedAttempts >= MAX_DECODED_RUNS) { state.truncated = true; break; }
    /* Check the decoded size before allocation; character length is not a
       UTF-8 byte count. The counters are shared across every hunk of a file. */
    const size = Buffer.byteLength(match[0], 'base64');
    if (state.decodedBytes + size > state.decodedLimit) { state.truncated = true; break; }
    state.decodedAttempts += 1;
    const decoded = decodedText(match[0]);
    state.decodedBytes += size;
    if (!decoded) continue;
    scanInto(state, decoded, () => location, prefilter, 'base64');
  }
}

export interface DetectionResult {
  readonly scanned: boolean;
  readonly truncated: boolean;
  readonly matchCount: number;
  readonly decodedBytes?: number;
  readonly candidates: readonly DetectedCandidate[];
}

function detectionResult(state: DetectionState): DetectionResult {
  const candidates = [...state.byKey.values()].map(candidate => Object.freeze({
    ...candidate,
    occurrences: Object.freeze(candidate.occurrences)
  }));
  return Object.freeze({
    scanned: true,
    truncated: state.truncated,
    matchCount: state.matchCount,
    decodedBytes: state.decodedBytes,
    candidates: Object.freeze(candidates)
  });
}

/*
 * Returns { scanned, truncated, matchCount, candidates }. A candidate carries
 * `secret`; `sanitizeCandidate` is what anything outside this file and
 * `exposure-findings` should be looking at.
 */
export function detectInText(input: DetectionInput = {}): DetectionResult {
  const text = typeof input.text === 'string' ? input.text : '';

  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return Object.freeze({
      scanned: false, truncated: true, matchCount: 0, decodedBytes: 0, candidates: Object.freeze([])
    });
  }

  const state = newDetectionState(input);
  const locate = createLocator(text);
  /* The keyword check is an optimisation and can be switched off, which is
     how a test proves it never changes an answer. */
  const prefilter = input.prefilter !== false;
  scanInto(state, text, locate, prefilter, null);
  if (input.decode !== false) decodeInto(state, text, locate, prefilter);
  return detectionResult(state);
}

/*
 * What one commit added to one file, from the hunks of its diff. Each hunk is
 * scanned with its context so a credential recognised by the words around it
 * is still recognised; a match is kept only when it starts on a line this
 * commit added, and is located at that line in the file as it stood at this
 * commit. Placeholders are numbered across the file's hunks, as they would be
 * across a whole file.
 */
interface HunkLine {
  readonly text?: unknown;
  readonly added?: unknown;
  readonly line?: unknown;
}

export function detectInHunks(input: DetectionInput = {}): DetectionResult {
  /* The diff reader's hunks: each a list of lines, the added ones marked with their line in the file. */
  const hunks = (Array.isArray(input.hunks) ? input.hunks : []) as readonly ({ readonly lines?: unknown } | null | undefined)[];
  const prefilter = input.prefilter !== false;
  const state = newDetectionState(input);
  for (const hunk of hunks) {
    const lines = (hunk && Array.isArray(hunk.lines) ? hunk.lines : []) as readonly (HunkLine | null | undefined)[];
    if (!lines.some(line => line && line.added)) continue;
    const text = lines.map(line => String((line as HunkLine).text || '')).join('\n');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      state.truncated = true;
      continue;
    }
    const locate = createLocator(text);
    const at = (index: number): Location | null => {
      const relative = locate(index);
      const source = lines[relative.line - 1];
      if (!source || !source.added || typeof source.line !== 'number' || !Number.isInteger(source.line)) return null;
      return { line: source.line, column: relative.column };
    };
    scanInto(state, text, at, prefilter, null);
    if (input.decode !== false) decodeInto(state, text, at, prefilter);
    if (state.matchCount >= MAX_MATCHES_PER_FILE) break;
  }
  return detectionResult(state);
}

/*
 * A file that is an exposure by its name. Nothing is read: the caller has the
 * path and the blob id from the tree, and the blob id is the identity -- so
 * the same keystore committed again is the same finding, and a replaced one is
 * a new one. The result has the same shape as `detectInText` so the findings
 * module does not need to know which kind of rule produced a candidate.
 */
export function detectInPath(input: { readonly path?: unknown; readonly sha?: unknown } = {}): DetectionResult {
  const filePath = typeof input.path === 'string' ? input.path : '';
  const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
  const name = filePath.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const empty = Object.freeze({ scanned: true, truncated: false, matchCount: 0, candidates: Object.freeze([]) });
  if (!extension || !(isCommitSha(sha) || isSha256Hex(sha))) return empty;
  const rule = PATH_RULES.find(item => item.extensions.includes(extension));
  if (!rule) return empty;
  return Object.freeze({
    scanned: true,
    truncated: false,
    matchCount: 1,
    candidates: Object.freeze([Object.freeze({
      rule: rule.rule,
      secret: `blob:${sha}`,
      placeholder: placeholderFor(rule.rule, 1),
      occurrences: Object.freeze([Object.freeze({ line: 1, column: 1 })]),
      occurrenceCount: 1,
      truncated: false
    })])
  });
}
