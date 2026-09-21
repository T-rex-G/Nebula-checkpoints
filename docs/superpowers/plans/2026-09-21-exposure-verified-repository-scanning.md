# Exposure: Verified Repository Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Goal:** Give a connected repository a scan that reports only what it can prove — a credential that still authenticates, a table that still answers an anonymous caller — and record each proof as governance evidence rather than as a guess.

**Architecture:** Detection reuses the tracked-text rules already in `src/secret-scanner.js`. What is new is the half that decides whether a match matters: a hardened outbound primitive extracted from the webhook worker, per-provider verification adapters that ask the provider itself, a scan job on the existing batch-worker pattern, and a findings store that keeps fingerprints and redacted context but never the credential. Findings enter the control catalogue as evidence and leave through the existing exception workflow. No analyser binary and no model is introduced: detection stays deterministic because it becomes an audit record.

**Tech Stack:** Node.js 22.23.1, CommonJS, `node:assert`, `node:https`, `node:dns`, PostgreSQL with checksummed migrations, Express, canonical JSON and SHA-256.

## Global constraints

- Add a failing regression before each behaviour change and capture the expected failure.
- No new runtime dependency, no analyser binary, and no model call anywhere in detection or severity. A finding must be reproducible from a commit SHA, a ruleset version and an engine version alone.
- Never persist a credential, a repository file, or a cloned tree. Findings carry a redacted excerpt and a digest; the workspace is destroyed with the job.
- Every outbound request from a scan goes through the guarded transport in Task 1. No other module may call `https.request` or `fetch` against a scan-derived address.
- Verification is three-state — `verified`, `rejected`, `unverifiable`. Never collapse `unverifiable` into either of the others.
- A probe touches only a target the reader has confirmed for that repository, is read-only, and is bounded to one row.
- Respect the single free-plan web service in `render.yaml`: the worker runs in-process on the existing batch pattern and must yield.

## Task 1: Extract a guarded outbound transport

**Files:**

- Create: `src/guarded-fetch.js`
- Create: `test/guarded-fetch.test.js`
- Modify: `src/governance-webhook-worker.js`
- Modify: `package.json`

**Red:** Assert the transport refuses a loopback address, an RFC1918 address, a link-local address, and `169.254.169.254` specifically; refuses a non-`https:` scheme; refuses a redirect whose new host resolves into any of those ranges; caps the response body and the total deadline; and pins the connection to the address it validated so a second DNS answer cannot move it. Assert `sendPinnedHttpsWebhook` still delivers through the extracted module unchanged. Run:

```bash
node test/guarded-fetch.test.js
node test/governance-webhook-worker.test.js
```

The first must fail because the module does not exist.

**Green:** Move the existing resolve-then-pin mechanism out of `governance-webhook-worker.js` into `guarded-fetch.js`, keeping `lookup` returning the already-validated address. Add the range rejection the webhook path never needed, an explicit redirect policy, a byte cap, and a deadline. Re-point the webhook worker at it so there is one outbound path, not two.

**Verify:** Both tests, plus `node --check src/guarded-fetch.js` and `git diff --check`.

## Task 2: Ask the provider whether a credential is live

**Files:**

- Create: `src/credential-verification.js`
- Create: `test/credential-verification.test.js`

**Red:** For each adapter, assert a `200` maps to `verified`, a `401`/`403` maps to `rejected`, and a transport failure or an unrecognised status maps to `unverifiable` with a reason. Assert the credential never appears in the returned record, in a thrown error, or in a log line. Assert every adapter is invoked through the Task 1 transport by injecting a transport that refuses to be bypassed. Run:

```bash
node test/credential-verification.test.js
```

Must fail because the module does not exist.

**Green:** Implement adapters for the rules `src/secret-scanner.js` already detects, each choosing the cheapest endpoint that proves liveness and nothing else: GitHub `GET /rate_limit`, which is documented not to consume the primary rate limit; GitLab `GET /api/v4/user`; Slack `auth.test`; AWS STS `GetCallerIdentity`. A rule with no adapter yields `unverifiable`, never `verified`.

**Verify:** The focused test, `node --check src/credential-verification.js`, and `git diff --check`.

## Task 3: Give a finding a stable identity

**Files:**

- Create: `src/exposure-findings.js`
- Create: `test/exposure-findings.test.js`

**Red:** Assert a fingerprint is stable when surrounding lines shift, when the file uses CRLF instead of LF, and when the path differs only by Unicode normal form; that it changes when the rule, the path or the matched construct changes; and that two runs over the same commit produce byte-identical records. Assert the stored excerpt is redacted, that the digest cannot reconstruct the credential, and that a record carries the engine version, the ruleset version and the scanned commit. Run:

```bash
node test/exposure-findings.test.js
```

Must fail because the module does not exist.

**Green:** Normalise the path to NFC and line endings to LF before hashing; fingerprint over rule identity and normalised context rather than absolute line number, so a finding survives edits above it. Redact the match to a fixed prefix and a length. Emit a record shaped to carry into SARIF later without re-deriving identity.

**Verify:** The focused test and `git diff --check`.

## Task 4: Persist scans and findings without persisting the repository

**Files:**

- Create: `db/migrations/020_exposure_scans.sql`
- Create: `src/exposure-store.js`
- Create: `test/exposure-store.test.js`
- Create: `test/exposure-persistence-contract.test.js`

**Red:** Assert the schema has no column that could hold file content or a credential; that a finding is unique per scan and fingerprint; that re-scanning a commit updates state rather than duplicating rows; and that a finding resolved in a later scan is retained with its resolution rather than deleted. Assert the migration applies and verifies against a real server, matching the existing contract style. Run:

```bash
node test/exposure-store.test.js
node test/exposure-persistence-contract.test.js
```

Both must fail because the migration and store do not exist.

**Green:** Add the migration with `nv_exposure_scans` and `nv_exposure_findings`, the finding row carrying fingerprint, rule, normalised path, line, redacted excerpt, excerpt digest, verification state and reason, first-seen and last-seen scan. Implement the store with the diff that Task 3's fingerprints make possible: new, still open, resolved.

**Verify:** Both tests plus `npm run test:migrations` against the local service.

## Task 5: Run the scan as a job on an ephemeral workspace

**Files:**

- Create: `src/exposure-worker.js`
- Create: `test/exposure-worker.test.js`
- Modify: `server.js`
- Modify: `src/capability-registry.js`

**Red:** Assert the worker shallow-clones into a per-job directory, scans, verifies, persists, and removes the directory on success, on scan failure, and on process interruption. Assert nothing outside that directory is written. Assert the job yields between batches rather than holding the event loop, and that two scans of one repository serialise. Assert the route is gated by a capability and refuses without one. Run:

```bash
node test/exposure-worker.test.js
node test/capability-registry.test.js
```

Both must fail.

**Green:** Follow the shape of `processWebhookDeliveryBatch` and `startWebhookWorker`. Add the `exposure-scan` capability, the enqueue route under the existing auth and capability middleware, and a status route. The clone is depth-1, single-branch, blobless where the provider supports it.

**Verify:** Both tests, `npm run test:runtime:matrix`, and `git diff --check`.

## Task 6: Prove anonymous readability rather than guessing at configuration

**Files:**

- Create: `src/anonymous-readability-probe.js`
- Create: `test/anonymous-readability-probe.test.js`

**Red:** Assert the probe runs only against a target the reader confirmed for that repository and refuses a target derived from the tree alone. Assert it is a single bounded read — `select=*&limit=1` — and that it never issues a write. Assert a populated array reports `anonymously-readable`, an empty array or a permission error reports `not-readable`, and anything else reports `unverifiable`. Assert the finding states what was proven — that the table answered an unauthenticated caller — and never claims a configuration setting it did not observe. Run:

```bash
node test/anonymous-readability-probe.test.js
```

Must fail because the module does not exist.

**Green:** Discover a candidate project reference and publishable key from the tree, present them for confirmation, and probe only after it. Enumerate through the service's own description document where it is exposed, and fall back to names found in the tree where it is not. Route the result through the Task 1 transport.

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

Both must fail.

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

**Red:** Assert a finding maps to a control and appears as evidence; that accepting an anonymously-readable table as intended records an exception rather than deleting the finding; that a resolved finding keeps its history. Assert the screen renders verification state distinctly from severity, so `unverifiable` never reads as safe, and that it holds at 360px. Run:

```bash
node test/control-mapping.test.js
npx playwright test test/e2e/exposure.spec.js
```

Both must fail.

**Green:** Add the control mapping, the exception reason, the screen, and the release-contract entries. The screen leads with what was proven and offers the exception as the response to an intended exposure.

**Verify:** `npm test`, `npm run test:e2e`, `npm run check:secrets`, `npm run docs:check`, and `git diff --check`.

## Out of scope

- Analyser binaries. Semgrep and TruffleHog earn their place only behind a separate worker service; `render.yaml` has one free-plan web service today.
- Free-text URL scanning. A target is a property of a repository the reader confirmed, never an address typed into a box.
- Model-written severity or narration. A summary paragraph may be generated later, cached against a digest of the finding set so it is stable, and never on the detection path.
