# Security and deployment guide

## Preserved infrastructure

Nebulaverse-X v5.3.0-alpha.14 does not create a database in Render. It uses one Render Free web service and your existing Neon PostgreSQL connection.

The server creates the following tables with non-destructive `CREATE TABLE IF NOT EXISTS` statements:

```text
nv_sessions
nv_security_state
nv_webhooks
nv_intelligence_events
nv_recovery_snapshots
nv_evidence_chain
nv_github_app_installations
nv_github_app_audit
```

No existing application table is dropped. The session table receives an additive `identity_keys` array and GIN index so session containment can query the active identity directly; legacy rows remain readable during migration.

## Provider authorization evidence

Repository governance roles are resolved server-side from the active provider credential and exact repository scope. Browser-supplied roles, access levels, and installation permissions are ignored. GitHub App installation capability is not treated as human governance authority; the stored human authorizer must still have a current provider role for the repository.

Provider lookup failure does not globally disable existing non-governance repository workflows, but the resulting snapshot grants no governance authority. Governance APIs reject unavailable, stale, contradictory, or insufficient evidence and require durable PostgreSQL availability.

## Central Mutation Gateway

All repository-changing provider requests must carry a server-created mutation context and are revalidated at the provider helper or Git transport boundary. Unknown operations, provider/repository mismatches, action mismatches, and missing critical step-up evidence fail before the outbound write. Task 4 does not yet evaluate governance policy; do not treat the gateway alone as a provider-side branch-protection replacement.


## Secrets

### `SESSION_SECRET`

Use the Render-generated value. It protects:

- Encrypted cookies
- Encrypted database session data
- Stored webhook secrets
- Snapshot signatures

Rotation response:

1. Rotate the value in Render.
2. Expect every session to be signed out.
3. Reconnect verified live events because existing encrypted webhook secrets become unreadable.
4. Expect snapshots signed with the old value to report `signatureValid: false`.

### `DATABASE_URL`

Paste the existing Neon pooled connection string into the Render service environment. Never commit it to GitHub or an `.env` file in the repository.

TLS certificate validation is enabled by default. `NV_DB_INSECURE=1` exists only for controlled development and should not be used in production.


### Optional GitHub App secrets

The feature is disabled when all GitHub App values are absent. When enabled, keep `GITHUB_APP_CLIENT_SECRET` and the private key exclusively in the server environment. Prefer `GITHUB_APP_PRIVATE_KEY_BASE64` on Render so PEM line endings cannot be damaged. The callback URL must be canonical HTTPS in production and cannot contain credentials, fragments, or a query string.

The browser receives only non-secret installation metadata. GitHub App installation tokens are generated server-side, cached only until shortly before expiry, and injected into a cloned provider account for the duration of an operation. They are never stored in the session account, Neon tables, audit details, UI, or API responses. Disconnect and provider authorization failures invalidate broker state.

The setup callback does not trust `installation_id` by itself. It verifies signed single-use state, rechecks the authorizing GitHub identity, and confirms that the user-authorized token can enumerate the claimed installation before registering it.

## GitHub webhook permissions

Webhook connection is opt-in and GitHub-only in v5.2. The credential must be able to create/delete repository webhooks. Nebulaverse-X does not expose the generated webhook secret to the browser after registration.

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
- Private API responses are not stored by the service worker.
- Logout and account switching purge repository-scoped drafts, recent-file history, local incident/snapshot data, private API caches, and the offline write queue so data cannot cross account boundaries.
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

## Governance API and draft security (Tasks 6–7)

- Governance routes use the authenticated server-side authorization snapshot and exact provider authority/repository scope; client role and actor claims are ignored.
- Governance writes enter the Central Mutation Gateway and are attributed to the verified human actor, including optional GitHub App sessions.
- Drafts are author-owned and use optimistic revisions. Submitted versions and linked audit records remain append-only.
- Optional `Idempotency-Key` values are validated and SHA-256 hashed before storage; raw values are not logged or included in mutation/audit evidence. Records are cleaned after 24 hours.
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
- Treat `X-Nebulaverse-Policy-*` headers as operational signals, not authorization claims; authority remains server-side.

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
