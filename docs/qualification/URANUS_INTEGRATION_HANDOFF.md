# Uranus integration handoff

## Integration target and revisions

The review vehicle is draft PR #84 on `codex/uranus-enterprise-evidence`. It targets `claude/failed-ci-pr-merge-399ykp`, the head branch of PR #82. The parent at qualification was `3475d70e452165d7f69f72d7ad18c535640200e2`. The 2.5 starting checkpoint was `61654dfc588a972ed4e88fcf9652aabcf7cb2586`. **The final combined product commit is `96ba4641da016190a7957e2dffa68906bf118d86`.** Its engine is 3.0.0 and its detector fingerprint is `07fa4da9fc33ce964763a62eacbd76a3790b0464d23b67877bd17a3f1128673c`. Subsequent commits contain the evaluation tools, evidence and this handoff. The draft PR description and reviewer's downloadable handoff pin the exact final review SHA. Git assigns the enclosing commit its ID after hashing the document. [Draft PR #84](https://github.com/T-rex-G/Nebula-checkpoints/pull/84) · [Parent PR #82](https://github.com/T-rex-G/Nebula-checkpoints/pull/82)

| Order | Commit | Purpose |
|---:|---|---|
| 1 | `a99f1e1b4b6cf4279645b49fc7296c8583d71f3c` | Make Uranus findings, coverage and fix history verifiable |
| 2 | `28c6c1f38858623a6ba11c1d8214c7faf5acb5b4` | Bind base comparisons to the PR commit and record Uranus qualification |
| 3 | `a629d11efef2a350475094711770c2d8b0aca42c` | Register the audit path contract and qualification record |
| 4 | `61654dfc588a972ed4e88fcf9652aabcf7cb2586` | Check evidence completeness in the kept-audit browser flow |
| 5 | `2f7611fd3b51cec093f890d0757329e7b7f201d3` | Keep the qualification record focused on measured engine behavior |
| 6 | `ea58464b62a1e100f618f354ba36ae8fdf37f965` | Measure frontend costs and record the bounded semantic analysis design |
| 7 | `7814ccf1a5b21a1df971dbcb99afa4c2abc5f111` | Add pinned offline framework and DOM-policy evaluations |
| 8 | `b761f86a8917e6b9144be6e09ac6fb8799a67914` | Resolve JavaScript sanitizer calls before granting a context guarantee |
| 9 | `84af40949bec27c822800be0b9eb1364d660b09d` | Export and verify scoped retained-audit coverage |
| 10 | `96ba4641da016190a7957e2dffa68906bf118d86` | Keep the member-chain reader with the token shapes it parses |
| 11 | `78e2869504d5c843921d00a6b73b98e082ddec2e` | Make the repository benchmark replayable from pinned Git blobs |
| 12 | `ad9a3bdf4ec94edb669469f5704b7ceca7da514d` | Record independent accuracy, coverage limits and verification results |
| 13 | `b15889808db4299f32a8c7b4d758394ccd8f1e30` | Hand off the qualified Uranus stack for migration review |
| 14 | `9442215ba3fd6c27453d7d0a105cdc62f2ee0949` | Exercise the framework scorer in the existing offline benchmark gate |
| 15 | `09f2777799104a137a49ef8f54242d696cb635d0` | Pin the integration handoff to the verified product fingerprint |
| 16 | Enclosing handoff commit | Consolidates independent scorer tests in the registered gate and records these instructions. |

```sh
git log -1 --format=%H -- docs/qualification/URANUS_INTEGRATION_HANDOFF.md
git rev-parse HEAD
git log --reverse --format='%H %s' 3475d70e452165d7f69f72d7ad18c535640200e2..HEAD
git diff --name-status 3475d70e452165d7f69f72d7ad18c535640200e2..HEAD
```

## What reaches the parent

| Area | Files and integration responsibility |
|---|---|
| Detector | In `apps/api/src/modules/uranus/domain/`, `uranus-shape.ts` supplies binding identity, writes and member chains, `uranus-scope.ts` tracks values and guards, `uranus-sanitise.ts` supplies context-specific guarantees and `uranus-flow.ts` applies them to calls and summaries. `audit-findings.ts`, `audit-catalog.ts` and `uranus-ruleset.ts` carry the blocker, version and fingerprint. |
| API and persistence | `application/coverage-proof.ts` creates and checks receipts, `application/kept-coverage.ts` shares the existing completeness predicate with `application/merge-gate.ts`, `http/code-audit-routes.ts` serves the opt-in representation and `persistence/audit-history-store.ts` reads a repository- and actor-scoped summary. These paths live under the Uranus module. |
| Contracts and offline client | `packages/contracts/src/audit-coverage-proof.ts` defines version 1, `packages/contracts/src/codes.ts` registers the invalid-proof-kind error, and `scripts/uranus-verify-coverage.js` is the Node verifier. |
| Validation | The code-audit history and route tests, coverage-proof helper and two contract oracles exercise the export. The JavaScript, C-family and benchmark tests, ID oracle, path-basename fixture, audit UI check and two browser specs pin the detector change. Scripts under `scripts/uranus-*`, the framework test and scoring protocol, and the standard npm unit command reproduce the evaluation. |
| Documentation and evidence | The documentation manifest, 2.5 qualification record, semantic architecture decision, 3.0 qualification, measurement JSON, qualification index and this handoff document the stack. |

Use the `git diff --name-status` command above for the full file list including 2.5. For just the mission's code and evidence, substitute `61654dfc588a972ed4e88fcf9652aabcf7cb2586` as the starting revision. The existing 2.5 commits also touch the React audit screen, legacy adapter, advisory client and database migration. The 3.0 production change is confined to the API and contracts.

**Database order.** Apply the inherited additive `033_code_audit_ruleset_digest.sql` before running the stack against an existing database. It adds nullable provenance. Preserve nulls on old rows. The previous application can read the extended schema. The runtime version module imports the root package manifest. Even a change to its npm scripts participates in the detector fingerprint. The existing registered offline benchmark test program contains both scoring suites. The package inventory gate checks that every top-level test program is registered. This arrangement preserves the qualified manifest and digest. 3.0 requires no further migration, backfill, dependency installation beyond the existing lockfile, service credentials, signing key, new GitHub App permission or feature flag. The existing history capability must be available for an export. The comparison tools use the existing TypeScript 5.9.3 Apache-2.0 development dependency. Corpus licenses and pins are in qualification. [Migration 033](../../db/migrations/033_code_audit_ruleset_digest.sql) · [Qualification](URANUS_3_0.md)

**Retained proof contract.** `GET /api/repo/:owner/:repo/code-audit/history/:auditId?proof=coverage` returns canonical JSON and the `X-Uranus-Coverage-Digest` header. Existing session, repository access, capability and governance reader checks precede the scoped summary query. A different identity or repository cannot read the row. Responses use `no-store`. The history detail representation without the query retains its shape. Unknown proof kinds return HTTP 400. The verifier bounds input to 8 KiB and checks the expected repository, commit, ruleset, decision and separately trusted digest. Exit 0 denotes complete recorded coverage, 2 incomplete or unrecorded, and 1 invalid. A missing historical ruleset cannot earn a complete decision. No source, raw paths, findings or user identity enter the receipt. Treat the scope digest as a correlatable identifier. [Wire contract](../../packages/contracts/src/audit-coverage-proof.ts) · [Verification and trust assumptions](URANUS_3_0.md)

**Decision boundaries.** A review blocker records uncertainty at a specific source location. Retain confirmed findings when other parts of an audit are incomplete. Branch policy and merge enforcement stay with Kepler. Fix credit still requires comparable evidence, matching detectors and the correct base/head revisions. A receipt says what the stored audit covered at that time. A recipient needs independent provenance for its digest and new expectations for a later revision. Advisory currency, deployed reachability, verified repair and authorization to merge require separate evidence.

## Integration procedure

1. Fetch the two reviewed branch tips into your trusted clone. Record their SHA values, confirm #84 still targets the parent development line and compare them with this handoff and the draft PR. Work in a disposable integration branch or worktree based on the settled migration.
2. Run `git merge-tree --write-tree <parent-head> <reviewed-84-head>`. At the recorded parent the combined product and qualification commits are descendants and the simulated merge was clean. Repeat with the completed migration and use ordinary reviewed integration. The parent branch owner controls the actual merge.
3. If the migration moved files, keep its current module boundaries. Reattach the proof to the existing guarded history-detail route, preserve its default representation, and keep both repository and actor scope in the SQL predicate. Keep the shared completeness predicate aligned with the gate. Preserve frontend behavior and the historic fixture/oracle rows.
4. Resolve conflicts in version labels, contract oracles and the documentation manifest by preserving both reviewed additions. For detector imports or analysis-source changes, regenerate the ruleset with `node scripts/uranus-ruleset.js --write` and review the new digest. Compare finding IDs and verdicts explicitly before accepting any oracle change. A new digest starts a new evidence epoch and changes fix comparability.
5. Install dependencies in the trusted project with the version in `.nvmrc`. Run the following on the integrated result. Set `NV_TEST_DATABASE_URL` to a disposable PostgreSQL 17 instance with test-database creation rights for the two database commands. Browser checks use Playwright Chromium and the repository's local test server.

```sh
npm ci
npm run typecheck
npm run lint
npm run build:server:check
npm run build:web:check
npm run docs:check
npm test
node test/architecture-oracles.test.js
node scripts/uranus-ruleset.js
node test/uranus-finding-ids.test.js
node test/uranus-owasp-benchmark.test.js
node test/uranus-code-audit-routes.test.js
npm run test:migrations
npm run test:code-audit-history
npm run test:e2e -- test/e2e/code-audit.spec.js test/e2e/code-audit-history.spec.js test/e2e/code-audit-polyglot.spec.js
```

6. Replay the pinned external suites with the commands in the qualification record. Expect 262 IDs in 337 internal cases, 208/208 expected findings, 17 extras, and the recorded independent confusion matrices. Check that incomplete coverage still blocks a clean observation and that a legacy proof exits 2, a tampered or mismatched proof exits 1 and an anchored complete proof exits 0. Compare the published automation against the exact draft head or its PR merge ref. [Independent assays and controls](URANUS_3_0.md)

## Rollback and open risks

Before integration, the draft remains isolated. After integration, a forward revert of the reviewed integration reinstates the parent's application. For a targeted rollback to 2.5, revert the 3.0 changes in reverse dependency order, including the final parser move, proof export, detector and related qualification assertions. Retain the nullable 033 column and historic evidence. Restore the actual digest corresponding to the restored detector source. Historical scans retain their original engine and digest. Missing evidence or differences across detector epochs cannot award fix credit. Verify the normal history response, authorization matrix and digest before resuming automated decisions.

The scoped proof has no signature, key rotation, revocation or deployed-state evidence. The JS/TS tracer is still bounded, dynamic and cross-module mutations can escape the binding model, and Python/C-family guarantees retain their earlier limitations. The new DOM cohort reached 10% recall and yielded zero confirmed positives. Owner decisions on signing, broader access, deployment signals or repair attestation can be made separately after their trust and data requirements have been tested. [Architecture decision and roadmap](../architecture/URANUS_SEMANTIC_EVIDENCE.md)
