# Release and Security Gates

Hosted public-alpha qualification for `5.3.0-alpha.17.0` is **Pending**. Every
gate below is release-blocking and must bind to the exact candidate, commit,
archive hash, schema version, Node version, execution time, and cleanup result.

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

## Accessibility gates

- Zero serious/critical axe findings on the golden path.
- Keyboard, focus, dialog, labels, landmarks, status announcements, contrast,
  non-colour state, reduced motion, 200% reflow, and mobile checks.
- One manual VoiceOver iOS pass and one manual desktop screen-reader pass.

A pass is public-alpha accessibility qualification, not legal certification.

## Live-provider gates

- GitHub must pass the complete golden path.
- GitLab and Gitea must each pass every capability advertised as `Supported`.
- Disposable mutations must prove stale-head rejection, exact readback,
  insufficient-permission denial, and verified cleanup.
- `Experimental` paths remain isolated and limitation-labelled.

## Hosted Render/Neon gates

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
