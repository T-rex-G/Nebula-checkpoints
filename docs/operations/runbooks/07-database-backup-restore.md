# Database backup, migration, and isolated restore

## Trigger

Use this runbook before migration, for the weekly backup rehearsal, or when database recovery evidence is required.

## Containment

Freeze new invitations and mutations. Use a trusted workstation with `pg_dump` and `pg_restore`; never create plaintext backup material on Render. The restore target must be an isolated Neon branch, never the cohort database.

```bash
set -euo pipefail
node scripts/alpha-db.js backup --output-dir "$NV_BACKUP_OUTPUT_DIR"
node scripts/alpha-db.js verify --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
```

## Verification

Verify the fresh backup before migration and apply/verify migrations through the operator CLI. In the Neon console, confirm the cohort and restore project/branch IDs and that the restore branch is isolated. Both database URLs must explicitly use `sslmode=verify-full`. On the trusted workstation only, set a transient `NEON_API_KEY`; the CLI uses Neon’s [official connection-URI endpoint](https://api-docs.neon.tech/reference/getconnectionuri) to bind both declared branches to the configured URLs and opens the target to verify its database and role.

The required environment is `DATABASE_URL`, `NV_RESTORE_DATABASE_URL`, `NV_BACKUP_KEY_BASE64`, `NEON_API_KEY`, `NV_COHORT_NEON_PROJECT_ID`, `NV_COHORT_NEON_BRANCH_ID`, `NV_RESTORE_NEON_PROJECT_ID`, `NV_RESTORE_NEON_BRANCH_ID`, and `NV_RESTORE_TARGET_KIND=isolated-neon-branch`. Run `restore-target` with `NV_RESTORE_TARGET_FINGERPRINT` unset, retain its sanitized JSON externally, compare every printed identity with the Neon console, and record its exact `fingerprint`. Only then set `NV_RESTORE_TARGET_FINGERPRINT` to that reviewed value. The destructive restore recomputes the fingerprint and repeats control-plane and live-session verification before decryption. Stop on any API, TLS, live-session, URL, project, branch, kind, or fingerprint mismatch. Unset `NEON_API_KEY` after the rehearsal.

```bash
set -euo pipefail
: "${DATABASE_URL:?set the cohort URL with sslmode=verify-full}"
: "${NV_RESTORE_DATABASE_URL:?set the isolated restore URL with sslmode=verify-full}"
: "${NV_BACKUP_KEY_BASE64:?set the transient backup key}"
: "${NEON_API_KEY:?set a transient Neon control-plane key}"
: "${NV_COHORT_NEON_PROJECT_ID:?set the cohort project ID}"
: "${NV_COHORT_NEON_BRANCH_ID:?set the cohort branch ID}"
: "${NV_RESTORE_NEON_PROJECT_ID:?set the restore project ID}"
: "${NV_RESTORE_NEON_BRANCH_ID:?set the restore branch ID}"
test "${NV_RESTORE_TARGET_KIND:?set the restore kind}" = "isolated-neon-branch"
node scripts/alpha-db.js migrate --backup-manifest "$NV_BACKUP_MANIFEST"
unset NV_RESTORE_TARGET_FINGERPRINT
node scripts/alpha-db.js restore-target
```

After the sanitized preview has been reviewed and its exact fingerprint has
been set out of band, run the destructive phase separately:

```bash
set -euo pipefail
: "${NV_RESTORE_TARGET_FINGERPRINT:?set only the exact reviewed fingerprint from restore-target}"
node scripts/alpha-db.js restore --backup "$NV_BACKUP_FILE" --manifest "$NV_BACKUP_MANIFEST"
node scripts/alpha-smoke.js
unset NEON_API_KEY
```

## Recovery

Keep the encrypted backup outside source control. Promote no restored data automatically; record schema/count/smoke proof and use a separately approved recovery decision if cohort replacement is necessary.

## Evidence

Record source commit, backup/manifest paths, non-secret digests, `015_alpha_privacy`, isolated target reference, table counts, smoke output, and plaintext-cleanup confirmation.

```bash
set -euo pipefail
sha256sum "$NV_BACKUP_FILE" "$NV_BACKUP_MANIFEST"
git status --short
```

For the protected Alpha.17 live-qualification workflow, configure the
`alpha17-live-qualification` environment with secrets
`ALPHA17_DATABASE_URL`, `ALPHA17_RESTORE_DATABASE_URL`,
`ALPHA17_BACKUP_KEY_BASE64`, and `ALPHA17_NEON_API_KEY`; configure variables
`ALPHA17_NEON_PROJECT_ID`, `ALPHA17_COHORT_NEON_BRANCH_ID`,
`ALPHA17_RESTORE_NEON_PROJECT_ID`, `ALPHA17_RESTORE_NEON_BRANCH_ID`, and the
out-of-band-reviewed `ALPHA17_RESTORE_TARGET_FINGERPRINT`. The hosted job
requires authorization schema `1.2.0`; its target hash binds all of those
project/branch identifiers, the isolated-target kind, and the reviewed
fingerprint. It verifies that signed target and installs the frozen candidate without lifecycle
scripts before any of these secrets are exposed. Its reviewed runner then
creates a fresh encrypted backup, verifies the isolated target, performs the
restore, records migration/count evidence, removes the backup directory, and
writes a bounded credential-free runner attestation directly under
`RUNNER_TEMP`.

Only the final sanitized hosted envelope is uploaded. It binds that complete
runner record and its SHA-256; neither the encrypted dump, its manifest, nor the
standalone runner record is an Actions artifact. The separate Ed25519-signed
operator record covers only the remaining console/operational observations and
must not claim `isolated-database-restore`.
