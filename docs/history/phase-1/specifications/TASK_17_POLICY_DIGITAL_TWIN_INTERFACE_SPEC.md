# Phase 1 Task 17 — Policy Digital Twin Interface Specification

## Goal

Provide one accessible, responsive, repository-scoped governance workspace that presents the authoritative Task 16 Policy Digital Twin and safely invokes the existing Tasks 6–14 lifecycle APIs without duplicating governance truth or trusting browser-supplied authority.

## Users

- Repository readers inspecting current, proposed, effective and historical governance evidence.
- Authors creating policies, generating baselines, editing drafts and requesting exact-scope exceptions.
- Reviewers claiming assignments and recording immutable approvals or rejections.
- Activators performing evidence-backed activation and rollback.
- Administrators deciding and revoking exceptions or waivers.

## Architecture

### Authoritative data

The browser consumes:

- `GET /api/repo/:owner/:repo/governance/digital-twin?historyLimit=50` for the Task 16 repeatable-read projection;
- a bounded server-generated interface-access envelope derived from the current authorization snapshot;
- existing governance lifecycle routes for every write;
- existing decision history and verification routes for additional evidence pages.

The browser never recomputes policy truth, provider permissions, governance roles, review state, exception applicability, activation readiness or enforcement outcomes.

### Client boundaries

- `src/governance-interface.js` projects only repository scope, verified human login, execution kind/auth method, capability booleans and evidence expiry.
- `public/governance-ui.js` is a pure deterministic, XSS-safe renderer with no network or storage side effects.
- `public/app.js` owns live network orchestration, confirmation dialogs, bounded JSON parsing, idempotency keys and repository/account-bound state reset.
- Governance API responses are network-only and are never written to local storage, IndexedDB or the service worker's private API cache.

## Interface sections

1. **Overview** — active policies, proposed versions, active exceptions, decision-page status and snapshot freshness.
2. **Current policy state** — active heads, enforcement mode, revision and latest version/review evidence.
3. **Drafts and proposed versions** — edit, validate, submit, inspect, simulate, review and activate workflows.
4. **Exceptions and waivers** — inspect, request, decide and revoke exact actor/target-bound records.
5. **Evidence history** — activation/rollback references, runtime decisions, cursor pagination and bounded decision-chain verification.

## States

The interface must explicitly render:

- loading;
- no-policy empty state;
- complete/current evidence;
- partial or truncated evidence;
- stale or unavailable authorization evidence;
- server/network errors;
- simulation eligible and blocked results;
- pending, approved, rejected, revoked, expired and superseded lifecycle states.

## Authorization and safety rules

- Visible controls are derived only from the server access envelope.
- Expired authorization evidence disables all governance controls even if the page remains open.
- DOM manipulation cannot grant authority; every API call revalidates current server/provider authorization.
- GitHub App execution displays the verified human governance actor separately from the installation execution principal.
- Simulation evidence is held only in memory and invalidated when the authoritative read-model hash changes.
- Activation and rollback require the exact eligible simulation hash/request and current policy revision; the server recomputes and rechecks all evidence.
- Every governance write uses a unique 8–200 character `Idempotency-Key`.
- Policy/baseline/draft/version/exception JSON is escaped before display and bounded JSON inputs use the existing governance parser and server validation.
- Raw credentials, provider responses, identity hashes, installation permissions, unrestricted source content, patches and diffs are never exposed by the interface-access envelope.

## Accessibility and responsive behavior

- Native buttons, form controls and headings preserve keyboard operation.
- The governance region has a labelled tab and polite ARIA live status.
- Loading uses `aria-busy`; errors use `role=alert`; partial/stale evidence uses explicit status banners.
- Confirmation workflows use a labelled modal dialog, focus containment, Escape cancellation and focus restoration.
- Layout collapses from metric/card grids to one-column rows on narrow screens.
- Reduced-motion preferences disable governance shimmer/animation.
- Destructive or terminal actions require explicit confirmation and clear consequences.

## Offline and caching contract

- `/governance` API paths remain `network-only` in `public/offline-cache-policy.js`.
- The static renderer may be precached as part of the application shell.
- Digital Twin, policy, draft, review, activation, exception and decision evidence must never be persisted for offline use.
- Repository change, account change, logout and private-cache purge clear in-memory governance state.

## Non-goals

Task 17 does not:

- create a second mutable Digital Twin store;
- add organization inheritance;
- change policy schemas or enforcement semantics;
- add new database migrations;
- bypass existing governance API or Central Mutation Gateway boundaries;
- modify Task 19;
- implement Phase 5 customer-controlled evidence storage;
- add a frontend framework or paid service.

## Acceptance criteria

1. Reader-authorized Digital Twin responses include a credential-free access envelope.
2. The renderer escapes all user/provider/governance text and never uses inline event handlers.
3. Current, proposed, effective and historical state are distinct and include explicit freshness/completeness.
4. All lifecycle controls are permission-aware and use only existing authenticated routes.
5. Authorization expiry disables controls without requiring navigation.
6. Repository/account transitions clear all in-memory governance evidence.
7. Governance responses are not written to browser persistence or offline API caches.
8. Fresh simulations are bound to policy/version and invalidated by authoritative state changes.
9. Decision history uses bounded cursor pagination and verification reports complete versus limit-bounded results accurately.
10. The interface is keyboard-operable, responsive, reduced-motion aware and screen-reader labelled.
11. Existing PAT, OAuth, optional GitHub App, GitLab and Gitea behavior remains compatible.
12. All source-level regressions, package contracts, syntax checks, secret checks and deterministic clean-package verification pass.
