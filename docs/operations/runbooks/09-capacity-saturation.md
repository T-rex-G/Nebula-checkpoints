# Capacity saturation

## Trigger

Use this runbook for repeated 429/503 responses, upload-slot exhaustion, memory pressure, Neon quota warning, or sustained latency outside the accepted cohort baseline.

## Containment

Stop issuing invitations. Lower—not raise—the hosted limits in Render. Allow at most one active mutation to finish safely; otherwise abort it and verify cleanup before admitting more work.

```bash
set -euo pipefail
node scripts/alpha-smoke.js
node scripts/alpha-load.js
node scripts/alpha-privacy.js cleanup-status
```

## Verification

Compare p50/p95, status counts, restart observations, active tester count, and pending cleanup against the accepted baseline. Confirm no limit exceeds the published Free-plan envelope.

```bash
set -euo pipefail
NV_CONFIG_RESPONSE="$(mktemp)"
NV_READY_RESPONSE="$(mktemp)"
trap 'rm -f -- "$NV_CONFIG_RESPONSE" "$NV_READY_RESPONSE"' EXIT
NV_CONFIG_TRANSPORT_EXIT=0
NV_READY_TRANSPORT_EXIT=0
NV_CONFIG_STATUS="$(curl --proto '=https' --silent --show-error --max-time 10 --write-out '%{http_code}' --output "$NV_CONFIG_RESPONSE" "$NV_ALPHA_BASE_URL/api/config")" || NV_CONFIG_TRANSPORT_EXIT=$?
NV_READY_STATUS="$(curl --proto '=https' --silent --show-error --max-time 10 --write-out '%{http_code}' --output "$NV_READY_RESPONSE" "$NV_ALPHA_BASE_URL/readyz")" || NV_READY_TRANSPORT_EXIT=$?
printf 'config_status=%s config_transport_exit=%s ready_status=%s ready_transport_exit=%s\n' \
  "$NV_CONFIG_STATUS" "$NV_CONFIG_TRANSPORT_EXIT" "$NV_READY_STATUS" "$NV_READY_TRANSPORT_EXIT"
cat "$NV_CONFIG_RESPONSE"
cat "$NV_READY_RESPONSE"
test "$NV_CONFIG_TRANSPORT_EXIT" -eq 0
test "$NV_READY_TRANSPORT_EXIT" -eq 0
test "$NV_CONFIG_STATUS" = 200
test "$NV_READY_STATUS" = 200
```

The probes record status and body without `--fail` so a degraded response is
captured as evidence, and the assertions run afterwards. Verification therefore
prints what it saw and then fails, rather than passing silently because `curl`
does not treat an HTTP 503 as an error.

## Recovery

Resume invitations gradually only after load and smoke pass with the reduced limits and no orphaned mutation. If the small cohort cannot remain within Free-plan limits, keep enrollment closed.

## Evidence

Record safe aggregate load JSON, config limits, status counts, restart count, cleanup result, containment change, and UTC recovery time. Never record cookies or repository names.

```bash
set -euo pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
