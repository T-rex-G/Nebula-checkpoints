# Nebulaverse-X Phase 0 Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce Nebulaverse-X v5.2.2 with unified release identity, privacy-safe optional PWA repository caching, migrations, CI, browser tests and reproducible packaging.

**Architecture:** Keep the current Express/PWA codebase and Render Free + Neon deployment. Add focused modules for release metadata, offline cache policy and migrations instead of expanding the monolithic files further.

**Tech Stack:** Node.js 18+, Express 4, PostgreSQL/Neon, service workers, Cache Storage, Playwright, GitHub Actions.

## Global Constraints

- Official product and Render service name is `Nebulaverse-X`.
- `package.json` is the only authored version source.
- Private repository caching is disabled by default and opt-in per repository.
- Private cache identity is opaque and partitioned by provider/account/session.
- No Render database, paid AI or paid service is added.
- Existing v5.2.1 product features remain functional.

---

### Task 1: Release identity and branding

**Files:**
- Create: `src/version.js`
- Modify: `package.json`, `package-lock.json`, `server.js`, `public/index.html`, `public/sw.js`, `test/server-smoke.test.js`
- Test: `test/release-contract.test.js`

- [ ] Write a failing release-contract test proving package, server response, rendered shell and service worker use v5.2.2 from one source.
- [ ] Run it and confirm the current hard-coded values fail.
- [ ] Implement `src/version.js`, dynamic `index.html`/`sw.js` rendering and official `nebulaverse-x` metadata.
- [ ] Run the release and smoke tests.

### Task 2: Private PWA cache policy

**Files:**
- Create: `public/offline-cache-policy.js`
- Modify: `public/sw.js`, `public/app.js`, `public/index.html`
- Test: `test/offline-cache-policy.test.js`, `test/account-boundary.test.js`

- [ ] Write failing tests for allowlisted endpoints, sensitive exclusions, scope validation, TTL/size limits and awaited account cleanup.
- [ ] Implement network-first scoped private caches and per-repository opt-in settings.
- [ ] Make login, add, switch, remove, logout, revocation and emergency transitions clear caches before identity changes.
- [ ] Run cache-policy and existing hardening tests.

### Task 3: Numbered Neon migrations

**Files:**
- Create: `src/migrations.js`, `db/migrations/001_sessions.sql`, `002_security.sql`, `003_intelligence.sql`, `004_recovery.sql`, `005_evidence.sql`
- Modify: `server.js`
- Test: `test/migrations.test.js`

- [ ] Write failing tests for ordering, checksum stability, advisory locking and changed-migration refusal.
- [ ] Move current schema DDL into idempotent numbered SQL files.
- [ ] Run migrations from the existing database readiness path.
- [ ] Run migration, config and intelligence tests.

### Task 4: Release hygiene and deterministic packaging

**Files:**
- Create: `.gitignore`, `scripts/package-release.js`, `test/package-contract.test.js`
- Modify: `.env.example`, `README.md`, `DEPLOY_RENDER_NEON.md`, `CHANGELOG.md`, `render.yaml`, `package.json`

- [ ] Write a failing package-contract test for required files and forbidden metadata/secrets.
- [ ] Implement deterministic release packaging and documentation updates.
- [ ] Verify the Render Blueprint contains one free `Nebulaverse-X` web service and no database resource.

### Task 5: CI and browser regression tests

**Files:**
- Create: `.github/workflows/ci.yml`, `playwright.config.js`, `test/e2e/mock-server.js`, `test/e2e/pwa.spec.js`
- Modify: `package.json`, `package-lock.json`

- [ ] Add Playwright as a development dependency and create deterministic shell/PWA/account-isolation journeys.
- [ ] Add CI commands for tests, Playwright, syntax checks, audit and package validation.
- [ ] Run Playwright locally with Chromium.

### Task 6: Clean-room release verification

**Files:**
- Modify: `scripts/verify.js`, `BUILD_REPORT.md`

- [ ] Run clean `npm ci`, full tests, Playwright, syntax checks and audit.
- [ ] Build the release ZIP, extract it elsewhere and repeat production install plus smoke tests.
- [ ] Generate SHA-256 and document exact verification evidence.
