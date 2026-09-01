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
- Generate a fresh Ed25519 authorization envelope using schema `1.3.0`. The
  selected jobs must exactly match the dispatch switches, every selected target
  hash must match the configured repository variables, and `ref` must name the
  exact ref the dispatch runs on.
- Allocate a new `authorizationId` for every dispatch. An identifier is spent on
  first use and is refused afterwards, so re-signing a spent approval with a
  later expiry does not produce a second activation. A dispatch that the
  verifier rejects does not spend its identifier and may be corrected and
  retried unchanged.
- Re-running an authorized workflow run is not a retry. It presents the same
  spent identifier and is refused, so recover by signing a fresh approval and
  dispatching again.
- Confirm the credential-free target preflight succeeds before the workflow
  reaches any secret-bearing step. Stop on any target or job mismatch.
- Expect cleanup to remove only the per-run branch and proof files. Repository
  deletion is outside the qualification harness and requires separate explicit
  authorization.

## After live qualification, before the go/no-go

- Sign the restore witness. The restore runner signs its record with a key it
  generates inside its own job and destroys when the job ends, so that
  signature cannot be verified anywhere else. Without your witness, a restore
  record with invented digests passes every other check the gate makes.

  Download the hosted evidence artifact from the run, then:

  ```
  NV_ALPHA17_OPERATOR_KEY_ID=<your key id> \
  NV_ALPHA17_OPERATOR_PRIVATE_KEY_BASE64=<your Ed25519 PKCS#8 DER, base64> \
  node scripts/sign-restore-witness.js hosted.json > restore-witness.json
  ```

  The command prints what you are witnessing before it signs anything. Read the
  run identity and confirm it against the workflow run you authorized. Your
  signature says *this record came from that run*; it does not endorse the
  restore's claims, which the gate checks separately. Signing a record from a
  run you cannot identify defeats the control entirely.

- Pass the witness to the gate as `NV_PUBLIC_ALPHA_RESTORE_WITNESS`. The gate
  refuses to produce a verdict without it, by design: an unwitnessed restore
  proof is not a weaker proof, it is an unverifiable one.

- Keep the private key off the runner and out of the repository. It is the
  operator key, not a CI secret; a copy inside CI would make the witness
  forgeable by anyone who can run the workflow, which is the exact gap it
  exists to close.

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
- Verify the target environment is completely configured before deploying, not
  after. `npm run doctor` evaluates the environment against
  `src/config-registry.js`, which names every variable this project reads, and
  exits non-zero when something the selected profile requires is absent. It
  calls the server's own configuration loaders rather than repeating their
  rules, so a pass is the answer the process will give at startup. It reports
  only whether a value is set, never the value, and is safe to run on the
  server.
- Create and verify a fresh encrypted backup.
- Record migration compatibility and rollback decision.
- Keep live mutations frozen until smoke and readiness pass.

```bash
set -euo pipefail
git status --short
git rev-parse HEAD
node --version
npm run doctor                 # exits non-zero if the profile is incomplete
npm run doctor -- --group=ci   # only when dispatching live qualification
sha256sum "$NV_BACKUP_FILE" "$NV_BACKUP_MANIFEST"
```

`NV_MAINTENANCE_MODE=1` closes the API with `503` while keeping `/healthz`
green and draining `/readyz`. Use it to hold traffic during a migration; unset
it or set `0` to return to service. It is read at startup, so changing it on
Render redeploys the service, which is what applies it.
