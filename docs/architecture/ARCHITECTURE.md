# Nebulaverse-X Architecture

## Current implemented foundation

Nebulaverse-X is one Node.js web service with browser-delivered workspaces and
provider adapters for GitHub, GitLab, and Gitea. PostgreSQL is optional for
basic repository work and required for durable sessions, verified events,
governance, and invitation access when invite mode is enabled. Durable state belongs in
Neon or the provider; Render local storage is disposable.

Repository mutations pass through server authentication, CSRF/origin checks,
step-up authorization where required, provider capability enforcement, a
central mutation gateway, provider permission and governance-role resolution,
and active-policy evaluation before provider transport. The server-owned
capability registry is projected read-only to the browser; client controls are
advisory, never an authorization boundary.

## Data and evidence boundaries

- Provider credentials remain in encrypted server sessions or the optional
  GitHub App broker and are never capability metadata.
- Governance policies, approvals, decisions, exceptions, notifications, and
  signed export evidence use immutable or append-only PostgreSQL records.
- Private governance evidence is live/network-only in the browser.
- PWA private caching is opt-in, bounded, scope-partitioned, and excludes raw
  files, sessions, security, recovery, evidence, and writes.
- Uploads are streamed through bounded temporary storage and the built-in
  signature gate before supported writes; optional YARA is not a hosted claim.

## Alpha privacy and credential lifecycle

One privacy store owns tester bindings, structured feedback, cleanup evidence,
deletion requests, immutable purge reports, retention, and cohort closure. One
provider-disconnect service owns sequential session removal and provider
resource cleanup. Disconnect fails closed when webhook absence or ownership is
not verified; provider-side PAT, OAuth, and App revocation is always described
as a separate provider action.

The browser presents **Disconnect from Nebulaverse-X**, **Revoke at provider**,
**End alpha session**, and **Delete alpha data** as distinct operations. Every
identity boundary clears offline writes, session storage, in-memory repository
state, scoped API caches, and CSRF state. The service worker deletes only
private `nv-api-` caches and preserves the static shell.

Retention uses the published cutoffs: 7 days for alpha/provider sessions, 14
days for operational logs, 30 days for verified events, 30 days for snapshots,
30 days for evidence exports, and 30 days for invite/revocation metadata after
cohort close. Deletion may preserve retained pseudonymous integrity metadata
containing hashes and timestamps; it never preserves credentials, repository
content, provider payloads, or human-readable tester identity.

## Controlled-alpha boundary

The controlled hosted architecture applies two independent checks: invitation
access and provider authorization. Neither check grants the other. Each tester
is additionally restricted to exact canonical sandbox-repository allowlists in
`provider:hostname/owner/repository` form, checked before provider credential
resolution or transport. The cohort accepts root-host-only GitLab and Gitea
installations; path-rooted provider installations remain unavailable even
though the broader product retains that capability.

GitHub repository creation/deletion, code search, and notifications are usable
experimental operations through ordinary connected accounts. Exact invitation
scopes still bound creation targets, deletion targets, search, and notifications.
Creation verifies the provider identity and repository readback; deletion keeps
fresh step-up, full-name confirmation, and provider administrator checks.
Connection-specific restrictions are privately projected to the interface.
Cohort administration remains a local-only invite CLI. Plaintext
invitation secrets are displayed once at issue time; PostgreSQL retains only a
keyed digest, never the plaintext code. The branch implements these controls,
but Plan 2 final branch review is pending and this architecture description is
not an acceptance claim.

The intended environment is one dedicated Render Free service and one dedicated
Neon Free PostgreSQL project, with distinct secrets and callback origin. Invite
mode fails closed until the operator supplies its dedicated `DATABASE_URL`, a
stable invitation pepper of at least 32 bytes, and terms version `2026-07-29`. Hosted
qualification, backup/restore, rollback, and cohort access remain pending
release gates. The privacy lifecycle is package-bound here; live qualification
remains a later exact-candidate release gate.

The CLI/store label and revocation-reason limits currently count JavaScript
UTF-16 code-unit values while PostgreSQL counts Unicode code point values. This
known minor remains deferred until the CLI and store contract change together.

Durable technical decisions are recorded in the
[architecture decision record](ARCHITECTURE_DECISIONS.md).

## Hosted operations boundary

The public-alpha service uses a verify-only hosted startup: the web process
checks that the numbered PostgreSQL migrations match the candidate and reports
a safe readiness state, but never silently changes an unknown schema. Migration
and recovery commands run from a trusted operator workstation with database
credentials supplied through the environment rather than command arguments.

Every hosted migration is preceded by an external encrypted backup whose
authenticated metadata and ciphertext digest are verified. Recovery is first
rehearsed as an isolated restore into a separate database branch. Render local
storage is treated as ephemeral and is never a backup destination. The live
Render/Neon and provider qualification still belongs to the exact-candidate
release gate.
