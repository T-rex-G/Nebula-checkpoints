# Governance Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add immutable, repository-scoped policy lifecycle persistence and a tamper-evident governance audit foundation for later Phase 1 enforcement and simulation tasks.

**Architecture:** A pure governance model module validates and hashes bounded policy data. A PostgreSQL store performs explicit transactional lifecycle operations over append-only history tables and one optimistic active-head row. No API routes, enforcement, or UI are introduced in this task.

**Tech Stack:** Node.js 22, CommonJS, built-in `crypto`, PostgreSQL/Neon numbered migrations, Node `assert` tests.

## Global Constraints

- GitHub App remains optional and PAT/OAuth/GitLab/Gitea behavior remains unchanged.
- Governance requires configured, available Neon persistence and has no cookie/in-memory durability fallback.
- Policy versions, decisions, activations, and audit records are append-only.
- Policy/audit JSON cannot contain credentials or secret-bearing fields.
- Rollback appends history and never rewrites a prior version or activation.
- Task 3 adds no mutation enforcement, policy simulation, governance routes, or UI.

---

### Task 1: Governance model and tamper-evident audit primitives

**Files:**
- Create: `src/governance-model.js`
- Create: `test/governance-model.test.js`

- [x] Write failing tests for scope normalization, bounded schema-v1 policy documents, duplicate rule rejection, sensitive-field rejection, deterministic document hashes, approval policy defaults/bounds, HMAC audit hashes, and tamper detection.
- [x] Run `node test/governance-model.test.js` and confirm the missing-module failure.
- [x] Implement the smallest deterministic model functions and stable `GovernanceError` codes.
- [x] Run the focused test and confirm it passes.

### Task 2: Immutable PostgreSQL governance schema

**Files:**
- Create: `db/migrations/007_governance.sql`
- Modify: `test/migrations.test.js`
- Create: `test/governance-persistence-contract.test.js`

- [x] Add failing assertions for all six tables, authority/scope uniqueness, version ordering/hash uniqueness, actor decision uniqueness, head revision, activation provenance, HMAC audit fields, indexes, and UPDATE/DELETE rejection triggers.
- [x] Run focused migration tests and confirm failure.
- [x] Add the idempotent numbered migration without requiring PostgreSQL extensions.
- [x] Run focused migration tests and confirm green.

### Task 3: Transactional governance store

**Files:**
- Create: `src/governance-store.js`
- Create: `test/governance-store.test.js`

- [x] Write failing scripted-client tests for policy creation, ordered immutable versions, self-approval rejection, one decision per actor, approval/rejection activation gates, optimistic revision conflicts, activation history, prior-activation rollback requirement, audit append order, and rollback on errors.
- [x] Run `node test/governance-store.test.js` and confirm the missing-module failure.
- [x] Implement explicit parameterized SQL transactions and error translation.
- [x] Run the focused store test and confirm green.

### Task 4: Release identity, documentation, and contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `PHASE_1_TASK_3_REPORT.md`
- Modify: `test/package-contract.test.js`
- Modify: `test/release-contract.test.js`

- [x] Add failing release assertions for `5.3.0-alpha.3`, Task 3 report, migration, modules, tests, test script inclusion, and syntax script inclusion.
- [x] Run focused release tests and confirm failure.
- [x] Update release metadata and precise operational documentation.
- [x] Run focused release tests and confirm green.

### Task 5: Regression, review, and clean-package proof

- [x] Run `npm test`, `npm run check:syntax`, `npm run check:secrets`, `npm run test:release`, and `npm audit --audit-level=high` when registry access permits.
- [x] Perform a read-only spec/correctness/concurrency/security/compatibility review and correct any blocker through the smallest failed task.
- [x] Build the deterministic alpha.3 archive.
- [x] Extract it cleanly and repeat dependency install, complete tests, syntax, secret scan, packaged-runtime, checksum, and unsafe-path validation.
- [x] Record the final SHA-256 beside the deterministic archive and document staging-only limitations in `PHASE_1_TASK_3_REPORT.md`.

## Execution record

- Test-first red signals were observed for the missing model, migration, store, release contracts, decision/activation serialization, audit snapshot consistency, and case-preserving authority path behavior.
- Focused tests passed after each minimal implementation slice.
- The complete legacy and Task 3 regression suite, syntax validation, secret scan, and packaged-runtime test passed before archive construction.
- Independent review corrected the decision/activation race, audit completeness snapshot race, and case-sensitive self-hosted path collision before final packaging.
- Live PostgreSQL migration rehearsal and browser E2E remain staging/CI checks because those services are unavailable or blocked in this sandbox.
