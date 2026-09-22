# Multi-Instance State

What is shared between processes, what is deliberately local, and what a
deployment must provide before a second instance is safe.

Written alongside the change that made it true, and verified by
`test/multi-instance-contract.test.js`, which starts two real server processes
against one PostgreSQL database rather than asserting any of this against a
fake.

## Why this document exists

A per-process `Map` guarantees something real: this grant cannot be replayed
against *this process*. It reads like a guarantee about the application, and
for a single instance the two are indistinguishable. They separate the moment a
second process starts, and they separate silently — no error, no log line, and
every unit test still green, because a unit test only ever has one process.

Three replay guards and two rate limiters were in that position. Each now has a
durable home, and the list below is what remains.

## Shared: correctness depends on it

| State | Where it lives | What breaks without sharing |
| --- | --- | --- |
| Step-up grants | `nv_single_use_guards`, kind `step-up` | one grant authorizes one sensitive action per instance |
| GitHub App OAuth state | `nv_single_use_guards`, kind `github-app-state` | an OAuth state is redeemable once per instance |
| Recovery authorizations | `nv_single_use_guards`, kind `restore-authorization` | one preview authorization restores refs once per instance |
| API rate limit | `nv_rate_limit_buckets`, namespace `api` | a limit of 300 becomes 300 × instances |
| Webhook rate limit | `nv_rate_limit_buckets`, namespace `webhook` | a limit of 120 becomes 120 × instances |
| Sessions | `nv_sessions`, and `alpha_privacy` hosted sessions | already shared; sessions were never cookie-resident when a database is configured |
| Webhook delivery claims | `nv_governance_webhook_deliveries` | already shared, via `FOR UPDATE SKIP LOCKED` |

Each guard is claimed in **one statement**, never a read followed by a write.
A read and a write can be interleaved by anything that crosses a connection,
and two requests carrying one grant would both get past the read before either
wrote. The conflict clause does the deciding, and PostgreSQL serialises
conflicting inserts on the primary key.

The comparison uses the **database's clock**, not the caller's. Two instances
with drifting clocks must not disagree about whether a grant is still alive,
and the only clock they share is attached to the table.

## Local by design: sharing would be wrong or pointless

| State | Why it stays in the process |
| --- | --- |
| `LIVE_CLIENTS` | sockets cannot be shared between processes. Its ceilings (`MAX_LIVE_CLIENTS_PER_KEY`, `MAX_LIVE_CLIENTS_TOTAL`) are **per instance** and must not be described as cluster-wide |
| `_buckets`, `WEBHOOK_BUCKETS` | admission filters in front of the shared counters, not the limit. Their job is that a caller already refused costs no query |
| `_etags`, `VCACHE`, `PUBLIC_BASE_CACHE` | caches of immutable or re-derivable values. A cold cache on a new instance costs a recomputation, never a wrong answer |
| `activeUploads`, `vBytes` | per-process resource accounting for work happening in *this* process |
| `_pool`, `_dbReady`, `_governanceStore`, `_singleUseStore`, `_rateLimitStore` | per-process handles to shared things. The handle is local; what it reaches is not |

## The limit that is still per instance

`LIVE_CLIENTS` bounds concurrent event streams per process. With two instances
the real ceiling is twice `MAX_LIVE_CLIENTS_TOTAL`, because admission is decided
locally. This is a capacity figure rather than a correctness one — nothing is
authorized differently — but an operator reading the configured number will be
reading half the true ceiling, and should know that.

A live-event subscriber is also still served only by the instance it is
connected to. Events are persisted and the browser resumes from its cursor on
reconnect, so nothing is lost, but a subscriber on instance A does not receive
in real time an event published on instance B. Closing that is a cost decision
rather than a defect: the revocation check in the same handler already runs
every five minutes rather than every minute specifically so a free-tier
PostgreSQL compute can still auto-suspend, and a per-subscriber catch-up poll
runs directly into that.

## Failure is refusal, never a local fallback

A shared store that cannot answer has not said the grant is unspent or the
caller within their limit. Every path refuses and says which:

- `STEP_UP_STORE_UNAVAILABLE`, `GITHUB_APP_STATE_UNAVAILABLE`,
  `RESTORE_AUTHORIZATION_UNAVAILABLE`, `RATE_LIMIT_UNAVAILABLE` — all 503.

None of them falls back to the in-process copy. A local guard answers "unspent"
on every instance that has not seen the grant, and a local counter answers
"well within" for every caller it has not seen, so falling back would let a
replay through *precisely during an outage*. Tests refuse any failure path that
reaches the local state or calls `next()`.

Which store answers is decided by **configuration, not availability**: with
`DATABASE_URL` set, the shared store is authoritative and a failure is a
refusal. Without it, the process is explicitly single-instance and the local
maps are the guard.

## What a deployment must provide

1. **The same `SESSION_SECRET` on every instance.** Every guard key is an HMAC
   derived from it. Instances with different secrets compute different keys for
   the same grant and therefore do not share a guard at all, while appearing to.
2. **The same `DATABASE_URL`,** reachable from every instance.
3. **Migrations applied before an instance serves.** `020` and `021` create the
   tables these guarantees live in.
4. **A direct connection for migrations.** Applying them uses a session-level
   advisory lock, which transaction pooling does not support.

## Restart

Guards and counters survive a restart because they are rows. The in-process
admission filters do not, which is correct: they are an optimisation, and a
cold one costs one extra query per caller.

An in-flight webhook batch is drained before the pool closes. Without that, a
delivery that had already sent its HTTP request could not record the attempt,
so its row stayed leased until expiry and the receiver was sent the same event
again — a duplicate on every restart landing mid-batch.

## What this is not

Not a claim that the application has been run on two instances in production.
It has not. `test/multi-instance-contract.test.js` proves the properties above
against two processes and one database in CI; scaling remains a capacity
decision requiring its own authorization, and the live-event gap above is open.
