# Neon outage, wake delay, or quota warning

## Trigger

Use this runbook when `/readyz` reports `waking`, `unavailable`, `migration-mismatch`, or when Neon reports a storage/compute quota warning.

## Containment

Stop new invitations and repository mutations. Enable the operator maintenance state in Render and keep PostgreSQL-backed sessions, governance, and alpha operations fail-closed. Never downgrade to cookie-only persistence.

```bash
set -euo pipefail
NV_READY_RESPONSE="$(mktemp)"
trap 'rm -f -- "$NV_READY_RESPONSE"' EXIT
NV_READY_TRANSPORT_EXIT=0
curl --proto '=https' --fail --silent --show-error --max-time 10 --write-out '%{http_code}\n' --output /dev/null "$NV_ALPHA_BASE_URL/healthz" | grep -qx '200'
NV_READY_STATUS="$(curl --proto '=https' --silent --show-error --max-time 10 --write-out '%{http_code}' --output "$NV_READY_RESPONSE" "$NV_ALPHA_BASE_URL/readyz")" || NV_READY_TRANSPORT_EXIT=$?
printf 'ready_status=%s ready_transport_exit=%s\n' "$NV_READY_STATUS" "$NV_READY_TRANSPORT_EXIT"
cat "$NV_READY_RESPONSE"
node scripts/alpha-privacy.js cleanup-status
```

Readiness is recorded, not asserted, because `waking`, `unavailable` and
`migration-mismatch` are the states that bring you to this runbook. Requiring
HTTP 200 here would abort containment exactly when it is needed. The liveness
probe still requires 200: the application being reachable is a precondition for
the rest of this block.

Do not retry migrations when readiness says `migration-mismatch`; use the backup/migration runbook.

## Verification

Confirm Neon service state and quota in its console, then verify that health remains live and readiness exposes no host, URL, exception, or quota identifier.

```bash
set -euo pipefail
node scripts/alpha-smoke.js
```

## Recovery

Wait for Neon to recover or reduce load within the approved limits. Disable maintenance containment only after readiness reports `connected` or an accepted `quota-warning`, smoke passes, and pending cleanup remains bounded.

## Evidence

Record UTC timestamps, safe readiness JSON, Neon incident/quota category, pending cleanup counts, recovery action, and source commit. Do not capture database URLs or console secrets.

```bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
