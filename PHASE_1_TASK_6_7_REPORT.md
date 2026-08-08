# Nebulaverse-X v5.3.0-alpha.6 — Phase 1 Tasks 6–7 report

## Scope

This combined prerelease implements:

- **Task 6 — Governance API and Authorization Boundary**
- **Task 7 — Policy Draft and Immutable Version Workflow**

The tasks are packaged together because the API boundary and its first durable lifecycle workflow share the same repository scope, authorization, mutation-gateway and persistence contracts. They were nevertheless implemented through separate internal test-first gates.

This is an alpha checkpoint within the controlled 21-task Phase 1 roadmap, not the completed v5.3 release.

## Governance API boundary

`src/governance-api.js` is the single service boundary between authenticated HTTP routes and the governance store. Every operation:

- uses a server-derived Task 5 authorization snapshot;
- binds to the exact provider authority, owner and repository scope;
- rejects unavailable, partial, stale, future-dated or contradictory permission evidence;
- requires the appropriate normalized governance role;
- uses the verified human governance actor for ownership and audit attribution;
- keeps a GitHub App installation execution principal separate from its human authorizer;
- requires the configured PostgreSQL database and has no cookie or process-memory durability fallback.

Browser-supplied roles, actor identities, provider permission levels and installation capabilities are never accepted as authority.

## API surface

The authenticated repository-scoped API includes:

- list and create policies;
- retrieve policy state;
- validate a proposed policy document;
- create, retrieve, update and validate an author-owned draft;
- submit a draft as an immutable policy version;
- list and retrieve immutable versions.

Reviewer decisions, reviewer assignment, activation, rollback, simulation, policy enforcement and exceptions remain outside this checkpoint.

## Draft and immutable-version workflow

Drafts are durable PostgreSQL records but are intentionally mutable while being authored. Each policy permits one active draft per author identity.

Draft updates require an exact `expectedRevision`. A stale writer receives a bounded conflict instead of overwriting newer content.

Submission occurs in one transaction:

1. lock and verify the author-owned draft in the exact repository scope;
2. require the expected revision;
3. normalize the stored policy document and verify its SHA-256 integrity hash;
4. serialize version-number allocation for the policy;
5. insert the next immutable policy version;
6. delete the submitted draft;
7. append the linked governance audit event;
8. commit all effects together or roll all of them back.

Database triggers from Task 3 continue to reject update, delete and truncate operations against immutable version, approval, activation and audit history.

## Central Mutation Gateway integration

The mutation registry now contains 32 actions, including:

- `governance.policy.create`
- `governance.draft.create`
- `governance.draft.update`
- `governance.draft.submit`

Each governance write enters the Central Mutation Gateway before persistence. Governance descriptors contain bounded identifiers and revision evidence only; policy names, descriptions, documents, credentials and idempotency keys are excluded.

Governance actions bind the descriptor actor to the verified human governance actor. This permits an optional GitHub App installation to execute provider authentication while preventing the installation identity from being credited with human policy authorship.

## Idempotent write safety

The four governance writes accept an optional `Idempotency-Key`:

- keys are validated, then stored only as SHA-256 hashes;
- records are isolated by repository scope, human actor and operation;
- the normalized request receives a separate hash;
- an exact retry returns the original stored response;
- reusing a key with different content returns a bounded conflict;
- reservation, governance write, audit append and response recording share the same PostgreSQL transaction;
- completed records are retained for 24 hours by the existing maintenance process.

No raw idempotency key is written to PostgreSQL, mutation metadata, logs or audit details.

## Security review corrections

The read-only implementation review identified and corrected these issues before packaging:

1. **Self-hosted Gitea base-path compatibility:** Task 5 snapshot comparison lower-cased the complete scope key, incorrectly rejecting case-sensitive base paths such as `/GitRoot`. Provider hostnames remain normalized while base-path case is now preserved.
2. **GitLab role separation:** regression coverage confirms Maintainer remains reviewer-level and cannot be normalized as Owner/administrator.
3. **Authorization consistency:** forged or inconsistent access-level, role and governance-role combinations are rejected before the gateway.
4. **Human actor binding:** GitHub App governance writes are bound to the verified human actor rather than the installation execution principal.
5. **Prototype-control keys:** governance policy and audit JSON now reject `__proto__`, `prototype` and `constructor`, preventing unsafe object-shape manipulation during normalization.
6. **Idempotency completion:** persistence now verifies that the reserved idempotency record was actually updated with the bounded response before committing.
7. **Policy existence checks:** validation and version-list operations first prove that the policy exists in the exact repository scope.
8. **Cache and safeguard boundaries:** governance responses now use `Cache-Control: no-store`, and only the exact current authoring/validation routes bypass repository read-only safeguards; future governance routes do not inherit an automatic exemption.
9. **Bounded list inputs:** non-integer or out-of-range list limits are rejected before PostgreSQL queries.
10. **Release-test integrity:** the release-contract harness now reports an early server exit as a failure instead of silently finishing during cleanup.

No P0 or unresolved P1 finding remains in the source-level Tasks 6–7 review.

## Database migration

`db/migrations/008_governance_drafts.sql` adds:

- `nv_governance_policy_drafts`;
- one-active-draft-per-author constraint;
- revision and document-integrity fields;
- `nv_governance_idempotency` with hashed keys and request hashes;
- bounded indexes for draft lookup and idempotency cleanup.

The migration is numbered and checksummed by the existing migration system. An already-applied migration cannot be silently changed.

## Configuration

Governance remains available only when `DATABASE_URL` is configured and reachable.

`NV_GOVERNANCE_AUDIT_SECRET` is optional but recommended as a stable production secret. When omitted, a derived key from `SESSION_SECRET` is used for compatibility. Rotating the secret used by an existing governance audit chain would prevent future verification of old records, so the deployment documentation requires stable secret management and backup.

## Verification boundaries

Source-level and dependency-free tests cover authorization, actor ownership, scope isolation, optimistic revisions, atomic submission, idempotent replay/conflict behavior, migration contracts, mutation-gateway integration, provider compatibility, secret exclusion and continuity/package contracts.

The complete dependency-backed Express, Playwright, live PostgreSQL/Neon and real-provider suites must still run in CI or staging before production promotion. Exact commands and environment limitations are recorded in `BUILD_REPORT.md`.

## Next task

**Phase 1 Task 8 — Reviewer Assignment and Approval Workflow** should add repository-scoped reviewer assignment, immutable approve/reject decisions, quorum computation and rejection handling while preserving author/reviewer separation, current provider-derived authorization and the immutable Task 3 history model.
