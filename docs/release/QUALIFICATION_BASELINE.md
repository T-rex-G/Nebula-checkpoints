# Nebulaverse-X v5.3.0-alpha.16.3 build report

## Checkpoint classification

Task 21 is **in progress**. Alpha.16.3 is the second correction candidate. Alpha.16.1 and alpha.16.2 remain immutable and release-blocked. Alpha.16.3 is not release-approved until fresh candidate-bound Node 22 and live Gitea evidence pass.

## Immutable baseline

- Task 20 closeout commit: `81995d0772f643008951a9a8b58fa07eb8746685`.
- Alpha.16.1 SHA-256: `0443c43121de2fe987a3c64682c169ddc9604b6950adc08590bad104247ca516`.
- Task 20 result: 18 mandatory checks passed, 1 failed, 0 unexecuted.
- The failed Gitea branch-discovery check used `commit.sha`; Gitea supplies `commit.id`.
- Alpha.16.2 commit: `c5982f016c01b61208badca7254a67a6eca32a6a`.
- Alpha.16.2 SHA-256: `1a83ddc3a94a42caa5c252e2a4833788c31f540ec8c21860e5aa333d22493564`.
- Alpha.16.2 passed the Node 22 candidate matrix, then live Gitea run `30392653545` failed during its bounded file write with HTTP 400 because the shared GitHub path attempted `POST /git/blobs`.

## Alpha.16.3 correction and regression evidence

- The real server regression reproduces the alpha.16.2 failure by rejecting every mutating Gitea `/git/*` request.
- Gitea file create, update and delete now use `/contents/{filepath}` on a disposable branch created from the exact expected head.
- The target branch moves only through Gitea's non-forced `old_commit_id`/`new_commit_id` compare-and-swap, followed by head verification and disposable-branch cleanup.
- A stale preflight head performs no provider write. A post-preflight compare-and-swap conflict returns `BRANCH_CHANGED`, does not retry the target write and cleans the disposable branch.
- Normalized Gitea governance scopes can be normalized again, preserving warn-mode policy-evaluation fallback before provider transport.
- GitHub's Git Data mutation path and GitLab's Repository Files mutation path remain unchanged.
- No provider credential, database migration or runtime dependency changed.

## Source verification

- The complete default `npm test` lifecycle passed all 93 top-level test programs, including the four-build deterministic packaging regression and the Gitea create, delete, stale-head, compare-and-swap race and real-server regressions.
- `npm run check:syntax`: passed, including the provider adapter and Gitea server fixture.
- `node scripts/verify.js`: passed.
- `npm run check:secrets`: passed.
- `npm audit --omit=dev --audit-level=high`: passed with zero vulnerabilities.
- The full high-severity audit reports only the documented four-entry development chain with no available fix.

The local Work Mode runtime is Node.js 24 while the project declares Node.js 22.x. The install emitted the expected engine warning. Node.js 22 verification remains a required CI condition and is not inferred from the local run.

## Dependency boundary

- `npm audit --omit=dev --audit-level=high`: zero production vulnerabilities.
- The full audit reports four high-severity package entries on one development-only chain: `archiver → readdir-glob → minimatch → brace-expansion`.
- The applicable advisory is `GHSA-mh99-v99m-4gvg`.
- npm reports no available fix.
- The release packager uses an explicit recursively collected file list and appends exact bytes; it does not invoke the affected glob traversal with user-controlled patterns.

This is a bounded reachability classification, not an advisory waiver. The lockfile is unchanged except for the project version, and the chain remains tracked for a supported dependency update.

## Deterministic archive proof

The first double build exposed nondeterministic ZIP entry ordering even though extracted payload bytes were identical. A four-build regression reproduced four distinct archive digests before the fix.

The packager now appends the already sorted file bytes in sequence while preserving normalized paths, modes and timestamps. The four-build byte-identity regression passes and is part of the default test suite. Final candidate digest, file count, safety inspection and fresh-extraction verification are recorded only after the source freeze.

## Remaining release gates

1. Run the complete default suite, syntax, build, secret and production-audit gates from the frozen alpha.16.3 source.
2. Build alpha.16.3 twice from the frozen source and require byte-identical archives.
3. Verify the archive and checksum structurally and from a fresh extraction.
4. Publish the immutable candidate on an isolated alpha.16.3 branch.
5. Run the candidate/runtime matrix under Node.js 22.
6. Re-execute the live Gitea compatibility procedure against alpha.16.3 and verify disposable-branch cleanup.
7. Preserve both existing PRs as draft/unmerged, keep `main` unchanged and retain alpha.16.1 and alpha.16.2 byte-for-byte.
