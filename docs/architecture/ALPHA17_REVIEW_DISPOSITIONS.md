# Alpha.17 Independent Review Dispositions

Latest review: `4ae300c4-410c-4ae7-89cc-b7e15767d22e`

Public alpha: **NO-GO**

The latest review failed with **15 actionable findings and 10 nitpicks**. GitHub
materialized 13 actionable inline threads and one outside-diff deployment-guide
action; the review body also reports failed inline posting and two failed-to-post
immutable-history linter suggestions, so the raw count is retained without
inventing a one-to-one mapping GitHub did not expose. This successor remediates
every materialized current-code finding and the applicable nitpicks. It does not
qualify its own bytes; the exact successor candidate and a new follow-up review
remain external release evidence.

The preceding review, `04b93d36-47ea-402d-abda-ca6dfb2a9290`, failed with **30
actionable findings and 9 nitpicks**. Its 18-action inline review, 10
summary-only minor findings, and 2 major failed-post findings remain preserved
in the detailed inventory below.

Immutable historical plans under `docs/history/` were not rewritten. Where a
review comment targeted a historical statement, the current executable
boundary was verified or strengthened and the disposition is explicit below.

## Latest-review remediation boundary

| Finding cluster | Disposition |
|---|---|
| Restore identity and destructive ordering | Applied: the runner binds the control-plane result to the configured target and rejects identical/mismatched infrastructure before backup or restore. |
| Evidence file reads and command liveness | Applied: evidence/artifact limits are enforced on the opened descriptor and every qualifier child has a finite command-specific timeout. |
| Live target, deployment, and operator trust | Applied: external target/deployment bindings are mandatory and the hosted Ed25519 signature is verified against a separately trusted key. |
| Browser identity isolation | Applied: offline identity is tab-scoped and a real multi-tab test proves the active tab survives while the sibling purges and reloads. |
| Historical-document integrity | Applied without rewriting history: the manifest references a SHA-256 baseline covering every immutable historical Markdown file. |
| Restore and deployment operations | Applied: preview and destructive restore blocks are separate; invite mode, independent pepper, terms, and explicit PostgreSQL CA requirements are documented and tested. |
| Test isolation and contract precision | Applied: continuity drift occurs only in a temporary copy; reflow terms, provider Authorization absence, governance inventories, UI attributes, and curl probes are checked independently. |
| Immutable-history wording suggestions | Superseded by integrity policy: no historical checkpoint bytes were rewritten; current architecture/runtime controls remain authoritative. |

## Previous raw actionable inventory

### Inline review — 18 actions across 15 GitHub threads

| Thread | Review target | Finding cluster |
|---|---|---|
| `PRRT_kwDOTyfRYc6YS8M0` | `ci/provider-alpha17-common.js` | Provider claims exceed the live proof contract → R3-A2. |
| `PRRT_kwDOTyfRYc6YS8M8` | Immutable hosted-alpha design | Credential-bearing HTTPS/redirect policy → R3-A3. |
| `PRRT_kwDOTyfRYc6YS8NA` | Credential-exposure runbook | Provider-issued application credentials → R3-A16. |
| `PRRT_kwDOTyfRYc6YS8NF` | Failed-deploy runbook | Fail-fast containment and restore-target verification → R3-A16. |
| `PRRT_kwDOTyfRYc6YS8NP` | Tester revocation runbook | Fail-fast revocation → R3-A16. |
| `PRRT_kwDOTyfRYc6YS8NU` | Operator checklist | Fail-fast restore rehearsal → R3-A16. |
| `PRRT_kwDOTyfRYc6YS8Nj` | Security deployment guide | GitHub App credential classification → R3-A16. |
| `PRRT_kwDOTyfRYc6YS8No` | Release security gates | Mutation/state-change proof completeness → R3-A2. |
| `PRRT_kwDOTyfRYc6YS8Nx` | Release security gates | Workflow-executed restore proof → R3-A7. |
| `PRRT_kwDOTyfRYc6YS8N4` | Qualification integrity plan | Credential/network isolation and candidate-report trust → R3-A5. |
| `PRRT_kwDOTyfRYc6YS8OC` | `scripts/alpha-db.js` | Certificate-verifying PostgreSQL TLS → R3-A6. |
| `PRRT_kwDOTyfRYc6YS8ON` | `scripts/alpha-db.js` | Role/TLS-bound restore fingerprint → R3-A6. |
| `PRRT_kwDOTyfRYc6YS8OU` | `src/qualification-evidence.js` | Prototype-mutating JSON keys → R3-A1. |
| `PRRT_kwDOTyfRYc6YS8Oh` | Workflow contract test | Digest-pinned Docker actions → R3-A14. |
| `PRRT_kwDOTyfRYc6YS8Oj` | Continuity test | Full baseline ancestry in CI → R3-A14. |

### Summary-only minor findings — 10

| ID | Finding | Disposition cluster |
|---|---|---|
| R3-M1 | Pin the complete independent-review evidence object. | R3-A17. |
| R3-M2 | Replace constant emergency-manifest `signatureValid` with actual verification. | R3-A12. |
| R3-M3 | Clarify the policy-head revision requirement without rewriting history. | R3-A8 and R3-N4. |
| R3-M4 | Define the account/session/repository cache-isolation contract. | R3-A4. |
| R3-M5 | Record the existing webhook redirect policy without rewriting Task 19. | R3-A3. |
| R3-M6 | Define webhook receiver replay handling. | R3-A18 and R3-N6. |
| R3-M7 | Make the capacity runbook stop on the first failed verification. | R3-A16. |
| R3-M8 | Align UX vision with the actual 320 CSS-pixel reflow gate. | R3-A15. |
| R3-M9 | Align automated accessibility qualification with 320 CSS pixels/400% zoom. | R3-A15. |
| R3-M10 | Document every `restore-target` environment prerequisite. | R3-A16. |

### Major findings GitHub failed to post inline — 2

| ID | Finding | Disposition cluster |
|---|---|---|
| R3-F1 | Make idempotency reservation mandatory before Task 11 activation or rollback store access. | R3-A8. |
| R3-F2 | Fail closed for unsupported active policy rules. | R3-A9. |

| ID | Disposition | Remediation and verification boundary |
|---|---|---|
| R3-A1 | Applied | Qualification JSON cloning rejects `__proto__`, `constructor`, and `prototype`; focused evidence and record tests cover each key. |
| R3-A2 | Applied | Every registry entry marked `Provider-verified` now belongs to the 16-capability live proof contract; implemented but unexercised paths are `Experimental` + `Inferred`. Envelopes require ten exact ordered state-change/cleanup checks. |
| R3-A3 | Applied | Provider API, OAuth, LFS, webhook, and archive requests reject redirects; the sole GitHub codeload hop is exact-origin/repository/path validated and credential-free. |
| R3-A4 | Applied | Offline caching requires a server-recomputed session/account/repository response echo, service-worker exact-match validation, and cross-tab identity purge/reload. |
| R3-A5 | Applied with explicit residual | Exact-archive qualification strips ambient credentials/options, isolates process homes/caches, disables install hooks, invokes the reviewed vendor copy explicitly, and rejects post-test matrix tampering. It remains credential-minimized candidate self-qualification, not an OS egress sandbox or independent hostile-code verifier; exact-byte independent review is mandatory before any live credential dispatch. |
| R3-A6 | Applied | Restore source/target URLs require explicit `sslmode=verify-full`; the v2 fingerprint includes host, port, database, role, TLS mode, pool state, project, branch, and kind. |
| R3-A7 | Applied | The hosted workflow itself creates a fresh encrypted backup, verifies the isolated Neon target, restores it, verifies migration/data smoke, erases backup material, and emits a bounded runner restore attestation. Operator-signed evidence covers only the remaining operator-observed checks and cannot claim the workflow-executed restore. |
| R3-A8 | Applied | Activation and rollback require a bounded `Idempotency-Key` before any governance-store read, with zero-store-access regressions. |
| R3-A9 | Applied | Any unsupported active rule throws an evaluator failure and blocks ordinary mutations before provider transport regardless of the general warn/block setting; the separately authorized governance recovery path remains non-blocking. |
| R3-A10 | Applied | The production HTTPS webhook sender has direct redirect-terminal regression coverage using its injected transport boundary. |
| R3-A11 | Applied | Snapshot configuration rejects reuse of the active key ID in retired keys; signature parsing derives from the shared version/algorithm constants. |
| R3-A12 | Applied | Emergency-manifest responses are produced only after verifying the freshly created signature through the configured keyring. |
| R3-A13 | Applied | Non-Git archive scanning has an explicit maximum directory depth and tests for both bounded traversal and excluded metadata/dependency/build roots. |
| R3-A14 | Applied | CI checkout has full history for continuity; workflow contract tests accept commit-pinned JavaScript actions and require digest-pinned Docker action references. |
| R3-A15 | Applied | Browser reflow automation now exercises an actual 320 CSS-pixel viewport, matching the manual 320 CSS-pixel/400% release requirement. |
| R3-A16 | Applied | Every operator command block is fail-fast; credential exposure names App-secret rotations, and restore documents/validates every required environment and the preview-before-fingerprint sequence. |
| R3-A17 | Applied | That remediation round recorded its complete failed-review object (run ID, 30 actionable, 9 nitpicks); the current continuity record now advances to the latest review. |
| R3-A18 | Applied with explicit residual | Security/architecture truth now states signed hosted-attestation provenance, webhook receiver replay duties, repository-scoped disposable live credentials, and the reviewed-candidate/egress-isolation trust boundary. |
| R3-N1 | Applied | Snapshot signature regex construction no longer duplicates protocol constants. |
| R3-N2 | Applied | Documentation-count assertions report the observed value on failure. |
| R3-N3 | Deferred as candidate-wide change | Node remains exactly locked to `22.23.1`; a runtime uplift must update engines, `.nvmrc`, workflows, contracts, and both source/archive qualification together rather than silently changing remediation bytes. |
| R3-N4 | Superseded, history preserved | ADR-073 records mandatory activation/rollback idempotency; the immutable Task 11 checkpoint remains historical. |
| R3-N5 | Current boundary proved | Every Policy Digital Twin write generates an idempotency key; ADR-073 records the stronger activation/rollback server requirement without rewriting Task 17. |
| R3-N6 | Documented | ADR-076 and the security guide state at-least-once webhook delivery and receiver signature/timestamp/deduplication duties, superseding ambiguous Task 19 wording. |
| R3-N7 | Documented | ADR-075 records the active-set → policy → review → exception → action lock order, superseding ambiguous Task 8 wording. |
| R3-N8 | Current boundary proved | The historical privacy plan is immutable; current runtime and tests reject `description`, repository content, provider payloads, and unsupported fields. |
| R3-N9 | Rejected as weaker design | ADR-072 remains authoritative: the deployed release fingerprint is computed from observed startup bytes, never trusted from circular embedded metadata. |

## Recorded predecessor review

Review: `912555dd-72ab-4662-9645-2313007eea3d`

The predecessor review failed with 16 actionable findings and 8 nitpicks. Its
recorded dispositions remain below because they explain the immutable automated
baseline and are not erased by the latest remediation round.

| ID | Disposition | Remediation and verification boundary |
|---|---|---|
| A1 | Applied | `.env.example` leaves the snapshot key ID empty and retains the sample only as a comment, preventing an empty-secret startup trap. |
| A2 | Applied | Provider delete qualification now proves stale-head rejection with zero commit/file retention, then binds the valid delete result to the observed advanced head and file absence; `test/alpha17-provider-harness.test.js` rejects a forged delete commit. |
| A3 | Current boundary already satisfied | The immutable historical privacy plan remains unchanged. `server.js` and `AlphaPrivacyStore` reject `description` and other unsupported fields; privacy tests cover descriptions, repository content, and provider payloads. |
| A4 | Applied | The credential-exposure runbook requires verified-live-events reconnection and independent webhook-health verification after `SESSION_SECRET` rotation. |
| A5 | Applied | Failed-deploy health and readiness probes use `curl --fail`. |
| A6 | Applied | Snapshot legacy compatibility is staged and verified before `SESSION_SECRET` rotation; reconnection and webhook-health verification follow rotation. |
| A7 | Applied with supersession | Continuity is schema 4, not the stale schema 2/3 narration. It adds exact dual commit/tree identity and the failed independent-review gate. |
| A8 | Applied | The architecture design now names two root Markdown files plus machine-readable `WORK_CONTINUITY.json`. |
| A9 | Applied | Restore preview and destruction require official Neon control-plane URI matches for both declared branches plus a live target database/role session check before decryption or `pg_restore --clean`. |
| A10 | Applied | `resume-work` accepts only the recorded local-source or published commit paired with the accepted tree; an unrelated same-tree ancestor is rejected by test. |
| A11 | Rejected as weaker design | A precomputed digest embedded in the release would be circular/self-attested. ADR-072 reaffirms the ADR-063/067 runtime observation, and the server computes it once at startup. |
| A12 | Applied | Production no longer adds `SESSION_SECRET` implicitly to legacy snapshot verification; only `NV_SNAPSHOT_LEGACY_KEYS_JSON` grants compatibility. |
| A13 | Applied | `test/release-contract.test.js` computes expected release identity once before server spawn and reuses that frozen expectation. |
| A14 | Applied | Capacity verification probes use HTTPS-only `curl --fail`. |
| A15 | Applied | The manual accessibility template records and externally retains start/end `/api/version` responses and requires both runtime fingerprints to equal the frozen candidate. |
| A16 | Applied | Mobile and desktop manual audit entries require 320 CSS-pixel or 400% zoom reflow. |
| N1 | Current boundary proved | ADR-051 already forbids redirects and makes 3xx terminal. The worker regression test proves one transport call and terminal `WEBHOOK_HTTP_302`. |
| N2 | Applied | Restore fingerprint tests cover wrong, short, and non-hex values and fail through the intended validation path. |
| N3 | Applied | Secret-scanner tests cover the non-Git archive walk and excluded metadata/dependency/build directories. |
| N4 | Applied | The pinned Node version is checked at the first line of candidate qualification, before archive reads or extraction. |
| N5 | Applied | Automated, provider, and hosted evidence producers import the single `EVIDENCE_SCHEMA_VERSION` authority. |
| N6 | Applied | Release-fingerprint and secret-scanner exclusion collections use frozen arrays, avoiding the false immutability claim of a frozen mutable `Set`. |
| N7 | Applied | Server test fixtures use deterministic snapshot keys independent from their session-secret fixtures. |
| N8 | Applied | Render/Neon deployment verification includes `releaseTreeSha256` and requires equality with the frozen candidate fingerprint. |

The previously reported zero-read archive comparison loop is also closed: an
incomplete read fails immediately rather than retrying forever, with a focused
regression probe in `test/qualify-candidate-archive.test.js`.
