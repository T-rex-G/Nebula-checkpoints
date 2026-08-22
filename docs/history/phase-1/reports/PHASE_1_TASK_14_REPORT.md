# Phase 1 Task 14 Report — Exceptions, Waivers and Expiry Workflow

## Checkpoint

- Product: **Nebulaverse-X**
- Version: **v5.3.0-alpha.11**
- Phase: **Phase 1 — Policy Digital Twin and Governance Foundation**
- Task: **14 — Exceptions, Waivers and Expiry Workflow**
- Status: **Implemented and source-reviewed**

## Objective

Introduce narrowly scoped, time-bounded policy exceptions and waivers without editing immutable policy documents, weakening provider authorization, bypassing the Central Mutation Gateway, or depending on a background worker for expiry correctness.

## Delivered behavior

### Two-person lifecycle

- A current server-verified repository author may request an exception or waiver.
- A different current server-verified repository administrator may approve or reject it.
- A current administrator may revoke an approved record.
- The requester cannot decide their own request.
- Browser-supplied actor identities, roles, permission levels, approval states and timestamps are rejected.
- Optional GitHub App execution remains separate from the verified human requester or administrator.

### Exact immutable scope

Every request is bound to the exact:

- provider and provider authority;
- repository owner and name;
- policy and immutable active version;
- immutable policy document hash;
- registered Central Mutation Gateway action;
- exception kind;
- one to fifty policy rule IDs;
- verified human requester identity;
- explicit non-empty canonical mutation-target metadata and deterministic target hash;
- server-validated expiry.

An exception applies only while the same immutable policy version and head revision remain active, and only for the same verified human plus exact normalized mutation target. A head change makes the record permanently superseded and non-applicable.

### Exception semantics

- `exception` waives matched `deny` rules.
- `waiver` waives matched `require-approval` rules.
- Target rules must exist in the immutable policy document, match the requested gateway action and have the effect required by the selected kind.
- Only covered matched rules are removed from the effective evaluation.
- Uncovered restrictive rules remain effective.
- The runtime decision preserves the original result, effective result, waived rule IDs, subject identity and target hash in exact applied-exception evidence.

### Time and lifecycle semantics

- Minimum duration: five minutes.
- Maximum duration: thirty days.
- Expiry is evaluated synchronously from the operation timestamp; correctness does not depend on a scheduler.
- Approval and revocation are evaluated against the same decision timestamp, preventing concurrent events from being applied retroactively.
- Request, approval, rejection and revocation rows are append-only.

## Persistence

Migration `012_governance_exceptions.sql` adds:

- `nv_governance_exception_requests`;
- `nv_governance_exception_events`;
- composite policy/version foreign keys;
- one immutable decision event per request;
- one immutable revocation event per request;
- canonical bounded target JSON and deterministic target hashes;
- runtime lookup indexes;
- UPDATE, DELETE and TRUNCATE rejection triggers.

Each lifecycle mutation and its HMAC audit append are transactional and use the existing hashed idempotency boundary.

## API and gateway integration

### Read routes

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions`
- `GET /api/repo/:owner/:repo/governance/exceptions/:exceptionId`

### Mutation routes

- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions`
- `POST /api/repo/:owner/:repo/governance/exceptions/:exceptionId/decision`
- `POST /api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke`

### Registered gateway actions

- `governance.exception.request`
- `governance.exception.decide`
- `governance.exception.revoke`

The request descriptor binds the exact action, kind, expiry, rule IDs and rule count. All writes are attributed to the verified human governance actor.

## Deployment hardening completed during review

### Historical decision compatibility

Adding the Task 14 gateway actions originally changed the canonical control-catalog hash. That would have made alpha.10 runtime decisions fail normalization and chain verification.

The reviewed solution preserves:

- control catalog `1.0.0` exactly for historical alpha.10 evidence;
- control catalog `1.1.0` for Task 14 and later actions;
- policy-decision engine version `1` for historical records;
- policy-decision engine version `2` for exception-aware records.

Historical evidence is never reinterpreted through a newer catalog.

### Active-exception bound

At most 100 approved, unexpired and unrevoked exceptions may be active for one repository scope and gateway action.

- Approval takes a repository/action advisory lock and rejects a 101st applicable exception.
- Runtime loading uses `LIMIT 101` and detects unsupported overflow.
- Revocation remains available as the recovery operation.
- Overflow follows the configured runtime evaluator failure mode and never silently grants a bypass.

### Terminal supersession across head transitions

Every request stores the exact policy-head revision that was active when it was created. Runtime loading and approval counting require both the same active version and the same head revision. Any activation or rollback transition permanently supersedes the request, even when a later rollback returns to the same version ID.

### Actor and target isolation

Each request is bound to the verified human requester and a SHA-256 fingerprint of the exact normalized mutation descriptor metadata for the registered action. A request made by one human cannot waive another human's operation, and a waiver for one path, branch, pull request, issue, release or other bounded target cannot apply to another. Optional GitHub App execution uses the verified human governance actor as the subject while preserving the installation as execution principal.

Raw content, patches, diffs, payloads, bodies, secret-bearing values and target metadata over 2 KiB are rejected. Only the target hash—not raw target metadata—is added to runtime decision evidence.

### Temporal concurrency correctness

Approval and revocation joins are bounded by the runtime operation timestamp. An event committed after evaluation begins cannot retroactively alter that earlier decision.

Authorization is revalidated after lock acquisition so a request cannot wait through provider-evidence expiry and then write.

## Security boundaries preserved

Exceptions cannot bypass:

- Task 1 step-up authorization;
- Task 5 provider-derived repository authority;
- exact mutation action classification;
- provider/repository scope matching;
- Task 8 human identity and separation of duties;
- Task 11 immutable active-version evidence;
- gateway policy evaluation;
- PostgreSQL append-only and HMAC evidence chains.

Missing, malformed or unavailable exception persistence never produces an implicit allow.

## Source-level verification

The checkpoint includes focused tests for:

- model normalization and secret rejection;
- immutable migration contracts;
- store lifecycle and authorization;
- API and route boundaries;
- exact actor/target runtime application and partial waivers;
- wrong-actor, wrong-target, target-hash-tampering and GitHub App human-binding rejection;
- active-exception runtime and approval limits;
- historical engine-v1 normalization and decision-chain verification;
- mutation-action and control-catalog coverage;
- lock-time and point-in-time behavior.

The final build report records the complete frozen-workspace and clean-package results.

## Environment-backed verification still required

Before production promotion, run:

- Express startup and route integration tests;
- Playwright browser tests;
- live Neon migration 012 execution;
- live PostgreSQL advisory-lock and concurrency tests;
- real GitHub, GitLab and Gitea operations;
- runtime packaging through `archiver`;
- dependency audit.

## Non-goals retained

Task 14 does not implement:

- policy templates or repository baselines;
- the Policy Digital Twin read model or final UI;
- organization-wide inheritance;
- notifications, webhooks or signed exports;
- customer-controlled external evidence storage;
- permanent policy bypasses.

## Next checkpoint

Proceed with the planned combined checkpoint:

- **Task 15 — Policy Templates and Repository Baselines**
- **Task 16 — Policy Digital Twin Read Model**
- Target version: **v5.3.0-alpha.12**
