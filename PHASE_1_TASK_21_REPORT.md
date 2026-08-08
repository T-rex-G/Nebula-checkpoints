# Phase 1 Task 21 checkpoint report

## Status

**In progress — alpha.16.3 Gitea mutation correction implemented locally; candidate requalification remains required.**

## Immutable baseline

- Task 20 closeout commit: `81995d0772f643008951a9a8b58fa07eb8746685`.
- Alpha.16.1 SHA-256: `0443c43121de2fe987a3c64682c169ddc9604b6950adc08590bad104247ca516`.
- Task 20 result: 18 mandatory checks passed, 1 failed, 0 unexecuted.
- Release-blocking failure: Gitea branch discovery returned an empty normalized SHA because alpha.16.1 read `commit.sha` instead of Gitea's `commit.id`.

Alpha.16.1 is not modified by Task 21.

Alpha.16.2 is also immutable:

- commit `c5982f016c01b61208badca7254a67a6eca32a6a`;
- SHA-256 `1a83ddc3a94a42caa5c252e2a4833788c31f540ec8c21860e5aa333d22493564`;
- credential-free Node 22 matrix passed;
- live Gitea run `30392653545` reached provider transport and failed during the bounded file write with HTTP 400;
- the provider harness verified that its disposable live-test branch was removed.

## Test-first correction

The regression was written before the implementation and failed because no provider-aware branch-normalization boundary existed. Its independent fixtures require:

- GitHub branch responses to use `commit.sha`;
- GitLab branch responses to use `commit.id`;
- Gitea branch responses to use `commit.id`;
- missing commit data to remain an empty SHA without inventing evidence.

The implementation adds one `normalizeProviderBranches` function to `src/intelligence.js` and routes the repository-detail responses in `server.js` through that boundary. No provider credentials, mutation behavior, database schema or external storage behavior changed.

## Alpha.16.2 live failure

The fresh live run proved that branch normalization was corrected, but exposed a second provider incompatibility. Alpha.16.2 reused GitHub's writable Git Data sequence, beginning with `POST /repos/{owner}/{repo}/git/blobs`. Gitea exposes its Git Data endpoints for reads but performs file create, update and delete through `/repos/{owner}/{repo}/contents/{filepath}`. The live bounded write therefore returned HTTP 400 and no successful provider pass record was created.

The failure remains release-blocking evidence and is not rewritten as a pass.

## Alpha.16.3 test-first mutation correction

The alpha.16.3 regression suite covers:

- create through the Gitea Contents API with no mutating `/git/*` call;
- delete through the Gitea Contents API using the provider-resolved current blob SHA;
- stale expected-head rejection before any provider write;
- a branch race after the temporary mutation but before target update;
- cleanup of the disposable branch after success or compare-and-swap conflict;
- a real Express route fixture that rejects all mutating Gitea `/git/*` calls and exercises create, stale-head rejection and delete.

The adapter creates a disposable `nv-tx/*` branch from the exact expected commit, mutates only that branch through the Contents API, validates the returned commit and its parent, and moves the requested target branch with Gitea's non-forced `old_commit_id`/`new_commit_id` compare-and-swap. It then verifies the target head and deletes the disposable branch. GitHub and GitLab route behavior is unchanged.

The server regression also exposed a Gitea-only governance fallback defect: normalized scopes contained `authority` but not `baseUrl`, so a second normalization failed when policy evaluation degraded to warn mode. Normalized Gitea scopes are now idempotent, and both the model and runtime fallback have direct regressions.

## Dependency advisory classification

The current full audit reports four high-severity package entries on one chain under the direct development dependency `archiver`:

`archiver → readdir-glob → minimatch → brace-expansion`

The production-only high-severity audit reports zero vulnerabilities. The package lock marks every package in the advisory chain as development-only, and npm reports no available fix. Nebulaverse's release packager recursively collects an explicit file list with `fs.readdirSync` and appends exact file bytes; it does not pass user-controlled patterns to Archiver's glob or directory traversal APIs. The advisory is therefore not reachable through the supported production runtime or the current deterministic packaging path.

Task 21 keeps the lockfile unchanged. This is a bounded risk classification, not an advisory waiver; future dependency updates must continue to audit the chain.

## Deterministic packaging correction

The pre-release double build exposed a packaging defect: extracted payloads were identical, but ZIP entry ordering varied because `archive.file` completed asynchronous filesystem reads in nondeterministic order. A regression then built the same source four times and failed with four different digests.

The packager now reads each already sorted file synchronously and appends its bytes to Archiver with the existing normalized name, mode and timestamp. The four-build regression is GREEN and is required by the default `npm test` contract. This changes packaging mechanics only; packaged source bytes and inclusion rules are unchanged.

## Release conditions

Task 21 is not complete until:

1. the focused regression and neighboring provider/runtime contracts pass;
2. the full source, syntax, package, secret and production-audit gates pass;
3. a deterministic `Nebulaverse-X-v5.3.0-alpha.16.3.zip` and SHA-256 sidecar are produced;
4. the new candidate is bound to fresh evidence;
5. the Gitea live compatibility procedure passes against alpha.16.3 with disposable-branch cleanup evidence;
6. both existing PRs remain draft, `main` remains unchanged, and alpha.16.1 and alpha.16.2 remain immutable.
