# Service cold start or outage

## Trigger

Use this runbook when `/healthz` is unavailable, returns a non-200 response, or the service does not become live within the recorded Render cold-start window.

## Containment

Stop issuing invitations and announce a temporary mutation freeze. Do not redeploy until a Render wake-up is distinguished from a failed deploy.

```bash
curl --fail --silent --show-error "$NV_ALPHA_BASE_URL/healthz"
curl --silent --show-error --write-out '%{http_code}\n' --output /dev/null "$NV_ALPHA_BASE_URL/readyz"
```

If health becomes available while readiness remains unavailable, continue with the Neon runbook. If the process repeatedly restarts or health never appears, treat the active deploy as failed.

## Verification

Run the non-secret smoke client. A cold start may increase duration; it must not change response contracts.

```bash
node scripts/alpha-smoke.js
```

## Recovery

Resume invitations only after health, readiness, version, config, and capability checks pass twice with no intervening restart. Roll back only through the failed-deploy runbook.

## Evidence

Record UTC start/end times, Render deploy identifier, restart count, smoke JSON, source commit, and whether the event was a cold wake or failed deploy.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
