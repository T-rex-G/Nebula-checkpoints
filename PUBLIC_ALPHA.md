# Controlled Public Alpha

Hosted qualification is pending; the cohort is not open. Plan 2 final branch
review is pending, so this document does not claim that controlled access has
been accepted.

The first cohort is invitation-only, limited to 5–10 testers, uses sandbox repositories only, and is not a production service. This controlled invitation access remains a pre-acceptance branch implementation.

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
