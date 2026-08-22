# Tester revocation and alpha-data deletion

## Trigger

Use this runbook for tester removal, compromised access, consent withdrawal, or an authenticated deletion request.

## Containment

Revoke the invitation/tester, stop new mutations, and begin provider-resource cleanup before purging retained alpha data.

Branch on whether the invitation was redeemed. An unredeemed invitation has no
tester behind it, so `revoke --tester` cannot reach it and the code stays
redeemable for its whole lifetime.

For an invitation that was never redeemed, revoke the code by its identifier.
`revoke-invite` exits non-zero unless it revoked the invitation, so a refusal --
including `redeemed`, which means you want the tester path below -- stops this
block rather than reading as containment.

```bash
set -euo pipefail
node scripts/alpha-invites.js revoke-invite --invite "$NV_INVITE_ID"
node scripts/alpha-privacy.js cleanup-status
```

For a redeemed invitation, revoke the tester. That transaction also revokes
every alpha session the tester owns, and reports how many in `sessionsRevoked`;
that count is the evidence sessions ended, so there is no separate session-end
call here. Adding one would fail the block rather than harden it: the session it
would target has just been revoked, so the request is refused and `--fail`
aborts containment on success. Provider sessions are revoked at the provider.

```bash
set -euo pipefail
node scripts/alpha-invites.js revoke --tester "$NV_TESTER_ID" --reason "$NV_REVOCATION_REASON"
node scripts/alpha-privacy.js cleanup-status
```

## Verification

Verify provider-side credential revocation separately. Confirm cleanup tasks are
verified and that deletion returns only the immutable non-secret report.

These commands do not test alpha session access, and this runbook does not
attempt to: proving a specific session is dead would require holding that
tester's cookie, which containment has just told you never to handle. The
evidence that sessions ended is the `sessionsRevoked` count returned by the
revocation transaction above, which revokes every unrevoked session for the
tester in the same transaction that revokes the tester.

```bash
set -euo pipefail
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js retention
```

## Recovery

Do not restore purged tester data. A future enrollment requires a new invitation and new provider authorization after the deletion report is complete.

## Evidence

Record tester reference, reason category, revocation timestamps, provider revocation confirmation, cleanup digest, purge-report digest, and retained-integrity categories. Exclude identity, cookie, and credential values.

```bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
