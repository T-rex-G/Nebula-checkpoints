/*
 * A finding as the workspace inbox carries it (GET /api/workspace/findings).
 *
 * The server builds these in src/findings-inbox.js from two stores -- kept
 * audits and exposure scans -- and the page draws them. The shape is one
 * contract between the two: what the server promises to send and all the page
 * may rely on.
 */

import type { SourceState as EvidenceSourceState } from './evidence.ts';

export const FINDINGS_CONTRACT_VERSION = 1;

export const SEVERITIES = Object.freeze(['critical', 'serious', 'warning'] as const);
export type Severity = (typeof SEVERITIES)[number];

export type FindingSource = 'audit' | 'exposure';

/* Where a finding stands: undecided (regressed, new, open), or a decision. */
export type FindingState = 'regressed' | 'new' | 'open' | 'accepted-risk' | 'false-positive';

export interface FindingDecision {
  readonly disposition: string;
  readonly reason?: string | null;
  readonly expiresAt?: string | null;
  readonly decidedAt?: string | null;
}

export interface FindingPackage {
  readonly ecosystem?: string;
  readonly name: string;
  readonly version: string;
  readonly fixed: string | null;
}

export interface InboxFinding {
  readonly key: string;
  readonly source: FindingSource;
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly ref: string | null;
  readonly rule: string;
  readonly title: string | null;
  readonly kind: string;
  readonly severity: Severity;
  readonly state: FindingState;
  readonly path: string | null;
  readonly line: number | null;
  readonly package: FindingPackage | null;
  readonly cves: readonly string[];
  readonly exploited: boolean;
  readonly verdict?: string | null;
  readonly firstSeenAt: string | null;
  readonly ageDays: number | null;
  readonly timesFixed: number;
  readonly regressedAfter: string | null;
  readonly decision: FindingDecision | null;
  readonly historyOnly: boolean;
}

/* The decisions a person may record, as the server describes them. */
export interface TriageVocabulary {
  readonly dispositions: readonly { readonly id: string; readonly label: string }[];
  readonly reasons: readonly { readonly id: string; readonly label: string; readonly disposition: string }[];
  readonly acceptDays: { readonly min: number; readonly max: number; readonly choices: readonly number[]; readonly default: number };
}

/* The inbox reads each store whole or not at all, so it never reports a partial source. */
export type SourceState = Exclude<EvidenceSourceState, 'partial'>;

export interface FindingsInbox {
  readonly available?: true;
  readonly sources?: { readonly audit?: SourceState; readonly exposure?: SourceState };
  readonly truncated?: boolean;
  readonly findings?: readonly InboxFinding[];
  readonly vocabulary?: TriageVocabulary | null;
}

/* The inbox the server could not read, or the page could not reach. */
export interface UnavailableInbox {
  readonly available: false;
  readonly reason?: string;
}
