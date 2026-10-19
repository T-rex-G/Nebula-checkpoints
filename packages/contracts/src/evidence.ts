/*
 * How much of what a part claims to know it actually read.
 *
 * Every part that reports evidence says how complete it is in its own words,
 * and those words are the wire format its clients already read. They stay.
 * This is the one scale they all mean something on:
 *
 *   complete     everything the part set out to read was read
 *   partial      some of it was read; what was not is named
 *   unknown      not established yet: never run, or still running
 *   unavailable  could not be read at all
 *
 * A vocabulary is declared here once, and its mapping is typed against it,
 * so a word added to a part without saying what it means does not compile.
 */

export const EVIDENCE_CONTRACT_VERSION = 1;

export const COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown', 'unavailable'] as const);
export type Completeness = (typeof COMPLETENESS)[number];

/* An exposure scan's coverage of the tree and history it was asked to read. */
export const EXPOSURE_COVERAGE = Object.freeze(['unknown', 'complete', 'partial'] as const);
export type ExposureCoverage = (typeof EXPOSURE_COVERAGE)[number];

/* An anonymous-readability probe's coverage of the tables it was asked about. */
export const PROBE_COVERAGE = Object.freeze(['complete', 'partial', 'refused'] as const);
export type ProbeCoverage = (typeof PROBE_COVERAGE)[number];

/* A kept audit's watch for new advisories and exploited vulnerabilities. */
export const AUDIT_WATCH_STATES = Object.freeze(['ok', 'partial', 'unavailable'] as const);
export type AuditWatchState = (typeof AUDIT_WATCH_STATES)[number];

/* Each source behind a workspace summary: the posture and the findings inbox. */
export const SOURCE_STATES = Object.freeze(['measured', 'partial', 'unavailable'] as const);
export type SourceState = (typeof SOURCE_STATES)[number];

/* The provider's evidence of a person's repository access (actor.ts declares its vocabulary). */
type AuthorizationEvidenceWord = 'resolved' | 'partial' | 'unavailable';

export const COMPLETENESS_OF: {
  readonly exposureCoverage: Readonly<Record<ExposureCoverage, Completeness>>;
  readonly probeCoverage: Readonly<Record<ProbeCoverage, Completeness>>;
  readonly auditWatch: Readonly<Record<AuditWatchState, Completeness>>;
  readonly source: Readonly<Record<SourceState, Completeness>>;
  readonly authorizationEvidence: Readonly<Record<AuthorizationEvidenceWord, Completeness>>;
} = Object.freeze({
  exposureCoverage: Object.freeze({ unknown: 'unknown', complete: 'complete', partial: 'partial' }),
  /* A refused probe asked nothing: the key was not an anonymous one, or the file named no project. */
  probeCoverage: Object.freeze({ complete: 'complete', partial: 'partial', refused: 'unavailable' }),
  auditWatch: Object.freeze({ ok: 'complete', partial: 'partial', unavailable: 'unavailable' }),
  source: Object.freeze({ measured: 'complete', partial: 'partial', unavailable: 'unavailable' }),
  authorizationEvidence: Object.freeze({ resolved: 'complete', partial: 'partial', unavailable: 'unavailable' })
});

/* A part's word on the one scale. A word the part never declared is not evidence of anything: unknown. */
export function completenessOf<Word extends string>(vocabulary: Readonly<Record<Word, Completeness>>, word: unknown): Completeness {
  return typeof word === 'string' && Object.hasOwn(vocabulary, word) ? vocabulary[word as Word] : 'unknown';
}

/*
 * Several parts as one. Complete only if every part is. Partial once anything
 * was read and something was not. When nothing was read, unknown while any
 * part may still answer, and unavailable once none can. No parts is unknown.
 */
export function combineCompleteness(parts: readonly Completeness[]): Completeness {
  if (!parts.length) return 'unknown';
  if (parts.every(part => part === 'complete')) return 'complete';
  if (parts.some(part => part === 'complete' || part === 'partial')) return 'partial';
  return parts.includes('unknown') ? 'unknown' : 'unavailable';
}
