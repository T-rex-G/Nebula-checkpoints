# Release and Security Gates

Public alpha: **NO-GO**

- Recorded automated baseline: **Passed**
- Current documentation successor: **Not qualified**
- Live-provider gate: **Pending**
- Hosted gate: **Pending**
- Manual accessibility gate: **Pending**
- Final release gate: **Pending**

The recorded baseline is commit `4aa3c378475dd7fdb490b206e0ca3cb88d027bbf`,
tree `29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb`, and archive SHA-256
`d3e86f3aa16faefc165dca8acd726ca22f8a8f10fd5c943ef3addddbab40d2cc`.
Qualification run `31322778223` passed 137/137 program checks, 56/56 browser
checks, deterministic double packaging, extracted-archive execution, secret and
syntax scans, and zero production and development audit vulnerabilities.

That evidence applies only to the recorded bytes. The documentation-truth
successor changes the archive and must earn a new external commit, tree, archive
hash, and evidence envelope. Every remaining gate is release-blocking and must
bind to that same exact candidate, schema, Node version, execution time, and
cleanup result.

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
  non-colour state, reduced motion, 200% reflow, and mobile checks.
- One manual VoiceOver iOS pass and one manual desktop screen-reader pass.

A pass is public-alpha accessibility qualification, not legal certification.

## Live-provider gates

- GitHub must pass the complete golden path.
- GitLab and Gitea must each pass every capability advertised as `Supported`.
- Each provider uses a separately pre-created `nvx-alpha17-` sandbox repository.
  The signed activation binds its exact repository/API identity; qualification
  creates and deletes only a per-run temporary branch and proof files.
- Disposable mutations must prove stale-head rejection, exact readback,
  insufficient-permission denial, and verified cleanup.
- A target or selected-job mismatch must fail before any live request or
  credential-bearing step.
- `Experimental` paths remain isolated and limitation-labelled.

## Hosted Render/Neon gates

- The signed activation binds the exact hosted origin, Render service identity,
  and Neon project identity before hosted credentials or traffic are used.
- Before smoke or load traffic, the hosted harness independently hashes the
  exact candidate release tree and requires `/api/version` to report the same
  deterministic digest computed by the deployed process. The observed digest,
  not a hash derived from target metadata, is the hosted evidence deployment ID.
- Render cold start, Neon scale-to-zero wake, five concurrent invited read
  workflows, and one bounded mutation at a time.
- Memory/restart observation, active-session revocation, provider disconnect,
  filesystem independence, database interruption/recovery, provider 429/outage,
  deploy rollback, tested database restore, and tester purge.
- Encrypted pre-deploy backup and one isolated restore; no dump in source,
  Actions artifacts, or Render local storage.

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
