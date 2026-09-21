# Multi-Instance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Status:** Reviewed implementation plan, not evidence that multi-instance operation is supported today. Merging this document does not scale Render, change Neon configuration, run migrations or authorize a deployment.

**Goal:** Make shared security state, job ownership and authorized event delivery correct across processes and restarts. Preserve the current free-tier single-instance deployment; enable additional instances only after the integrated failure tests and rollout preconditions pass.

**Architecture:** Keep Node/CommonJS and the existing PostgreSQL stores. Sessions are **not uniformly stateless**: with `DATABASE_URL`, the cookie holds a sealed `sid` and `sessionOf` reads `nv_sessions`; only the optional no-database path keeps session data in a sealed cookie. Existing hosted-session mutation already has a concurrency-aware path. Webhook delivery already uses database row claims with `FOR UPDATE SKIP LOCKED`; the missing work is lease ownership/fencing and lifecycle behavior, not replacing it with an unconditional global singleton. Three replay guards and two rate ledgers need shared state. Sockets stay local, while durable, scope-checked events and revocations cross instances.

**Tech Stack:** Node.js 22.23.1, CommonJS, `node:assert`, PostgreSQL with `pg`, atomic SQL and fenced row claims. Durable live-event catch-up comes before optional `LISTEN`/`NOTIFY`. `checkJs` uses a pinned development-only TypeScript checker; no runtime compilation or language rewrite.

## Review baseline and delivery sequence

Reviewed against `main` at `62efb98930f67469ecfba38f9780dbb2f5fe559c` and PR #46 at `6e13a6920b44af5d33167bc3e3d9a9f73aa0ce80`.

| Existing seam | What the code establishes | What still needs proof |
| --- | --- | --- |
| `setSession` / `sessionOf` | Database-backed sessions when configured; hosted mutation merges under store control | No lost account/security updates or resurrection after revocation across processes, including invitation-off database mode |
| `consumePendingStepUp` | Synchronous `Map.get` then `Map.set` | An atomic async consume, not just duck-typed Map methods |
| `claimWebhookDeliveries` | Atomic disjoint row claims, default 60-second lease | Lease expiry during a sequential batch, stale completion and crash/reclaim |
| `closeLiveSessions` / `LIVE_CLIENTS` | Local sockets; periodic session recheck | Cross-instance revocation and gap-aware catch-up without identity leakage |
| `runMigrations` / deployment guide | Checksummed migrations and a session advisory lock; direct host required for apply | Explicit direct/pooled connection profile and no concurrent startup migration race |

Tasks 1–5 and 8 are the correctness track. Type checking (6) and router extraction (7) are separate, reviewable maintenance increments; they must not delay or obscure security fixes. Prove the two-process negative cases before marking any capability multi-instance-ready. Do not estimate duration from the number of Maps.

Coordinate schema allocation and job ownership with [Exposure PR #45](https://github.com/T-rex-G/Nebula-checkpoints/pull/45), but do not require its feature to ship first. Current migrations end at `019`; `<next>` below means allocate from current main when implementation lands, not reserve `021`/`022` or edit already-applied files.

## Global constraints

- Add a failing regression before each behaviour change and capture the expected failure.
- No new runtime dependency, no framework, no language, no build step. `public/index.html` keeps its unbundled script tags and `npm start` keeps its meaning.
- Preserve successful single-instance behavior and all documented limits, windows, token lifetimes and access checks. Correct fail-open/race behavior deliberately with tests; byte-for-byte preservation of an unsafe path is not a goal.
- Prove each fix with two instances against one database, not with a unit test alone. A guard that is only asserted in-process is the bug this plan exists to remove.
- Never widen a security window to make a test pass. Use controlled clocks for expiry and bounded waits only for asynchronous propagation.
- Keep `DATABASE_URL` optional only in the profiles that already allow it. No database means explicitly single-process, restart-volatile mode; invite/hosted profiles must retain their existing database requirement. A configured but unavailable database must **not** silently fall back to local replay/rate/session state.
- Use database time and atomic operations for shared state; log bounded reason codes, not grants, cookies, provider credentials or database URLs. Keep liveness distinct from readiness when a store is unavailable.
- Define and test direct versus transaction-pooled connectivity before introducing session-scoped features. `LISTEN` and session advisory locks are not supported through transaction pooling; a dedicated `pg` client connected to the pooler does not fix that. Existing apply-mode migrations need a direct connection; hosted production stays verify-only.
- Bound connection pools, query/lock timeouts, cleanup batches, queue depth and rows retained. Measure active and idle database/query costs within the existing free-tier budget. No paid service, Redis, always-on scan worker or changed hosting plan is implied.

## Task 1: Make the replay contract implementable by something other than a Map

**Files:**

- Modify: `src/security-foundation.js`
- Modify: `test/security-foundation.test.js`
- Modify: `server.js` (all asynchronous consume callers)
- Modify: `test/security-foundation-server.test.js`

**Red:** `consumePendingStepUp` rejects a non-Map today, but replacing that check alone would leave a distributed check-then-set race. Use a delayed atomic store and race two consumers of the same valid grant: exactly one may proceed. Assert malformed/expired/wrong-scope claims never consume anything, an unavailable store rejects before mutation, and a caller cannot treat an unresolved Promise as authorization. Test cleanup of pending session state only after successful consumption and preserve the synchronous in-memory adapter's semantics. Run:

```bash
node test/security-foundation.test.js
node test/security-foundation-server.test.js
```

The new contract/race cases must fail before implementation; keep existing authorization assertions intact.

**Green:** Define one operation such as `consumeOnce({ kind, keyHash, expiresAt })` returning a boolean or throwing a typed availability error. Validation precedes consumption; consumption is atomic, not separate async `get` and `set`. Wrap the Map for the permitted no-database profile and implement the same contract for PostgreSQL in Task 2. Await every caller before any provider mutation, OAuth exchange or authorization-dependent response. Consuming a grant cannot make a remote side effect exactly once: preserve existing idempotency/precondition checks and do not re-enable a grant after an uncertain provider response.

**Verify:** The focused test, `npm run lint`, and `git diff --check`.

## Task 2: Give the three single-use guards a durable home

**Files:**

- Create: `db/migrations/<next>_single_use_guards.sql`
- Create: `src/single-use-store.js`
- Create: `test/single-use-store.test.js`
- Create: `test/single-use-persistence-contract.test.js`
- Modify: `server.js`
- Modify: `src/alpha-privacy-store.js` only if shared session concurrency evidence requires it
- Create: `test/multi-instance-session.test.js`

**Red:** Use two actual database connections and two app processes. Exercise step-up, GitHub App state **and restore authorization**, including simultaneous consumption, replay after restart, expiry boundaries and clock skew. There must be no capacity eviction of an unexpired key and no in-memory fallback after a configured database fails. Failures before durable consume cause zero protected side effects. Separately race account/security updates and logout/revoke against a stale session write in both hosted and invitation-off database modes: unrelated updates survive and a deleted/revoked session cannot be recreated by an in-flight request. Run:

```bash
node test/single-use-store.test.js
node test/single-use-persistence-contract.test.js
node test/multi-instance-session.test.js
```

The new replay and session-concurrency scenarios must fail for their intended invariant before the corresponding fix.

**Green:** One namespaced table keyed by guard kind and domain-separated key hash. Use insert-conflict/conditional expiry logic atomically and reject expired claims before insert. Sweep only expired rows in bounded batches using the same time semantics as validation; capacity exhaustion fails closed, never drops a live guard. Replace all three guards and await all their callers. Preserve `nv_sessions`, its ownership and existing hosted mutation path; use revision-checked updates or equivalent serialized mutations for existing sessions, reserving session creation for authenticated login. Shared keys/configuration must match across instances; a process-random fingerprint key would defeat replay protection.

**Verify:** Both tests, `npm run test:migrations`, and `npm test`.

## Task 3: Make a rate limit mean the same thing on every instance

**Files:**

- Create: `db/migrations/<next>_rate_limit_buckets.sql`
- Create: `src/rate-limit-store.js`
- Create: `test/rate-limit-store.test.js`
- Modify: `server.js`

**Red:** Assert N is N across two actual store connections and simultaneous requests, not N per instance. Preserve the current API window (`> 60000`) and webhook window (`>= 60000`) boundary behavior explicitly instead of silently switching to epoch-aligned windows. A malformed caller-controlled cookie must not create unlimited new identities; rotating/resealing one authenticated session's cookie must not reset its bucket. Cover IPv4/IPv6 and the existing trusted-proxy policy. Test bounded cardinality/cleanup, restart and configured-database failure. Protected requests return a typed unavailable response on store failure, while `/healthz` remains a liveness check. Run:

```bash
node test/rate-limit-store.test.js
```

Must fail.

**Green:** Replace `_buckets` and `WEBHOOK_BUCKETS` with atomic conditional upserts preserving the start-of-window rules and ceilings. Hash a validated stable session identifier (or the existing trusted IP identity for unauthenticated traffic), not the first 40 characters of arbitrary cookie text. Separate API/webhook key namespaces. Bound query time, storage growth and connection use; reject overload without evicting an active counter. Keep any cheap pre-auth admission limiter local as defense in depth, not the authoritative shared limit, and document its separate purpose. Measure contention and query cost before enabling the database path.

**Verify:** The focused test, `npm run test:migrations`, and `npm test`.

## Task 4: Fence delivery claims and handle worker loss

**Files:**

- Modify: `src/governance-store.js`
- Modify: `src/governance-webhook-worker.js`
- Create: `db/migrations/<next>_webhook_claim_fencing.sql`
- Create: `test/webhook-claim-concurrency.test.js`
- Modify: `test/governance-webhook-worker.test.js`
- Modify: `server.js`

**Red:** First prove the existing `FOR UPDATE SKIP LOCKED` claim separates simultaneous workers; do not assert the false premise that each already delivers every row. Then reproduce lease overrun: a batch of ten sequential deliveries with the default 60-second claim can outlive later rows' leases. After reclaim, the previous owner must not renew or record completion. Test bounded transport cancellation, database connection loss, shutdown during a send, expiry/reclaim and a crash after the receiver accepted a request but before acknowledgment was recorded. Run:

```bash
node test/webhook-claim-concurrency.test.js
node test/governance-webhook-worker.test.js
```

The first must fail.

**Green:** Retain transactional row claims, add an owner/generation token and require it for renewal and completion. Claim just-in-time for available send slots or renew queued claims before expiry; do not solve batch overrun merely by increasing the lease. Stop starting work when ownership is uncertain, abort bounded in-flight work on loss and reject stale state updates. `stop()` currently only clears the interval; add a drain/cancel contract and verify it. No process-wide session advisory lock is needed for this queue. Use stable delivery/idempotency identifiers across retries: network delivery is at-least-once and the receiver must deduplicate; database fencing cannot retract an HTTP request already sent. Without a database the persistent governance worker remains unavailable, matching current bootstrap behavior.

**Verify:** Both tests and `npm test`.

## Task 5: Deliver authorized live events with durable catch-up

**Files:**

- Create: `src/live-channel.js`
- Create: `test/live-channel.test.js`
- Modify: `server.js`
- Modify: the existing event/session stores and append a migration only if their durable cursor/outbox contract needs one

**Red:** Two processes must deliver only to the matching provider authority, repository and current identity. Disconnect/reconnect a listener during publication; test catch-up, duplicates, out-of-order commits, events beyond retention and a slow/backpressured client. Race subscription setup with commit, including a transaction that allocates an ID before a later transaction commits. Revoke a session on A and assert B stops private delivery before forwarding the next event; repeat with the wake-up dropped and with database failure. Test both direct and transaction-pooled profiles, notification byte limits, bounded connection counts and idle query budgets. Run:

```bash
node test/live-channel.test.js
```

Must fail.

**Green:** The durable event store/outbox is truth; `NOTIFY` is an optional wake-up, not a replay log. Define a scope-bound cursor with commit-order-safe catch-up, event-ID deduplication and explicit resync when retention has removed the cursor. Reuse existing events where this contract holds; otherwise add the smallest transactional outbox. Publish identifiers only, then read sanitized payloads under current authorization. `LIVE_CLIENTS` stays local and its existing per-process connection ceilings remain documented; do not call them cluster-wide limits.

Default to bounded catch-up polling only while local authorized subscribers exist, with idle backoff and a measured free-tier cost. An optional LISTEN optimization requires an explicitly direct/session-capable connection, reconnect/resubscribe, and catch-up after LISTEN commits. Never use the transaction pooler for LISTEN or hold an application transaction open as a substitute. Session revocations are durable and fan out too; an unavailable authorization store stops private delivery rather than trusting cached access. Keep socket cleanup and backpressure bounded. This is not a promise of zero-loss notification delivery.

**Verify:** The focused test and `npm test`.

## Task 6: Type-check the source without introducing a build step

**Files:**

- Create: `jsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/public-alpha-alpha17.yml`
- Modify: `scripts/ci-local.js` and `scripts/qualify-candidate-archive.js` as required for equivalent gates
- Modify: `test/ci-local.test.js`
- Modify: `test/public-alpha-workflow-contract.test.js`

**Red:** In a disposable fixture copied from the checked include set, inject a real JavaScript type error and assert the local checker exits nonzero without producing files; a test merely looking for a script string is insufficient. CI contracts must prove the same check runs before expensive browser gates in normal CI, automated qualification and extracted-candidate verification. Run:

```bash
node test/ci-local.test.js
```

**Green:** Add pinned development-only `typescript` and required type declarations to the lockfile; do not rely on a globally installed or network-downloaded `tsc`. Use `tsc --project jsconfig.json --noEmit` with `allowJs`/`checkJs` and Node-compatible module resolution. Start with an explicit, useful module set including the new shared-state contracts; expand to `src/`, `scripts/` and remaining server seams in measured slices, not by hiding errors with blanket `any` or `@ts-nocheck`. Keep strictness tightening separate. Runtime startup, source language and output artifacts are unchanged.

**Verify:** `npm run typecheck`, `node test/ci-local.test.js`, and `npm run lint`.

## Task 7: Establish the router pattern and stop the file growing

**Files:**

- Create: `src/routes/security.js`
- Create: `test/route-surface.test.js`
- Modify: `server.js`

**Red:** Record method/path plus middleware order and public boundary behavior before extraction. Include anonymous/authorized requests, CSRF/origin checks, capability/repository refusal, step-up consumption, response headers and error mapping. A route count or matching path inventory alone cannot detect a missing auth middleware. Do not hardcode historical line counts as a safety proof. Run:

```bash
node test/route-surface.test.js
```

Must fail because the inventory and the module do not exist.

**Green:** Extract only `/api/security` behind explicit injected dependencies and preserve mount/middleware order. Keep shared store ownership at application bootstrap; routers must not construct private replay/rate stores. Characterization tests and a documented module ownership rule guide later extraction; unrelated handlers and all frontend modules stay untouched. Complete this as a separate increment from the security-state changes.

**Verify:** The focused test, `npm test`, `npm run test:e2e`, and `git diff --check`.

## Task 8: Prove the property, then record it

**Files:**

- Create: `test/multi-instance-contract.test.js`
- Create: `docs/architecture/multi-instance.md`
- Modify: `docs/DOCUMENTATION_MANIFEST.json`
- Modify: `CHANGELOG.md`

**Red:** Establish the harness before Tasks 2–5, then start two processes with the same keys/config against an isolated PostgreSQL 17 database. Prove all three replay guards (including restore), shared rate limits, safe session concurrency/revocation, fenced claims, authorized event catch-up and bounded restart behavior. Use a controlled receiver/provider fixture: no live mutations. Test actual process death, stale owners after takeover, database outage/recovery and deliberate no-database single-instance mode. Also test the declared pooled connection profile; direct-only PostgreSQL tests cannot prove pooler compatibility. Run:

```bash
node test/multi-instance-contract.test.js
```

New negative scenarios must fail for the relevant boundary before the fix, then pass together. Do not keep an intentionally failing suite in main; each implementation slice carries its red evidence and green regression.

**Green:** Document shared versus local state, authorization isolation, connection modes, measured capacity, restart semantics and recovery procedures. Inventory non-Map globals, caches and timers as well: move only correctness-critical state and give each retained cache a scope/invalidation rule. Register the architecture document and wire new integration tests into the actual npm/runtime-matrix/CI and extracted-candidate paths. Record real evidence, not only a list of intended checks.

**Verify:** `npm test`, `npm run test:e2e`, `npm run docs:check`, `npm run typecheck`, and `npm run check:secrets`.

## Rollout and readiness gates

1. Allocate append-only migrations from current main and validate upgrade on an isolated copy. Apply with the existing direct-connection migration workflow; all app instances verify the same schema before becoming ready. No production migration is authorized by this plan review.
2. Keep one serving instance while all security paths switch to the shared stores. Mixed old/new replicas are unsafe: an old process can ignore durable replay consumption or overwrite a newer session. Drain old workers and document how outstanding grants/states are expired or invalidated without widening TTLs before admitting another instance.
3. Expose bounded readiness reasons and metrics for shared-store failure, rejected replay, stale claim, replay lag and dropped/backpressured streams. Liveness stays available. A missing database in an explicitly distributed profile is not a supported degradation.
4. Prove pooled/direct behavior, finite total connection budget and idle costs with the deployed free-tier constraints before enabling additional connections or instances. Treat scaling as a later capacity decision requiring deployment authorization, not a prerequisite for this code.
5. Roll back by draining to one compatible instance and preserving additive tables/evidence. Do not roll back to a local-only replay implementation while shared-mode grants or concurrent requests remain valid. Never drop applied schema as an automatic rollback step.

Technical basis: [PgBouncer feature compatibility](https://www.pgbouncer.org/features.html) excludes LISTEN and session advisory locks from transaction pooling; [PostgreSQL LISTEN](https://www.postgresql.org/docs/17/sql-listen.html) defines subscription/reconnect ordering; [PostgreSQL NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html) describes payload and delivery constraints. [TypeScript checkJs](https://www.typescriptlang.org/tsconfig/checkJs.html) checks JavaScript without requiring a language migration. These sources support the design constraints, not a claim that the planned implementation already passes.

## Out of scope

- Frontend module migration and visual redesign: separate work, not a prerequisite for the shared-state changes.
- Strict type checking. Task 6 turns the checker on; tightening it is a series of small changes, not a flag flip in this plan.
- Extracting every route. Task 7 establishes a tested seam, not proof that every future extraction is safe.
- Any change to a limit, a window, an expiry or a ceiling. This plan moves state; it does not retune it.
