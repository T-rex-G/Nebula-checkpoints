# Runtime Policy Evaluation, Enforcement Modes and Control Mapping

## Goal
Evaluate every registered repository mutation against the exact active governance policy set at the Central Mutation Gateway, derive non-authoritative compliance-control evidence, and enforce explicit observe, warn or block rollout modes without weakening Tasks 1–11.

## Runtime rules

- The incoming mutation descriptor remains policy-neutral and cannot contain policy decisions, enforcement modes or control mappings.
- Active policy versions are read and integrity-checked inside one PostgreSQL transaction immediately before a decision is appended.
- All active policies for the exact provider authority and repository scope are evaluated in stable policy-key order.
- Policy documents may declare `enforcement.mode` as `observe`, `warn` or `block`; absence means `observe` for backward compatibility.
- `deny` outranks `require-approval`, which outranks `allow`.
- A non-allow result blocks only when a matching active policy is explicitly in `block` mode.
- `warn` allows the mutation while returning bounded warning headers and immutable evidence.
- `observe` allows the mutation and records what would have happened without presenting it as an enforced denial.
- No active policy means an explicit allow decision with `no-active-policy` evidence.
- Evaluation/persistence unavailability follows `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn|block`, defaulting to `warn` so existing optional-Neon deployments remain available. Invalid values fail startup.

## Decision evidence

Each decision binds mutation ID, exact scope, actor, action, active policy heads, immutable document hashes, matched rules, effective effect, rollout outcome, control mapping, previous record hash and HMAC record hash. The append-only decision stream is separate from policy lifecycle audit history so it can represent no-policy and multi-policy outcomes.

## Control mapping

- Mapping is derived after policy evaluation and never enters through the mutation descriptor.
- A canonical versioned catalog starts with AICPA 2017 Trust Services Criteria with revised points of focus (2022), using bounded `SOC2-TSC:CC6.1` and `SOC2-TSC:CC8.1` references.
- Policy rules may add only catalog-approved `controlRefs`; arbitrary control identifiers are rejected during policy normalization.
- Mappings use relationship `supports`, never `satisfies`.
- Mapping failures degrade visibly to `partial`, `unmapped` or `unavailable` and never alter enforcement.
- Control ordering, deduplication, catalog hash and mapping hash are deterministic.

## Deployment safeguards

- Migration 011 is additive and backward compatible.
- Pre-Task-12 audit records remain unchanged and verifiable.
- Decision writes happen before provider writes.
- Unknown gateway actions still fail before evaluation.
- Runtime decisions never contain credentials, raw content, patches, commit messages, provider response bodies or browser-supplied roles.
- Block responses use bounded codes and no provider details.
