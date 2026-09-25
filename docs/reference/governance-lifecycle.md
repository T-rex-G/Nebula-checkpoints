# Governance lifecycle

Everything that can happen to a policy after it exists, who may do it, and what
is kept.

A policy is created, drafted, submitted as an immutable version, reviewed,
simulated and activated. From there it can also be switched off, archived,
restored, and -- for a whole repository at once -- reset. A draft can be
discarded and a version that never ran can be withdrawn. None of these edits a
record of something that already happened: each one appends to the governance
ledger, and the audit chain still verifies afterwards.

The implementation lives in `src/governance-store.js` (one transaction per
operation), `src/governance-api.js` (roles and input), and
`db/migrations/028_governance_lifecycle.sql`. The behaviour below is exercised
against a real PostgreSQL server by `test/governance-lifecycle-postgres.test.js`.

## The operations

| Operation | Role | What happens | What is kept |
|---|---|---|---|
| **Switch off** | activator | The active version stops being enforced at once. Approved exceptions on it end, because they were bound to that version and head revision. | The version, its reviews and its activation evidence. The switch-off is an entry in the activation history (`deactivate`). |
| **Turn back on** | activator | The version that was running when the policy was switched off becomes active again, through the rollback workflow, with a fresh simulation against "no policy". | Everything; this is an ordinary rollback. |
| **Archive** | administrator | The policy leaves the Digital Twin and enforces nothing. A running policy is switched off first, in the same transaction, and that is recorded as its own event. The policy key becomes free for a new policy. | Versions, drafts, reviews, activations and the audit chain. |
| **Restore** | administrator | An archived policy returns, **switched off**. Turning it on is a separate, simulated step. Refused while a current policy uses the same key. | Everything it had when it was archived. |
| **Discard draft** | author (own draft) or administrator | The draft and its unsubmitted edits are deleted. | Submitted versions; the discard is recorded with the draft's revision and document hash. |
| **Withdraw version** | author (own version) or administrator | A version that never took effect can no longer be reviewed or activated, and stops appearing as proposed. A version that was ever active cannot be withdrawn: it is history, and rollback reads it. | The version itself, marked withdrawn. |
| **Reset governance** | administrator, with step-up re-authentication and the repository name typed | Every live policy is switched off and archived in one transaction -- the repository is either governed as before or not governed at all, never half. | The evidence ledger, signed exports, webhooks and notification settings are untouched. Every archived policy can be restored. Each record of the reset carries the same `resetId`. |

Switching off, archiving and reset require an `Idempotency-Key`; a repeated
request with the same key returns the first answer rather than acting twice.
Every operation that changes enforcement checks the policy's head revision, so
a page that is out of date is refused with a conflict instead of acting on a
state it never saw.

## What is recorded

Each operation writes one audit event per policy it touches, and each event
reaches notifications and webhooks like the rest:

- `policy.deactivated` -- the version switched off, its number, the head
  revision before and after, the authorization evidence and the reason.
- `policy.archived` -- the key, whether it was running, and the reason.
- `policy.restored` -- the key and the reason.
- `draft.discarded` -- the draft id, its revision and document hash, and
  whether its author or an administrator discarded it.
- `version.withdrawn` -- the version number and the reason.

A withdrawal also leaves a row in `nv_governance_version_withdrawals`, which
holds the version, the policy and the actor's identity key and nothing else
about the person: the login and the reason are in the audit ledger, which the
privacy purge can reach. The table is append-only, like the rest of the
governance history.

## What a reset is not

It does not delete the governance history, and it cannot: the ledger is
append-only by trigger. It does not remove webhooks, exports or notification
settings, which describe where evidence goes rather than what is enforced. And
it does not touch the repository -- governance rows belong to this server, so
the reset works in read-only mode and is not blocked by protected paths.
