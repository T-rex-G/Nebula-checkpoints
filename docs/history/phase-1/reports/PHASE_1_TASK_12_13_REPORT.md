# Phase 1 Tasks 12–13 Implementation Report

## Checkpoint

- Product: Nebulaverse-X
- Version: `5.3.0-alpha.10`
- Tasks:
  - Task 12 — Gateway Policy Evaluation Integration
  - Task 13 — Observe, Warn and Block Enforcement Modes
- Status: implemented; source-level review and final package verification recorded in `BUILD_REPORT.md`

## Implemented behavior

### Runtime gateway evaluation

Every registered mutation entering the Central Mutation Gateway is evaluated before its route callback can reach a provider write. The descriptor rejects client/server-route attempts to inject `policyDecision`, `controlMapping`, or `enforcementMode`.

The runtime store loads all active policy versions for the exact provider authority and repository, recomputes immutable document hashes, evaluates in deterministic policy-key order, appends decision evidence, commits, and only then permits provider execution when the result is not blocking.

### Rollout modes

- `observe`: provider execution continues and would-deny/would-require-approval evidence is recorded.
- `warn`: provider execution continues with bounded warning evidence and response headers.
- `block`: deny or approval-required outcomes stop before provider transport.
- Legacy policies without `enforcement.mode` remain observe-only and retain their original immutable document hashes.
- No active policy creates an explicit allow decision.

### Deployment failure mode

`NV_GOVERNANCE_RUNTIME_FAILURE_MODE` accepts only `warn` or `block`. Render explicitly starts with `warn`. Invalid values fail configuration validation.

Runtime errors emit a bounded non-secret server event. `block` converts repository mutation evaluator unavailability to `503 POLICY_EVALUATION_UNAVAILABLE`; `warn` preserves the previous mutation behavior and exposes warning evidence.

### Recovery path

Policy outcomes and evaluator failures cannot block governance control-plane mutations. These actions are still evaluated and recorded as warnings, but existing server-derived role checks, approval, simulation, optimistic revisions, PostgreSQL transactions, idempotency and audit evidence remain mandatory. This prevents a malformed policy from making rollback impossible.

### Active-policy concurrency

Runtime transactions acquire a shared advisory lock for the repository active-policy set before reading heads. Activation and rollback acquire the same key exclusively before changing heads. Concurrent runtime evaluations remain possible, while a head transition cannot create a phantom or mixed active set. A repository scope supports at most 100 simultaneously active policies: activation rejects a 101st policy, runtime reads are bounded to 101 rows for explicit overflow detection, and migration 011 fails with a clear remediation error if an existing database already exceeds the limit.

### Immutable policy decision ledger

Migration `011_governance_policy_decisions.sql` adds append-only decision evidence containing:

- exact repository scope and actor;
- action/category/risk;
- descriptor SHA-256 hash;
- active policy/version/document/head evidence;
- policy-set, evaluation and control mapping evidence;
- allow/warn/block outcome and bounded codes;
- linked decision, previous and HMAC record hashes.

Database constraints bind relational columns to decision JSON and reject UPDATE, DELETE and TRUNCATE.

Reader-authorized endpoints provide bounded history and chain verification:

```text
GET /api/repo/:owner/:repo/governance/decisions?limit=100&afterSeq=0
GET /api/repo/:owner/:repo/governance/decisions/verify?limit=50000
```

History uses strict integer validation, repeatable-read snapshots, and an `afterSeq` cursor. Verification scans the chain in bounded server-side chunks inside one repeatable-read transaction and returns an explicit `POLICY_DECISION_VERIFICATION_LIMIT` result when the requested maximum is reached before the head.

### Versioned control evidence

The server derives mapping after policy evaluation from canonical catalog `nebulaverse-control-catalog` version `1.0.0`. Initial bounded references are `SOC2-TSC:CC6.1` and `SOC2-TSC:CC8.1`, with internal framework revision label `2017-revised-2022`.

Mappings use relationship `supports`, preserve catalog and mapping hashes, deduplicate sources deterministically, and never alter enforcement. Catalog versions referenced by stored decisions are retention-critical and must remain available to future verification code rather than being replaced in place. `repository.star` and `repository.unstar` are intentionally unmapped, and a coverage test requires every registered action to be mapped or deliberately unmapped.

## Security corrections made during implementation/review

- Bound each decision to method, route, bounded mutation metadata and step-up evidence through `descriptorHash`.
- Revalidated decision semantics so policy-set hash, effects, modes, warnings, block codes and control mappings cannot contradict matched-rule evidence.
- Validated version/head integer ranges and approved control references during decision normalization.
- Added repository-scope shared/exclusive active-set locks to eliminate concurrent activation phantoms.
- Added bounded runtime error observability rather than silently swallowing evaluator failures.
- Extended governance recovery protection to active-policy denial and evaluator-unavailable paths.
- Added database constraints for descriptor hash, mapping schema/status/hash, previous hash and JSON/column consistency.
- Added chain-listing validation and HMAC verification with explicit corruption reason codes.
- Added strict integer limits, cursor pagination, consistent read snapshots, and bounded chunk verification for long-running repositories.
- Prevented a 101st active policy from making runtime enforcement unavailable, with activation and migration preflight checks.
- Separated warning-mode and observe-mode evidence so mixed rollouts cannot be mislabeled.
- Preserved bounded `POLICY_*` operational error codes and added action/scope context to non-secret evaluator failure logs.

## Compatibility

Preserved:

- GitHub PAT and OAuth;
- optional GitHub App authentication with human governance attribution;
- GitLab and Gitea token connectivity;
- Task 1 step-up and same-origin/CSRF protections;
- Tasks 3–11 immutable lifecycle evidence;
- one Render Free service plus optional existing Neon PostgreSQL;
- legacy policy document hashes and observe behavior.

## Verification summary

See `BUILD_REPORT.md` for exact commands and results. The final checkpoint must include:

- all dependency-free tests passing in source and clean extraction;
- syntax, build and secret checks;
- deterministic duplicate builds;
- archive safety and checksum verification;
- explicit disclosure of dependency-backed, live Neon and real-provider checks unavailable in the execution environment.

## Deferred scope

Not implemented in alpha.10:

- exceptions and waivers;
- templates and repository baselines;
- final Policy Digital Twin read model or interface;
- full bulk-operation completion proof;
- notifications, webhooks or audit exports.

## Next

Phase 1 Task 14 — Exceptions, Waivers and Expiry Workflow, as standalone `v5.3.0-alpha.11` after a focused design and acceptance gate.
