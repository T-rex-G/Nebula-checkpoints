# Database backup, migration, and isolated restore

## Trigger

Use this runbook before migration, for the weekly backup rehearsal, or when database recovery evidence is required.

## Containment

Freeze new invitations and mutations. Use a trusted workstation with `pg_dump` and `pg_restore`; never create plaintext backup material on Render. The restore target must be an isolated Neon branch, never the cohort database.

```bash
node scripts/alpha-db.js backup --output-dir "$NV_BACKUP_OUTPUT_DIR"
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
```

## Verification

Verify the fresh backup before migration, apply/verify migrations through the operator CLI, then restore into the separately configured target.

```bash
node scripts/alpha-db.js migrate --backup-manifest "$NV_BACKUP_MANIFEST"
node scripts/alpha-db.js restore --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
node scripts/alpha-smoke.js
```

## Recovery

Keep the encrypted backup outside source control. Promote no restored data automatically; record schema/count/smoke proof and use a separately approved recovery decision if cohort replacement is necessary.

## Evidence

Record source commit, backup/manifest paths, non-secret digests, `015_alpha_privacy`, isolated target reference, table counts, smoke output, and plaintext-cleanup confirmation.

```bash
sha256sum "$NV_BACKUP_FILE" "$NV_BACKUP_MANIFEST"
git status --short
```
