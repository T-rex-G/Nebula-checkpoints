# Tester revocation and alpha-data deletion

## Trigger

Use this runbook for tester removal, compromised access, consent withdrawal, or an authenticated deletion request.

## Containment

Revoke the invitation/tester, stop new mutations, and begin provider-resource cleanup before purging retained alpha data.

Revocation ends every alpha session the tester owns, so there is no separate
session-end call here. Adding one would fail the block rather than harden it:
the session it would target has just been revoked, so the request is refused and
`--fail` aborts containment on success. Provider sessions are revoked at the
provider. Verification below confirms the alpha session no longer works.

```bash
set -euo pipefail
node scripts/alpha-invites.js revoke --tester "$NV_TESTER_ID" --reason "$NV_REVOCATION_REASON"
node scripts/alpha-privacy.js cleanup-status
```

## Verification

Verify provider-side credential revocation separately. Confirm cleanup tasks are verified, the alpha session no longer works, and deletion returns only the immutable non-secret report.

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
