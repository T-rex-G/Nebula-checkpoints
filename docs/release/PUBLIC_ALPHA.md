# Controlled Public Alpha

Public alpha: **NO-GO**

The recorded `3995a81e64ced1011f7e5c0662307f270c67e2b8` alpha.17 baseline
passed automated exact-archive
qualification, but independent review failed with 16 actionable findings and 8
nitpicks. Review `04b93d36-47ea-402d-abda-ca6dfb2a9290` then failed the
pre-remediation PR head with 30 actionable findings and 9 nitpicks. The latest
review to fail, `4ae300c4-410c-4ae7-89cc-b7e15767d22e`, reported 15 actionable
findings and 10 nitpicks against the published remediation head. That inventory
was remediated and review `4d47a6a5-e9d9-4a92-8a59-3883615069e8` returned no
actionable findings. Each further successor changes packaged bytes again and is
**not qualified** until its own external archive identity, automated evidence,
and follow-up independent review pass.
Live-provider, hosted, manual
accessibility, and final release gates remain pending.

Hosted qualification is pending; the cohort is not open. Plans 1–3 are accepted
locally, and Plan 4's automated desktop/mobile UX and accessibility checkpoint
passes. Live hosted, provider, database and manual assistive-technology evidence
remain release gates and are not claimed here.

The first cohort is invitation-only, limited to 5–10 testers, uses sandbox repositories only, and is not a production service.
Controlled invitation access remains independent from provider authorization.
Live qualification uses separately pre-created `nvx-alpha17-` repositories;
the signed activation binds each exact target, and the harness deletes only its
per-run branch and proof files, never the repository.
The release-blocking limitation register is
`docs/qualification/PUBLIC_ALPHA_KNOWN_LIMITATIONS.md`, and the opening and
closing procedure is `docs/qualification/PUBLIC_ALPHA_COHORT_CHECKLIST.md`.

## Tester scope and onboarding

If the cohort opens, each tester receives a one-time invite, accepts the current
terms and sandbox rule, connects a least-privilege GitHub, GitLab, or Gitea
credential, and may select only repositories on the invite's exact canonical
allowlist. Repository scopes use the exact canonical
`provider:hostname/owner/repository` form. GitHub is the complete intended
golden path. Root-host-only GitLab and Gitea installations are eligible for the
cohort; installations whose provider base URL contains a path prefix remain
unavailable. GitLab and Gitea expose only their registry-qualified subsets.

Global notifications are unavailable because they cannot be constrained to an
invitation's exact repository allowlist. Repository creation and deletion are
unavailable, and global search is unavailable. These operations fail before
provider credentials or provider transport are used.

Do not use production repositories, irreplaceable source or data, active
deployment credentials, real secrets, regulated/personal data, or any repository
whose loss would cause material harm.

## Accessibility qualification

The supported golden-path screens pass automated desktop/mobile checks for
serious or critical axe findings, keyboard completion, focus containment and
restoration, live announcements, non-colour trust states, reduced motion and
320 CSS-pixel/400% reflow. Manual VoiceOver on iOS and one desktop screen-reader pass remain required before cohort opening. The manual record starts `Not executed` and no accessibility certification is claimed.

## Limits and hosting

The intended stack is one dedicated Render Free service and one dedicated Neon
Free project. Render Free may spin down after inactivity, takes time to wake,
has 512 MB RAM, 0.1 CPU, and ephemeral storage. Neon Free may scale to zero and
is bounded by its free storage and compute quotas. These constraints make the
service suitable for a small evaluation cohort, not production.

Key initial limits are 10 total live clients, two per repository, 16 MB Git data
and native push, 25 MB upload, one upload at a time, ten retained snapshots, and
a 5,000-entry snapshot manifest. Limits may be lowered after hosted measurement;
they are never unlimited claims.

## Credentials, privacy, and removal

Provider authorization is separate from invitation access. Prefer a
repository-selected GitHub App when configured, then suitable OAuth, then a
narrowly scoped short-lived token. Disconnecting Nebulaverse-X does not
necessarily revoke a provider credential; testers also receive provider-side
revocation guidance.

Operators issue, list, revoke, and purge invitations through the local-only
invite CLI, `node scripts/alpha-invites.js`; no privileged invite-management
route is exposed by the hosted web service. An issued high-entropy invitation
code is displayed only once. PostgreSQL stores its keyed digest, and no
plaintext invitation code is persisted.

The privacy notice covers opaque tester/invite IDs, provider identity metadata,
allowlisted repository IDs, encrypted sessions, verified events, governance and
recovery evidence, operational logs/correlation IDs, and structured feedback.
Repository content is not retained merely for analytics or feedback.

The default public-alpha retention schedule is explicit:

- 7 days for alpha and provider sessions;
- 14 days for operational logs where platform controls permit;
- 30 days for verified events;
- 30 days for recovery snapshots;
- 30 days for evidence exports; and
- 30 days for invite and revocation metadata after cohort close.

Settings exposes four separate actions with different consequences:

- **Disconnect from Nebulaverse-X** removes token-bearing application state
  after verified resource cleanup. It does not claim provider-side revocation.
- **Revoke at provider** first disconnects safely, then presents the exact
  provider-owned revocation destination.
- **End alpha session** clears the invitation-access cookie and all
  identity-bound browser data without claiming deletion.
- **Delete alpha data** requires typed confirmation, verified provider cleanup,
  local/browser purge, and an immutable non-secret completion report.

Required webhook/temporary-resource cleanup is verified before deletion is
reported complete. Minimal chain-integrity evidence may remain as retained
pseudonymous integrity metadata: hashes and timestamps only, never tester labels,
repository content, provider payloads, or credentials.

## Support and known constraints

Support bundles and feedback contain only version, correlation ID, provider,
feature, capability status, sanitized error code, timestamp, and runtime
metadata. Free-form descriptions are rejected. They exclude credentials,
repository content, diffs, and provider payloads.

Expected constraints include Render/Neon wake delay, bounded uploads and push,
provider-specific feature differences, GitHub-only verified live events for this
cohort, optional rather than full hosted YARA, and no production availability
commitment. Errors must state what happened, whether state changed, what is safe,
the next action, and a copyable correlation ID.

One implementation minor remains explicitly deferred: CLI and store label and
revocation-reason limits use JavaScript UTF-16 code-unit counts while PostgreSQL
uses Unicode code point counts. That mismatch requires a coordinated contract
change and is not claimed fixed here.

## Hosted operations qualification

Local hosted-operations qualification covers the fixed five-tester cohort
limits, fail-closed `/healthz` and `/readyz` projections, an encrypted backup
format, migration verification, isolated restore rehearsal, bounded smoke/load
clients, the Render blueprint contract, and the incident runbooks. The hosted
web process verifies migrations; it does not silently apply them.

Operators run `scripts/alpha-db.js` from a trusted workstation. Before a
migration they create and verify an encrypted backup outside the Render
filesystem, then rehearse an isolated restore before relying on that recovery
path. Smoke traffic is read-only by default; the load tool allows at most five
workers, ten reads, and one explicitly requested mutation.

For the protected live-qualification job, the same reviewed database operations
are orchestrated by `ci/run-alpha17-restore-validation.js` after signed-target
preflight. The runner removes its fresh backup material before emitting a
credential-free restore record; the final hosted envelope binds that record
separately from the signed operator observations. An operator record cannot
substitute for workflow-executed restore proof.

Live Render/Neon qualification remains pending. No live deployment, database
migration, backup, restore, smoke test, or provider mutation is claimed by the
local Plan 5 evidence.

## Final evidence trust inputs

The final gate is run from the exact frozen candidate tree on a trusted operator
workstation. Its subject digest and source commit, each provider authorization
target digest, hosted target digest, operator key ID, and Ed25519 public key are
supplied independently through the `NV_PUBLIC_ALPHA_*` and
`NV_ALPHA17_OPERATOR_*` environment variables documented in `.env.example`.
Those trusted values must come from the separately reviewed activation record
and operator key registry, not from the evidence bundle being verified.

The gate computes the deployment fingerprint from its own candidate tree. It
then requires the hosted evidence to bind that exact fingerprint, requires all
live evidence to bind the independently supplied target digests, and verifies
the hosted operator record's Ed25519 signature against the trusted public key.
A structurally valid or self-consistent evidence bundle is insufficient when
any external binding or cryptographic verification fails.
