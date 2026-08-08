# Phase 1 Task 18 Report — Full Mutation Coverage and Bulk Operation Governance

## Checkpoint

- Version: `v5.3.0-alpha.14`
- Phase 1 Task 18: **Complete**
- Next checkpoint: Task 19 — Governance Notifications, Webhooks and Audit Exports
- Database migration: none
- New runtime dependency: none

## Objective

Task 18 proves that every supported repository/provider write enters the Central Mutation Gateway and that aggregate operations have explicit, bounded and testable execution semantics. It does not implement Task 19 notifications/exports or Phase 5 external evidence storage.

## Machine-verifiable mutation inventory

Added `src/mutation-coverage.js` as the immutable source of truth for:

- every repository mutation route;
- its registered Central Mutation Gateway action;
- execution mode (`single`, `composite`, `batch-atomic`, or `batch-partial`);
- maximum item count;
- maximum canonical payload size where applicable;
- maximum provider-write assertions;
- atomicity and partial-failure semantics.

Static contracts scan mutating repository routes and fail when a route is neither inventoried nor explicitly classified as a non-mutating POST/control operation. Provider helpers `gh`, `glFetch`, `uploadViaGitPush`, and `uploadViaLFS` must assert an active gateway context before any provider write. Git LFS batch negotiation, object upload and verification are individually classified.

## Gateway execution evidence

The Central Mutation Gateway now attaches one deeply immutable execution contract to every normalized mutation descriptor. Within the active async mutation context it:

- counts every authorized provider-side-effect attempt;
- rejects an assertion beyond the registered maximum before transport;
- emits a bounded provider-write index;
- derives a deterministic operation ID from mutation ID, write index, method, operation and normalized target identity;
- exposes a bounded execution snapshot for aggregate API responses;
- records provider-write count and operation IDs in completion events.

The historical governance descriptor-evidence hash remains unchanged. Execution contracts are additive runtime metadata and do not reinterpret Tasks 12–17 immutable decision history.

## Aggregate operation contracts

### File batch

`file.batch` now requires:

- 1–100 `put` or `delete` items;
- unique normalized paths;
- a canonical payload no larger than 2 MiB;
- one fresh 40-character `expectedHeadSha`;
- deterministic ordered item IDs and an aggregate batch hash;
- one provider commit or no commit.

Raw file content is excluded from governance metadata. Content is represented only by a SHA-256 hash.

### Restore paths and directory move

`commit.restore-paths` and `directory.move` require a fresh aggregate expected head and preserve single-provider-commit semantics. Existing path and tree bounds remain authoritative.

### Recovery restore refs

The recovery descriptor is now bound before policy evaluation to the exact branch-action list sealed by the recovery-preview authorization. It includes deterministic per-action IDs and a batch hash.

Execution remains sequential and bounded to 50 actions. Results expose per-item operation IDs, explicit success/failure and aggregate `partialFailure`. The sealed authorization is at-most-once; partial or failed recovery requires a fresh preview instead of an automatic replay.

## Provider and transport compatibility

The implementation preserves:

- GitHub PAT and OAuth;
- optional GitHub App installation execution with verified human governance attribution;
- GitLab supported repository writes;
- Gitea supported repository writes;
- Git receive-pack upload;
- Git LFS batch, upload and verification.

No new provider, Bitbucket support, notification delivery, signed export format or external evidence sink is introduced.

## Security and deployment review

The review traced every mutating route, provider helper, direct Git transport, aggregate path, retry boundary and provider-specific branch.

Deployment-sensitive protections include:

- unknown actions and operations fail before provider transport;
- provider-write overflow fails before the excess side effect;
- aggregate payloads and item counts are bounded;
- batch target identity is included in policy/exception evidence;
- aggregate writes require optimistic branch-head concurrency evidence;
- recovery cannot replay a consumed authorization after partial provider success;
- direct Git LFS stages cannot bypass gateway assertions;
- static route and helper contracts fail the build when mutation coverage drifts.

The source-level review found no unresolved P0 or P1 issue.

## Verification boundary

The final source checkpoint must pass all dependency-free tests, build verification, JavaScript syntax checking, secret scanning, package/continuity contracts, deterministic archive comparison and clean-extraction verification.

Before production promotion, CI or staging must additionally run:

- clean `npm ci` and dependency audit;
- dependency-backed Express and release tests;
- real GitHub, GitLab and Gitea single/batch mutation tests;
- optional GitHub App execution tests;
- Git receive-pack and Git LFS failure-ladder tests;
- partial recovery and fresh-preview retry exercises;
- live Neon policy/exception decision concurrency;
- Playwright browser workflows for batch and recovery operations.
