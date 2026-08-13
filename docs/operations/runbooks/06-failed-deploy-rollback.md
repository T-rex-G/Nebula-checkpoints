# Failed deploy and rollback

## Trigger

Use this runbook when the new Render deploy fails health/startup, repeatedly restarts, or produces a release-blocking regression.

## Containment

Stop invitations and mutations. In the Render deploy record, capture the failed deploy ID and its source commit; do not substitute the operator workstation's checkout. Preserve the failed deploy logs. Before selecting an older application image, determine whether its migration contract is compatible with the current database.

```bash
set -euo pipefail
curl --proto '=https' --fail --silent --show-error --max-time 10 --write-out '%{http_code}\n' --output /dev/null "$NV_ALPHA_BASE_URL/healthz" | grep -qx '200'
curl --proto '=https' --fail --silent --show-error --max-time 10 --write-out '%{http_code}\n' --output /dev/null "$NV_ALPHA_BASE_URL/readyz" | grep -qx '200'
test -n "$NV_FAILED_RENDER_DEPLOY_ID"
test "${#NV_FAILED_RENDER_SOURCE_COMMIT}" -eq 40
printf '%s\n' "$NV_FAILED_RENDER_SOURCE_COMMIT" | grep -qxE '[0-9a-f]{40}'
```

Do not roll back across an incompatible migration. Use maintenance containment plus an isolated, verified database restore instead.

## Verification

Verify the encrypted pre-deploy backup and record the current migration before any rollback decision.

```bash
set -euo pipefail
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
```

## Recovery

Roll back in Render only when compatibility is recorded. Otherwise restore into the isolated target, verify `015_alpha_privacy`, then execute the approved database recovery decision. Run smoke twice after recovery.

## Evidence

Record failed and recovery deploy IDs, source commits, migration compatibility decision, backup manifest digest, rollback/restore timestamps, and smoke outputs.

```bash
set -euo pipefail
sha256sum "$NV_BACKUP_MANIFEST"
date -u +%Y-%m-%dT%H:%M:%SZ
```
