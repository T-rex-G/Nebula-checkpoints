# Phase 1 Task 11 — Policy Activation and Rollback Specification

## Goal

Promote an approved immutable policy version to the authoritative policy head, or restore a previously evidence-backed active version, without trusting browser authority or stale simulation results.

## Authorization boundary

Activation and rollback require a fresh server-derived `activator` role for the exact provider authority and repository. The normalized repository access level must be 50. GitHub App installation credentials may execute authentication, but the verified human governance actor is recorded as the activator.

Authority evidence is validated when the request enters the service and again after PostgreSQL advisory locks are acquired. Expired, partial, unresolved, inconsistent or cross-scope evidence fails closed.

## API

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/activations`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/activate`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/rollback`

Write requests contain only:

- `expectedRevision` — exact current policy-head revision;
- `reason` — bounded non-secret activation or rollback rationale;
- `simulation.simulationHash` — exact hash previously reviewed by the caller;
- `simulation.request` — bounded scenario request used to recompute the evidence.

Actor identity, roles, permissions, installation capability and repository scope are never accepted from the body.

## Evidence recomputation and binding

The server reloads the immutable target version and current active baseline, recomputes Task 9–10 simulation evidence, and requires the submitted simulation hash to match. The store then revalidates after acquiring the per-policy and per-version review locks:

- exact repository scope;
- target version ID and immutable document hash;
- current active baseline kind, version ID and document hash;
- canonical no-policy baseline hash when no version is active;
- `activationReadiness.eligible === true` with no blocker codes;
- one to 200 scenarios and bounded summary counts;
- exact current policy-head revision.

## Activation rules

A first activation requires the deterministic Task 8 review state to be `approved`. Legacy approval rows without assignments do not count. Any rejection blocks activation. A version with prior evidence-backed activation must use rollback rather than create a misleading new activation event.

## Rollback rules

Rollback is allowed only to an immutable version with a prior Task 11 evidence-backed activation for the same policy. The new rollback event stores the source activation ID, the version being replaced, the current simulation evidence and the new head revision. Rollback never rewrites prior history.

## Persistence and concurrency

Migration `010_governance_activation_evidence.sql` adds a one-to-one immutable evidence record for every Task 11 activation or rollback. Composite foreign keys bind activation, policy, target version, baseline version and rollback source to the same policy.

One PostgreSQL transaction performs:

1. idempotency reservation when supplied;
2. policy and review advisory locks;
3. authority, review, revision and evidence revalidation;
4. append-only activation event;
5. optimistic policy-head update;
6. immutable activation evidence insert;
7. HMAC audit-chain append;
8. idempotent response capture.

Any failure rolls back every write.

## Central Mutation Gateway

Task 11 registers:

- `governance.policy.activate`
- `governance.policy.rollback`

Both are critical governance actions bound to the verified human governance actor.

## Acceptance criteria

1. Only fresh server-derived activators for the exact scope can write.
2. Activation requires final Task 8 approval and no rejection.
3. Submitted simulation hashes are recomputed and must match current immutable state.
4. Stale head revisions, baselines, document hashes or authorization fail closed.
5. Lock waiting cannot outlive authorization evidence.
6. Rollback targets require same-policy prior evidence-backed activation.
7. Previous active version and rollback-source provenance are append-only.
8. Activation, head update, evidence and HMAC audit append are atomic.
9. Exact idempotent retries replay the prior result; conflicting reuse fails.
10. Credentials, raw provider responses and browser-supplied authority never enter evidence.
11. PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon compatibility remain unchanged.

## Non-goals

- evaluating active policy on ordinary repository mutations;
- observe, warn or block rollout modes;
- exceptions or waivers;
- provider-side branch protection changes;
- policy templates, Digital Twin UI, notifications or exports.
