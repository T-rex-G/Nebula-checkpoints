/*
 * The repository's trust summary and the public error, decided.
 *
 * Both say things a reader acts on -- how far the evidence for a repository
 * goes, and what happened when an action failed -- so every value is read as
 * text, cut to a length, and stripped of anything that looks like a
 * credential before it is shown. Drawn by TrustViews.tsx.
 */
import { CAPABILITY_EVIDENCE_STATES } from '../../../../../packages/contracts/src/capability.ts';
import type { CapabilityEvidenceState } from '../../../../../packages/contracts/src/capability.ts';
import { field } from '../../platform/values.ts';

export type EvidenceState = CapabilityEvidenceState;

/*
 * The evidence marks, drawn rather than typed: five circles that differ only
 * in what is inside them -- a check for what the provider vouched for, an
 * equals for what was computed exactly, a wave for what was approximated, a
 * clock for what has aged, a bar for what is not there. Descending
 * confidence, and a reader compares the middles rather than five different
 * outlines.
 *
 * Deliberately not a shield for Provider-verified: the rail already spends a
 * shield on Governance, and one drawing meaning both "policy" and "attested
 * evidence" is worse than no icon. A shield is protection; this is
 * attestation.
 */
const RING = 'M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z';
export const EVIDENCE_MARKS: Readonly<Record<EvidenceState, readonly string[]>> = Object.freeze({
  'Provider-verified': Object.freeze([RING, 'M8.7 12.1l2.2 2.3 4.4-4.7']),
  Deterministic: Object.freeze([RING, 'M8.7 10.6h6.6M8.7 13.6h6.6']),
  Inferred: Object.freeze([RING, 'M8.6 13.1c1.1-1.9 2.2-1.9 3.4 0s2.3 1.9 3.4 0']),
  Stale: Object.freeze([RING, 'M12 7.6V12l3 1.8']),
  Unavailable: Object.freeze([RING, 'M8.4 12h7.2'])
});

/* A state the registry names, or Unavailable: nothing unnamed is shown as evidence. */
export function evidenceName(state: unknown): EvidenceState {
  return CAPABILITY_EVIDENCE_STATES.find(name => name === state) ?? 'Unavailable';
}

/* A value as text a reader may see: its fallback when absent, credentials redacted, cut to `maximum`. */
export function safeValue(value: unknown, fallback: string, maximum = 600): string {
  const text = String(value === null || value === undefined || value === '' ? fallback : value)
    .replace(/(?:postgres(?:ql)?:\/\/|gh[pousr]_|github_pat_)[^\s]+/gi, '[redacted]')
    .replace(/\b(token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
  return text.slice(0, maximum);
}

export interface SummaryFieldDefinition {
  readonly key: 'connection' | 'pipeline' | 'risk' | 'action' | 'evidence';
  readonly id: string;
  readonly label: string;
}

export const SUMMARY_FIELDS: readonly SummaryFieldDefinition[] = Object.freeze([
  Object.freeze({ key: 'connection', id: 'trustConnection', label: 'Connection freshness' }),
  Object.freeze({ key: 'pipeline', id: 'trustPipeline', label: 'Application and evidence health' }),
  Object.freeze({ key: 'risk', id: 'trustRisk', label: 'Risk or governance issue' }),
  Object.freeze({ key: 'action', id: 'trustAction', label: 'Recommended next action' }),
  Object.freeze({ key: 'evidence', id: 'trustEvidence', label: 'Supporting evidence' })
] as const);

export interface SummaryField extends SummaryFieldDefinition {
  readonly text: string;
  readonly evidence: EvidenceState;
}

export interface SummaryView {
  readonly fields: readonly SummaryField[];
  readonly announcement: string;
}

/* The summary the page was handed, each field read as text with the evidence behind it. */
export function summaryView(model: unknown): SummaryView {
  return {
    fields: SUMMARY_FIELDS.map(definition => {
      const value = field(model, definition.key);
      return {
        ...definition,
        text: safeValue(field(value, 'text'), 'No verified result is available.'),
        evidence: evidenceName(field(value, 'evidenceState'))
      };
    }),
    announcement: safeValue(field(model, 'announcement'), 'Repository trust summary updated.')
  };
}

/*
 * The one-line standing of the fields, for the phone layout where the detail
 * is collapsed behind a disclosure. It counts states rather than summarising
 * the prose: the prose is the part that moves out of view, and inventing a
 * sentence to stand in for it would be asserting something the model never
 * said. Weakest first, and named for the weakest present, which is the one
 * worth a colour.
 */
export const ROLLUP_ORDER: readonly EvidenceState[] = Object.freeze(['Unavailable', 'Stale', 'Inferred', 'Deterministic', 'Provider-verified']);

export function rollup(states: readonly EvidenceState[]): { readonly text: string; readonly worst: EvidenceState } {
  const counts = new Map<EvidenceState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const parts = ROLLUP_ORDER.filter(name => counts.has(name)).map(name => `${counts.get(name) ?? 0} ${name.toLowerCase()}`);
  return {
    text: parts.length ? parts.join(' · ') : 'Not measured',
    worst: ROLLUP_ORDER.find(name => counts.has(name)) ?? 'Unavailable'
  };
}

export function providerChangeText(value: unknown): 'yes' | 'no' | 'unknown' {
  if (value === true || value === 'yes') return 'yes';
  if (value === false || value === 'no') return 'no';
  return 'unknown';
}

export interface ErrorView {
  readonly message: string;
  readonly providerChanged: 'yes' | 'no' | 'unknown';
  readonly safeState: string;
  readonly nextAction: string;
  readonly correlationId: string;
  /* Whether there is a correlation ID to copy. */
  readonly copyable: boolean;
  readonly code: string;
}

/* A failed action, as the reader is told it: what happened, whether anything changed, where things stand, what to do next. */
export function errorView(error: unknown): ErrorView {
  const correlationId = safeValue(field(error, 'correlationId'), 'Unavailable', 160);
  return {
    message: safeValue(field(error, 'message'), 'The request could not be completed.'),
    providerChanged: providerChangeText(field(error, 'providerChanged')),
    safeState: safeValue(field(error, 'safeState'), 'No verified change was applied.'),
    nextAction: safeValue(field(error, 'nextAction'), 'Retry, or share the correlation ID with support.'),
    correlationId,
    copyable: correlationId !== 'Unavailable',
    code: safeValue(field(error, 'code'), 'UNSPECIFIED', 120)
  };
}
