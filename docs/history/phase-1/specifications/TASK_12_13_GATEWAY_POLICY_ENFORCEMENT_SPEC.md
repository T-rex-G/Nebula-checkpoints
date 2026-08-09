# Phase 1 Tasks 12–13 Specification

## Title

Gateway Policy Evaluation Integration, Observe/Warn/Block Enforcement, and Versioned Control Evidence

## Goal

Evaluate every registered repository mutation at the Central Mutation Gateway against the exact active policy set for its provider authority and repository, persist an immutable explainable decision before provider execution, and enforce explicit rollout modes without weakening authentication, authorization, step-up, provider compatibility, recovery, or deployment availability.

## Scope

### Included

- Runtime evaluation of all registered gateway actions.
- Exact active-policy-set loading and document-integrity verification.
- Policy-level `observe`, `warn`, and `block` modes.
- Backward-compatible `observe` behavior for legacy policy versions without an enforcement field.
- Immutable descriptor-bound policy decision history.
- Reader-authorized decision listing and HMAC-chain verification.
- Versioned, deterministic, non-authoritative SOC 2 control evidence.
- Explicit deployment failure mode `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn|block`.
- Recovery-safe governance control-plane behavior.

### Excluded

- Exceptions, waivers, expiry, or emergency bypasses.
- Policy templates and repository baselines.
- Final Policy Digital Twin UI.
- Governance notifications, webhooks, or exports.
- Organization-level inheritance.

## Boundary placement

```text
validated route intent
  → immutable mutation descriptor
  → repository active-policy-set lock
  → active policy integrity checks
  → deterministic policy evaluation
  → versioned control-evidence mapping
  → immutable policy decision append
  → allow / warn / block
  → provider transport only when allowed
```

The route, browser, and provider helpers cannot provide an enforcement mode, policy decision, control mapping, actor role, or permission claim.

## Policy document contract

Policy schema version 1 may optionally include:

```json
{
  "enforcement": { "mode": "observe" }
}
```

Allowed values are `observe`, `warn`, and `block`. Absence remains absence during canonicalization and means `observe`, preserving all pre-alpha.10 immutable document hashes.

Rules may optionally include catalog-approved `controlRefs`. Unknown framework or control IDs are rejected before persistence.

## Evaluation semantics

- Policy evaluation reuses the registered mutation action vocabulary and Task 9–10 matching behavior.
- `deny` outranks `require-approval`, which outranks `allow` within a policy.
- Active policies are evaluated in deterministic policy-key and policy-ID order.
- A matching non-allow result blocks only when its active policy version is explicitly `block`.
- `warn` allows provider execution and returns bounded warning evidence.
- `observe` records a would-deny or would-require-approval decision while allowing provider execution.
- No active policy creates an explicit `no-active-policy` allow decision.
- Conflicts and unsupported active rules are visible warning evidence and never silently ignored.

## Recovery invariant

Active policy rules cannot block governance control-plane mutations. Such decisions are evaluated, mapped, persisted, and downgraded to `warn`. The same rule applies when policy evaluation itself is unavailable, allowing an authorized administrator to repair or roll back a problematic policy.

This does not bypass existing controls: governance actions still require server-derived roles, approval state, simulation evidence, optimistic revisions, PostgreSQL availability, idempotency, the mutation gateway, and immutable audit evidence.

## Concurrency and active-set consistency

Runtime evaluations acquire a PostgreSQL transaction-scoped shared advisory lock keyed by repository scope before reading active heads. Activation and rollback acquire the matching exclusive lock before changing any head. Concurrent mutations can evaluate in parallel, while active-head changes are linearized against the complete repository active-policy set.

A separate scope decision-chain lock serializes immutable record linkage without holding locks across provider network operations. At most 100 policies may be simultaneously active in one repository scope. Activation of a 101st policy is rejected, runtime reads detect overflow explicitly, and migration 011 refuses to deploy over an already-invalid active set.

## Immutable decision evidence

Each persisted decision includes:

- decision and mutation UUIDs;
- exact provider authority, owner, repository, and scope key;
- verified human/execution actor binding already established by the gateway;
- action, category, and risk;
- SHA-256 descriptor hash covering method, route, bounded metadata, and step-up evidence;
- exact active policy IDs, version IDs, version numbers, document hashes, and head revisions;
- deterministic policy-set hash;
- matched rules and effects;
- effective effect, rollout mode, enforcement outcome, warning codes, and block code;
- versioned control mapping and mapping hash;
- decision hash, previous hash, HMAC record hash, and timestamp.

The decision is committed before provider execution. It records the policy evaluation of an attempted mutation, not proof that the downstream provider operation succeeded.

## Control mapping contract

- Mapping occurs after policy evaluation and never affects enforcement.
- Catalog ID: `nebulaverse-control-catalog`.
- Initial catalog version: `1.0.0`.
- Initial framework revision label: `2017-revised-2022`.
- Approved initial references: `SOC2-TSC:CC6.1` and `SOC2-TSC:CC8.1`.
- Relationship is always `supports`, never `satisfies` or certification.
- Mapping sources distinguish action catalog and policy rule references.
- Controls and sources are sorted and deduplicated deterministically.
- `repository.star` and `repository.unstar` are intentionally explicit `unmapped` actions.
- Mapping statuses are `mapped`, `partial`, `unmapped`, or `unavailable`.
- Catalog and mapping hashes are persisted with each new decision.
- A catalog version referenced by immutable decisions must remain supported permanently; later catalog revisions are additive and cannot reinterpret stored version `1.0.0` evidence.

## Deployment failure behavior

`NV_GOVERNANCE_RUNTIME_FAILURE_MODE` accepts only:

- `warn` — default and Render Blueprint initial setting. Existing repository writes continue with explicit evaluator-unavailable evidence.
- `block` — repository writes fail before provider execution with `503 POLICY_EVALUATION_UNAVAILABLE`.

Invalid values fail startup. Operators must not switch to `block` before migration, Neon readiness, decision-chain verification, observe/warn review, and representative staging mutations pass.

## Public operational evidence

Allowed mutations receive bounded response headers:

- `X-Nebulaverse-Policy-Outcome`
- `X-Nebulaverse-Policy-Mode`
- `X-Nebulaverse-Policy-Decision`
- `X-Nebulaverse-Policy-Warning`

These headers are diagnostic signals, never authorization inputs.

Read-only endpoints:

```text
GET /api/repo/:owner/:repo/governance/decisions?limit=100&afterSeq=0
GET /api/repo/:owner/:repo/governance/decisions/verify?limit=50000
```

Both require a fresh server-derived repository reader role and return `Cache-Control: no-store`. List limits and cursors are strict non-negative integers. Listing uses a repeatable-read snapshot and returns `nextAfterSeq`; verification scans bounded pages in one repeatable-read transaction and explicitly reports an incomplete prefix when its maximum is reached.

## Database contract

Migration `011_governance_policy_decisions.sql` is additive and creates an append-only decision ledger with:

- immutable UPDATE, DELETE, and TRUNCATE rejection;
- UUID and normalized scope constraints;
- descriptor, policy-set, decision, previous, and record hash constraints;
- JSON schema/status consistency checks;
- decision JSON to relational-column consistency checks;
- scope/time, action/time, control-mapping, and record-hash indexes.

Existing lifecycle audit records and policy document hashes remain unchanged. Before creating the ledger, migration 011 checks that no repository scope already exceeds the supported 100-active-policy limit and aborts with remediation guidance rather than deploying a runtime that would immediately degrade.

## Acceptance criteria

1. Every registered mutation action is evaluated before provider transport.
2. Unknown actions still fail at descriptor normalization.
3. Client-supplied policy or control evidence is rejected.
4. Legacy policies remain observe-only after upgrade.
5. Observe, warn, and block semantics are deterministic and independently tested.
6. Control references do not change enforcement outcomes.
7. Active document hash corruption fails through the configured deployment failure behavior.
8. Runtime and activation use matching shared/exclusive repository active-set locks.
9. Decisions bind the exact descriptor and active policy heads.
10. Decisions are appended before provider execution and remain immutable.
11. Decision history and chain verification are repository-scoped and reader-authorized.
12. Control mappings are deterministic, catalog-versioned, bounded, and non-authoritative.
13. All registered actions are either mapped or intentionally marked unmapped.
14. Governance recovery operations cannot be policy-locked, including during evaluator failure.
15. Runtime errors emit bounded operational logs without credentials or provider response bodies.
16. Deployment documentation explains migration, rollout sequence, failure mode, rollback, and verification.
17. PAT, OAuth, optional GitHub App, GitLab, and Gitea behavior remains compatible.
18. Existing Tasks 1–11 tests remain green where dependencies are available.
19. Decision history supports strict cursor pagination and long-chain verification without decimal-limit database errors.
20. Activation and migration prevent more than 100 simultaneously active policies in one repository scope.
21. Mixed observe/warn evidence identifies each rollout class accurately.
22. The final ZIP is deterministic, checksum-verified, archive-safe, and tested from clean extraction.

## Next task boundary

Task 14 may add approved, time-bounded exceptions and waivers. It must consume the immutable decision contract rather than altering or bypassing Tasks 12–13 evidence.
