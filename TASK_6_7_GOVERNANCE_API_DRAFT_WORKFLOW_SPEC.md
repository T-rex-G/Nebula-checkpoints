# Phase 1 Tasks 6–7 — Governance API and Policy Draft Workflow Specification

## Goal

Expose one server-side, repository-scoped governance API boundary and a durable policy draft workflow that produces immutable policy versions without trusting browser-supplied roles, scope, identities, credentials, or provider evidence.

## Actors and authorization

- `reader` may list policies and read policy/version state.
- `author` may create policies and create, read, update, validate, and submit only their own drafts.
- Reviewer, activation, rollback, exception, simulation, enforcement, and organization inheritance operations remain out of scope.
- Authorization evidence must be server-derived, resolved, complete, verified, unexpired, and scoped to the exact provider authority, owner, and repository.
- A GitHub App installation remains the execution principal; the separately verified human governance actor owns drafts and authors immutable versions.

## Persistence

- Governance remains unavailable without the configured PostgreSQL/Neon `DATABASE_URL`.
- Drafts are durable PostgreSQL records and may be updated only by their owning human author.
- Draft updates use optimistic revisions and reject stale writes.
- Governance writes accept an optional bounded `Idempotency-Key`; exact retries replay the original result, while key reuse with a different normalized request fails closed.
- One active draft per policy and human author is allowed.
- Submitting a draft creates the next immutable version and deletes the mutable draft in the same transaction.
- Draft create/update and immutable version submission append bounded, credential-free audit evidence.
- Existing policy versions, approvals, activations, and audit records remain append-only.

## API surface

Repository prefix: `/api/repo/:owner/:repo/governance`

- `GET /policies`
- `POST /policies`
- `GET /policies/:policyId`
- `POST /policies/:policyId/validate`
- `POST /policies/:policyId/drafts`
- `GET /policies/:policyId/drafts/:draftId`
- `PATCH /policies/:policyId/drafts/:draftId`
- `POST /policies/:policyId/drafts/:draftId/validate`
- `POST /policies/:policyId/drafts/:draftId/submit`
- `GET /policies/:policyId/versions`
- `GET /policies/:policyId/versions/:versionId`

## Mutation gateway

Every governance write enters the existing central mutation gateway with a registered repository-scoped governance action and the same immutable authorization snapshot used by the governance authorization boundary. Governance database writes do not impersonate provider API writes and therefore do not call `assertProviderMutation`.

## Failure behavior

- Missing database: `503 GOVERNANCE_DATABASE_REQUIRED`.
- Missing, stale, partial, unavailable, or insufficient authorization: bounded `403` response.
- Cross-repository policy/draft/version identifiers: `404` without disclosing existence.
- Draft ownership mismatch: `404` without disclosing another author’s draft.
- Stale draft revision: `409 GOVERNANCE_DRAFT_REVISION_CONFLICT`.
- Duplicate policy key, duplicate immutable document, or duplicate active draft: bounded `409` response.
- Unknown database/provider errors: generic bounded server error; no raw provider or database response is returned.

## Non-goals

- Reviewer assignment, decisions, quorum, or rejection workflow.
- Simulation and impact diff.
- Activation or rollback APIs.
- Active-policy mutation enforcement.
- Exceptions, templates, organization inheritance, UI, notifications, webhooks, or exports.

## Acceptance criteria

1. All governance APIs use the existing authenticated request security foundation.
2. Role and actor decisions derive only from a normalized server-side authorization snapshot.
3. Evidence must be resolved and unexpired at the moment the governance operation begins.
4. All policy, draft, and version reads are restricted to the exact repository scope.
5. Authors cannot read, update, validate, or submit another human author’s draft.
6. Draft revision conflicts fail without overwriting newer content.
7. Idempotency records store only hashes and bounded credential-free responses; they are isolated by repository scope, human actor, and operation.
8. Validation normalizes the document, approval policy, and deterministic document hash without persistence.
9. Draft submission creates one immutable version and removes the draft atomically.
10. Governance writes execute inside the central mutation gateway.
11. No credentials, authorization headers, cookies, raw provider bodies, or unbounded content enter responses, audit records, descriptors, or logs.
12. PAT, OAuth, optional GitHub App, GitLab, Gitea, repository browsing, and non-governance mutation behavior remain compatible.
13. Dependency-free unit, contract, migration, syntax, secret, archive, and package checks pass; dependency-backed suites are run where the environment permits.
