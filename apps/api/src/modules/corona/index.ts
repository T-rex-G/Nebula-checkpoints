/*
 * Corona: the safeguards around a repository and the way back. The evidence
 * ledger's keys and what a record verifies under; the paths a person has
 * protected; the names a restore may act on; what a restore would do, from
 * two snapshots; a snapshot's signature and the keyring that keeps old ones
 * verifiable; and the repository's access surface, with the access graph's
 * shortest paths. The rest of the server reaches this module through this
 * file only.
 */
export {
  EVIDENCE_ACTIVE_KEY_ID,
  EVIDENCE_LEGACY_KEY_ID,
  acceptsLegacySessionKey,
  evidenceKeyrings,
  evidenceRecordHash,
  parseRetiredSessionSecrets,
  verifyEvidenceRecord
} from './domain/evidence-ledger.ts';
export type { EvidenceKeyrings, Keyring, Verification } from './domain/evidence-ledger.ts';
export { protectedPatternsForRepository } from './domain/safeguards.ts';
export { lfsAttributePattern, normalizeBranchName, normalizeCommitSha, normalizeRepoPath } from './domain/recovery-names.ts';
export type { InvalidName } from './domain/recovery-names.ts';
export { compareSnapshots } from './domain/snapshots.ts';
export type { Comparison, SnapshotComparison } from './domain/snapshots.ts';
export { SIGNATURE_PREFIX, createSnapshotSignatures, loadSnapshotSigningConfig } from './domain/snapshot-signatures.ts';
export type { SnapshotSignatures, SnapshotSigningConfig, SnapshotVerification } from './domain/snapshot-signatures.ts';
export { riskForAccessSurface, shortestPath } from './domain/access-surface.ts';
export type { GraphPath, SurfaceReason, SurfaceRisk } from './domain/access-surface.ts';
