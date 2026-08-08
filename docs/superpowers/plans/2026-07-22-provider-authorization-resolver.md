# Provider Permission and Governance Role Resolver Implementation Plan

**Goal:** Add a server-derived authorization snapshot and attach it to every mutation gateway descriptor without enforcing policy yet.

## Constraints

- Preserve PAT, OAuth, optional GitHub App, GitLab and Gitea behavior.
- Keep credentials and raw provider responses out of snapshots, events, logs and continuity files.
- Fail closed for governance roles on uncertainty.
- Use red/green/refactor and preserve Tasks 1–4 invariants.

## Steps

- [x] Add failing unit tests for snapshot validation, role mapping, provider adapters, GitHub App principal separation, error minimization, cache isolation and concurrency.
- [x] Add failing server and mutation-gateway contracts requiring the resolver and snapshot.
- [x] Implement `src/authorization-resolver.js` with immutable normalization and bounded cache.
- [x] Return fresh sanitized installation evidence from the GitHub App broker.
- [x] Integrate resolver invocation into mutation context creation and attach the snapshot to the gateway descriptor.
- [x] Run focused tests, dependency-free regression, syntax and secret checks.
- [x] Perform an independent read-only change review and correct findings.
- [x] Update version, reports, roadmap, architecture decisions and continuation artifacts.
- [x] Build a deterministic alpha.5 ZIP and SHA-256 checksum.
