# Phase 1 Task 11 Report — Policy Activation and Rollback Service

## Outcome

Nebulaverse-X v5.3.0-alpha.9 adds authorized, evidence-bound policy activation and rollback while preserving immutable history, optimistic policy-head concurrency and human attribution across PAT, OAuth, optional GitHub App, GitLab and Gitea authentication.

## Implementation

- Added activator-authorized activation, rollback and activation-history API methods and routes.
- Added critical Central Mutation Gateway actions `governance.policy.activate` and `governance.policy.rollback`.
- Recomputed Task 9–10 simulation evidence from the submitted bounded scenario request before every write.
- Bound activation to exact scope, target version/document hash, active/no-policy baseline, scenario-set hash, result hash and simulation hash.
- Required final Task 8 approval for first activation and rejected any review rejection.
- Required expected policy-head revision and reused the shared per-policy plus per-version review locks.
- Revalidated level-50 authorization after lock acquisition.
- Added hashed idempotency support through the existing transactional governance idempotency boundary.
- Added reader-authorized activation history with immutable provenance fields.

## Persistence

Migration `010_governance_activation_evidence.sql` adds immutable one-to-one evidence for Task 11 events. It records simulation versions and hashes, target and baseline document hashes, impact counts, fresh activator permission evidence and rollback-source activation identity.

Composite foreign keys prevent evidence, baseline and rollback provenance from crossing policy boundaries. UPDATE, DELETE and TRUNCATE are rejected.

## Security review corrections

Review added:

- lock-time authorization expiry revalidation;
- canonical no-policy baseline-hash verification;
- database-level same-policy activation and rollback-source provenance;
- rejection of browser actor/role/permission fields;
- exact GitHub App human-activator attribution;
- bounded activation-specific input errors;
- secret-pattern rejection in activation and rollback reasons;
- explicit rollback-only handling for previously evidence-backed active versions.
- removal of literal control bytes from the activation validation source, with a plain-text source regression guard.

## Test-first evidence

The implementation began with failing API, route and persistence-contract tests. Focused coverage now includes:

- activator role enforcement and lower-role rejection;
- simulation recomputation and mismatch rejection;
- GitHub App installation/human separation;
- expected revision conflicts;
- Task 8 approval gating;
- stale authorization after lock wait;
- canonical baseline verification;
- evidence-backed rollback provenance;
- mutation-gateway critical action binding;
- immutable migration contracts;
- existing governance, provider, migration, archive and security regressions.

## Non-goals preserved

Task 11 does not evaluate active policy on ordinary repository mutations and does not introduce observe, warn or block modes. Those remain the combined Tasks 12–13 checkpoint.

## Next

Phase 1 Tasks 12–13 — Gateway Policy Evaluation Integration and Observe/Warn/Block Enforcement Modes.

## Verification result

The frozen source and a separate clean extraction each passed 41 dependency-free test programs, build verification, complete syntax checking and secret-pattern scanning. The deterministic release archive contains 160 unique regular files and passed path, duplicate, symlink and forbidden-artifact inspection. Dependency-backed runtime, Playwright, live Neon and real-provider checks remain required before production promotion.
