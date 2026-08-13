# Provider outage or rate limit

## Trigger

Use this runbook for provider 429 responses, repeated provider 5xx responses, or a capability becoming temporarily unavailable.

## Containment

Stop mutation retries immediately. Preserve the last expected-head value and do not convert a failed write into an unconditional write. Read-only checks may continue within provider limits.

```bash
set -euo pipefail
curl --proto '=https' --fail --silent --show-error "$NV_ALPHA_BASE_URL/api/capabilities?provider=$NV_PROVIDER&authority=$NV_PROVIDER_AUTHORITY"
node scripts/alpha-privacy.js cleanup-status
```

## Verification

Confirm provider status and rate-reset evidence without exposing credential headers. Verify that unsupported actions remain disabled and that no automatic mutation retry occurred.

```bash
set -euo pipefail
node scripts/alpha-smoke.js
```

## Recovery

After the provider recovers, re-read the disposable target head. Resume a mutation only with a fresh expected head and explicit operator action. Complete or verify any cleanup task before reopening tester writes.

## Evidence

Record provider, authority, safe status code counts, correlation identifiers, expected-head digest, retry count, cleanup status, and UTC recovery time. Exclude repository names and credentials.

```bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
