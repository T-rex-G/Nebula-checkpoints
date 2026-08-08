# Policy Digital Twin Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, accessible repository governance interface backed by the alpha.12 Policy Digital Twin and existing lifecycle APIs.

**Architecture:** Add one server-side access projection and one pure browser renderer, then integrate them into the existing repository workspace through lazy-loaded orchestration in `public/app.js`. Preserve all existing server authorization, CSRF, mutation-gateway, audit, simulation and persistence boundaries.

**Tech Stack:** Node.js 22, CommonJS, Express 4, plain HTML/CSS/JavaScript, existing modal and API helpers.

## Global Constraints

- No new runtime or development dependency.
- Governance state and evidence are never cached offline or persisted in browser storage.
- Every server-derived string inserted into HTML is escaped.
- UI permissions are hints only; server-side authorization remains authoritative.
- Activation and rollback require a fresh eligible in-memory simulation for the exact policy/version.
- No Task 18, Task 19, external-storage or organization-wide work.

---

### Task 1: Server-derived interface access envelope

**Files:**
- Create: `src/governance-interface.js`
- Modify: `server.js`
- Test: `test/governance-interface-access.test.js`
- Test: `test/governance-interface-server-contract.test.js`

**Interfaces:**
- Consumes: Task 5 authorization snapshot.
- Produces: `projectGovernanceInterfaceAccess(snapshot, now)` and `{ digitalTwin, access }` response envelope.

- [ ] Write failing tests for credential-free access projection, stale evidence, GitHub App human attribution and route response shape.
- [ ] Run tests and confirm missing-module/response failures.
- [ ] Implement the minimal immutable projection and route envelope.
- [ ] Run focused tests and existing Digital Twin API/server tests.

### Task 2: Pure governance renderer and validators

**Files:**
- Create: `public/governance-ui.js`
- Test: `test/governance-interface-renderer.test.js`

**Interfaces:**
- Consumes: `{ digitalTwin, access, selectedPolicyId, simulation, verification, loading, error }`.
- Produces: escaped HTML, normalized access, default simulation request and strict JSON-object parser.

- [ ] Write failing tests for summary rendering, partial/empty/error states, permission-aware actions and XSS escaping.
- [ ] Run tests and confirm missing module.
- [ ] Implement UMD renderer and helpers with deterministic output.
- [ ] Run focused tests and syntax check.

### Task 3: Workspace shell and responsive styles

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/sw.js`
- Modify: `public/offline-cache-policy.js`
- Test: `test/governance-interface-ui-contract.test.js`
- Test: `test/offline-cache-policy.test.js`

**Interfaces:**
- Produces: `tab-governance`, `govRoot`, `govLive`, refresh/verify controls and mobile navigation entry.

- [ ] Write failing contract tests for required IDs, ARIA semantics, scoped styles, script loading and network-only governance requests.
- [ ] Run tests and confirm missing interface.
- [ ] Add the shell, styles, script/precache entry and explicit governance network-only classification.
- [ ] Run focused tests and existing service-worker/build checks.

### Task 4: Read-model loading and navigation integration

**Files:**
- Modify: `public/app.js`
- Test: `test/governance-interface-client-contract.test.js`

**Interfaces:**
- Produces: `loadGovernanceTwin`, `renderGovernanceInterface`, `clearGovernanceState`, lazy activation from `switchTab('governance')`.

- [ ] Write failing client contract tests for loading, repository/account reset, no browser persistence and bounded history pagination.
- [ ] Run tests and confirm missing functions.
- [ ] Implement state, lazy loading, rendering, refresh, verification and load-more history.
- [ ] Run focused tests and existing UI/account/offline tests.

### Task 5: Policy and draft workflows

**Files:**
- Modify: `public/app.js`
- Test: `test/governance-interface-lifecycle-contract.test.js`

**Interfaces:**
- Calls existing policy, template, baseline, draft, validation and submission endpoints.

- [ ] Write failing contract tests for role-gated create-policy, generate-baseline, create/update/validate/submit-draft flows and idempotency headers.
- [ ] Run tests and confirm missing workflows.
- [ ] Implement modal workflows using strict JSON parsing and current policy/draft revisions.
- [ ] Run focused tests and governance API regressions.

### Task 6: Simulation, review, activation and rollback workflows

**Files:**
- Modify: `public/app.js`
- Test: `test/governance-interface-enforcement-contract.test.js`

**Interfaces:**
- Stores one in-memory simulation keyed by scope, policy ID, version ID and read-model hash.
- Calls existing simulate, claim-reviewer, decision, activate and rollback endpoints.

- [ ] Write failing tests for simulation freshness binding, activation blocker display, rejection rationale and confirmation requirements.
- [ ] Run tests and confirm missing workflows.
- [ ] Implement the minimal secure modal flows and clear simulation evidence after refresh/mutation.
- [ ] Run focused tests and Tasks 8–13 regressions.

### Task 7: Exception workflows and final accessibility hardening

**Files:**
- Modify: `public/app.js`
- Modify: `public/governance-ui.js`
- Modify: `public/style.css`
- Test: `test/governance-interface-exception-contract.test.js`
- Test: `test/governance-interface-accessibility.test.js`

**Interfaces:**
- Calls existing exception request, decision and revocation endpoints.

- [ ] Write failing tests for exact target JSON, actor omission, expiry bounds, admin decisions, focus/live-region semantics and reduced motion.
- [ ] Run tests and confirm missing behavior.
- [ ] Implement exception modals and accessibility refinements.
- [ ] Run focused tests and Task 14 regressions.

### Task 8: Release contracts, review and package

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/version.js` consumers, `scripts/verify.js`, release/package/continuity tests and project documentation.
- Create: `TASK_17_POLICY_DIGITAL_TWIN_INTERFACE_SPEC.md`
- Create: `PHASE_1_TASK_17_REPORT.md`

- [ ] Add failing alpha.13 package and continuity contracts.
- [ ] Update version metadata, roadmap, ADRs, project state, continuation prompt, changelog and deployment notes.
- [ ] Run every source-level test individually, build verification, syntax and secret checks.
- [ ] Perform a read-only security/accessibility/regression review and fix blockers through new failing tests.
- [ ] Build two deterministic archives and require identical hashes.
- [ ] Inspect and test the exact clean extraction before producing the checksum sidecar.
