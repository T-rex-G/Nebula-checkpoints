# Tester revocation and alpha-data deletion

## Trigger

Use this runbook for tester removal, compromised access, consent withdrawal, or an authenticated deletion request.

## Containment

Revoke the invitation/tester, end alpha and provider sessions, stop new mutations, and begin provider-resource cleanup before purging retained alpha data.

```bash
node scripts/alpha-invites.js revoke --tester "$NV_TESTER_ID" --reason "$NV_REVOCATION_REASON"
node scripts/alpha-privacy.js cleanup-status
curl --proto '=https' --fail --silent --show-error -X POST "$NV_ALPHA_BASE_URL/api/alpha/end" -H 'X-NV: 1' -H "Cookie: $NV_ALPHA_COOKIE"
```

## Verification

Verify provider-side credential revocation separately. Confirm cleanup tasks are verified, the alpha session no longer works, and deletion returns only the immutable non-secret report.

```bash
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js retention
```

## Recovery

Do not restore purged tester data. A future enrollment requires a new invitation and new provider authorization after the deletion report is complete.

## Evidence

Record tester reference, reason category, revocation timestamps, provider revocation confirmation, cleanup digest, purge-report digest, and retained-integrity categories. Exclude identity, cookie, and credential values.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
