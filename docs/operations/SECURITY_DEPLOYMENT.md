# Security and deployment guide

## Controlled-alpha infrastructure

Nebulaverse-X 5.3.0-alpha.17.0 controlled alpha uses one dedicated Render Free
web service and one dedicated Neon Free PostgreSQL project. The Render blueprint
does not create a Render database, and neither environment may be reused for
production repositories or data.

The hosted web process verifies the expected migration set and fails readiness
when it is incomplete; it does not silently apply migrations. Operators apply
the versioned SQL migrations from a trusted workstation only after an encrypted
backup and isolated restore rehearsal. Migrations are additive and must not drop
existing application data as part of deployment.

Persistent sessions, security state, events, recovery evidence, governance,
controlled-alpha access, credential-cleanup, privacy, and audit records belong
in Neon. Render's filesystem is ephemeral and is never a backup boundary.

## Provider authorization evidence

Repository governance roles are resolved server-side from the active provider credential and exact repository scope. Browser-supplied roles, access levels, and installation permissions are ignored. GitHub App installation capability is not treated as human governance authority; the stored human authorizer must still have a current provider role for the repository.

Provider lookup failure does not globally disable existing non-governance repository workflows, but the resulting snapshot grants no governance authority. Governance APIs reject unavailable, stale, contradictory, or insufficient evidence and require durable PostgreSQL availability.

## Central Mutation Gateway

All repository-changing provider requests must carry a server-created mutation
context and are revalidated at the provider helper or Git transport boundary.
Unknown operations, provider/repository mismatches, action mismatches, and
missing critical step-up evidence fail before the outbound write. Active
governance policies are evaluated through the gateway in observe, warn, or
block mode with immutable decision evidence. This application boundary still
does not replace provider-native branch protection.


## Secrets

### `SESSION_SECRET`

Use the Render-generated value. It protects:

- Encrypted cookies
- Encrypted database session data
- Stored webhook secrets

Rotation response:

1. If the old value signed pre-migration snapshots, place it in the bounded
   `NV_SNAPSHOT_LEGACY_KEYS_JSON` compatibility keyring, deploy, and verify a
   retained snapshot **before** rotating `SESSION_SECRET`.
2. Rotate the value in Render and expect every session to be signed out.
3. Reconnect every approved verified-live-events integration because existing
   encrypted webhook secrets become unreadable, then independently verify
   webhook delivery health.
4. Remove the compatibility key only after every snapshot it signed expires.

### Evidence-ledger key

Evidence records are hashed with a key derived from `SESSION_SECRET` for that
purpose alone. Records written before that derivation existed were hashed with
the raw secret, so verification tries the derived key first and then the raw
one.

Accepting the raw secret lets anyone holding it forge evidence that verifies, so
production accepts it only when `NV_EVIDENCE_LEGACY_SESSION_KEY` is exactly
`true`. Leave it unset unless this deployment's ledger predates the derived key.

Two properties make this unlike the snapshot keyring. Evidence records never
expire, so there is no retention window to wait out: the compatibility key stays
needed for as long as those records must remain provable. And a deployment that
needs it is told so rather than left guessing, because verification reports
`legacyKeyRequired` when a record links correctly and would verify under the
retired key, which distinguishes an unmigrated chain from tampering.

Removal path:

1. Confirm the export reports `legacyRecords: 0` for every repository, which
   means no record still depends on the retired key.
2. Unset `NV_EVIDENCE_LEGACY_SESSION_KEY` and redeploy.
3. Verify each ledger still reports `valid: true` with `legacyKeyRequired`
   absent or false.

To remove it while pre-separation records still exist, first re-anchor: export
and archive the existing chain as a closed record, then let the ledger begin a
new chain under the derived key. Rotating `SESSION_SECRET` itself does not
retire this key, because the derived key moves with it.

### Snapshot-signing keyring

Production requires an independent `NV_SNAPSHOT_SIGNING_KEY_ID` and
`NV_SNAPSHOT_SIGNING_SECRET`; the signing secret must differ from
`SESSION_SECRET`. New signatures embed the non-secret key ID. To rotate, create
a fresh secret and never-reused key ID, move the previous ID/secret pair to
`NV_SNAPSHOT_RETIRED_KEYS_JSON`, deploy, and verify both a new snapshot and one
retained snapshot. Remove a retired pair only after all snapshots signed by it
have expired. The retired and legacy keyrings are server-only secrets and must
never appear in evidence or tickets.

### `DATABASE_URL`

Paste the existing Neon pooled connection string into the Render service environment. Never commit it to GitHub or an `.env` file in the repository.

TLS certificate validation is enabled by default. `NV_DB_INSECURE=1` exists only for controlled development and should not be used in production.


### Optional GitHub App secrets

The feature is disabled when all GitHub App values are absent. When enabled, keep `GITHUB_APP_CLIENT_SECRET` and the private key exclusively in the server environment. Prefer `GITHUB_APP_PRIVATE_KEY_BASE64` on Render so PEM line endings cannot be damaged. The callback URL must be canonical HTTPS in production and cannot contain credentials, fragments, or a query string.

The browser receives only non-secret installation metadata. GitHub App installation tokens are generated server-side, cached only until shortly before expiry, and injected into a cloned provider account for the duration of an operation. They are never stored in the session account, Neon tables, audit details, UI, or API responses. Disconnect and provider authorization failures invalidate broker state.

The setup callback does not trust `installation_id` by itself. It verifies signed single-use state, rechecks the authorizing GitHub identity, and confirms that the user-authorized token can enumerate the claimed installation before registering it.

Treat the App private key, OAuth client secret, and webhook secret as separate
rotation domains. If one is exposed, revoke/reset it in GitHub App settings,
replace only the corresponding Render value, redeploy, and verify a fresh
installation-token or callback flow. A webhook-secret rotation must update both
GitHub and Render in one maintenance window and finish with an independently
verified signed delivery. Never retain an exposed App secret as a compatibility
key. Follow `runbooks/04-credential-exposure.md` for the exact containment order.

## GitHub webhook permissions

Verified live webhook connection is opt-in and GitHub-only for the controlled
alpha. The credential must be able to create/delete repository webhooks.
Nebulaverse-X does not expose the generated webhook secret to the browser after
registration.

On Render, the callback uses `RENDER_EXTERNAL_URL`. On other production hosts, set `PUBLIC_BASE_URL` to a canonical HTTPS origin. The server does not trust an arbitrary production `Host` header to construct callbacks.

## Self-hosted GitLab and Gitea

The server validates custom provider URLs before use:

- HTTP(S) only
- No username/password in URL
- No raw IP host
- No localhost/private hostname
- DNS answers must not resolve to private, loopback, link-local, or reserved ranges
- Cross-origin redirects do not carry provider credentials

For production, set `NV_GIT_HOST_ALLOWLIST` to the exact approved hostnames.

## Browser security

- Production cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`.
- Mutating API routes require the `X-NV: 1` app header, same-origin checks, and an identity/session-bound CSRF token.
- CSP blocks plugins/objects, framing, hostile base URLs, and non-self form submissions.
- Markdown is passed through DOMPurify and falls back to plain text when the sanitizer is unavailable.
- HTML, SVG, XHTML, XML, XSL/XSLT are served as attachments.
- Private API caching is disabled by default. A tester may opt one repository into a bounded 24-hour text/JSON cache; sensitive, governance, raw, ZIP, security, session, notification, and mutation routes remain network-only. The server recomputes the authenticated session/account/repository scope and echoes it on eligible responses, and the service worker caches only an exact response/request binding match.
- Logout, login, account switching/removal, provider disconnect, access revocation, and alpha deletion purge repository-scoped drafts, recent-file history, local incident/snapshot data, private API caches, and the offline write queue. Same-origin tabs receive a `BroadcastChannel`/storage boundary event and purge before reload so stale tabs cannot carry data across identities.
- Provider-controlled avatar attributes and label colors are escaped/validated before HTML insertion.
- If Neon is configured but unavailable, database-backed sessions fail closed with `503` rather than downgrading to a full browser-cookie session.
- ZIP extraction validates archive paths, duplicate names, entry counts, methods, declared/actual sizes, ZIP64 markers, and compression ratios before allocating extracted content.

## Webhook threat controls

- Raw-body HMAC verification
- Timing-safe signature comparison
- Random 192-bit public hook identifier
- Random 256-bit secret
- Repository identity match
- Delivery-ID deduplication
- 2 MB payload limit
- Per-IP/hook delivery rate limit
- Minimized persistence
- Retention cleanup

## Recovery boundaries

A signed snapshot is useful for incident evidence and guided reference restoration. It is not a complete disaster-recovery backup because it does not independently preserve every Git object, LFS object, issue, PR review, release asset, webhook, or organization configuration.

For real disaster recovery, store independently encrypted mirror/LFS/metadata backups outside the source provider and test restoration regularly.

## Protected-file boundary

Nebulaverse-X policies cannot prevent a maintainer from changing a path through Git CLI, GitHub's website, another application, or a compromised provider token. Synchronizing equivalent GitHub/GitLab rules is a future production stage.

## Upload malware gate and optional YARA

Raw upload/blob routes are scanned before any provider write. The always-available built-in gate is deliberately bounded and currently recognizes the standard EICAR antivirus test signature; this verifies that the blocking path works but is not a general malware engine.

An optional YARA adapter is included for advanced/self-hosted deployments. It uses `execFile` without a shell, a trusted rules path, bounded output, a 1–30 second timeout, and a maximum of 20 reported matches. It is disabled unless `NV_YARA_RULES_PATH` is configured. `NV_REQUIRE_YARA=1` makes uploads fail closed when the configured scanner is unavailable.

Render Free does not normally include a YARA binary, and running arbitrary malware analysis in the main web process is not equivalent to an isolated antivirus sandbox. Production guest-upload scanning still needs a dedicated worker with CPU, memory, timeout, archive-depth, extracted-size, and network controls. Dependency checks remain separate through OSV/Dependabot data.

## Operational checklist

Before public exposure:

- Use a private source repository.
- Configure the existing Neon pooled `DATABASE_URL`.
- Keep `SESSION_SECRET` only in Render.
- Configure `NV_GIT_HOST_ALLOWLIST` when self-hosted providers are enabled; custom production hosts are rejected without it.
- Tune `NV_LIVE_CLIENTS_PER_REPO`, `NV_LIVE_CLIENTS_TOTAL`, and snapshot retention only after measuring the Render Free instance.
- Connect webhooks only for repositories that need live monitoring.
- Confirm `/healthz` and `/readyz`.
- Run `npm test`, `npm run check:syntax`, `npm run check:secrets`, and `npm run test:release` before each deploy.
- When GitHub App is enabled, verify callback URLs, selected repositories, installation health, and least-privilege permissions from Settings.
- Review Render logs for webhook, database, and provider errors.
- Export evidence before destructive recovery actions.
- Use the restore preview and review every reset/recreate action before typing `RESTORE`; the authorization expires after 10 minutes and a changed branch head requires a new preview.
- Keep optional YARA disabled unless the binary and rules are managed by the deployment administrator.
- Maintain an independent backup outside Nebulaverse-X.
- Keep upload concurrency and native-push memory limits conservative on Render Free.

Live-provider qualification credentials must belong only to the pre-created
`nvx-alpha17-` sandbox repository, be disposable after the run, and have no
organization or production-repository reach. The signed activation envelope
binds the exact reviewed candidate and target, but candidate code still runs in
the credential-bearing job. Therefore live dispatch requires a passing
independent review of those exact bytes and an environment approval. A candidate
that is not already trusted must instead run on an egress-isolated runner or
through a separately trusted harness; the repository workflow does not claim to
sandbox arbitrary hostile candidate code.

Exact-archive qualification runs `npm ci` with lifecycle scripts disabled in a
minimal allowlisted environment and invokes the reviewed vendor-copy step
explicitly. Ambient CI tokens, npm credentials, `NODE_OPTIONS`, and unrelated
variables are not inherited by candidate tests. This limits accidental secret
exposure; it is not a network sandbox for malicious code.

## Governance API and draft security (Tasks 6–7)

- Governance routes use the authenticated server-side authorization snapshot and exact provider authority/repository scope; client role and actor claims are ignored.
- Governance writes enter the Central Mutation Gateway and are attributed to the verified human actor, including optional GitHub App sessions.
- Drafts are author-owned and use optimistic revisions. Submitted versions and linked audit records remain append-only.
- Every Policy Digital Twin interface write generates a fresh bounded `Idempotency-Key`. Activation and rollback reject a missing or malformed key before any governance-store read; other governance writes retain their compatibility behavior. Accepted keys are SHA-256 hashed before storage, raw values are not logged or included in mutation/audit evidence, and records are cleaned after 24 hours.
- Governance JSON rejects sensitive fields, oversized structures, and JavaScript prototype-control keys.
- Configure a stable `NV_GOVERNANCE_AUDIT_SECRET` of at least 32 bytes before production governance use. It protects both governance lifecycle audit and runtime decision chains. Rotating it breaks verification of records created under the previous secret unless a controlled migration is performed.
- Keep each repository scope at or below 100 active policies. Migration 011 and later activations enforce this limit so policy evaluation cannot silently become unavailable.
- Retain every deployed control-catalog version that appears in immutable decision evidence; never replace historical mapping semantics in place.
## Runtime enforcement security (Tasks 12–13)

- Configure `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn` for initial deployment. `warn` preserves compatibility but makes evaluator failure visible; `block` converts evaluator unavailability into a pre-provider `503` for repository mutations.
- Do not switch to `block` until migration `011_governance_policy_decisions.sql`, Neon readiness, immutable decision-chain verification, and representative staging mutations have passed.
- Policies without an explicit rollout mode are interpreted as `observe`, preventing legacy policies from becoming blocking during upgrade.
- Runtime reads and policy activation share a repository-scoped advisory-lock protocol so every decision is linearized against one exact active-policy set.
- Each persisted decision binds the normalized mutation descriptor by SHA-256 and records policy/version/document/head evidence before provider execution.
- Control mappings are versioned, server-derived, non-authoritative evidence. They use a `supports` relationship and cannot modify enforcement.
- Active policies and evaluator failures cannot block governance recovery/control-plane mutations. These routes still require their existing server-derived role, approval, simulation, concurrency, PostgreSQL, and HMAC-audit protections.
- Any unsupported rule found in an active policy is an evaluator failure, never an implicit allow. The configured runtime failure mode converts it to an observable warning or a pre-provider block; recovery/control-plane mutations retain their separate safe fallback.
- Treat `X-Nebulaverse-Policy-*` headers as operational signals, not authorization claims; authority remains server-side.

## Governance delivery receiver responsibilities

Webhook delivery is at-least-once. Retries preserve the immutable delivery ID
in `X-Nebulaverse-Delivery` and `Idempotency-Key`; receivers must verify the
signature over delivery ID, timestamp, and exact body, enforce their own narrow
timestamp window, and deduplicate that delivery ID for at least the configured
retry/dead-letter horizon before applying side effects. A 2xx response confirms
transport acceptance, not exactly-once processing. Redirects are terminal and
are never followed.

## Hosted restore attestation boundary

The live hosted harness directly measures deployment identity, smoke, bounded
load, mutation cleanup, and cold-start behavior. After exact-target preflight,
the protected workflow installs the frozen candidate with lifecycle scripts
disabled and exposes restore credentials only to the reviewed restore runner.
That runner creates and removes a fresh encrypted backup, proves distinct
source/target branch identities, repeats control-plane and live-session target
verification, executes restore through migration `015_alpha_privacy`, and emits
a bounded credential-free record with nonzero backup, target, and restore
digests. The hosted artifact retains that complete record and independently
recomputed SHA-256; the standalone record and backup material are not uploaded.

Remaining checks that require operator console access use a separate fresh
Ed25519-signed operational record bound to the same candidate and source commit.
That operator record is retained with its key ID and recomputed hash, but is
forbidden from claiming `isolated-database-restore`. The two records preserve
who executed each check instead of collapsing both into an unqualified
`status: pass`.

## Policy simulation security (Tasks 9–10)

- Simulation requires a fresh server-derived `reader` role for the exact provider authority and repository. Browser-supplied scope, actors, roles, permissions and credentials are rejected.
- The simulation route is explicitly enumerated as a read-only control-plane POST. It does not receive mutation-gateway middleware and cannot call provider mutation APIs.
- Scenarios are bounded to 200 entries and use only registered gateway actions plus credential-free mutation facts. Raw source content, patches, diffs, headers, cookies, tokens and secret-like values are rejected.
- Immutable proposed and active policy document hashes are recomputed before evaluation; any mismatch fails closed.
- Evidence binds repository scope, proposed and baseline policy hashes, normalized scenarios, results and the complete report with deterministic SHA-256 hashes.
- Proposed rule conflicts, unsupported policy actions, and supported proposed rules not exercised by any scenario set `activationReadiness.eligible` to `false`. Task 11 must reject blocker-bearing or stale simulation evidence.
- Simulation is not proof of provider-side behavior and creates no database row, audit event, activation, exception or runtime enforcement decision.


## Exception and waiver security (Task 14)

- Requests require fresh server-derived author authority; approve/reject/revoke require fresh administrator authority. A requester cannot decide their own request.
- Records are bound to one provider authority, repository, policy, active immutable version, exact policy-head revision, document hash, verified human requester, action, canonical mutation-target hash and bounded rule set. Browser-supplied actors, roles, states and timestamps are rejected.
- Duration is five minutes to thirty days. Expiry and policy-version supersession are checked synchronously; no scheduler is trusted for correctness.
- Target metadata is explicit, non-empty, normalized, limited to 2 KiB and rejects raw content, patches, diffs, payloads, bodies and secret-like values. Optional GitHub App execution binds to the verified human governance actor.
- Only covered matched rules are waived. Uncovered restrictive rules remain effective, and runtime decisions preserve original and effective outcomes.
- At most 100 approved applicable records may exist per repository/action. Approval uses a serialization lock; overflow never silently becomes an allow.
- Approval and revocation applicability use one post-lock operation timestamp so concurrent events cannot be applied retroactively.
- Retain policy-decision engine version 1 and control catalog `1.0.0` for historical evidence. Task 14 writes engine version 2 and catalog `1.1.0`.
- Apply migration `012_governance_exceptions.sql` and verify live Neon lock behavior before production use.
