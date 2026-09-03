# Alpha.17 Qualification Evidence Integrity Design

## Goal

Make the alpha.17 qualification pipeline fail closed unless every reported pass is tied to the exact packaged candidate, the exact qualification claim, the exact execution context, and verified cleanup. The corrected pipeline must remain safe to inspect and package locally without dispatching a live workflow or changing `main`.

## Release decision

The current branch is not eligible for a live qualification dispatch until this design is implemented and the corrected archive passes clean local verification. A GitHub provider run can establish only the GitHub transport claims it actually exercises; it cannot by itself authorize the whole public alpha.

## Non-goals

- No production deployment, merge, pull request, or change to `main`.
- No live-provider mutation during implementation or local verification.
- No claim that GitLab, Gitea, hosted, manual, or full-product behavior passed when those checks did not run.
- No redesign of the application or provider capability registry.
- No general-purpose attestation framework beyond the alpha.17 qualification boundary.

## Root causes

The published workflow extracts the release archive but runs the automated matrix from the source checkout. The provider harness then labels every registry-supported provider capability as proven even though it exercises only a small repository/branch/file lifecycle. Finally, the gate verifies artifact hashes without parsing the artifact or proving that it contains the claim it backs. A valid but unrelated file can therefore satisfy many evidence entries.

The workflow also uses a run-unique concurrency key, so destructive live runs do not serialize. Its continuity record contains publication narration that becomes stale as soon as a new commit is created. The secret scanner is extension- and pattern-limited, and runtime/action selectors are mutable.

## Candidate execution boundary

The archive is the qualification subject. A dedicated candidate runner will:

1. accept the archive path, expected SHA-256, extraction directory, and matrix report path;
2. verify the archive hash before extraction;
3. reject unsafe or ambiguous archive layouts;
4. extract exactly one candidate root;
5. install from that root with `npm ci`;
6. run syntax, secret, dependency-audit, runtime-matrix, and Playwright gates from that root;
7. verify that the matrix report names the expected archive hash as its subject; and
8. emit the schema-1.1 automated evidence envelope from those exact-candidate results.

The GitHub Actions workflow will call this runner instead of executing the matrix from the checkout. A behavioral regression test will build a synthetic archive whose matrix and browser scripts record their execution, proving the runner and automated envelope belong to the extracted subject.

## Evidence envelope

Qualification artifacts are JSON objects with schema version `1.1.0`. Every artifact contains:

- `artifactType`: `automated`, `provider-live`, `hosted-live`, or `manual`;
- `subjectSha256`: the packaged candidate SHA-256;
- `sourceCommit`: the immutable source commit used to build it;
- `originId`: a workflow run identifier or explicit local/manual origin;
- `completedAt`: an ISO-8601 completion time;
- `cleanupVerified`: whether all artifact-level cleanup completed;
- `claims`: an object keyed by the exact qualification label.

Each claim contains `status`, `completedAt`, and `cleanupVerified`. Provider-live artifacts additionally contain `provider` and `authorizedTargetSha256`; hosted artifacts contain a deployment fingerprint. Secret values and raw target identifiers are forbidden.

The qualification document uses exact labels:

- `automated.<check>`
- `providers.<provider>.<capability>`
- `hosted.<check>`
- `manual.<check>`

An artifact may support several entries only when its parsed `claims` object explicitly contains every corresponding label. A hash match alone is insufficient.

## Gate verification

The artifact verifier will read a regular JSON file, confirm its SHA-256, parse its envelope, and return the validated object. The qualification evaluator will reject an entry unless all of these match:

- artifact ID and digest;
- qualification subject hash;
- source commit and origin/run identity;
- exact evidence label;
- claim status, timestamp, and cleanup state;
- artifact type appropriate to the evidence category;
- provider and authorized-target fingerprint for provider evidence.

Missing, malformed, stale, blocked, failed, uncleaned, context-mismatched, or unclaimed evidence keeps the gate closed. Legacy boolean artifact verification is rejected to prevent accidental fallback to hash-only behavior.

## Provider claim boundary

The common provider harness will record named checks rather than synthesize all supported capabilities. The lifecycle checks are:

- repository read;
- default-branch read;
- disposable-branch creation;
- expected-head write;
- UTF-8 readback;
- stale-head rejection;
- read-only authorization denial;
- expected-head delete; and
- cleanup absence.

Those checks may prove only the following registry capabilities:

| Provider | Claims emitted after all prerequisites pass |
| --- | --- |
| GitHub | `repository.read`, `branches.read`, `branches.write`, `file.read`, `file.write`, `file.delete` |
| GitLab | `repository.read`, `branches.read`, `file.read`, `file.write`, `file.delete` |
| Gitea | `repository.read`, `branches.read`, `file.read`, `file.write`, `file.delete` |

GitLab and Gitea `branches.write` remain unclaimed because their capability registry marks that feature unavailable. Pull requests, webhooks, event normalization, retry/rate-limit behavior, authentication modes, transport error mapping, governance, and UI behavior are not emitted by this harness.

## Live safety and reproducibility

All workflow-dispatch live jobs share one stable concurrency group and keep `cancel-in-progress: false`. Pull-request automated runs use a PR-specific non-live group. The live target authorization hash remains mandatory, and cleanup is required even after a failed mutation.

The workflow will pin:

- Node.js `22.23.1`;
- runner image `ubuntu-24.04`; and
- the current full commit SHA of each first-party GitHub Action, with its major version documented in a comment.

This removes mutable selectors from the release path while retaining readable provenance.

## Continuity contract

`WORK_CONTINUITY.json` records the immutable published baseline commit/tree and the next qualification action. It does not record a self-referential "last pushed commit" or a pending-publication sentence that a new commit invalidates. `resume-work` derives the current HEAD from Git, proves the required baseline ancestry, validates the worktree, and supports a fail-closed `--require-clean` mode used by CI.

## Secret scanning

The scanner will inspect every tracked releasable text file rather than a fixed extension list. It will retain existing PEM/GitHub/AWS/Slack checks, add stable GitLab token prefixes and credential-bearing URL checks, and add contextual assignment checks for providers without a reliable global prefix. Binary files are skipped; findings include only file and rule identity, never the secret value. Tests use temporary untracked fixtures.

## Testing strategy

Each correction starts with a regression test that fails for the published tree:

1. synthetic archive execution proves candidate-root isolation and hash fail-closed behavior;
2. provider harness tests reject capability overclaiming;
3. evidence tests reject unrelated, wrong-subject, wrong-provider, wrong-run, and missing-claim artifacts;
4. workflow contract tests reject run-unique concurrency and mutable runtime/action selectors;
5. continuity tests reject stale narrative fields and dirty CI preflight;
6. scanner tests detect secrets in previously ignored text filenames and contextual formats.

Completion requires focused regressions, syntax checks, the full required test matrix under Node `22.23.1`, a clean install, deterministic packaging, archive-root qualification, secret scanning, and a clean worktree review. No live run is part of local completion.

## Handoff states

- **NO-GO:** any local verification fails, the corrected archive is not deterministic, evidence binding can be bypassed, or the worktree/archive is not clean and reproducible.
- **GO for provider-stage dispatch:** all local checks pass and the exact corrected archive hash/commit are frozen. This permits one serialized, authorized live-provider run only.
- **GO for public alpha:** every required automated, provider, hosted, and manual claim has fresh semantically bound evidence and the final qualification gate passes. A single provider-stage run is not this state.
