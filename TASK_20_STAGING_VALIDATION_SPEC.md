# Task 20 — Staging, Security, Concurrency and Accessibility Validation

## Status

Task 20 remains **in progress**. This specification defines the release-blocking evidence contract and the exact validation matrix. It does not claim that unavailable live environments passed.

## Scope

Task 20 validates the Phase 1 implementation against clean installation, runtime integration, deterministic packaging, real browser behavior, Neon migrations and races, supported providers, destructive sandbox recovery, and webhook delivery abuse cases.

Task 20 does not add unrelated product features, start Task 21, or implement customer-controlled external evidence storage. External storage remains Phase 5.

## Evidence contract

Evidence schema `1.2.0` is fail-closed and binds every record to:

- the immutable Task 20 catalog hash;
- the exact release-candidate SHA-256 subject hash;
- one known check ID;
- that check's prescribed command or canonical procedure ID;
- a non-secret environment fingerprint;
- a UTC execution interval;
- one or more verified non-secret artifact files for every pass or fail;
- an artifact path confined to `staging/evidence/`, a matching on-disk SHA-256, a regular-file check, and a 128 MiB per-artifact ceiling.

Missing, failed, blocked, stale, duplicated, malformed, wrong-catalog, wrong-subject, wrong-command, or artifact-free pass/fail evidence closes the gate. Evidence expires after seven days by default.

The deterministic report hash excludes verification time. The same still-fresh evidence therefore produces the same report hash, while crossing the freshness boundary changes the effective result and report hash.

Raw credentials, cookies, authorization headers, private keys, provider response bodies, internal URLs, and secret-bearing logs are forbidden from evidence files.

## Local executable checks

| Check | Prescribed command |
|---|---|
| `source.full-suite` | `node scripts/test-matrix.js --allow-missing-dependencies --require-subject --report staging/evidence/source-full-suite.json` |
| `runtime.npm-ci` | `npm ci` |
| `runtime.audit` | `npm audit --omit=dev --audit-level=high` |
| `runtime.express-suite` | `node scripts/test-matrix.js --require-all --require-subject --report staging/evidence/runtime-full-suite.json` |
| `runtime.package-release` | `npm run test:release && npm run package:release -- dist` |
| `browser.desktop` | `npx playwright test test/e2e/pwa.spec.js test/e2e/security-foundation.spec.js --project=desktop` |
| `browser.mobile` | `npx playwright test test/e2e/task20-accessibility.spec.js --project=mobile --grep "More navigation activates"` |
| `browser.keyboard-a11y` | `npx playwright test test/e2e/task20-accessibility.spec.js --project=desktop --grep "keyboard"` |
| `browser.offline-boundary` | `npx playwright test test/e2e/task20-accessibility.spec.js --project=desktop --grep "offline"` |

The independent test-matrix runner executes every top-level test program separately. In source mode it may classify a failure as blocked only for a genuine Node `MODULE_NOT_FOUND` result where the exact requested package is declared and actually unavailable; printed lookalike text, timeouts, signals, local-module errors, and all other failures remain failures. Candidate evidence uses `--require-subject`, embedding `NV_STAGING_SUBJECT_SHA256` in the report. Runtime mode requires every program to pass.

## Canonical live procedures

The following procedure IDs are immutable command identities for schema `1.2.0`. Their result artifacts must document the exact environment, start/end time, sanitized command-output hashes, affected sandbox identifiers, cleanup result, and pass/fail conclusion.

### Neon

- `task20://neon/migration-rehearsal/v1`
  - Use a disposable Neon branch or database.
  - Rehearse a fresh migration from zero through migration 013.
  - Rehearse an upgrade from the alpha.15 migration head.
  - Re-run migration startup to prove idempotency.
  - Change one applied migration checksum in an isolated copy and prove startup fails closed.
  - Remove the disposable branch/database after evidence capture.

- `task20://neon/concurrent-governance/v1`
  - Run simultaneous reviewer claim/decision, activation/rollback, and exception approve/revoke races against one sandbox repository scope.
  - Prove advisory locks, optimistic revisions, two-person rules, final state, audit ordering, and chain verification.
  - No race may create duplicate heads, duplicate final decisions, or an unauthorized approval.

- `task20://neon/outbox-workers/v1`
  - Run at least two delivery workers against one outbox.
  - Prove one active lease per delivery, lease recovery after worker termination, bounded retries, and no duplicate terminal success record.

### Providers

- `task20://provider/github-pat-oauth/v1`
  - Validate both PAT and OAuth sessions against a dedicated GitHub sandbox repository.
  - Exercise repository read, branch discovery, one bounded gateway mutation, resulting evidence, and cleanup.

- `task20://provider/gitlab/v1`
  - Validate a dedicated GitLab sandbox through the same repository read and bounded mutation workflow.
  - Preserve provider-specific permission errors without bypassing the gateway.

- `task20://provider/gitea/v1`
  - Validate a dedicated Gitea sandbox, including configured base-URL restrictions and paginated branch behavior.

- `task20://provider/github-app/v1`
  - Required only when GitHub App support is configured.
  - Prove installation credentials remain execution-only while verified-human governance attribution is preserved.

### Destructive sandboxes

- `task20://destructive/batch-and-recovery/v1`
  - Use a dedicated disposable branch.
  - Execute a bounded file batch, record exact item/operation IDs, capture recovery refs, mutate again, preview recovery, restore, and verify content/ref state.
  - Exercise a stale expected-head conflict and prove no commit occurs.
  - Cleanup must be explicit and verified.

- `task20://destructive/receive-pack-lfs/v1`
  - Exercise Git receive-pack and Git LFS batch/upload/verify paths in dedicated sandbox refs/objects.
  - Record each provider-write operation ID and failure ladder.
  - Prove provider-write ceilings, retry behavior, and cleanup.

### Webhook delivery

- `task20://delivery/ssrf-rebinding/v1`
  - Use controlled public DNS names and endpoints.
  - Exercise private, loopback, link-local, reserved, mixed-answer, redirect, and DNS-rebinding attempts.
  - Prove validation occurs at configuration and immediately before every delivery, with TLS hostname verification retained.

- `task20://delivery/retry-restart-deadletter/v1`
  - Exercise transient status codes/timeouts, permanent failures, worker restart, lease expiry, secret rotation, replay/idempotency identifiers, five-attempt ceiling, and dead-letter recovery.
  - Prove authoritative governance writes remain committed regardless of delivery failure.

## Browser behavior requirements

The Playwright suite must prove behavior, not hidden markup:

- keyboard focus enters the labelled modal, wraps in both directions, closes with Escape, and returns to the invoking control;
- mobile More navigation visibly activates the Governance workspace and loads live delivery evidence;
- governance API responses never appear in Cache Storage;
- after online governance data is loaded, removing API interception and enabling browser offline mode causes refresh to fail visibly rather than reuse cached governance evidence.

Route-mocked UI flows block service workers so Playwright interception remains deterministic. A separate active-service-worker flow verifies that a real governance request is never cached and returns the live-only offline response after browser connectivity is disabled.

## Gate operation

Generate a blocked plan for an exact candidate:

```bash
NV_STAGING_SUBJECT_SHA256=<candidate-sha256> npm run staging:plan
```

Verify evidence for that same candidate:

```bash
NV_STAGING_SUBJECT_SHA256=<candidate-sha256> npm run staging:verify -- staging/TASK_20_EVIDENCE_TEMPLATE.json
```

The verifier recomputes every referenced artifact file hash from the current working tree and returns a non-zero status unless all required records are fresh valid passes. Missing, symlinked, oversized, path-escaping, or tampered artifact files are rejected before gate evaluation. Optional GitHub App evidence may be absent only when that feature is not configured.

## Completion rule

Task 20 is complete only after the exact candidate has an open gate and the evidence/report artifacts are independently reviewed. Until then Task 21 remains blocked.
