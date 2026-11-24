import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { isCommitSha } from '../../../../../../packages/contracts/src/ids.ts';
import { REASONS as VERIFICATION_REASONS, VERIFICATION_STATES, verificationFreshness } from './verification-outcomes.ts';
import { REASONS as PROBE_REASONS, PROBE_STATES } from './readability-outcomes.ts';
import { detectInText } from './exposure-detection.ts';
import { shannonEntropy } from './exposure-rules.ts';
import { property, trimmedText } from '../../../platform/values/fields.ts';
import { RULE_NARRATION, type RuleNarration } from './rule-narration.ts';
export { RULE_NARRATION } from './rule-narration.ts';
export type { RuleNarration } from './rule-narration.ts';

/*
 * Saying what a finding means, in words, without a model.
 *
 * A stored finding is a rule name, a path, a line and four version numbers.
 * That is enough to act on if you already know what `contextual-provider-secret`
 * implies -- and the person who most needs to act is the one least likely to
 * know.
 *
 * So there is one explanation per rule, per verification outcome, per probe
 * outcome and per disposition, and all of it is a lookup table rather than a
 * generator. A generator would be shorter and would drift: the same finding
 * would be worded differently between runs, a reader comparing two scans could
 * not tell whether the wording or the world had changed, and nobody could
 * review the sentences because nobody could enumerate them. A table can be
 * read end to end by a person, and a rule added without an entry fails this
 * module's test rather than producing a finding that explains nothing.
 *
 * Two rules about the words themselves.
 *
 * The consequence comes first, in the reader's terms. "A GitHub personal
 * access token" is what it is; "anyone who has this can act as you on GitHub"
 * is what it means, and only the second tells somebody whether to stop what
 * they are doing.
 *
 * Nothing that could not be read aloud goes in. No credential, no fingerprint,
 * not even a prefix -- a finding should be safe to paste into a ticket and show
 * on a screen in an open-plan office, and the placeholder exists so it is.
 */

/*
 * Moves when the wording changes, so a stored narration can be told from a
 * freshly generated one. The sentences are part of the product's contract with
 * a reader: changing them silently means two people reading the same finding a
 * month apart disagree about what they were told.
 */
/* 2: a location says when a credential is only in history, inside an archive,
   or written base64-encoded, and withholds only the credential-shaped part of
   a path. */
/* 3: verification and readability observations carry their check time and
   freshness deadline; an expired or undated result never implies current
   liveness, rejection or protection. */
export const NARRATION_VERSION = 3;

/*
 * One sentence per verification outcome. The unverifiable ones are written
 * carefully: none of them may read as safety, because "we could not tell" and
 * "it is harmless" are different sentences and only one of them is true.
 */
export const VERIFICATION_NARRATION: Readonly<Record<string, string>> = Object.freeze({
  [VERIFICATION_STATES.VERIFIED]: 'The provider accepted this credential at the time of the check: it was used to identify its own account, and it worked.',
  [VERIFICATION_STATES.REJECTED]: 'The provider refused this credential at the time of the check. That records a rejection at that moment; the credential remains in the repository history.',
  [VERIFICATION_REASONS.AUTHORIZATION_MISSING]: 'Nobody authorised a check, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_INVALID]: 'The authorisation to check this credential did not validate, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_EXPIRED]: 'The authorisation to check this credential had expired, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_MISMATCH]: 'The authorisation was for a different credential, repository or target, so this one was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.UNSUPPORTED_CREDENTIAL_CLASS]: 'There is no way to ask this kind of credential whether it works without using it against a service it was not issued for, so nothing was asked. Assume it works.',
  [VERIFICATION_REASONS.UNSUPPORTED_TOKEN_CLASS]: 'This token class authenticates differently from the one this checker understands, so asking would have been a guess. Nothing was asked; assume it works.',
  [VERIFICATION_REASONS.INCOMPLETE_CREDENTIAL]: 'This is half a credential -- an identifier without its secret -- so there is nothing to test. That is not reassurance: the other half is often committed nearby.',
  [VERIFICATION_REASONS.IDENTITY_CONFIRMED]: 'The provider identified the account this credential belonged to at the time of the check, confirming that it worked then.',
  [VERIFICATION_REASONS.CREDENTIAL_REFUSED]: 'The provider refused this credential at the time of the check.',
  [VERIFICATION_REASONS.MALFORMED_IDENTITY_RESPONSE]: 'The provider answered, but not with an identity this checker could read, so the answer proves nothing either way.',
  [VERIFICATION_REASONS.PROVIDER_THROTTLED]: 'The provider was rate-limiting us and did not answer the question. Being throttled means the request reached a working service, not that the credential is dead.',
  [VERIFICATION_REASONS.PROVIDER_POLICY_RESTRICTED]: 'The provider blocked the request on policy grounds rather than rejecting the credential. A credential blocked by policy from one endpoint usually still works elsewhere.',
  [VERIFICATION_REASONS.PROVIDER_AMBIGUOUS_REJECTION]: 'The provider gave an answer that means either "this credential is gone" or "this credential is fine but you may not ask from here". It cannot be read as the first.',
  [VERIFICATION_REASONS.PROVIDER_UNEXPECTED_STATUS]: 'The provider answered in a way this checker has not been reviewed against, so the answer was not interpreted.',
  [VERIFICATION_REASONS.TRANSPORT_REFUSED]: 'The request could not be completed, so the question was never answered.',
  [VERIFICATION_REASONS.TRANSPORT_TIMEOUT]: 'The provider did not answer within the time allowed, so the question was never answered.',
  [VERIFICATION_REASONS.RUN_LIMIT_REACHED]: 'This scan had already made as many checks as it is allowed, so this credential was not checked.'
});

/*
 * One sentence per probe outcome, and the two careful ones are the reason this
 * table exists. An empty result and a refusal are both easy to report as
 * "protected", and a reader told that stops looking.
 */
export const PROBE_NARRATION: Readonly<Record<string, string>> = Object.freeze({
  [PROBE_STATES.READABLE]: 'A row came back. That projection of that table was readable by an anonymous stranger at that moment, with no sign-in of any kind.',
  [PROBE_REASONS.ROWS_VISIBLE]: 'A row came back, so those columns of that table were readable by an anonymous stranger at the time of the check. Other columns and other tables were not tested.',
  [PROBE_REASONS.NO_VISIBLE_ROWS]: 'No rows came back. That is not evidence of protection: an empty table, a filter that matched nothing, and a policy that permits the read while hiding every row look identical from outside.',
  [PROBE_REASONS.ACCESS_DENIED_FOR_TESTED_REQUEST]: 'The service refused this exact request -- these columns of this table for an anonymous caller. It says nothing about the rest of the table, the rest of the schema, or whether row-level security is switched on.',
  [PROBE_REASONS.KEY_NOT_ANONYMOUS]: 'The key found is not an anonymous public key, so it was not used. A stronger key would bypass the policies this check is about, and using one would prove nothing.',
  [PROBE_REASONS.PROJECT_REFUSED]: 'The project reference was not a shape this checker will connect to, so nothing was contacted.',
  [PROBE_REASONS.RELATION_REFUSED]: 'The table name was not a plain table name, so nothing was requested. Only named tables are read, never functions.',
  [PROBE_REASONS.PROJECTION_REFUSED]: 'The columns requested were not a confirmed list of named columns, so nothing was requested. Selecting everything is never done.',
  [PROBE_REASONS.AUTHORIZATION_MISSING]: 'Nobody authorised this read, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_INVALID]: 'The authorisation for this read did not validate, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_EXPIRED]: 'The authorisation for this read had expired, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_MISMATCH]: 'The authorisation was for a different project, table or set of columns, so nothing was contacted.',
  [PROBE_REASONS.PROVIDER_THROTTLED]: 'The service was rate-limiting us and did not answer, so nothing is known about readability.',
  [PROBE_REASONS.PROVIDER_UNEXPECTED_RESPONSE]: 'The service answered in a way this checker does not interpret, so nothing is known about readability.',
  [PROBE_REASONS.TRANSPORT_REFUSED]: 'The request could not be completed, so nothing is known about readability.'
});

export const DISPOSITION_NARRATION: Readonly<Record<string, string>> = Object.freeze({
  open: 'This finding is open: the credential is in the tree and nothing has established that it stopped working.',
  'credential-rejected': 'The issuing provider refused this credential at a recorded check. Review the check time and freshness before treating it as resolved; a past refusal does not establish its current status.',
  'accepted-risk': 'Somebody reviewed this finding and accepted the risk. It is recorded against their name and the credential is still in the repository.',
  'removed-from-tree': 'A complete scan of the same branch no longer finds this credential in the tree. It is still in the repository history and still reachable by anyone with a clone, so it needs revoking unless it has already been revoked.'
});

type Fields = Readonly<Record<string, unknown>>;

/* A table's own entry: an inherited key is not a sentence. */
function entryOf<T>(table: Readonly<Record<string, T>>, key: string): T | null {
  return (Object.hasOwn(table, key) && table[key]) || null;
}

export function narrationForRule(rule: unknown): RuleNarration | null {
  const name = typeof rule === 'string' ? rule : '';
  return entryOf(RULE_NARRATION, name);
}

/*
 * A rule's severity, as a scan's history and the security posture sum it. A
 * rule with no entry is serious, as `describeFinding` describes it, rather
 * than nothing.
 */
export function exposureSeverityOf(rule: unknown): Severity {
  const entry = narrationForRule(rule);
  return entry ? entry.severity : 'serious';
}

/* Only stored UTC instants are displayed. Date.parse alone accepts prose and
   rolls impossible dates into a later month, which would make corrupt
   observations appear fresh or reflect arbitrary text into the report. */
function observationTimestamp(value: unknown): string | null {
  const timestamp = trimmedText(value);
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(timestamp);
  if (!parts) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === `${parts[1]}.${(parts[2] || '').padEnd(3, '0')}Z` ? canonical : null;
}

/* Shared with presentation code so the badge and the words age together.
   Keeping the original state records what happened; freshness describes
   whether that observation can still be used. */
export interface ObservationFreshness {
  readonly freshness: 'fresh' | 'stale';
  readonly observedAt: string | null;
  readonly freshnessDeadline: string | null;
}

export function observationFreshness(record: unknown, now: number = Date.now()): ObservationFreshness {
  const observedAt = observationTimestamp(record && property(record, 'observedAt'));
  const freshnessDeadline = observationTimestamp(record && property(record, 'freshnessDeadline'));
  /* Date.parse of null is NaN, which the checks below refuse, as they always did. */
  const observed = observedAt === null ? NaN : Date.parse(observedAt);
  const deadline = freshnessDeadline === null ? NaN : Date.parse(freshnessDeadline);
  const valid = Number.isFinite(now) && observedAt !== null && freshnessDeadline !== null
    && observed <= now && deadline > observed;
  return Object.freeze({
    freshness: valid ? verificationFreshness({ freshnessDeadline }, now) : 'stale',
    observedAt,
    freshnessDeadline
  });
}

function describeObservation(sentence: string | null, record: unknown, now: number): string | null {
  if (!sentence) return null;
  const observation = observationFreshness(record, now);
  const checked = observation.observedAt || 'unavailable (missing or invalid timestamp)';
  const deadline = observation.freshnessDeadline || 'unavailable (missing or invalid timestamp)';
  const status = observation.freshness === 'fresh'
    ? 'This records the result at the time of the check; status can change before the freshness deadline.'
    : 'Current status is unknown: this observation has expired or its timing cannot establish freshness. Run a new authorised check to learn the current status.';
  return `${status} Last recorded check: ${checked}. Freshness deadline: ${deadline}. ${sentence}`;
}

export function describeVerification(record: unknown, now: number = Date.now()): string | null {
  if (!record || typeof record !== 'object') return null;
  const reason = trimmedText(property(record, 'reason'));
  const state = trimmedText(property(record, 'state'));
  /*
   * The reason is more specific than the state, so it wins when there is one.
   * A verified credential and a rejected one also have a sentence keyed by
   * state, for a record that carries no reason.
   */
  return describeObservation(entryOf(VERIFICATION_NARRATION, reason) || entryOf(VERIFICATION_NARRATION, state), record, now);
}

export function describeProbe(record: unknown, now: number = Date.now()): string | null {
  if (!record || typeof record !== 'object') return null;
  const reason = trimmedText(property(record, 'reason'));
  const state = trimmedText(property(record, 'state'));
  return describeObservation(entryOf(PROBE_NARRATION, reason) || entryOf(PROBE_NARRATION, state), record, now);
}

export function describeDisposition(disposition: unknown): string | null {
  const name = typeof disposition === 'string' ? disposition : '';
  return entryOf(DISPOSITION_NARRATION, name);
}

/*
 * Where a credential is, in a sentence. The path is quoted because a reader
 * needs it, and a path can contain anything a repository chose to name a file
 * -- including something shaped like a credential. So the path is trimmed to
 * its directory and its last segment is described rather than quoted whenever
 * the last segment looks like it might be a secret itself.
 */
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/* A date as a reader says it, read from the stored UTC timestamp's own text --
   no clock, no locale and no date arithmetic, so the sentence is the same
   wherever and whenever it is read. */
function spokenDate(value: unknown): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(trimmedText(value));
  if (!parts) return '';
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day} ${MONTHS[month - 1] ?? ''} ${parts[1] ?? ''}`;
}

/*
 * Where it is, and what about where it is changes what to do: a credential
 * only in history is still exposed to anyone with a clone, one written in
 * base64 does not look like itself on the line it is on, and one inside an
 * archive is in a file a reader has to download and open to see.
 */
/* A finding as narration reads it: every field checked before it is said. */
export type NarrationInput = Fields;

export function describeLocation(finding: NarrationInput): string {
  const occurrences: readonly unknown[] = Array.isArray(finding.occurrences) ? finding.occurrences : [];
  const recorded = finding.occurrenceCount;
  const count = typeof recorded === 'number' && Number.isInteger(recorded) ? recorded : occurrences.length;
  const path = trimmedText(finding.path);
  const where = safeDisplayPath(path);
  const notes: string[] = [];
  if (path && where !== path) notes.push(`Part of the file's path is not shown, because it is itself credential-shaped.`);
  const archive = path.indexOf('!/');
  if (archive > 0) {
    notes.push(`That is a file inside the archive ${safeDisplayPath(path.slice(0, archive))}, which anyone who can read the repository can download and open.`);
  }
  if (trimmedText(finding.decodedFrom) === 'base64') {
    notes.push('It is written base64-encoded, so the line shows an encoded run rather than the credential as it is used.');
  }
  const introduced = isCommitSha(trimmedText(finding.introducedCommit)) ? trimmedText(finding.introducedCommit) : '';
  if (introduced) {
    const when = spokenDate(finding.introducedAt);
    const added = `commit ${introduced.slice(0, 7)}${when ? ` on ${when}` : ''}`;
    notes.push(finding.inTree === false
      ? `It is no longer in the current files, but it is still in the repository's history: it was added in ${added}, and anyone with a clone can check that commit out and read it. Deleting it from the files did not remove it.`
      : `It was first added in ${added}.`);
  }
  const tail = notes.length ? ` ${notes.join(' ')}` : '';
  if (!occurrences.length) return `In ${where}.${tail}`;
  /* An occurrence is the store's own record, read as it always was. */
  const first = occurrences[0] as Fields;
  const at = `line ${String(first.line)}`;
  if (count <= 1) return `In ${where}, at ${at}.${tail}`;
  if (finding.truncated) {
    return `In ${where}, in ${count} places. The first ${occurrences.length} are recorded, starting at ${at}.${tail}`;
  }
  return `In ${where}, in ${count} places, starting at ${at}.${tail}`;
}

/*
 * A path is shown as it is unless part of it could itself be a credential,
 * and then only that part is withheld. It is the one way a secret could reach
 * a sentence that is meant to be safe to read aloud, so it is decided by the
 * same rules that find credentials in files -- and by a shape test for tokens
 * no rule names -- rather than by length.
 *
 * Length was the old test, and it was wrong in the direction that matters to
 * a reader: any name with twenty letters, digits, hyphens or underscores in a
 * row was withheld, which is most test files and workflows in an ordinary
 * repository (`anonymous-readability-probe.test.js`,
 * `public-alpha-alpha17.yml`), so the finding could not say where it was.
 */
const HIDDEN_SEGMENT = '\u2039hidden\u203a';

function credentialShapedSegment(segment: string): boolean {
  if (!segment) return false;
  if (detectInText({ text: segment }).candidates.length) return true;
  /*
   * A token no rule names still looks like one: a long run with no word
   * breaks, letters and digits mixed, and not much repetition. Words joined
   * by hyphens, underscores or dots are split first, so a descriptive name is
   * judged a word at a time and never reaches the length.
   */
  return segment.split(/[-_.\s]+/).some(piece => piece.length >= 16
    && /[A-Za-z]/.test(piece) && /[0-9]/.test(piece)
    && shannonEntropy(piece) >= 3);
}

export function safeDisplayPath(filePath: string): string {
  if (!filePath) return 'an unnamed file';
  const segments = filePath.split('/');
  const last = segments.length - 1;
  return segments.map((segment, index) => {
    if (!credentialShapedSegment(segment)) return segment;
    /*
     * A short alphabetic extension carries no secret and says what kind of
     * file this is, so a file keeps it; anything else in the segment goes.
     */
    const extension = index === last ? (/\.[A-Za-z]{1,5}$/.exec(segment) || [''])[0] : '';
    return `${HIDDEN_SEGMENT}${extension}`;
  }).join('/');
}

/*
 * The whole description of one finding: what it is, what it means, where it
 * is, and what to do. A pure function of the record -- no clock, no
 * randomness, no environment -- so the same finding reads the same way every
 * time anybody looks at it.
 */
/* The words for one finding: what it is, what it means, where, and what to do. */
export interface FindingNarration {
  readonly narrationVersion: number;
  readonly severity: Severity;
  readonly what: string;
  readonly consequence: string;
  readonly action: string;
  readonly where: string;
}

export function describeFinding(finding: unknown): FindingNarration | null {
  if (!finding || typeof finding !== 'object') return null;
  const record = finding as NarrationInput;
  const rule = trimmedText(record.rule);
  const explained = narrationForRule(rule);
  const placeholder = trimmedText(record.placeholder) || `<${rule || 'credential'}>`;

  if (!explained) {
    /*
     * A rule with no entry is described as unexplained rather than omitted,
     * and is not downgraded: an unexplained credential in a repository is not
     * less serious for being unexplained.
     */
    return Object.freeze({
      narrationVersion: NARRATION_VERSION,
      severity: 'serious',
      what: `${placeholder} matched the rule "${rule}", which has no written explanation yet.`,
      consequence: 'What this credential unlocks is not described here, so treat it as live and as capable of whatever its kind normally permits.',
      action: 'Rotate it, and add an explanation for this rule so the next reader is not left guessing.',
      where: describeLocation(record)
    });
  }

  return Object.freeze({
    narrationVersion: NARRATION_VERSION,
    severity: explained.severity,
    what: `${placeholder} is a credential this scan recognised.`,
    consequence: explained.consequence,
    action: explained.action,
    where: describeLocation(record)
  });
}
