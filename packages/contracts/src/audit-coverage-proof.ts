/* The public, source-free statement made by a retained-audit coverage proof. */
import type { AuditWatchState } from './evidence.ts';

export const AUDIT_COVERAGE_PROOF_CONTRACT_VERSION = 1;
export interface AuditCoverageStatement {
  readonly kind: 'uranus.kept-audit-coverage';
  readonly version: typeof AUDIT_COVERAGE_PROOF_CONTRACT_VERSION;
  readonly scopeDigest: string;
  readonly auditId: string;
  readonly commitSha: string;
  readonly engine: string;
  readonly ruleset: string | null;
  readonly auditedAt: string;
  readonly analysisComplete: boolean | null;
  readonly files: { readonly read: number; readonly eligible: number; readonly complete: boolean };
  readonly findings: { readonly stored: number; readonly total: number };
  readonly watch: { readonly checkedAt: string; readonly state: AuditWatchState } | null;
}

export interface AuditCoverageProof {
  readonly statement: AuditCoverageStatement;
  readonly decision: 'complete' | 'incomplete' | 'unrecorded';
  readonly digest: string;
}
