# Policy Digital Twin Interface Design

## Goal

Deliver a repository-scoped, accessible governance workspace that makes the authoritative Policy Digital Twin understandable and allows authorized users to complete the existing policy lifecycle without bypassing server-side authorization or evidence requirements.

## Users

- Readers inspect current, proposed, effective and historical governance state.
- Authors create policies and drafts, generate baselines, submit versions and request bounded exceptions.
- Reviewers claim review assignments and approve or reject immutable versions.
- Activators activate or roll back versions only with fresh simulation evidence.
- Administrators decide and revoke exception requests.

## Architecture

1. `src/governance-interface.js` projects the existing authorization snapshot into a bounded, credential-free UI access envelope. It exposes only boolean capabilities, evidence status and expiry.
2. `public/governance-ui.js` is a dependency-free UMD module containing deterministic, XSS-safe renderers and JSON/scenario helpers. It is unit-testable in Node and exposed as `window.NebulaGovernanceUI` in the browser.
3. `public/index.html` adds one Governance tab and an accessible tab panel with live status, toolbar and rendering host.
4. `public/app.js` owns network orchestration and modal workflows. All state-changing calls continue to use the existing `api()` CSRF boundary and server-side governance middleware.
5. `public/style.css` adds scoped responsive styles only under `.gov-*` selectors.
6. Governance API reads remain `Cache-Control: no-store`, and the offline-cache policy explicitly classifies every `/governance` endpoint as network-only.

## Interface hierarchy

- Header: repository scope, freshness, access summary, refresh and chain verification.
- Summary: active policies, proposed versions, active exceptions and recent decisions.
- Current policies: active version, mode, latest version and review state.
- Proposed work: drafts and submitted versions with permission-aware actions.
- Exceptions: state, action, expiry and bounded lifecycle actions.
- History: activations and policy decisions with cursor-based loading.

## Lifecycle workflows

### Create policy and draft

Authors can create a policy, generate a repository baseline from a canonical template, create or update an owned draft, validate it and submit an immutable version. Policy documents are edited as JSON and are never rendered as HTML.

### Simulation

Readers can run a bounded scenario set against a proposed version. The interface shows impact, conflicts, coverage and activation-readiness blockers. The last successful simulation request and hash are held only in memory and are cleared when the repository, policy, version or Digital Twin snapshot changes.

### Review

Reviewers may self-assign, then approve or reject. Rejection requires a bounded rationale. Controls are disabled when the read model reports terminal review state or when access evidence is stale/unavailable.

### Activation and rollback

Activators can activate only after a fresh in-memory simulation is eligible and matches the selected version. Rollback is available from activation history and requires a fresh eligible simulation for the target version. Both actions require an explicit confirmation reason and exact expected policy revision.

### Exceptions

Authors can request an actor- and target-bound exception or waiver. Administrators can approve, reject or revoke. The interface never accepts another actor identity and never widens the target beyond the entered bounded JSON object.

## UX states

- Loading: skeleton summary and `aria-busy=true`.
- Empty: explain how to create the first policy or baseline without showing inert tables.
- Partial: display a persistent warning naming incomplete sections.
- Unauthorized: explain the required repository role; do not show disabled destructive controls as if they could work.
- Offline/unavailable: explain that governance requires a live connection and never show cached governance evidence.
- Error: bounded message and retry control; no raw provider or database error body.
- Success: refresh the Digital Twin, restore focus to the triggering control and announce the result through an ARIA live region.

## Accessibility

- Semantic headings and sections.
- Every icon-only button has an accessible name.
- Status is not communicated by color alone.
- Keyboard-operable tab and action controls.
- Focus returns after modal workflows.
- Motion follows the existing reduced-motion setting.
- Layout remains usable at 320 CSS pixels and at 200% zoom.

## Security and privacy constraints

- Escape every server-derived string before HTML insertion.
- Never place credentials, raw provider responses, authorization snapshots or private evidence in the DOM.
- Access booleans are advisory UI hints only; server middleware remains authoritative.
- No localStorage, IndexedDB or service-worker caching for governance state or simulation evidence.
- Clear in-memory governance state when switching repositories, signing out or changing account.
- Do not execute policy JSON or use it as HTML.
- Keep idempotency keys random, operation-scoped and in memory only.

## Non-goals

- No external evidence storage.
- No organization-wide governance interface.
- No redesign of the existing repository workspace.
- No notification/webhook/export UI from Task 19.
- No new frontend framework or dependency.

## Acceptance criteria

1. A Governance tab is available on desktop and mobile.
2. The interface renders all Digital Twin sections and explicitly reports partial freshness.
3. Server-derived access controls hide or disable actions consistently without replacing server authorization.
4. Policy/draft, simulation, review, activation/rollback and exception workflows call only existing governance endpoints.
5. A fresh eligible simulation is required in memory before activation or rollback can be initiated.
6. Governance reads are network-only and never enter offline private caches.
7. Rendered server strings are HTML-escaped and regression-tested against script injection.
8. Loading, empty, error, unavailable and partial states are accessible and recoverable.
9. Existing repository, provider and governance tests remain green.
10. Package, continuity, syntax, secret and clean-extraction checks pass for alpha.13.
