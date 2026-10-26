/*
 * Quasar: credential exposure. Detection and its rules, keyed findings, the
 * archives a scan opens, what a finding means in words, the scan worker and
 * its store, and the three provider clients -- the repository reader, the
 * credential verifier and the readability probe -- each a namespace of its
 * own, because each speaks to a different party and their vocabularies
 * overlap. Its routes are in http/. The rest of the server reaches this module
 * through this file only.
 */
export { KEY_KINDS, KEY_PATTERN, MAX_KEY_LENGTH, classifyKey } from './domain/supabase-key-kinds.ts';
export type { KeyClassification, KeyKind } from './domain/supabase-key-kinds.ts';
export { EXPOSURE_RULES, MIN_ENTROPY_BITS, PATH_RULES, plausibleConnectionString, plausibleSecret, shannonEntropy } from './domain/exposure-rules.ts';
export type { ExposureRule, PathRule } from './domain/exposure-rules.ts';
export {
  DETECTION_ENGINE_VERSION,
  MAX_CANDIDATES_PER_FILE,
  MAX_MATCHES_PER_FILE,
  MAX_OCCURRENCES_PER_CANDIDATE,
  MAX_TEXT_BYTES,
  RULES_VERSION,
  createLocator,
  detectInHunks,
  detectInPath,
  detectInText,
  sanitizeCandidate
} from './domain/exposure-detection.ts';
export type { DetectedCandidate, DetectionInput, DetectionResult, Location, SanitizedCandidate } from './domain/exposure-detection.ts';
export {
  CandidateSecret,
  FINGERPRINT_KEY_VERSION,
  buildFindings,
  fingerprintFor,
  fingerprintKeyId,
  reconcileFindings,
  revealForVerification
} from './domain/exposure-findings.ts';
export type {
  BuildFindingsInput,
  BuiltFindings,
  Finding,
  FindingScope,
  FingerprintInput,
  Reconciliation,
  RevealedProbe,
  VerificationProbe
} from './domain/exposure-findings.ts';
export {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_MEMBERS,
  MAX_EXPANDED_BYTES,
  MAX_MEMBER_BYTES,
  MEMBER_SKIPS,
  ZIP_EXTENSIONS,
  archiveKind,
  openArchive,
  safeMemberPath
} from './domain/exposure-archives.ts';
export type { ArchiveKind, ArchiveMember, DecodeText, MemberSkip, NamedMember, OpenArchiveInput, OpenedArchive } from './domain/exposure-archives.ts';
export {
  REASONS as VERIFICATION_REASONS,
  VERIFICATION_FRESHNESS_MS,
  VERIFICATION_STATES,
  verificationFreshness
} from './domain/verification-outcomes.ts';
export type { VerificationReason, VerificationState } from './domain/verification-outcomes.ts';
export { PROBE_STATES, REASONS as PROBE_REASONS } from './domain/readability-outcomes.ts';
export type { ProbeReason, ProbeState } from './domain/readability-outcomes.ts';
export {
  DISPOSITION_NARRATION,
  NARRATION_VERSION,
  PROBE_NARRATION,
  RULE_NARRATION,
  VERIFICATION_NARRATION,
  describeDisposition,
  describeFinding,
  describeLocation,
  describeProbe,
  describeVerification,
  narrationForRule,
  exposureSeverityOf,
  observationFreshness,
  safeDisplayPath
} from './domain/exposure-narration.ts';
export type { FindingNarration, NarrationInput, ObservationFreshness, RuleNarration } from './domain/exposure-narration.ts';
export * as exposureReader from './client/exposure-reader.ts';
export * as credentialVerifier from './client/credential-verification.ts';
export * as readabilityProbe from './client/anonymous-readability-probe.ts';
export { resolveExposureSession } from './application/exposure-session.ts';
export type { ExposureSessionDependencies, ExposureSessionInput } from './application/exposure-session.ts';
export { DEFAULT_BUDGETS, EXPOSURE_BUDGET_VERSION, createExposureRunner, startExposureWorker } from './application/exposure-worker.ts';
export type {
  Budgets,
  ExposureRunner,
  ExposureRunnerOptions,
  ExposureWorkerOptions,
  ObservedFinding,
  ScanConnections,
  ScanReader,
  ScanStore,
  SessionResolver
} from './application/exposure-worker.ts';
export {
  COVERAGE,
  DECODINGS,
  DEFAULT_PROBE_FRESHNESS_MS,
  DEFAULT_VERIFICATION_FRESHNESS_MS,
  DISPOSITIONS,
  EXPOSURE_CONFIG_VERSION,
  ExposureStore,
  ExposureStoreError,
  MAX_FINDINGS_PER_SCAN,
  MAX_OCCURRENCES,
  SCAN_MODES,
  SCAN_STATES,
  SKIPPED_REASONS,
  TERMINAL_STATES
} from './persistence/exposure-store.ts';
export type {
  Disposition,
  ExposureScope,
  ExposureStoreOptions,
  FindingRecord,
  ObservationRecord,
  ReadabilityProbeRecord,
  ScanRecord,
  VerificationRecord
} from './persistence/exposure-store.ts';
export { EXPOSURE_VERIFIABLE_RULES, exposureFindingPayload } from './http/finding-payload.ts';
export { registerExposureRoutes } from './http/exposure-routes.ts';
export type { ExposureRecords, ExposureRouteDeps, GovernanceAccessOptions } from './http/exposure-routes.ts';
