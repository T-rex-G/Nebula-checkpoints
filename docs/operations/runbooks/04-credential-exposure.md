# Credential exposure

## Trigger

Use this runbook when a provider credential, invitation code, session material, application secret, or backup key may have been disclosed.

## Containment

Choose the containment order from the exposed credential type:

- For an invitation, session cookie, or application/session secret, freeze invitations and mutations first, revoke the affected tester, and invalidate active sessions before rotating the affected Render value.
- For a provider credential, revoke it at the provider first, then freeze the affected tester and complete provider-resource cleanup.
- For a backup key, stop backup/restore operations first and preserve controlled access to the old key until every retained encrypted backup has been re-keyed or expired.

Do not delay the first applicable containment action while investigating unrelated credential classes.

```bash
node scripts/alpha-invites.js revoke --tester "$NV_TESTER_ID" --reason "$NV_REVOCATION_REASON"
node scripts/alpha-privacy.js cleanup-status
```

Never paste the exposed value into logs, tickets, evidence, or commands.

## Verification

Confirm provider revocation independently, confirm the tester cannot redeem or resume a session, and verify provider cleanup ownership before closing the incident.

```bash
node scripts/alpha-smoke.js
node scripts/alpha-privacy.js cleanup-status
```

## Recovery

Issue replacement credentials only after the source of exposure is removed. Redeploy with rotated Render values, invalidate active sessions, and re-enroll only approved testers.

## Evidence

Record credential type, provider-side revocation time, affected tester hash/reference, rotations performed, cleanup result, source commit, and scanner result. Record no credential value.

```bash
node scripts/check-secrets.js
date -u +%Y-%m-%dT%H:%M:%SZ
```
