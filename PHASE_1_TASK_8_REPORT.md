# Phase 1 Task 8 Report — Reviewer Assignment and Approval Workflow

## Checkpoint

Version: **Nebulaverse-X v5.3.0-alpha.7**

Task 8 adds the reviewer-assignment and immutable decision workflow on top of the Task 6–7 Governance API and submitted policy versions. It remains an alpha checkpoint and does not activate or enforce policy.

## Implemented behavior

- Added reviewer self-claim for the current server-verified human governance actor.
- Added immutable, repository-scoped reviewer assignments.
- Added one immutable approve/reject decision per assigned identity and version.
- Added deterministic pending, approved, rejected, quorum, and terminal review state.
- Added reader-authorized review-state retrieval.
- Enforced current reviewer authority at both assignment and decision time.
- Enforced author/reviewer separation when `disallowAuthorApproval` is enabled.
- Required a bounded rationale for rejection and screened rationale for likely credential material.
- Preserved GitHub App installation execution while attributing governance evidence to its verified human actor.
- Added optional hashed idempotent retry behavior for claims and decisions.
- Added exact policy/version/repository/provider-authority isolation.

## Architecture and persistence

- Added `db/migrations/009_governance_reviews.sql`.
- Added immutable `nv_governance_review_assignments` with authorization evidence captured at claim time.
- Extended `nv_governance_approvals` with Task 8 assignment and decision-time authorization evidence.
- Added database uniqueness and foreign-key constraints binding each decision to the assigned human and version.
- Added update/delete/truncate rejection for reviewer-assignment history.
- Excluded pre-Task-8 approval rows without assignments from review state and activation quorum.
- Added shared policy and version advisory locks so reviews serialize safely against future activation.

## API and Mutation Gateway

Added routes:

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions`

Added mutation actions:

- `governance.reviewer.assign`
- `governance.approval.decide`

No browser-supplied reviewer identity, governance role, access level, installation permission, or actor claim is accepted.

## Test-first evidence

The implementation began with failing tests for the absent review model, migration, store operations, API methods, routes, and gateway actions. Focused tests then proved:

- deterministic quorum and rejection;
- author separation;
- current and non-stale authorization evidence;
- GitHub App human attribution;
- exact scope and version binding;
- unassigned-decision rejection;
- terminal-state finality;
- repeated claim deduplication;
- rejection rationale and sensitive-text controls;
- policy/version concurrency locks;
- immutable database constraints;
- gateway action and metadata contracts.

## Review findings resolved

The implementation and regression review resolved the following risks before packaging:

- legacy unassigned approvals accidentally satisfying Task 8 review or later activation;
- review/activation race windows by using the shared policy lock;
- browser-supplied reviewer and actor fields;
- GitHub App installation identity being mistaken for a human reviewer;
- stale provider evidence, including evidence that expires while waiting for PostgreSQL locks;
- duplicate assignment or decision races;
- sensitive credential-like content in rationale;
- broad safeguard exemptions for future governance routes.

No P0 or unresolved P1 source-level finding remains at the release checkpoint.

## Scope intentionally deferred

Task 8 does not implement policy simulation, impact diff, activation/rollback APIs, active-policy evaluation, observe/warn/block modes, exceptions, templates, notifications, exports, or the Policy Digital Twin UI.

## Verification boundary

The checkpoint passed 34 dependency-free test programs, build verification, syntax checks, secret scanning, deterministic duplicate-build comparison, archive inspection, and clean-extraction verification. Dependency-backed Express, package-release, browser, live PostgreSQL/Neon, and real-provider checks remain unavailable in this environment because the public-registry dependency installation did not complete and left an invalid partial tree, which was removed.

## Next checkpoint

Proceed with the combined **Phase 1 Tasks 9–10 — Policy Simulation Engine and Simulation Evidence/Impact Diff** as `v5.3.0-alpha.8`, beginning with a focused design and acceptance gate before production code.
