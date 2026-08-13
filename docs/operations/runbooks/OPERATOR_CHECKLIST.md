# Public alpha operator checklist

Use sanitized outputs only. Never paste database URLs, cookies, invitation codes, provider credentials, application secrets, or backup keys into evidence.

## Before live qualification dispatch

- Pre-create one dedicated provider repository per selected provider. Its name
  must begin `nvx-alpha17-`; do not use the checkpoint repository or any
  production repository.
- Record the exact repository/API identity for each selected provider and, for
  hosted qualification, the exact service origin, Render service identity, and
  cohort/restore Neon project and branch identities, isolated-target kind, and
  reviewed restore-target fingerprint.
- Generate a fresh Ed25519 authorization envelope using schema `1.2.0`. The
  selected jobs must exactly match the dispatch switches, and every selected
  target hash must match the configured repository variables.
- Confirm the credential-free target preflight succeeds before the workflow
  reaches any secret-bearing step. Stop on any target or job mismatch.
- Expect cleanup to remove only the per-run branch and proof files. Repository
  deletion is outside the qualification harness and requires separate explicit
  authorization.

## Daily

- Check Render service state, active deploy, cold starts, and recent restarts.
- Check Neon storage, compute state, wake delays, and quota warnings.
- Review safe error/correlation counts and provider 429/5xx counts.
- Review pending cleanup tasks and deletion requests.
- Review active tester/invitation counts against the approved cohort.
- Confirm `/healthz`, `/readyz`, `/api/version`, `/api/config`, and capabilities.

```bash
set -euo pipefail
node scripts/alpha-smoke.js
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-invites.js list
date -u +%Y-%m-%dT%H:%M:%SZ
```

## Weekly

- Create an encrypted external backup from the trusted workstation.
- Verify the backup and rehearse restore into an isolated Neon branch. Copy the
  cohort and restore project/branch IDs from the Neon console, confirm the
  branch identities differ, and approve the exact sanitized target fingerprint
  before supplying `NV_RESTORE_TARGET_FINGERPRINT`.
- Run retention and review immutable cleanup/deletion evidence.
- Review published limits against safe load evidence; limits may decrease only.

```bash
set -euo pipefail
NV_BACKUP_RESULT="$(node scripts/alpha-db.js backup --output-dir "$NV_BACKUP_OUTPUT_DIR")"
NV_BACKUP_FILE="$(node -e 'const r=JSON.parse(process.argv[1]); if(typeof r.backupPath!=="string"||!r.backupPath)process.exit(2); process.stdout.write(r.backupPath)' "$NV_BACKUP_RESULT")"
NV_BACKUP_MANIFEST="$(node -e 'const r=JSON.parse(process.argv[1]); if(typeof r.manifestPath!=="string"||!r.manifestPath)process.exit(2); process.stdout.write(r.manifestPath)' "$NV_BACKUP_RESULT")"
readonly NV_BACKUP_FILE NV_BACKUP_MANIFEST
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
unset NV_RESTORE_TARGET_FINGERPRINT
node scripts/alpha-db.js restore-target
```

Stop after the sanitized `restore-target` preview. Confirm the cohort and
restore project/branch identities differ, review the exact fingerprint, and set
`NV_RESTORE_TARGET_FINGERPRINT` to that reviewed value. Continue in the same
shell so the readonly backup paths remain bound to the just-created backup.
Only then run the destructive restore block:

```bash
set -euo pipefail
test -n "${NV_RESTORE_TARGET_FINGERPRINT:-}"
node scripts/alpha-db.js restore --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
node scripts/alpha-privacy.js retention
node scripts/alpha-load.js
```

## Before any deploy or migration

- Confirm the exact clean source commit and Node 22 runtime.
- Create and verify a fresh encrypted backup.
- Record migration compatibility and rollback decision.
- Keep live mutations frozen until smoke and readiness pass.

```bash
set -euo pipefail
git status --short
git rev-parse HEAD
node --version
sha256sum "$NV_BACKUP_FILE" "$NV_BACKUP_MANIFEST"
```
