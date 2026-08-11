# Controlled alpha shutdown

## Trigger

Use this runbook at the approved end of the cohort or when risk requires permanent shutdown.

## Containment

Stop invitations and mutations, revoke every tester and provider credential, end sessions, and complete provider hook/branch cleanup before closing infrastructure. Create and verify the final encrypted backup before closing the cohort. Stop immediately if backup verification fails; do not run `cohort-close` and do not decommission Render or Neon.

```bash
set -euo pipefail
node scripts/alpha-db.js backup --output-dir "$NV_BACKUP_OUTPUT_DIR"
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js cohort-close --confirm CLOSE-ALPHA
```

## Verification

Verify zero pending cleanup, cohort closure, final retention/purge reports, encrypted backup integrity, and absence of provider resources. Keep Render/Neon available until these checks finish.

```bash
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js retention
```

## Recovery

After evidence is complete, disable/delete the dedicated Render service and dedicated Neon project through their consoles. Preserve only the approved encrypted backup and non-secret evidence. Reopening requires a new cohort and new secrets.

## Evidence

Record closure authorization, tester/provider revocation counts, cleanup and purge digests, final backup digests, service/database closure timestamps, and evidence retention location.

```bash
sha256sum "$NV_BACKUP_FILE" "$NV_BACKUP_MANIFEST"
date -u +%Y-%m-%dT%H:%M:%SZ
```
