/*
 * Posture: what the workspace's own records say about it, read together. The
 * credential's reach and the recovery points behind the overview, the
 * security posture and the findings inbox drawn from Uranus's audits and
 * Quasar's scans, the pull-request board's items, the provider's branch rules
 * beside the server's own safeguards, and the standards every finding is
 * filed under. The rest of the server reaches this module through this file
 * only.
 */
export {
  CWE_NAMES,
  CWE_TOP25_2025,
  MAP as STANDARDS_MAP,
  MAPPED_RULES,
  OWASP_2025,
  OWASP_2025_CWES,
  OWASP_EDITION,
  standardsFor
} from './domain/security-standards.ts';
export type { OwaspBasis, OwaspCategory, Standards } from './domain/security-standards.ts';
export { GITHUB_BROAD_SCOPES, credentialPosture, exposureSummary, githubTokenKind } from './domain/workspace-posture.ts';
export type { CredentialInput, CredentialPosture, RepositoryExposure, TokenKind } from './domain/workspace-posture.ts';
export { EXPOSURE_CATEGORY, SEVERITIES, TOP_REPOSITORIES, summarizePosture } from './domain/posture-summary.ts';
export type { PostureInput } from './domain/posture-summary.ts';
export { EXPOSURE_KIND, NEW_WINDOW_MS, STATES as INBOX_STATES, buildInbox } from './domain/findings-inbox.ts';
export type { InboxInput, InboxItem } from './domain/findings-inbox.ts';
export { MAX_LABELS, MAX_LABEL_LENGTH, pullListItem } from './domain/pull-list.ts';
export type { PullListItem } from './domain/pull-list.ts';
export { CONTROLS as BRANCH_CONTROLS } from './domain/branch-rules.ts';
export type { ControlId, ControlReading } from './domain/branch-rules.ts';
export { readBranchProtection } from './application/branch-protection.ts';
export type { BranchProtectionInput, RepositoryRead } from './application/branch-protection.ts';
export { createPostureReader } from './application/posture-reader.ts';
export type { PostureDependencies, WorkspacePosture } from './application/posture-reader.ts';
export { registerBranchProtectionRoutes, registerWorkspacePostureRoutes } from './http/posture-routes.ts';
export type { BranchProtectionDeps, PostureGuards, WorkspacePostureDeps } from './http/posture-routes.ts';
