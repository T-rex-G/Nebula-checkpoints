# Alpha.17 Qualification Evidence Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Goal:** Correct the alpha.17 qualification path so a pass is earned only by the exact packaged candidate and semantically bound evidence for the exact claim and execution context.

**Architecture:** Keep the existing qualification catalog and live-provider clients. Add one archive-bound candidate runner, one small evidence-envelope validator, precise provider claim mappings, a tracked-text secret scanner, and an immutable continuity record. The workflow consumes those components with fixed runtime/action versions and a stable live concurrency group.

**Tech Stack:** Node.js 22.23.1, CommonJS, `node:assert`, GitHub Actions, Playwright, npm, ZIP archives, canonical JSON and SHA-256.

## Global constraints

- Work only in the isolated correction worktree based on published tree `673737fc9a51aeffd54e068d5148de061fb559b2`.
- Do not dispatch a workflow, contact live provider targets, open a pull request, merge, deploy, or change `main`.
- Add a failing regression before each behavior change and capture the expected failure.
- Keep all evidence free of credentials, raw repository names, branch names, session data, and authenticated URLs.
- Treat a single GitHub live run as provider-stage evidence, never as whole-public-alpha approval.
- Use `apply_patch` for source edits and run `git diff --check` after every task.

## Task 1: Prove execution inside the packaged candidate

**Files:**

- Create: `scripts/qualify-candidate-archive.js`
- Create: `test/qualify-candidate-archive.test.js`
- Modify: `.github/workflows/public-alpha-alpha17.yml`
- Modify: `test/public-alpha-workflow-contract.test.js`
- Modify: `test/package-contract.test.js`
- Modify: `scripts/verify.js`
- Modify: `package.json`

**Red:** Add a synthetic ZIP test that contains a minimal package lock and candidate-owned `scripts/test-matrix.js`. Assert the runner verifies the expected SHA-256 before extraction, rejects traversal/multiple roots, performs `npm ci` in the extracted root, invokes the candidate-owned matrix with `--require-all --require-subject`, and accepts only a report whose `subjectHash` is the archive hash and whose failed/blocked counts are zero. Add a wrong-hash case that proves no candidate command ran. Run:

```bash
node test/qualify-candidate-archive.test.js
node test/public-alpha-workflow-contract.test.js
```

Both must fail because the runner and workflow contract do not exist yet.

**Green:** Implement strict absolute-path CLI parsing, streamed SHA-256, bounded safe ZIP inventory validation, single-root extraction, candidate-root `npm ci`, and candidate-root syntax, secret, audit, runtime-matrix, and Playwright execution. The workflow builds twice, compares bytes, then calls the runner with archive A, archive B, expected digest, extraction directory, source commit, origin ID, and report outputs; it no longer runs the public-alpha matrix from checkout. Preserve the raw reports and emit a schema-1.1 automated evidence envelope containing every automated claim.

**Verify:** Run the two focused tests plus `node --check scripts/qualify-candidate-archive.js` and `git diff --check`.

## Task 2: Bind every qualification entry to parsed claim evidence

**Files:**

- Create: `src/qualification-evidence.js`
- Create: `test/helpers/public-alpha-pass-fixture.js`
- Modify: `src/public-alpha-qualification.js`
- Modify: `scripts/public-alpha-gate.js`
- Modify: `test/public-alpha-qualification.test.js`
- Modify: `test/public-alpha-qualification-contract.test.js`
- Modify: `test/public-alpha-gate-cli.test.js`
- Delete: `test/fixtures/public-alpha-qualification-pass.json`
- Modify: `staging/PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json`
- Modify: `test/package-contract.test.js`
- Modify: `scripts/verify.js`

**Red:** Build a valid record and category-specific artifact envelopes in the test helper. Add rejections for a boolean-only verifier, malformed JSON envelope, wrong subject, wrong source commit, wrong artifact type, wrong provider, absent exact claim, claim timestamp mismatch, claim status mismatch, unverified cleanup, invalid origin ID, and invalid provider target hash. The CLI test must write real JSON artifacts and prove an unrelated hash-correct JSON file cannot authorize a claim. Run the three focused tests and capture their failures.

**Green:** Bump the qualification/evidence schema to `1.1.0`. Validate and deeply freeze JSON envelopes. Change the CLI artifact verifier to hash, parse, and return a bounded envelope. Index verified envelopes by artifact ID. For every evidence entry, require an exact `claims[label]` record and match subject, source commit, category type, provider context, pass state, timestamp, and cleanup. Reject legacy `true` return values.

**Verify:** Run the three focused tests, `node --check` for both source files, and `git diff --check`.

## Task 3: Make live harnesses emit only proven claims

**Files:**

- Modify: `ci/provider-alpha17-common.js`
- Modify: `ci/run-hosted-alpha17-validation.js`
- Modify: `test/alpha17-provider-harness.test.js`
- Modify: `test/alpha17-hosted-harness.test.js`

**Red:** Assert exact provider capability arrays: six GitHub claims and five GitLab/Gitea claims. Assert `live-events`, pull-request, webhook, authentication, rate-limit, and other unexecuted capabilities are absent. Require named repository/default-branch/write/read/delete/cleanup checks and a `provider-live` envelope with exact claim labels, origin ID, provider, signed target hash, candidate hash, source commit, and claim-level timestamps/cleanup. Require the hosted harness to emit all and only `hosted.<key>` claims in a `hosted-live` envelope.

**Green:** Replace registry-wide `providerCapabilities` with an immutable prerequisite map. Record each real lifecycle operation as a named check, derive claims only after all prerequisites pass, and keep cleanup fail-closed. Convert hosted output to the same envelope contract while preserving its signed operational-record validation.

**Verify:** Run both harness tests, relevant syntax checks, and `git diff --check`.

## Task 4: Serialize live runs and pin the workflow

**Files:**

- Modify: `.github/workflows/public-alpha-alpha17.yml`
- Modify: `test/public-alpha-workflow-contract.test.js`
- Create: `.nvmrc`
- Modify: `package.json`
- Modify: `test/release-contract.test.js`

**Red:** Require a live-shared concurrency key with no `github.run_id`, `cancel-in-progress: false`, runner `ubuntu-24.04`, Node `22.23.1`, full commit-SHA action pins, and `resume-work --require-clean`. Require `.nvmrc` and `package.json.engines.node` to identify the same exact runtime. Run the workflow and release contract tests; they must fail on the mutable published selectors.

**Green:** Pin the current v4 commits:

- checkout `11d5960a326750d5838078e36cf38b85af677262`
- setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`
- upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`
- download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093`

Use a PR-specific group for pull requests and one stable group for every workflow-dispatch run. Pin Node and runner everywhere without weakening permissions or target authorization.

**Verify:** Run focused contracts, parse the workflow with the existing test, and run `git diff --check`.

## Task 5: Replace stale continuity narration with immutable facts

**Files:**

- Modify: `WORK_CONTINUITY.json`
- Modify: `scripts/resume-work.js`
- Modify: `test/work-continuity.test.js`

**Red:** Require schema 2, immutable baseline commit `315a88406487117fe32449e59eb3dfce4067b444`, parent `7f721a770df8e658e00163e05ebc259502f99c09`, tree `673737fc9a51aeffd54e068d5148de061fb559b2`, and candidate hash `6d29b357eca034afa413940f07d27352889c4a619be9483fc00a78d08da8b72d`. Reject self-referential `lastPushedCommit`, `lastPushedSourceCommit`, and pending-publication fields. Add a disposable-repository test where `--require-clean` rejects a dirty tree but ordinary resume still reports it. Preserve archive/no-Git behavior and detached-HEAD ancestry proof.

**Green:** Reduce continuity state to immutable baseline, known failed runs, stable limitations, and a current-head next action. Make CLI parsing explicit and make `--require-clean` fail when Git exists and the worktree is dirty. Derive branch, HEAD, and cleanliness at runtime.

**Verify:** Run `node test/work-continuity.test.js`, JSON-parse the continuity file, and run `git diff --check`.

## Task 6: Scan every releasable text file for credentials

**Files:**

- Create: `src/secret-scanner.js`
- Create: `test/secret-scanner.test.js`
- Modify: `scripts/check-secrets.js`
- Modify: `test/package-contract.test.js`
- Modify: `scripts/verify.js`

**Red:** In temporary fixtures, prove detection in extensionless and Markdown files for private keys, GitHub tokens, stable GitLab prefixes, AWS keys, Slack tokens, credential-bearing URLs, and contextual npm/Gitea/Neon/OAuth assignments. Prove binary content and harmless environment-variable names are skipped, and findings never echo secret values.

**Green:** Discover tracked files with `git ls-files -z`, falling back to a bounded recursive archive walk when Git is unavailable. Skip symlinks, non-files, excluded generated directories, oversized files, and NUL-containing binaries. Scan decoded text with named patterns and return only relative path plus rule ID. Keep the CLI fail-closed on discovery/read errors.

**Verify:** Run the scanner test, then `node scripts/check-secrets.js`, syntax checks, and `git diff --check`.

## Task 7: Integrate, clean-install, refreeze, and decide

**Files:**

- Modify as required by contract failures only; no unrelated refactor.
- Produce outside the repository: corrected deterministic ZIP, checksum, extracted-matrix report, and verification summary.

**Integration:** Update package/verification inventories for every new tracked file. Run all focused tests from Tasks 1–6, then the full required matrix with exact Node `22.23.1`. Run syntax, secret scanning, production audit, development audit classification, and `git diff --check`.

**Clean-room verification:** From a fresh `npm ci` using a writable temporary cache, package twice to separate external directories, compare the archives byte-for-byte, validate the checksum, and run the candidate archive qualifier against the exact archive. Confirm the source worktree has no untracked releasable files and review `git diff --stat`, `git diff`, and the final commit range.

**Freeze:** Commit the correction locally with no remote write. Build the final archive from that immutable commit, record its SHA-256 and source commit, and rerun the archive qualifier so the frozen hash is the tested subject.

**Decision:**

- issue **NO-GO** if any required check fails or any evidence bypass remains;
- issue **GO for one serialized provider-stage dispatch** only if all local checks and the frozen archive qualification pass;
- do not claim public-alpha GO until all automated, provider, hosted, and manual entries have fresh semantically bound artifacts and the final gate returns GO.
