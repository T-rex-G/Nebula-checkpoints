# Exposure: Verified Repository Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Status:** Reviewed implementation plan, not an implemented or qualified capability. Merging this document authorizes no live credential test, database probe, deployment or new infrastructure.

**Goal:** Give a connected repository a bounded scan that distinguishes a detected exposure from an explicitly authorized, time-stamped verification. An unverified credential is still a finding; an empty response is not proof that a database is protected.

**Architecture:** Reuse the rules in `src/secret-scanner.js`, not its current first-match-only traversal as a complete findings engine. Read an immutable provider tree through a guarded, bounded transport; never execute repository code. Keep deterministic detection separate from live observations. Persist scoped, sanitized evidence, coverage and append-only verification attempts. Explicitly authorized probes are optional. Findings map to controls and can receive exceptions without changing the recorded observation. No analyser binary or model is introduced.

**Tech Stack:** Node.js 22.23.1, CommonJS, `node:assert`, `node:https`, `node:dns`, PostgreSQL with checksummed migrations, Express, canonical JSON, SHA-256 and domain-separated HMAC for sensitive fingerprints.

## Review baseline and delivery order

Reviewed against `main` at `62efb98930f67469ecfba38f9780dbb2f5fe559c` and PR #45 at `b29072a77841739018a435ed7989898e54079aa4`.

- `scanFiles` emits only the first match of each rule per file and exposes only path/rule/line. Complete occurrence extraction is new work, not an adapter already provided by that function.
- Webhooks already reject private/non-public addresses through `normalizeWebhookDestination` in `src/governance-delivery.js`. Task 1 must preserve those protections, signatures, retry semantics and redirect rejection.
- Seven pattern rules and six manually reviewed preview findings do not establish precision, recall or superiority to another scanner. Require a labeled synthetic true-positive/false-positive corpus and explicit coverage; do not claim a benchmark from that preview.
- Build passive detection first: Tasks 1, 3, 4, 5, 7 and the passive portion of 8. Active verification (2 and 6) stays opt-in until target authorization, adapter semantics and resource tests pass.
- Before multi-instance scan execution, reuse the durable claim/fencing and privacy contracts from [foundation PR #46](https://github.com/T-rex-G/Nebula-checkpoints/pull/46). Do not create a second incompatible job-ownership mechanism. No paid worker or deployment scaling is required by this plan.

## Global constraints

- Add a failing regression before each behaviour change and capture the expected failure.
- No new runtime dependency, analyser binary or model call in detection or severity. Deterministic detection is reproducible from immutable commit, rules/engine versions, scope, configuration and fingerprint-key version; a live verification can change between runs and records its own observation time.
- Never persist raw credentials, source excerpts, repository contents or probe response rows, including in logs, exceptions, telemetry, queued jobs or browser caches. A schema alone cannot enforce this: use an allowlisted serializer and leak tests at every output boundary. Generated context contains placeholders, not copied source lines.
- Every outbound request from a scan goes through the guarded transport in Task 1. No other module may call `https.request` or `fetch` against a scan-derived address.
- Verification is three-state — `verified`, `rejected`, `unverifiable` — with reason and time. `rejected` means this verifier did not accept the credential, not that the exposure is harmless. Rate limits, unsupported credential types and missing consent remain `unverifiable`.
- Repository read permission is not authority to use a discovered credential or query its external project. Require a separate authenticated, expiring authorization bound to actor, repository, commit, candidate fingerprint, exact target and permitted operation; no bulk consent to arbitrary hosts. Revalidate at execution and after disconnect/revocation. CI uses fixtures only; live qualification needs separately authorized disposable targets.
- Every enqueue, status, finding, cancel, export and exception action must apply the existing provider/authority/repository and identity boundaries. Never fetch an arbitrary job ID without the same ownership check.
- Respect the single free-plan web service: bounded asynchronous batches, one active scan per process, durable per-repository claims, finite queue and per-identity admission. Freeze file/count/total-byte, memory, response-byte, request-count and wall-clock caps from measured fixtures before enabling the capability. Caps produce `partial` coverage, never an all-clear.
- No runtime feature flag, capability status, migration or production environment changes occur in this plan PR. Allocate migration numbers from current main when implementation lands; do not reserve `020` in conflict with another plan or rewrite applied checksums.

## Task 1: Extract a guarded outbound transport

**Files:**

- Create: `src/guarded-fetch.js`
- Create: `test/guarded-fetch.test.js`
- Modify: `src/governance-webhook-worker.js`
- Modify: `package.json`

**Red:** Keep existing webhook tests green. New transport tests must reject loopback, private/link-local/metadata, shared, reserved and IPv6-mapped non-public addresses, mixed public/private DNS answers, userinfo and unexpected ports. Validate all answers and pin the actual connection while preserving hostname/SNI certificate checks. Reject redirects by default (including public-to-public credential forwarding), scheme changes and caller-selected proxy bypasses. Bound DNS, connection, TLS, body and total elapsed time; reject over-size or decompressed over-size bodies and cancel underlying work. Assert no authorization header/body appears in errors. Test scan and webhook profiles separately: scan GET/query support must not widen the webhook URL policy or change signed POST bytes. Run:

```bash
node test/guarded-fetch.test.js
node test/governance-webhook-worker.test.js
```

The first must fail because the module does not exist.

**Green:** Extract the resolve/validate/pin plumbing and reuse the existing public-address validation. Keep separate operation profiles: provider reads, authorized verification and signed webhook delivery. Credential-bearing probes use adapter-owned allowlisted origins and paths, not a URL copied from a repository. Preserve no-redirect webhook behavior; if a provider read genuinely needs a redirect, review that specific route and never forward credentials across origins. Do not bypass the guard with `git clone`, archive URLs, native binaries or lazy blob fetches.

**Verify:** Both tests, plus `node --check src/guarded-fetch.js` and `git diff --check`.

## Task 2: Ask the provider whether a credential is live

**Files:**

- Create: `src/credential-verification.js`
- Create: `test/credential-verification.test.js`

**Red:** Test provider-specific response bodies as well as status codes, absent/expired authorization, unsupported token classes, malformed success bodies, rate limiting, policy restrictions and timeouts. A public unauthenticated 200 is not authentication proof. Assert missing consent makes zero network calls; deduplicate repeated candidates within the same authorized run. Use a refusing injected transport to prove all probes pass through Task 1, and inspect returned records/errors/logs for synthetic secret leakage. Run:

```bash
node test/credential-verification.test.js
```

Must fail because the module does not exist.

**Green:** Implement only credential classes with documented authentication proof and fixture coverage:

| Adapter | Proof and refusal contract |
| --- | --- |
| GitHub / GitLab user tokens | Use the authenticated identity endpoint appropriate to that token class and validate its response shape; do not infer authentication solely from `/rate_limit`, which also supports public access. App/installation/deploy/runner token classes need their own reviewed adapter or remain unsupported. |
| GitHub throttling | A 403 can be primary/secondary throttling or a policy restriction, not an invalid credential. Preserve the reason and bounded retry time; do not retry within the throttle window. |
| Slack | Parse `ok` and documented error codes from `auth.test`. HTTP 200 with `ok:false` cannot be verified. Ambiguous `invalid_auth` (including an IP restriction) must not be presented as globally revoked. |
| AWS | The existing rule finds an access-key ID, not the complete signing credentials. An ID alone is `unverifiable: incomplete-credential`. Defer STS until an explicitly approved pairing/signing design supplies the matching secret and, for temporary credentials, session token. Never try combinations of discovered secrets. |
| Other patterns | Private keys, authenticated URLs and contextual secrets remain detected/unverifiable; never attempt arbitrary database login or submit them to an unrelated authority. |

Record adapter/version, authorized target ID, observed-at, bounded reason code and a freshness deadline. Do not persist raw response identity details unnecessarily. Verification expiry cannot silently upgrade or resolve a finding. Keep detection severity separate from liveness, and keep historical attempts immutable.

**Verify:** The focused test, `node --check src/credential-verification.js`, and `git diff --check`.

## Task 3: Give a finding a stable identity

**Files:**

- Create: `src/exposure-findings.js`
- Create: `test/exposure-findings.test.js`
- Create: `src/exposure-detection.js`
- Create: `test/exposure-detection.test.js`
- Modify: `test/secret-scanner.test.js` (compatibility coverage only)

**Red:** A file with two different tokens matching one rule must yield two candidates, not today's first-match-only result. Repeated occurrences carry complete bounded locations/counts. Preserve the existing CLI's sanitized result contract. Detection/fingerprints stay stable across line shifts and CRLF/LF without normalizing secret bytes. Distinct case-sensitive or Unicode-distinct Git paths must not collapse; display normalization is not identity. Different credential bytes with the same visible prefix must not share a fingerprint. Deterministic detection records match for identical inputs, while separately stored live observations may differ. Assert same candidate in different identity/authority/repository scopes cannot share an accessible record, and raw neighboring secrets never enter output. Run:

```bash
node test/exposure-findings.test.js
node test/exposure-detection.test.js
node test/secret-scanner.test.js
```

The new focused tests must fail before implementation; the existing scanner suite must remain green.

**Green:** Enumerate every bounded occurrence using cloned rules without shared regex state. Pass candidate bytes only to the short-lived verifier; exported detection objects are sanitized. Fingerprint scoped rule identity, exact Git path and candidate bytes with a purpose-derived HMAC key and explicit key version; do not publish an unkeyed digest of guessable secret material. Absolute line number is a location, not identity. Store a generated placeholder and bounded locations rather than a partially redacted source line. A key/rules/config change requires explicit comparison compatibility; it must not make all old findings appear resolved. Do not claim JavaScript memory can be securely zeroized: minimize copies and lifetime instead.

**Verify:** The focused test and `git diff --check`.

## Task 4: Persist scans and findings without persisting the repository

**Files:**

- Create: `db/migrations/<next>_exposure_scans.sql` (allocate at implementation)
- Create: `src/exposure-store.js`
- Create: `test/exposure-store.test.js`
- Create: `test/exposure-persistence-contract.test.js`

**Red:** Test allowlisted serialization, bounded field sizes and absence of synthetic secrets in database rows, APIs, exceptions, logs and exports; column names cannot prove this. Repeating the same idempotency key must return the same scan, while a deliberate rescan of the same commit creates a new observation without duplicating finding identity. A canceled, failed, truncated, unauthorized or incompatible scan cannot mark a missing finding resolved. Tests must run actual SQL against isolated PostgreSQL, not only inspect schema text. Prove cross-identity access denial, disconnect/purge and bounded retention without deleting unexpired evidence required by the existing governance contract. Run:

```bash
node test/exposure-store.test.js
node test/exposure-persistence-contract.test.js
```

Both must fail because the migration and store do not exist.

**Green:** Persist scans, scoped finding identity and append-only observations, with source commit, reference lineage, rule/engine/config/key versions, observed time, coverage/skipped reasons and terminal job state. Use database uniqueness for idempotency and per-repository execution ownership. Compare only complete compatible coverage of the same scope/ref lineage; distinguish removed-from-scanned-tree from credential rejection or accepted risk. Never imply absence at HEAD erases a secret from Git history. Extend existing privacy/purge and governed-retention paths rather than inventing a second owner-workspace model. Allocate and register append-only migration IDs together with the foundation work.

**Verify:** Both tests plus `npm run test:migrations` against the local service.

## Task 5: Run a bounded, restart-safe scan job

**Files:**

- Create: `src/exposure-worker.js`
- Create: `test/exposure-worker.test.js`
- Modify: `server.js`
- Modify: `src/capability-registry.js`

**Red:** Assert an authorized ref is resolved once to an immutable commit; a branch move cannot mix trees. Enumerate/read provider blobs only through the guarded transport, with no checkout, hooks, submodules, LFS smudge, package install or repository code execution. Cover truncated/paginated trees, binary/oversized files, symlinks, invalid paths, many small files and per-job byte/time budgets. A limit is visible `partial` coverage. Verify event-loop responsiveness and cancellation while reading/scanning, not just between jobs. Two processes must not own the same repository scan; stale workers cannot finalize a reclaimed job. Deny every job/read/export/cancel route to the wrong identity and recheck access before execution. Run:

```bash
node test/exposure-worker.test.js
node test/capability-registry.test.js
```

The new worker cases and added capability assertions must fail for their intended behavior before implementation; existing capability tests should continue to pass.

**Green:** Use bounded provider tree/blob reads at the captured commit, initially only for providers with implemented, tested readers. This avoids the unguarded Git subprocess/lazy-fetch path and keeping a cloned tree on disk. Jobs store scope/commit/cursor/consent identifiers, never copied provider credentials; resolve an existing authorized session at execution. On revocation, stop rather than retain its credential. Reuse the database claim/expiry/fencing contract, admission control and bounded status API. Restarted jobs refetch by immutable commit or terminate visibly; they do not silently resume obsolete consent. If temporary storage is ever needed, use a private owned directory with quotas and normal cleanup plus startup orphan recovery. A `finally` block cannot promise cleanup after SIGKILL or power loss. Test abrupt process death and recovery explicitly.

**Verify:** Both tests, `npm run test:runtime:matrix`, and `git diff --check`.

## Task 6: Prove anonymous readability rather than guessing at configuration

**Files:**

- Create: `src/anonymous-readability-probe.js`
- Create: `test/anonymous-readability-probe.test.js`

**Red:** Require explicit authority for the exact project, relation and selected non-sensitive projection; tree discovery alone sends zero probes. A populated result proves readability only for that tested projection/role at that time. An empty array is `unverifiable: no-visible-rows` (empty table and row filtering are indistinguishable); a documented permission refusal is `access-denied-for-tested-request`, not proof of all-table protection or an RLS setting. Bound response bytes as well as rows and never return/store row values. Refuse service-role/secret keys, user-session tokens, RPC/functions, arbitrary relation names, wildcard `select=*`, pagination and writes. Run:

```bash
node test/anonymous-readability-probe.test.js
```

Must fail because the module does not exist.

**Green:** Discover candidate project metadata, then have an authorized operator confirm a finite relation/projection allowlist and suitable public key. Read at most one row of the approved non-sensitive projection with a strict byte/deadline cap; never select the full row or follow pagination. Use the provider's anonymous role only; a public key alone is not a leaked administrator secret. Where safe projection or ownership cannot be established, do not probe and state why. Metadata discovery, including any service description read, is inside the same consent and transport boundary; unavailable discovery reduces coverage. A read may transfer data or consume quota even if it changes no rows, so keep the result to a sanitized observation and explain this during confirmation.

**Verify:** The focused test and `git diff --check`.

## Task 7: Say what a finding means without a model

**Files:**

- Create: `src/exposure-narration.js`
- Create: `docs/reference/exposure-findings.md`
- Create: `test/exposure-narration.test.js`
- Modify: `docs/DOCUMENTATION_MANIFEST.json`

**Red:** Assert every rule and probe outcome has a narration entry, that the test fails when a rule is added without one, and that narration is a pure function of the record — same record, same words, every run. Assert no narration string contains the excerpt or the digest. Run:

```bash
node test/exposure-narration.test.js
node test/documentation-architecture.test.js
```

The new narration checks must fail before implementation. Existing documentation checks remain green until the new document is added, then require its manifest entry.

**Green:** Write one explanation per rule: the consequence first in the reader's terms, then the location. Keep it a lookup table, not a generator. Register the reference document in the manifest under the `current` lifecycle.

**Verify:** Both tests and `npm run docs:check`.

## Task 8: Make findings governable, then integrate

**Files:**

- Modify: `src/control-catalog.js`
- Modify: `src/governance-exceptions.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Create: `test/e2e/exposure.spec.js`
- Modify: `test/package-contract.test.js`
- Modify: `CHANGELOG.md`

**Red:** Assert a finding maps to a control only through the existing authorized evidence boundary; a repository reader cannot approve their own exception without the required governance role. Exception scope, approver, expiry, revocation and audit trail must match existing rules. The UI separates detection, verification freshness, scan coverage and disposition; pending/partial/rejected/expired states cannot show a green all-clear. Test cancellation, resume failure, account switch/purge, escaped provider text, keyboard/screen-reader operation, both themes and 320/360px reflow. No raw candidate or probe row may enter DOM, exports or browser storage. Run:

```bash
node test/control-mapping.test.js
npx playwright test test/e2e/exposure.spec.js
```

Add focused assertions to the existing mapping suite before changing it; the new browser scenarios must fail for the missing feature, not only a missing file.

**Green:** Add the control mapping, the exception reason, the screen, and the release-contract entries. The screen leads with what was proven and offers the exception as the response to an intended exposure.

**Verify:** `npm test`, `npm run test:e2e`, `npm run check:secrets`, `npm run docs:check`, and `git diff --check`.

## Evidence required before enabling Exposure

| Risk | Required acceptance evidence |
| --- | --- |
| False certainty | Fixture matrix for provider body/status semantics, empty tables, unsupported types and stale observations |
| Wrong target or identity | Zero outbound requests without valid consent; cross-scope job/finding/export denial and revocation tests |
| Secret leakage | Synthetic canaries absent from database, logs, error paths, DOM and exports; no source/row persistence |
| Incomplete scan | Every occurrence enumerated within declared caps; partial scans never auto-resolve prior findings |
| Free-tier overload / restart | Measured CPU/memory/event-loop and API/DB budgets, deterministic cancel and process-kill recovery |

Register every new test in the actual npm/CI/runtime-matrix discovery paths; running it manually once is insufficient. Keep existing release/qualification gates intact. These future acceptance tests are not claimed to pass by this documentation PR.

Provider semantics checked during review: [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/), [GitHub rate-limit responses](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [AWS signed credential requirements](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html), and [Supabase row filtering](https://supabase.com/docs/guides/database/postgres/row-level-security). Recheck these contracts when implementing each adapter.

## Out of scope

- Analyser binaries. Semgrep and TruffleHog earn their place only behind a separate worker service; `render.yaml` has one free-plan web service today.
- Free-text URL scanning. A target is a property of a repository the reader confirmed, never an address typed into a box.
- Model-written severity or narration. A summary paragraph may be generated later, cached against a digest of the finding set so it is stable, and never on the detection path.
