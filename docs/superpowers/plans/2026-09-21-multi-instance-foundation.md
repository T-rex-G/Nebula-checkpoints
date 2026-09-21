# Multi-Instance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Goal:** Make correctness independent of the number of processes serving the application, so a second instance is a capacity decision rather than a security event.

**Architecture:** Nothing is rewritten and no language is introduced. Sessions are already stateless — `unseal` over `SESSION_SECRET`, no server-side session store — so the application is one property away from horizontal already. That property is the set of module-scope `Map`s in `server.js` holding state that must be shared: three single-use guards, two rate-limit ledgers, and the live-client registry, plus a delivery worker every instance would start. Each moves to PostgreSQL, which already holds nineteen checksummed migrations and already coordinates through `pg_advisory_xact_lock` in four modules. The pattern exists; this applies it where it is missing.

**Tech Stack:** Node.js 22.23.1, CommonJS, `node:assert`, PostgreSQL with `pg`, advisory locks and `LISTEN`/`NOTIFY`, `jsconfig.json` with `checkJs`.

## Global constraints

- Add a failing regression before each behaviour change and capture the expected failure.
- No new runtime dependency, no framework, no language, no build step. `public/index.html` keeps its unbundled script tags and `npm start` keeps its meaning.
- Every task must keep a single-instance deployment working exactly as it does today. A durable store replaces a `Map`; it does not change a limit, a window, or an expiry.
- Prove each fix with two instances against one database, not with a unit test alone. A guard that is only asserted in-process is the bug this plan exists to remove.
- Never widen a security window to make a test pass. If a durable guard is slower, the test waits.
- Keep `DATABASE_URL` optional: the application must still boot and serve without a database, degrading to today's in-process behaviour with that degradation stated at startup.

## Task 1: Make the replay contract implementable by something other than a Map

**Files:**

- Modify: `src/security-foundation.js`
- Modify: `test/security-foundation.test.js`

**Red:** `consumePendingStepUp` currently rejects any store that is not a `Map` — `replayStore instanceof Map` — so no durable implementation can be passed to it. Add a test that supplies a conforming store which is not a `Map` and asserts the grant is consumed once and refused on replay. Assert the existing `Map` path is unchanged, and that a store missing a contract method is still rejected with a clear error rather than silently ignored. Run:

```bash
node test/security-foundation.test.js
```

Must fail on the `instanceof` guard.

**Green:** Replace the type check with a contract check over the methods actually used, and make the call sites await it so an implementation may be asynchronous. Keep the in-memory `Map` as the default and as the fixture.

**Verify:** The focused test, `npm run lint`, and `git diff --check`.

## Task 2: Give the three single-use guards a durable home

**Files:**

- Create: `db/migrations/021_single_use_guards.sql`
- Create: `src/single-use-store.js`
- Create: `test/single-use-store.test.js`
- Create: `test/single-use-persistence-contract.test.js`
- Modify: `server.js`

**Red:** Assert that consuming a key through one store instance makes a second, independently constructed instance refuse it — the two-instance property, expressed as two connections to one database. Assert expiry removes a key, that consumption is atomic under concurrent callers, and that no eviction can drop an unexpired key. `USED_GITHUB_APP_STATES` is capped at ten thousand entries and evicts the oldest; the durable store must have no capacity at which an unexpired guard disappears. Run:

```bash
node test/single-use-store.test.js
node test/single-use-persistence-contract.test.js
```

Both must fail.

**Green:** One table keyed by guard kind and key hash with an expiry, consumption as an insert whose conflict means "already used", and a bounded sweep of expired rows. Replace `USED_STEP_UP_GRANTS`, `USED_GITHUB_APP_STATES` and `USED_RESTORE_AUTHORIZATIONS` at their call sites. Store hashes, never the grant, state or authorization itself.

**Verify:** Both tests, `npm run test:migrations`, and `npm test`.

## Task 3: Make a rate limit mean the same thing on every instance

**Files:**

- Create: `db/migrations/022_rate_limit_buckets.sql`
- Create: `src/rate-limit-store.js`
- Create: `test/rate-limit-store.test.js`
- Modify: `server.js`

**Red:** Assert that a limit of N is N across two store instances sharing a database, not N per instance. Assert the window boundary behaves as the current implementation does, that a counter increments atomically under concurrency, and that a database failure fails closed for the protected route rather than opening it. Run:

```bash
node test/rate-limit-store.test.js
```

Must fail.

**Green:** Move `_buckets` and `WEBHOOK_BUCKETS` to a counter table with the same window and the same ceilings. Keep the read path cheap: one upsert returning the new count.

**Verify:** The focused test, `npm run test:migrations`, and `npm test`.

## Task 4: Let exactly one instance run the delivery worker

**Files:**

- Create: `src/worker-lease.js`
- Create: `test/worker-lease.test.js`
- Modify: `server.js`

**Red:** Assert that two instances contending for the lease produce exactly one holder; that releasing or losing the connection lets the other acquire it; that the holder renews while alive; and that the loser runs no delivery. `startWebhookWorker` is started unconditionally today, so two instances would each deliver every webhook. Run:

```bash
node test/worker-lease.test.js
node test/governance-webhook-worker.test.js
```

The first must fail.

**Green:** Use a session-level advisory lock — the same mechanism `governance-store.js` already uses transactionally — held for the process lifetime, with the worker started only on acquisition and stopped on loss. Without a database, one instance is assumed and the worker starts as it does today.

**Verify:** Both tests and `npm test`.

## Task 5: Deliver a live event to a subscriber on any instance

**Files:**

- Create: `src/live-channel.js`
- Create: `test/live-channel.test.js`
- Modify: `server.js`

**Red:** Assert an event published on one instance reaches a subscriber attached to another. Assert the per-key and total client ceilings still hold per instance, that a dropped listener reconnects without losing its place beyond the documented window, and that a payload too large for a notification is carried by reference rather than truncated. Run:

```bash
node test/live-channel.test.js
```

Must fail.

**Green:** Publish through `LISTEN`/`NOTIFY` on a dedicated connection and have `broadcastLive` fan out from the notification rather than only from the local call. `LIVE_CLIENTS` stays in-process — sockets cannot be shared — but membership stops deciding who hears an event.

**Verify:** The focused test and `npm test`.

## Task 6: Type-check the source without introducing a build step

**Files:**

- Create: `jsconfig.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `test/ci-local.test.js`

**Red:** Add `npm run typecheck` to the workflow and assert in the CI contract test that it runs before the browser suite, so a type error is reported in seconds rather than after the long gates. The test must fail because the script does not exist. Run:

```bash
node test/ci-local.test.js
```

**Green:** Add `jsconfig.json` with `checkJs`, `strict` off to start, and an include list covering `src/` and `scripts/`. Annotate with JSDoc only where the checker cannot infer. Nothing is compiled: `npm start` is unchanged and no file is emitted. Raise strictness in later, separate changes rather than here.

**Verify:** `npm run typecheck`, `node test/ci-local.test.js`, and `npm run lint`.

## Task 7: Establish the router pattern and stop the file growing

**Files:**

- Create: `src/routes/security.js`
- Create: `test/route-surface.test.js`
- Modify: `server.js`

**Red:** `server.js` is 6,988 lines carrying 148 routes. Assert the complete route surface — method and path for every route — is unchanged after extraction, by comparing against a recorded inventory. Assert no single route module exceeds a stated ceiling, and that `server.js` itself declines to grow beyond its current route count so the next feature lands in a module. Run:

```bash
node test/route-surface.test.js
```

Must fail because the inventory and the module do not exist.

**Green:** Extract one cohesive group — the `/api/security` routes — into an Express router mounted from `server.js`, changing no handler body. The inventory test is what makes the remaining extractions safe to do incrementally afterwards.

**Verify:** The focused test, `npm test`, `npm run test:e2e`, and `git diff --check`.

## Task 8: Prove the property, then record it

**Files:**

- Create: `test/multi-instance-contract.test.js`
- Create: `docs/architecture/multi-instance.md`
- Modify: `docs/DOCUMENTATION_MANIFEST.json`
- Modify: `CHANGELOG.md`

**Red:** Start two application processes against one database and assert, end to end: a step-up grant consumed on one is refused by the other; an OAuth state likewise; a rate limit counts once across both; exactly one delivers webhooks; a live event published on one reaches a subscriber on the other. Run:

```bash
node test/multi-instance-contract.test.js
```

Must fail before Tasks 2 through 5 land, and is the test that proves this plan rather than each part of it.

**Green:** Document which state is shared, which is deliberately per-instance and why, and what a deployment must provide for a second instance to be safe. Register the document under the `architecture` lifecycle.

**Verify:** `npm test`, `npm run test:e2e`, `npm run docs:check`, `npm run typecheck`, and `npm run check:secrets`.

## Out of scope

- The frontend module migration. Twenty-nine unbundled scripts and 13,148 lines sharing a global namespace is real debt and its own plan; native ES modules can remove the globals without a bundler, and none of it affects correctness under load.
- Strict type checking. Task 6 turns the checker on; tightening it is a series of small changes, not a flag flip in this plan.
- Extracting all 148 routes. Task 7 establishes the pattern and the guard that makes the rest routine.
- Any change to a limit, a window, an expiry or a ceiling. This plan moves state; it does not retune it.
