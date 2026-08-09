# Phase 1 Task 8 — Reviewer Assignment and Approval Workflow Specification

## Goal

Add repository-scoped reviewer assignment and immutable approve/reject decisions for submitted policy versions without introducing activation, simulation, enforcement, exceptions, templates, or UI behavior.

## Chosen assignment model

Reviewer assignment is a **self-claim by the currently authenticated, server-verified human governance actor**.

This model is intentionally used instead of accepting an administrator-supplied reviewer identity because it behaves consistently across GitHub PAT/OAuth, optional GitHub App, GitLab, and Gitea without trusting browser identity claims or adding ambiguous provider-specific third-party identity lookup.

## Security rules

- The browser cannot supply reviewer identity, login, role, access level, installation permissions, or actor identity.
- A claim or decision requires a fresh, resolved, complete Task 5 authorization snapshot with the `reviewer` role for the exact provider authority and repository.
- A GitHub App installation remains the execution principal; the verified human authorizer is the reviewer and audit actor.
- When `disallowAuthorApproval` is true, the version author cannot claim review or decide.
- Each human identity has at most one immutable assignment and one immutable decision per version.
- Rejection requires a bounded rationale; likely credential material is rejected.
- Exact retries may use the existing hashed, actor/scope/operation-isolated `Idempotency-Key` contract.

## Persistence

Migration `009_governance_reviews.sql` adds:

- immutable `nv_governance_review_assignments`;
- policy/version foreign-key linkage;
- bounded provider role and authorization-evidence fields captured at assignment;
- assignment and current authorization evidence on Task 8 approval rows;
- one decision per assignment and identity;
- UPDATE, DELETE, and TRUNCATE rejection for assignment history.

Legacy approval rows without a Task 8 assignment remain readable only as historical primitives and are excluded from Task 8 review state and activation quorum.

## API

Read:

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review`

Writes:

- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions`

The reviewer-claim body must be empty. The decision body accepts only:

- `decision`: `approve` or `reject`;
- `rationale`: bounded text, mandatory for rejection.

The writes enter the Central Mutation Gateway as:

- `governance.reviewer.assign`;
- `governance.approval.decide`.

## Deterministic review state

- `pending`: no rejection and approvals are below `requiredApprovals`;
- `approved`: no rejection and distinct approvals meet or exceed quorum;
- `rejected`: one or more rejection decisions exist.

Approved and rejected states are terminal for Task 8. Further assignments or decisions fail closed. Task 8 never activates policy.

## Concurrency and retry safety

- Assignment and decision transactions acquire a shared per-policy lock and a per-version review lock.
- State is re-read after locking.
- Unique database constraints protect one assignment and one decision per identity.
- Idempotency reservation, mutation, audit, and response capture occur in one transaction.
- Future activation uses the same per-policy serialization boundary.

## Acceptance criteria

1. Exact authority/repository/policy/version scope is enforced without cross-scope existence leakage.
2. Reviewer identities and authority are server-derived only.
3. GitHub App installation and human reviewer identities remain separate.
4. Author/reviewer separation is enforced when configured.
5. Assignments and decisions are immutable and identity-unique.
6. Rejection requires rationale; all rationale is bounded and credential-screened.
7. Quorum and rejection state are deterministic and terminal without activation.
8. Concurrent and repeated requests are serialized and retry-safe.
9. Every write enters the Central Mutation Gateway.
10. The append-only HMAC audit chain is preserved.
11. Credentials, raw idempotency keys, provider bodies, and browser authority claims do not enter evidence or errors.
12. PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free, and optional Neon compatibility remain intact.

## Non-goals

- assigning a different human identity from the browser;
- policy simulation and impact evidence;
- activation or rollback APIs;
- active-policy evaluation and enforcement modes;
- exceptions, templates, notifications, exports, or Policy Digital Twin UI.
