# Phase 1 Task 8 — Reviewer Assignment and Approval Workflow Design

## Goal

Add repository-scoped review assignment and immutable approve/reject decisions for submitted policy versions without introducing activation, simulation, enforcement, exceptions, templates, or UI behavior.

## Security model

- A reviewer assignment is a self-claim by the currently authenticated, server-verified human governance actor.
- The API accepts no reviewer identity, login, role, access level, installation permission, or actor claim from the browser.
- A claim requires a fresh, resolved, complete Task 5 authorization snapshot with the `reviewer` governance role for the exact provider authority, owner, and repository.
- GitHub App installation identity remains the execution principal; the verified human authorizer remains the reviewer identity.
- When `disallowAuthorApproval` is true, the version author cannot claim review or record any review decision.
- Each human identity may have at most one immutable assignment and one immutable decision per version.

Self-claim is chosen instead of administrator-supplied reviewer identities because it preserves equivalent behavior across GitHub PAT/OAuth, optional GitHub App, GitLab, and Gitea without trusting browser claims or introducing provider-specific third-party identity lookup ambiguity.

## Persistence

Add `009_governance_reviews.sql` with:

- immutable `nv_governance_review_assignments`;
- repository/version linkage through the existing policy/version foreign keys;
- bounded provider-role and authorization-evidence fields captured at assignment time;
- nullable assignment/evidence columns added to `nv_governance_approvals` for migration compatibility;
- a unique decision-to-assignment relationship for Task 8 decisions;
- UPDATE, DELETE, and TRUNCATE rejection for review assignments.

Assignments and decisions remain append-only. Raw provider responses, credentials, raw idempotency keys, email addresses, and unrestricted personal data are not persisted.

## API

Read:

- `GET /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review`

Writes:

- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me`
- `POST /api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions`

The claim body must be empty. The decision body accepts only:

- `decision`: `approve` or `reject`;
- `rationale`: bounded text; required for rejection.

Both writes support the existing optional `Idempotency-Key` contract and enter the Central Mutation Gateway as `governance.reviewer.assign` and `governance.approval.decide`.

## Deterministic review state

For a submitted version:

- `pending`: no rejection and approvals are below the required quorum;
- `approved`: no rejection and distinct approvals meet or exceed `requiredApprovals`;
- `rejected`: one or more rejection decisions exist.

`approved` and `rejected` are terminal Task 8 review states. Further assignments or decisions fail closed. Task 8 does not activate a policy.

The read model exposes counts, quorum, terminal status, assignments, and immutable decisions. It never exposes credentials or provider response bodies.

## Concurrency

- Reviewer claim and decision transactions acquire the shared per-policy PostgreSQL advisory lock used by activation, then a per-version review lock.
- Current provider authorization evidence and review state are revalidated after lock acquisition and before mutation.
- Unique constraints protect one assignment and one decision per identity.
- Optional idempotency reservations and writes occur in the same transaction.
- Rejection and quorum are computed from immutable decisions under the same lock.

## Acceptance criteria

1. Exact cross-provider authority/repository/policy/version scope is enforced without cross-scope existence leakage.
2. Reviewer identities come only from fresh server-derived authorization snapshots.
3. GitHub App installation and human reviewer identities stay separate.
4. Author/reviewer separation is enforced when configured.
5. One immutable assignment and one immutable decision exist per human identity and version.
6. Reject requires a rationale; approve rationale remains optional and bounded.
7. Quorum and rejection states are deterministic and terminal without activation.
8. Concurrent assignment/decision attempts are serialized and retry-safe.
9. All writes enter the Central Mutation Gateway.
10. History and HMAC audit evidence remain append-only.
11. No credentials, raw idempotency keys, browser role claims, or unrestricted provider data enter persistence, metadata, logs, errors, or responses.
12. PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free, and optional Neon compatibility remain intact.

## Non-goals

- administrator assignment of another human identity;
- policy simulation or impact evidence;
- activation or rollback APIs;
- active-policy evaluation or enforcement modes;
- exceptions, waivers, templates, notifications, exports, or Policy Digital Twin UI.
