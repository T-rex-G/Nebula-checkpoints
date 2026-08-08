# Task 14 — Exceptions, Waivers and Expiry Workflow

## Goal

Add a repository-scoped, two-person, time-bounded exception workflow without weakening immutable policy, review, activation, runtime decision, audit or provider boundaries.

## Terminology

- **Exception:** temporarily waives one or more matched `deny` rules.
- **Waiver:** temporarily waives one or more matched `require-approval` rules.
- Neither changes an immutable policy document or active head.
- An approved record applies only to the exact provider authority, repository, policy, active version, exact policy-head revision, document hash, verified requester identity, registered action, canonical mutation-target fingerprint and rule IDs recorded in the request.

## Roles and separation of duties

- Request: current server-verified `author` role or higher.
- Approve/reject/revoke: current server-verified `administrator` role.
- The requester cannot approve or reject their own request.
- Browser-supplied actor, role, permission, approval or authorization evidence is rejected.
- GitHub App execution remains separate from the verified human governance actor.

## Lifecycle

`pending -> approved | rejected | expired | superseded`

`approved -> revoked | expired | superseded`

- State is derived from immutable request/event records plus current time and active policy head.
- Expiry is automatic at `expiresAt`; runtime never applies an expired record.
- Policy version changes make older requests `superseded` and non-applicable.
- Approval or rejection after expiry/supersession is rejected.
- Revocation is append-only and takes effect immediately.

## Bounds

- Duration: at least 5 minutes and at most 30 days from server time.
- One action and one explicit non-empty canonical mutation target per request.
- Target metadata is normalized with the Central Mutation Gateway contract, limited to 2 KiB, secret-scanned and prohibited from containing raw content, patches, diffs, payloads or request bodies.
- 1–50 unique rule IDs.
- Target rules must exist in the exact immutable version, match the requested action and all have the effect required by the selected kind.
- Reason and decision rationale are bounded, printable and secret-scanned.

## Runtime application

The Central Mutation Gateway continues to evaluate the immutable active policy first. Approved exceptions are then applied only to matched target rules:

1. Evaluate active policy rules normally.
2. Load active approved, unrevoked, unexpired records for the exact scope/action/version/head revision.
3. Require the runtime verified human governance actor and canonical mutation-target hash to match the request exactly.
4. Mark only covered matched rules as waived.
5. Recompute the policy effect from remaining matched rules.
6. Preserve original effect, subject identity, target hash, waived rule IDs and immutable exception evidence in the runtime decision.
7. Persist the decision before provider execution.

A partial waiver does not neutralize uncovered restrictive rules. Exceptions do not apply to unknown actions, unsupported rules, inactive versions, different repositories, different provider authorities, different verified humans, different normalized mutation targets or future policy-head states.

## Persistence

Migration `012_governance_exceptions.sql` adds immutable request and event tables with composite foreign keys, uniqueness constraints and append-only triggers.

Every request, approval, rejection and revocation also appends lifecycle audit evidence. Runtime application is additionally captured in the separate policy-decision HMAC chain.

## API

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions`
- `GET /api/repo/:owner/:repo/governance/exceptions/:exceptionId`
- `POST /api/repo/:owner/:repo/governance/exceptions/:exceptionId/decision`
- `POST /api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke`

All responses use `Cache-Control: no-store`. Writes pass through the Central Mutation Gateway and support bounded hashed idempotency.

## Mutation actions

- `governance.exception.request`
- `governance.exception.decide`
- `governance.exception.revoke`

## Deployment invariants

- Runtime expiry is enforced by database/server time and does not depend on a background worker.
- Existing pre-Task-14 policy decisions remain verifiable.
- Engine-version 2 decisions include exception evidence; engine-version 1 remains accepted for historical records.
- Missing or invalid exception persistence causes normal runtime failure-mode handling; it never silently grants a bypass.
- Governance recovery routes remain non-blocking under policy enforcement, but exception authorization and PostgreSQL constraints remain mandatory.

## Non-goals

- Organization-wide exceptions.
- Cross-repository inheritance.
- Permanent overrides.
- Browser-managed roles.
- External ticketing or evidence storage.
- Task 15 templates or Task 19 notifications/exports.

## Review-hardening amendments

### Historical evidence compatibility

Task 14 introduces policy-decision engine version 2 and control catalog version `1.1.0`. The exact Task 12–13 catalog `1.0.0` and engine-version-1 normalization remain supported permanently for existing immutable decisions. A historical record is normalized and re-derived with the catalog version it originally recorded; a newer catalog must never reinterpret it.

### Active exception bound

A maximum of 100 approved, unexpired and unrevoked records may be applicable to one repository scope and gateway action. Approval acquires a repository/action serialization lock before counting current records and rejects a 101st approval. Runtime loading detects an impossible overflow with `LIMIT 101` and follows the configured evaluator failure mode. Revocation remains available as the recovery path.

### Point-in-time semantics

One server operation timestamp is captured after all required locks are acquired. Approval must exist at or before that timestamp; a revocation affects the decision only when its event timestamp is at or before the same timestamp. This prevents a concurrent approval or revocation from being applied retroactively to a decision already in progress.

### Descriptor evidence

`governance.exception.request` gateway metadata includes the exact normalized target rule IDs, canonical target metadata and the original rule count, in addition to policy/version, kind, action and expiry. Decision and revocation descriptors bind the exact exception identifier and bounded decision/reason facts.


### Terminal head-revision binding

Each request stores the policy-head revision active at creation. Approval counting, state derivation and runtime loading require the current active version and current head revision to match the stored values. Any later activation or rollback transition supersedes the request permanently, including a later return to the same version ID.

### Actor and target binding

The immutable request stores the verified human requester plus canonical target JSON and `target_hash = SHA-256(stableJson({ action, metadata }))`. Runtime application compares that identity and hash with the current descriptor. For optional GitHub App execution, the subject remains the verified human governance actor rather than the installation principal. Raw content and sensitive target values are never persisted.

### Relational scope binding

Migration 012 adds a unique `(policy_id, scope_key)` policy index and a composite foreign key from exception requests, preventing persisted scope metadata from diverging from the owning policy.
