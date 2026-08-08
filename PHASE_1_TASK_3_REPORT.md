# Nebulaverse-X v5.3.0-alpha.3 — Phase 1 Task 3 report

## Scope

This prerelease implements the Governance Persistence Foundation required by the later central Mutation Gateway, approval workflow, policy simulation, activation/rollback controls, and Policy Digital Twin interface.

Task 3 intentionally adds no governance HTTP routes, no enforcement against repository mutations, and no governance UI. It establishes the durable contracts those later tasks will consume. GitHub PAT, GitHub OAuth, optional GitHub App, GitLab token, and Gitea token behavior remain unchanged.

This is Task 3 of the approved 21-task Phase 1 plan, not the completed v5.3 governance release.

## Architecture

- `src/governance-model.js` is a database-independent model for repository scope normalization, bounded policy schema validation, deterministic document hashing, approval settings, credential-field rejection, audit-record signing, and audit-chain verification.
- `src/governance-store.js` is a focused PostgreSQL store for policy creation, immutable versions, reviewer decisions, transactional activation, rollback, state reads, and audit verification.
- `db/migrations/007_governance.sql` creates six governance tables and database-level immutability triggers.
- Governance is repository-scoped rather than login-scoped. Provider authority is included so GitLab/Gitea installations on different servers cannot collide. Authors, reviewers, and activators retain separate immutable identity keys, enabling genuine multi-person approval.

## Persistence model

Migration `007_governance.sql` adds:

- `nv_governance_policies`
- `nv_governance_policy_versions`
- `nv_governance_approvals`
- `nv_governance_policy_heads`
- `nv_governance_activations`
- `nv_governance_audit`

Policy versions, approvals, activations, and audit records are append-only. PostgreSQL triggers reject UPDATE, DELETE, and TRUNCATE against those history tables. The only mutable governance row is the policy head containing the active version and its monotonic revision.

Composite foreign keys ensure an active, previous, activation, or audit version belongs to the same policy. Rollback appends a new activation event and changes the head; no historical version or activation is rewritten.

## Policy document contract

The initial policy document schema is version `1` and contains:

- an optional description;
- zero to 500 uniquely identified rules;
- a normalized action for each rule;
- an explicit `allow`, `deny`, or `require-approval` effect;
- optional bounded JSON conditions and metadata.

Documents are canonicalized and hashed with SHA-256. Identical content cannot be inserted twice for the same policy. Documents are limited to 256 KiB, bounded by depth, field count, array length, rule count, field-name length, and string size.

Policy and audit JSON reject secret-bearing names including token, secret, password, private-key, authorization, and cookie variants. Credentials are never required by or persisted through the governance store.

## Approval and activation invariants

- One immutable approve/reject decision is allowed per version and reviewer identity.
- Versions require between one and five approvals.
- Author self-approval is forbidden by default.
- Any rejection blocks activation.
- Decisions are frozen once a version has ever been activated.
- Activation requires the caller's expected revision to match the current policy head.
- Advisory and row locks serialize concurrent lifecycle changes.
- A rollback target must belong to the policy and must have been activated previously.
- Rollback creates a new immutable lifecycle event with previous/resulting revision provenance.

Authorization to create, review, activate, or roll back a repository policy will be enforced by later API/Gateway tasks using provider permissions. Task 3 deliberately keeps persistence separate from transport and provider authorization.

## Tamper-evident audit

Every lifecycle event records minimized credential-free details, a details hash, the previous record hash, and an HMAC record hash derived from `SESSION_SECRET`. A database sequence defines unambiguous per-policy order even when timestamps collide. Audit verification reports validity, records checked, total records, chain head, and whether the full chain was checked or only a bounded prefix.

Rotating `SESSION_SECRET` intentionally makes old governance audit HMACs unverifiable. Production operations must treat secret rotation as a controlled cryptographic-boundary event and retain the prior secret securely when historical verification is required.

## Deployment behavior

The migration is applied automatically through the existing numbered, checksummed migration runner when `DATABASE_URL` is configured. Existing deployments without Neon continue to run the current non-governance product features. Durable governance operations intentionally require configured and available Neon persistence and will not fall back to cookies or process memory.

## Independent review corrections

The final read-only correctness and security review identified and corrected three issues before packaging:

- reviewer decisions and activation now acquire the same per-policy advisory lock, preventing an approval/rejection from being appended after activation through a concurrent transaction;
- audit verification now obtains the bounded records and the full-chain count in one PostgreSQL statement snapshot, avoiding inconsistent completeness results during concurrent audit appends;
- self-hosted provider base paths preserve case, preventing policy-scope collisions between distinct case-sensitive installation paths.

No P0 or P1 blocker remains for the alpha.3 persistence checkpoint.

## Verification performed

The focused test-first cycles cover:

- provider/authority/repository scope normalization;
- self-hosted authority separation and unsafe URL rejection;
- canonical policy hashes and duplicate rule rejection;
- document size and sensitive-field rejection;
- approval-policy defaults and bounds;
- audit creation, chaining, and tamper detection;
- policy creation and ordered version insertion;
- author self-approval rejection;
- immutable decision finality after activation;
- approval and rejection activation gates;
- optimistic revision conflict rejection;
- valid and invalid rollback targets;
- duplicate decision translation;
- bounded complete/partial audit verification from one statement snapshot;
- serialization of reviewer decisions against activation;
- case-preserving self-hosted provider authority paths;
- migration discovery, constraints, composite foreign keys, indexes, and immutability triggers.

## Clean-package verification

A provisional deterministic archive was checksum-verified, inspected, and extracted into a new directory before the final archive was sealed. The extracted package passed:

- 112 packaged source entries with zero unsafe paths and zero forbidden generated/secret files;
- `npm ci --offline`: 131 packages installed, 132 packages audited, zero vulnerabilities reported from the locked dependency metadata;
- the complete unit, contract, migration, hardening, GitHub App, security-foundation, package, and server-smoke suite;
- JavaScript syntax validation;
- secret-pattern scanning;
- packaged-runtime validation.

The final SHA-256 is supplied in the adjacent `.sha256` file so the archive remains deterministic and does not contain a self-referential checksum.

## Remaining boundaries

- Task 3 does not expose governance routes or UI and does not yet route repository mutations through policy evaluation.
- Provider permission checks, reviewer-role resolution, organization inheritance, simulations, activation UI, and policy-enforcement decisions belong to later Phase 1 tasks.
- No live PostgreSQL service was available in the sandbox. SQL structure, parameterization, transaction ordering, migration discovery, and store behavior are covered through migration contracts and deterministic scripted clients. The migration must also be exercised against a disposable Neon/PostgreSQL staging database before production promotion.
- `npm audit --audit-level=high` was attempted, but the configured npm advisory service returned HTTP 503. Clean locked installations still report 132 packages and zero vulnerabilities from the available dependency metadata; repeat the online advisory query in CI.
- Browser E2E execution remains a CI/staging activity because Playwright's Chromium binary is not installed in this sandbox. Task 3 changes no browser route or interface, but the existing four browser journeys must still run in CI.
