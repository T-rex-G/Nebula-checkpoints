/*
 * Corona: the safeguards around a repository and the way back. The evidence
 * ledger's keys and what a record verifies under; the paths a person has
 * protected; the names a restore may act on; what a restore would do, from
 * two snapshots; a snapshot's signature and the keyring that keeps old ones
 * verifiable; and the repository's access surface, with the access graph's
 * shortest paths. Recovery reads and compares snapshots and issues and
 * spends a restore preview's single-use grant, and http/ holds the routes:
 * the commit recoveries, the safeguards, the snapshots and restores, the
 * access surface and the evidence. The rest of the server reaches this module
 * through this file only.
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
export { RESTORE_AUTH_TTL_MS, SNAPSHOT_KINDS, createRecovery } from './application/recovery.ts';
export type { RefsSnapshot, Recovery, RecoveryDeps, RepositoryTarget, RestoreAction, RestoreGrant, SingleUse } from './application/recovery.ts';
export { registerCommitRecoveryRoutes, registerSnapshotRoutes } from './http/recovery-routes.ts';
export type { CommitRecoveryDeps, RecoveryGuards, SafetyState, SnapshotDeps } from './http/recovery-routes.ts';
export { registerSafeguardRoutes } from './http/safeguard-routes.ts';
export type { SafeguardDeps } from './http/safeguard-routes.ts';
export { registerAccessSurfaceRoutes } from './http/access-surface-routes.ts';
export type { AccessSurfaceDeps } from './http/access-surface-routes.ts';
export { registerEvidenceRoutes } from './http/evidence-routes.ts';
export type { EvidenceDeps } from './http/evidence-routes.ts';
