# Governance Persistence Foundation Design

## Status

Approved from the Phase 1 roadmap and the user's instruction to continue to Task 3.

## Goal

Create the durable, tamper-evident data foundation required by later Phase 1 governance workflows without yet enforcing policy on repository mutations or adding governance UI.

## Scope

Task 3 adds:

- provider-authority/repository-scoped policy identities;
- immutable versioned policy documents;
- immutable approve/reject decisions from distinct identities;
- one transactional active-version pointer with an optimistic revision;
- append-only activation and rollback history;
- append-only, HMAC-linked governance audit records;
- validation that prevents secrets and credentials from entering policy or audit JSON;
- a focused PostgreSQL store API for later Mutation Gateway and Policy Digital Twin tasks.

Task 3 does not add:

- mutation interception or enforcement;
- policy simulation;
- approval UI or API routes;
- provider-side ruleset changes;
- organization-wide policy inheritance.

## Architecture

`src/governance-model.js` owns deterministic normalization, bounded JSON validation, document hashing, approval-policy validation, audit hashing, and audit-chain verification. It has no database or Express dependency.

`src/governance-store.js` owns transactional PostgreSQL lifecycle operations. It receives a pool and the server secret, uses advisory/row locks for ordering, and exposes explicit methods for policy creation, version creation, approval decisions, activation, rollback, reads, and audit verification.

`db/migrations/007_governance.sql` creates policy, version, approval, active-head, activation, and audit tables. Immutable history tables reject UPDATE, DELETE, and TRUNCATE through database triggers. Rollback appends a new activation record and moves only the active head; it never mutates a historical version or activation.

## Security invariants

- Policy and audit JSON are bounded, canonicalized, and rejected when sensitive field names such as access tokens, secrets, passwords, private keys, authorization headers, or cookies are present.
- Every policy is bound to one normalized provider authority/repository scope; self-hosted authority paths preserve case to prevent distinct installations from colliding; actors retain separate immutable identity keys so multi-person approval is possible.
- Policy versions are immutable and content-addressed by SHA-256.
- The version author cannot approve that version when separation of duties is enabled.
- One identity can record only one immutable decision per version.
- Any rejection blocks activation of that version.
- Activation requires the configured number of distinct approvals.
- Approval decisions and activation share one per-policy transaction lock, preventing decisions from crossing the activation boundary.
- Activation uses an expected revision to reject stale or concurrent head changes.
- Rollback targets a version that was previously activated for the same policy.
- Audit records form an HMAC-linked chain per policy and are independently verifiable through one snapshot-consistent query.
- Database-backed governance fails closed; there is no cookie or memory fallback for durable policy state.

## Data model

- `nv_governance_policies`: stable identity, repository scope, human metadata, creator.
- `nv_governance_policy_versions`: immutable ordered versions, canonical document, hash, author, approval requirements.
- `nv_governance_approvals`: immutable approve/reject decision per version and actor identity.
- `nv_governance_policy_heads`: mutable active version pointer and monotonic revision.
- `nv_governance_activations`: immutable activate/rollback events, previous and resulting versions, expected/resulting revisions.
- `nv_governance_audit`: immutable HMAC-linked lifecycle events with credential-free details.

## Error handling

The model and store return stable `GovernanceError` codes. Constraint conflicts, stale revisions, missing approvals, rejection, self-approval, wrong scope, and unavailable persistence fail closed. Transaction failures roll back before returning.

## Verification

- Pure model tests cover canonical hashes, bounds, secret rejection, scope normalization, approval rules, and audit-chain tampering.
- Store tests exercise transaction ordering and lifecycle preconditions with deterministic scripted PostgreSQL clients.
- Migration contract tests inspect constraints, foreign keys, indexes, and append-only triggers.
- Existing migrations, security, GitHub App, release, smoke, syntax, secret, and package tests remain green.
