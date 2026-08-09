# Phase 1 Tasks 9–10 Report — Policy Simulation and Explainable Impact

## Outcome

Nebulaverse-X v5.3.0-alpha.8 adds a read-only deterministic simulation capability for immutable proposed policy versions and an explainable impact comparison against the same policy's active version or a no-policy baseline.

## Implementation

- Added `src/governance-simulation.js`.
- Added reader-authorized `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate`.
- Reused `MUTATION_ACTIONS` for action identity, category and risk.
- Added bounded scenario normalization, secret-like value screening, raw-content field rejection and dangerous-object-key rejection.
- Added exact/scalar/array/nested condition matching and case-sensitive bounded path globs.
- Added deterministic effect precedence and explicit conflict evidence.
- Added active/no-policy comparison, impact diff, risk/action summaries and bounded warnings.
- Added repository-scope, scenario-set, evaluation, result and simulation hashes.
- Added immutable policy document-hash revalidation.
- Added explicit activation readiness; proposed conflicts, unsupported policy actions and unexercised supported proposed rules become blockers.

## Security boundaries

Simulation requires fresh server-derived reader authority for the exact provider authority and repository. Browser actors, roles, provider permissions, scope and credentials are never accepted. The route is explicitly enumerated as a read-only control-plane POST and has no `governanceMutationContext`. The service calls only existing scoped read methods and the pure evaluator.

No simulation record, audit event, provider request, repository mutation, activation, exception or enforcement result is created.

## Test-first evidence

The implementation began with failing module, service and route-contract tests. Focused tests cover action registration, input bounds, immutability, credential rejection, path conditions, conflicts, precedence, unknown policy actions, no-policy baseline, strengthened/relaxed changes, active-policy conflicts, stable hashes, exact reader scope and absence of gateway writes.

## Review corrections

Review added stored document-hash revalidation, bounded `SIMULATION_*` API errors, secret-like value rejection, raw content/patch/diff exclusion, explicit scope/scenario/result hashes, active-policy conflict evidence, bounded warning records, proposed-rule coverage evidence and blocker-bearing activation readiness.

## Non-goals preserved

No activation/rollback, runtime gateway evaluation, observe/warn/block modes, exceptions, templates, notifications, exports or final Digital Twin UI were introduced.

## Next

Phase 1 Task 11 — Policy Activation and Rollback Service.
