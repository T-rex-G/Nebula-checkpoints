# Phase 1 Task 20 checkpoint report

## Status

**Execution complete — 18 of 19 mandatory checks passed; alpha.16.1 remains release-blocked.**

Task 20 execution completed with 18 of 19 mandatory checks passing. The Gitea compatibility procedure failed because alpha.16.1 read `commit.sha` from a Gitea branch response that exposes the commit identifier as `commit.id`. The failure is preserved as release-blocking evidence. Alpha.16.1 remains immutable, and Task 21 must produce and requalify alpha.16.2.

## Alpha.16.1 changes

- Upgraded staging evidence to schema `1.2.0`.
- Bound every record to the exact catalog hash and release-candidate SHA-256.
- Bound every record to the prescribed command or canonical live procedure ID.
- Required the verifier to reopen every pass/fail artifact under `staging/evidence/`, reject symlinks/path escape/oversize, and recompute its SHA-256.
- Required at least one verified non-secret artifact file for every pass or fail.
- Rejected unknown schema versions, wrong catalogs, mixed candidates, forged command hashes, artifact-free pass/fail records, duplicates, stale evidence, and missing expected subjects.
- Made the staging report hash reproducible across verification times while evidence remains fresh.
- Added a versioned evidence envelope and mandatory `NV_STAGING_SUBJECT_SHA256` CLI input.
- Added a dependency-aware independent test-matrix runner with hashed, candidate-bound reports and strict genuine-`MODULE_NOT_FOUND` classification.
- Replaced presence-only browser checks with behavioral focus, mobile navigation, live Governance, cache inspection, and offline-failure assertions.
- Added desktop and mobile Playwright projects.

## Verification in this environment

- 91 top-level test programs discovered after the new tests were added.
- 84 passed.
- 7 were blocked only by declared unavailable `express` or `archiver` dependencies.
- 0 failed.
- The blocked programs are `config-startup`, two GitHub App server tests, `package-release`, `release-contract`, `security-foundation-server`, and `server-smoke`.
- `node scripts/verify.js`, syntax checking, staging-contract tests, and secret scanning passed.

A bounded `npm ci --ignore-scripts --no-audit --no-fund` attempt received repeated `503` responses from the environment package proxy. The installer was terminated and the partial `node_modules` directory was removed. No runtime, audit, Archiver, or Playwright pass is claimed.

## Historical pre-execution blockers

Live Neon, GitHub, GitLab, Gitea, optional GitHub App, destructive sandbox, receive-pack/LFS, webhook network, clean dependency, runtime, and Playwright evidence remains required. The committed evidence template is deliberately blocked and uses an all-zero placeholder subject until regenerated for an exact release candidate.

## Release impact

Alpha.16.1 is a safer continuation checkpoint for Task 20. Task 20 remains incomplete, the staging gate remains closed, and Task 21 must not start.
