# Release and Security Gates

Public alpha: **NO-GO**

Throughout these documents *the recorded independent review* means the review of
the recorded baseline. A review that passed against a later successor is always
named as a remediation review, because it qualifies different bytes.

- Recorded automated baseline: **Passed**
- Recorded baseline's independent review: **Failed** — `912555dd-72ab-4662-9645-2313007eea3d`
- Latest remediation review: **Passed** — `4d47a6a5-e9d9-4a92-8a59-3883615069e8`
- Current successor: **Not qualified**
- Live-provider gate: **Pending**
- Hosted gate: **Pending**
- Manual accessibility gate: **Pending**
- Final release gate: **Pending**

The recorded baseline uses branch-head commit `3995a81e64ced1011f7e5c0662307f270c67e2b8`,
pull-request merge commit `379f96daa85709bbc4c002f60501819690b00de2`, tree
`b0945a403beaa4c4242a1d6526aa7c3d80d48f08`, and archive SHA-256
`58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711`.
Qualification run `32540542682` passed 142/142 program checks, 60/60 browser
checks, deterministic double packaging, extracted-archive execution, secret and
syntax scans, and zero production and development audit vulnerabilities.

Independent review `912555dd-72ab-4662-9645-2313007eea3d` then failed with 16
actionable findings and 8 nitpicks. That result is release-blocking. The
later review `04b93d36-47ea-402d-abda-ca6dfb2a9290` failed the pre-remediation
PR head with 30 actionable findings and 9 nitpicks (18 inline actions plus 12
summary/failed-post actions). The newest review,
`4ae300c4-410c-4ae7-89cc-b7e15767d22e`, failed the published remediation head
with 15 actionable findings and 10 nitpicks. That inventory was remediated, and
review `4d47a6a5-e9d9-4a92-8a59-3883615069e8` returned no actionable findings
against the recorded baseline above. Each further successor changes the archive
again and must earn a new external commit, tree, archive hash, evidence
envelope, and passing follow-up review.
Every gate must bind to that same exact candidate, schema, Node version,
execution time, and cleanup result.

## Automated gates

- Node.js 22 exact-lockfile clean install, full unit/contract suite, syntax, and
  secret scan.
- Deterministic double package build, safe fresh extraction, clean-install
  verification, and production audit with zero critical/high findings.
- Full development-audit classification.
- Desktop/mobile browser golden paths and capability/UI/server consistency.
- Invite replay, expiry, revocation, enumeration resistance, allowlist bypass,
  credential removal, browser purge, retention, and abuse tests.
- Webhook/temporary-branch cleanup, cold-start/degraded states, and
  backup/restore script validation.

## Dependency and security evidence

The following results are **pending for the exact frozen candidate**. Local
source checks or an earlier archive do not complete this record.

- Production dependency audit: `npm audit --omit=dev --audit-level=high`; zero
  critical/high findings required.
- Development dependency audit: record package, dependency path, severity,
  affected range, runtime or build exposure, and disposition for every finding.
  A finding may be accepted only when evidence shows it is unreachable from the
  production artifact and the disposition is explicit.
- Repository and staged-evidence secret scan: pass required, including generated
  qualification summaries and provider/hosted evidence.
- Security-boundary suite: pass required for invitation, allowlist, credential,
  mutation, cleanup, revocation, retention, and purge boundaries.
- Known release defects: zero critical/high findings required.

The external qualification record must contain command status, execution time,
Node version, source commit, archive SHA-256, tool/database version, sanitized
finding counts, and the immutable artifact reference. Do not store raw audit
reports containing paths, repository targets, provider responses, credentials,
or backup metadata in source. Any unresolved critical/high finding is a no-go;
it cannot be hidden by a summary or limitation entry.

## Accessibility gates

- Zero serious/critical axe findings on the golden path.
- Keyboard, focus, dialog, labels, landmarks, status announcements, contrast,
  non-colour state, reduced motion, 320 CSS-pixel/400% reflow, and mobile checks.
- One manual VoiceOver iOS pass and one manual desktop screen-reader pass.

A pass is public-alpha accessibility qualification, not legal certification.

## Live-provider gates

- GitHub must pass the complete golden path.
- GitLab and Gitea must each pass every capability advertised as `Supported`.
- Each provider uses a separately pre-created `nvx-alpha17-` sandbox repository.
  The signed activation binds its exact repository/API identity; qualification
  creates and deletes only a per-run temporary branch and proof files.
- Disposable mutations must prove stale-head write and delete rejection with
  zero commits, exact readback, insufficient-permission denial, a valid delete
  result bound to the observed advanced head, file absence, and verified cleanup.
- A target or selected-job mismatch must fail before any live request or
  credential-bearing step.
- `Experimental` paths remain isolated and limitation-labelled.
- Live credentials are disposable and scoped only to the exact pre-created
  sandbox repository. The candidate-supplied harness receives them only after
  exact-target authorization and environment approval. This assumes those exact
  bytes passed independent review; arbitrary hostile candidates require an
  egress-isolated runner or separately trusted harness.

## Hosted Render/Neon gates

- The signed activation binds the exact hosted origin, Render service identity,
  cohort/restore Neon project and branch identities, isolated-target kind, and
  reviewed restore fingerprint before hosted credentials or traffic are used.
- Before smoke or load traffic, the hosted harness independently hashes the
  exact candidate release tree and requires `/api/version` to report the same
  deterministic digest computed by the deployed process. The observed digest,
  not a hash derived from target metadata, is the hosted evidence deployment ID.
- Render cold start, Neon scale-to-zero wake, five concurrent invited read
  workflows, and one bounded mutation at a time.
- Memory/restart observation, active-session revocation, provider disconnect,
  filesystem independence, database interruption/recovery, provider 429/outage,
  deploy rollback, tested database restore, and tester purge.
- Encrypted pre-deploy backup and one isolated restore whose source/target URLs
  match official Neon branch connection URIs and whose destructive target is
  rechecked through a live database session; no dump in source, Actions
  artifacts, or Render local storage.
- The reviewed workflow runner—not the operator record—must execute and attest
  restore. The hosted envelope retains its complete bounded record and digest
  and requires backup-manifest/ciphertext, target-fingerprint, branch-identity,
  and sanitized restore-evidence hashes plus
  control-plane/live-session/migration/smoke/cleanup proof.
- A separately signed operator record may cover only the remaining console
  observations. The hosted envelope retains that record, key ID, and digest and
  rejects any operator-record `isolated-database-restore` claim.

## Manual go/no-go

Open the cohort only when all automated, accessibility, live-provider, and
hosted gates pass; no known critical/high release defect remains; every visible
feature is correctly status-labelled; privacy/terms/retention match runtime;
backup, rollback, revocation, cleanup, and purge are proven; limitations are
published; and the exact archive/checksum are frozen.

Any credential/session leak, invite or allowlist bypass, unverified mutation,
incomplete cleanup, destructive non-sandbox action, capability inconsistency,
untested restore, serious/critical golden-path accessibility defect, failed
revocation, or five-tester instability is a no-go.

The predecessor Task 21 qualification is historical evidence, not a pass for
these successor gates.

## Hosted-operations evidence state

- **Local hosted-operations gate: passed.** Deterministic tests cover readiness,
  migration verification, encrypted backup integrity, CLI argument secrecy,
  isolated restore orchestration, bounded smoke/load behavior, the Render
  blueprint, and incident-runbook contracts.
- **Live Render/Neon gate: pending.** The exact release candidate must still
  prove cold start, scale-to-zero recovery, external backup, isolated restore,
  migration, rollback, resource limits, smoke/load behavior, and tester/provider
  cleanup against the dedicated live services.

Local evidence cannot substitute for live-provider or hosted evidence, and the
cohort remains closed until the pending live gate is bound to the exact candidate.
