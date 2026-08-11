# Capacity saturation

## Trigger

Use this runbook for repeated 429/503 responses, upload-slot exhaustion, memory pressure, Neon quota warning, or sustained latency outside the accepted cohort baseline.

## Containment

Stop issuing invitations. Lower—not raise—the hosted limits in Render. Allow at most one active mutation to finish safely; otherwise abort it and verify cleanup before admitting more work.

```bash
node scripts/alpha-smoke.js
node scripts/alpha-load.js
node scripts/alpha-privacy.js cleanup-status
```

## Verification

Compare p50/p95, status counts, restart observations, active tester count, and pending cleanup against the accepted baseline. Confirm no limit exceeds the published Free-plan envelope.

```bash
curl --proto '=https' --fail --silent --show-error "$NV_ALPHA_BASE_URL/api/config"
curl --proto '=https' --fail --silent --show-error "$NV_ALPHA_BASE_URL/readyz"
```

## Recovery

Resume invitations gradually only after load and smoke pass with the reduced limits and no orphaned mutation. If the small cohort cannot remain within Free-plan limits, keep enrollment closed.

## Evidence

Record safe aggregate load JSON, config limits, status counts, restart count, cleanup result, containment change, and UTC recovery time. Never record cookies or repository names.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
