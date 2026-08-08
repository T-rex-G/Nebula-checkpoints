# GitHub App Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add optional, server-owned GitHub App installation authentication and short-lived credential brokering without regressing PAT, OAuth, GitLab, or Gitea.

**Architecture:** A focused GitHub App module owns configuration validation, signed flow state, App JWT generation, GitHub API calls, and installation-token caching. A separate provider credential resolver injects ephemeral installation tokens at the authenticated request boundary. The monolithic server only orchestrates session state, routes, optional database persistence, and UI-safe status data.

**Tech Stack:** Node.js 22, CommonJS, Express 4, built-in `crypto`/`fetch`, PostgreSQL/Neon migrations, browser JavaScript, Node `assert` tests.

## Global Constraints

- GitHub App authentication is optional; no GitHub App variable means the feature is disabled.
- Partial or insecure production configuration fails closed.
- PAT, OAuth, GitLab, and Gitea behavior remains available.
- App private keys, client secrets, temporary user tokens, and installation tokens never enter browser JSON, logs, audit details, or persisted installation metadata.
- Callback state is session-bound, identity-bound, purpose-bound, expiry-bounded, and single-use.
- A claimed installation must be visible to the authorizing GitHub App user token and verified by the authenticated App.
- Installation tokens are cached no longer than sixty seconds before expiry and invalidated on disconnect or provider authorization failure.
- Render Free and deployments without Neon remain supported.

---

### Task 1: GitHub App cryptographic and configuration primitives

**Files:**
- Modify: `src/config.js`
- Create: `src/github-app.js`
- Create: `test/github-app.test.js`

**Interfaces:**
- Produces: `loadGithubAppConfig(env, options)`; `createGithubAppJwt(config, options)`; `createGithubAppState(secret, claims, options)`; `verifyGithubAppState(secret, token, expected, options)`; `GithubAppBroker`.

- [x] Write tests that prove absent configuration disables the feature, partial configuration fails, production callbacks require HTTPS, escaped private-key newlines normalize, RS256 JWTs verify, flow state rejects tampering/expiry/context mismatch, broker requests use App JWTs, suspended installations fail, concurrent refreshes coalesce, and cache expiry is bounded.
- [x] Run `node test/github-app.test.js` and confirm it fails because the interfaces do not exist.
- [x] Implement only the tested primitives with bounded input validation and redacted errors.
- [x] Run `node test/github-app.test.js` and confirm all assertions pass.

### Task 2: Provider credential boundary

**Files:**
- Create: `src/provider-credentials.js`
- Create: `test/provider-credentials.test.js`

**Interfaces:**
- Consumes: `GithubAppBroker.resolveInstallationAccount(account)`.
- Produces: `resolveProviderAccount(account, dependencies)` returning a cloned request account with an ephemeral token.

- [x] Write tests proving PAT/OAuth/GitLab/Gitea tokens pass through, GitHub App accounts require a broker, returned accounts are clones, stored accounts remain tokenless, and invalid account shapes fail closed.
- [x] Run the focused test and confirm a missing-module failure.
- [x] Implement the minimal resolver.
- [x] Run the focused test and confirm it passes.

### Task 3: Installation metadata persistence and lifecycle audit

**Files:**
- Create: `db/migrations/006_github_app.sql`
- Modify: `test/migrations.test.js`
- Create: `test/github-app-persistence-contract.test.js`

**Interfaces:**
- Produces: `nv_github_app_installations` and `nv_github_app_audit` tables containing no credentials.

- [x] Add failing migration/contract assertions for immutable migration discovery, composite identity/installation ownership, JSON permissions, lifecycle status, and credential-free columns.
- [x] Run focused tests and confirm failure.
- [x] Add the idempotent SQL migration.
- [x] Run focused tests and confirm green.

### Task 4: Server installation and credential-broker integration

**Files:**
- Modify: `server.js`
- Create: `test/github-app-server-contract.test.js`
- Create: `test/github-app-disabled-server.test.js`

**Interfaces:**
- Consumes: Task 1 configuration/broker and Task 2 resolver.
- Produces: connect, OAuth callback, setup, status, refresh, and disconnect routes; tokenless GitHub App session accounts; request-time credential resolution.

- [x] Write failing contract and live-disabled tests for optional configuration, CSRF-protected initiation, signed state consumption, ownership verification calls, tokenless account persistence, App-specific `/api/me` and repository listing, safe disconnect, broker invalidation, and no public secret fields.
- [x] Run focused tests and confirm expected failures.
- [x] Wire configuration and broker, add session-only management authentication, implement callback pending-state consumption, ownership verification, optional DB persistence/audit, GitHub App account creation, credential resolution before provider operations, App-specific identity/repository behavior, and invalidation on credential rejection.
- [x] Run focused tests and the existing security foundation tests until green.

### Task 5: Settings management interface

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`
- Create: `test/github-app-ui-contract.test.js`

**Interfaces:**
- Consumes: `/api/config` and GitHub App management routes.
- Produces: optional Settings connection panel and callback result notices.

- [x] Add failing UI contract assertions for disabled/enabled states, connect, refresh, reauthorize, disconnect, repository scope, health, and authorizing identity; assert no secret names are rendered.
- [x] Run the focused test and confirm failure.
- [x] Add API helpers, Settings markup, delegated event handlers, and callback toast/query cleanup while preserving existing PAT/OAuth login controls.
- [x] Run focused UI and account-boundary tests and confirm green.

### Task 6: Version, deployment documentation, and release contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `render.yaml`
- Modify: `README.md`
- Modify: `DEPLOY_RENDER_NEON.md`
- Modify: `SECURITY_DEPLOYMENT.md`
- Modify: `CHANGELOG.md`
- Create: `PHASE_1_TASK_2_REPORT.md`
- Modify: `test/package-contract.test.js`
- Modify: `test/release-contract.test.js`
- Modify: `package.json` scripts

**Interfaces:**
- Produces: version `5.3.0-alpha.2`, documented optional environment variables and GitHub setup/callback URLs, and complete test inclusion.

- [x] Add failing release assertions for version, report, scripts, configuration documentation, and inclusion of new modules/tests/migration.
- [x] Run focused release tests and confirm failure.
- [x] Update version, documentation, environment examples, Render comments, scripts, changelog, and report without adding secrets.
- [x] Run focused release tests and confirm green.

### Task 7: Regression, security review, and deterministic package proof

**Files:**
- Review all Task 1–6 changes; no feature expansion.

- [x] Run `npm test`, `npm run check:syntax`, `npm run check:secrets`, `npm run test:release`, and `npm audit --audit-level=high`.
- [x] Perform read-only spec, correctness, concurrency, security, compatibility, and secret-exposure review; return to the smallest failed task for any finding.
- [x] Run `npm run package:release -- /mnt/data/nebulaverse-x-v5.3.0-alpha.2-dist`.
- [x] Extract the ZIP to a fresh directory, run `npm ci --offline`, the full test suite, syntax scan, secret scan, package runtime test, and unsafe-path inspection.
- [x] Record the final SHA-256 and remaining staging-only limitations in `PHASE_1_TASK_2_REPORT.md`.


## Execution record

- Implemented inline in an isolated extracted workspace because the supplied prerelease archive contained no Git history.
- All focused red/green slices and the complete source regression suite passed.
- Security review findings were corrected before packaging, including cross-authorizer cache isolation, race-safe invalidation, upstream timeouts, capability boundaries, and stale-cookie state replay protection.
- `npm audit --audit-level=high` was attempted against the public registry but the advisory endpoint was unreachable from the sandbox. The clean offline installation still audited the locked tree and reported 132 packages with 0 vulnerabilities.
- Browser E2E execution was attempted but blocked by the sandbox browser policy; the tests remain included for CI/staging execution.
- The final deterministic ZIP and adjacent SHA-256 file are verified from a clean extraction before handoff.
