# Phase 1 Tasks 9–10 — Policy Simulation and Explainable Impact Specification

## Goal

Evaluate an immutable proposed policy version against bounded, credential-free repository mutation scenarios without executing provider writes or changing governance state, then return deterministic evidence and a comparison with the current active policy or the no-policy baseline.

## Boundary

Simulation is read-only. It must not enter the Central Mutation Gateway, append audit events, create database records, activate policy, enforce allow/warn/block, create exceptions, or call provider mutation APIs.

The service reads only:

- the exact repository-scoped proposed immutable version;
- the current active version for the same policy when one exists;
- the stable Central Mutation Gateway action registry.

## Scenario contract

A request contains `schemaVersion: 1` and one to 200 scenarios. Every scenario has:

- a unique bounded `id`;
- an exact registered mutation `action`;
- optional bounded JSON `attributes` describing mutation/repository facts such as `branch`, `paths`, `protected`, `defaultBranch`, or other non-secret facts.

Provider, authority, owner, repository, actor identity, permissions, credentials, tokens, headers and cookies cannot be supplied in scenarios. Repository scope and reader authorization come from the server.

## Rule evaluation

- Rule actions must use the Central Mutation Gateway action vocabulary.
- A rule matches only the same exact action and when every condition matches the scenario attributes.
- Scalar conditions use exact equality.
- Array conditions match when the scenario scalar is present in the rule array, or when the scenario array intersects the rule array.
- `paths` supports deterministic glob patterns using `*`, `**`, and `?`; matching is case-sensitive and path-normalized.
- Unknown condition keys are valid only when the scenario supplies a compatible value.
- No matching rule means the default effect `allow`.
- Conflicting matched effects are reported. Effective precedence is `deny` > `require-approval` > `allow`.

## Evidence and impact diff

The response includes:

- normalized scenario inputs;
- proposed and baseline results per scenario;
- matched rule identifiers and effects;
- conflicts and unsupported rule actions;
- category and risk from the gateway registry;
- change classification: `unchanged`, `strengthened`, `relaxed`, or `changed`;
- aggregate affected actions, action classes, risk levels, conflicts and change counts;
- proposed, baseline and result hashes;
- one stable simulation hash over the complete deterministic evidence;
- explicit activation readiness with bounded blocker codes and unexercised proposed-rule evidence.

Risk ordering is `low < medium < high < critical`. Effect strictness is `allow < require-approval < deny`.

## API

`POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate`

The route requires the fresh server-derived `reader` governance role. It is an explicitly enumerated read-only control-plane operation and never receives mutation-gateway middleware.

## Acceptance criteria

1. Exact authority/repository/policy/version scope is enforced without cross-scope leakage.
2. Only registered gateway actions can be simulated.
3. Inputs are bounded, deeply immutable, credential-free and deterministic.
4. Simulation performs no provider or governance write and creates no audit/persistence record.
5. Proposed results are compared with the active version or an explicit no-policy baseline.
6. Matched rules, conflicts, effective outcomes, action classes and risk are explainable.
7. Equivalent inputs produce byte-stable hashes regardless of object key order.
8. Relaxations and strengthened outcomes are correctly distinguished.
9. Unknown policy actions are surfaced as diagnostics and never silently evaluated.
10. Proposed rule conflicts, unsupported proposed policy actions, or any supported proposed rule not exercised by a scenario make activation readiness ineligible.
11. Existing PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon behavior remains unchanged.

## Non-goals

- activation or rollback;
- active mutation enforcement;
- observe, warn or block rollout modes;
- exception/waiver workflows;
- provider branch-rule changes;
- persistence of simulation runs;
- final Policy Digital Twin UI.
