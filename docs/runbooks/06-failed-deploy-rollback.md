# Failed deploy and rollback

## Trigger

Use this runbook when the new Render deploy fails health/startup, repeatedly restarts, or produces a release-blocking regression.

## Containment

Stop invitations and mutations. Preserve the failed deploy logs and exact source commit. Before selecting an older application image, determine whether its migration contract is compatible with the current database.

```bash
curl --silent --show-error "$NV_ALPHA_BASE_URL/healthz"
curl --silent --show-error "$NV_ALPHA_BASE_URL/readyz"
git rev-parse HEAD
```

Do not roll back across an incompatible migration. Use maintenance containment plus an isolated, verified database restore instead.

## Verification

Verify the encrypted pre-deploy backup and record the current migration before any rollback decision.

```bash
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
```

## Recovery

Roll back in Render only when compatibility is recorded. Otherwise restore into the isolated target, verify `015_alpha_privacy`, then execute the approved database recovery decision. Run smoke twice after recovery.

## Evidence

Record failed and recovery deploy IDs, source commits, migration compatibility decision, backup manifest digest, rollback/restore timestamps, and smoke outputs.

```bash
sha256sum "$NV_BACKUP_MANIFEST"
date -u +%Y-%m-%dT%H:%M:%SZ
```
