# Credential exposure

## Trigger

Use this runbook when a provider credential, invitation code, session material, application secret, or backup key may have been disclosed.

## Containment

Choose the containment order from the exposed credential type:

- For an exposed invitation, revoke the invitation code itself. An unredeemed invitation has no tester behind it, so tester revocation cannot reach it and the code stays redeemable for its whole lifetime. If it has already been redeemed, `revoke-invite` refuses and names that state: revoke the tester instead, which also ends its sessions.
- For a session cookie or application/session secret, freeze invitations and mutations first, revoke the affected tester, and invalidate active sessions before rotating the affected Render value.
- For a provider credential, revoke it at the provider first, then freeze the affected tester and complete provider-resource cleanup.
- For an exposed `GITHUB_APP_PRIVATE_KEY_BASE64`, delete the exposed private key in GitHub App settings before creating a replacement and updating the Render value.
- For a backup key, stop backup/restore operations first and preserve controlled access to the old key until every retained encrypted backup has been re-keyed or expired.

Do not delay the first applicable containment action while investigating unrelated credential classes.

Revoke the exposed invitation by its identifier, never by its code. The
identifier is the portion between `nvx_alpha_` and the separator, and
`alpha-invites.js list` prints it. Passing the code would place the secret in
shell history and process listings at the moment it is known to have leaked.

```bash
set -euo pipefail
node scripts/alpha-invites.js revoke-invite --invite "$NV_INVITE_ID"
```

`revoke-invite` exits non-zero unless it revoked the invitation, so a refusal
stops this block rather than reading as containment.

Then, for a redeemed invitation or any exposure with a tester behind it:

```bash
set -euo pipefail
node scripts/alpha-invites.js revoke --tester "$NV_TESTER_ID" --reason "$NV_REVOCATION_REASON"
node scripts/alpha-privacy.js cleanup-status
```

Record the reason in the incident record. The invitations table holds no reason
column, and adding one would move the migration head that qualification evidence
pins.

Never paste the exposed value into logs, tickets, evidence, or commands.

## Verification

Confirm provider revocation independently, confirm the tester cannot redeem or resume a session, and verify provider cleanup ownership before closing the incident.

```bash
set -euo pipefail
node scripts/alpha-smoke.js
node scripts/alpha-privacy.js cleanup-status
```

## Recovery

Issue replacement credentials only after the source of exposure is removed. Redeploy with rotated Render values, invalidate active sessions, and re-enroll only approved testers.

For an optional GitHub App exposure, rotate the affected credential at GitHub and in Render as one coordinated maintenance action:

- delete the exposed App private key in GitHub App settings, create a replacement, update `GITHUB_APP_PRIVATE_KEY_BASE64`, and redeploy;
- reset an exposed OAuth client secret, update `GITHUB_APP_CLIENT_SECRET`, and verify a fresh authorization callback; and
- replace an exposed GitHub webhook secret at both GitHub and Render, then verify a newly signed delivery. Do not retain the prior value as compatibility material.

After any `SESSION_SECRET` rotation, reconnect each approved verified-live-events integration and independently verify webhook delivery health; encrypted webhook secrets created under the old value are no longer readable.

## Evidence

Record credential type, provider-side revocation time, affected tester hash/reference, rotations performed, cleanup result, source commit, and scanner result. Record no credential value.

```bash
set -euo pipefail
node scripts/check-secrets.js
date -u +%Y-%m-%dT%H:%M:%SZ
```
