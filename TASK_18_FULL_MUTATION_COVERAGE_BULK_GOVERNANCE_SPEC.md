# Task 18 — Full Mutation Coverage and Bulk Operation Governance Specification

## Goal

Prove that every repository/provider side effect enters the Central Mutation Gateway and that aggregate operations are bounded, target-bound, deterministic, observable and explicit about atomic versus partial-success behavior.

## Non-goals

- No Task 19 notifications, webhooks-as-notification-delivery, or audit export implementation.
- No Phase 5 external evidence storage.
- No new provider or Bitbucket support.
- No change to policy semantics, approval semantics or the Task 17 interface beyond bounded mutation evidence already returned by existing APIs.

## Coverage inventory

`src/mutation-coverage.js` is the canonical immutable inventory for repository mutation routes and aggregate execution contracts. The build must fail when:

- a registered repository mutation route is absent from the inventory;
- an inventory action is absent from the Central Mutation Gateway registry;
- a provider write helper can perform a write without `assertProviderMutation`;
- an unknown provider write operation is used;
- a bulk contract has unbounded items, payload or provider writes.

Read-only POST routes, account/session operations, OAuth exchanges and GitHub App installation-token brokerage are explicitly outside repository mutation coverage and must remain enumerated in tests rather than inferred as provider repository writes.

## Execution contracts

Every gateway action has a deeply immutable execution contract:

- `mode`: `single`, `composite`, `batch-atomic`, or `batch-partial`;
- `maxItems`;
- `maxPayloadBytes` when client-supplied aggregate payload exists;
- `maxProviderWrites`;
- `atomicity`: `single-side-effect`, `single-provider-commit`, `multi-step`, or `best-effort-per-item`;
- `partialFailure`: boolean.

The gateway enforces `maxProviderWrites` at runtime and emits a deterministic operation ID for each authorized provider-side effect.

## Aggregate operations

### `file.batch`

- 1–100 items.
- Maximum canonical operation payload: 2 MiB.
- Unique normalized paths.
- Each item is `put` or `delete`.
- One deterministic item ID per item.
- One aggregate policy decision.
- One provider commit or no commit; partial success is not allowed.

### `commit.restore-paths`

- 1–500 resolved paths.
- One aggregate policy decision.
- One provider commit or no commit.

### `directory.move`

- 1–800 source items.
- One aggregate policy decision.
- One provider commit or no commit.

### `recovery.restore-refs`

- 1–50 sealed branch actions.
- The descriptor includes deterministic item IDs and a batch hash derived from the sealed authorization before policy evaluation.
- One aggregate policy decision.
- Provider writes execute sequentially.
- Partial success is explicit and returned per item.
- The sealed authorization is at-most-once; automatic replay is forbidden. A failed/partial attempt requires a fresh preview.

## Retry and identity rules

- Every mutation retains its gateway `mutationId`.
- Every provider-side effect receives `operationId = SHA-256(mutationId, provider-write index, method, operation and target)`.
- Aggregate items receive deterministic item IDs independent of request ordering where semantics permit ordering independence; file-batch item order remains preserved and is included in the batch hash.
- Unknown actions, operations or overflow fail before provider transport.
- Existing optimistic-concurrency and idempotency boundaries remain authoritative.

## Provider compatibility

Coverage and contracts must preserve:

- GitHub PAT and OAuth;
- optional GitHub App installation execution with human governance attribution;
- GitLab supported writes;
- Gitea supported writes;
- Git receive-pack and Git LFS transports.

Git LFS batch, object upload and verification side effects each receive an explicit gateway operation assertion inside the already-authorized `file.upload` context.

## Acceptance criteria

1. A machine-readable immutable route/action inventory covers every provider repository mutation route.
2. Static tests fail for an unguarded or unclassified mutation route.
3. Static tests prove all provider write helpers assert the active gateway context.
4. All action execution contracts are bounded and immutable.
5. Provider write overflow fails before the excess side effect.
6. Provider write events contain deterministic operation IDs and bounded indexes.
7. File batches reject more than 100 operations, duplicate paths, unknown operations and payloads above 2 MiB.
8. File-batch metadata binds item count, ordered item IDs and batch hash without raw content.
9. Recovery metadata binds exact sealed branch actions before policy/exception evaluation.
10. Recovery remains bounded to 50 sequential actions and exposes explicit per-item partial outcomes.
11. Git LFS write stages are individually classified and asserted.
12. Existing mutation, governance, provider, interface and historical evidence tests remain green.
13. No Task 19 or Phase 5 implementation is introduced.
