# ✦ Nebulaverse-X

**Git operations, repository security, governance, and recovery from one visual workspace.**

Nebulaverse-X keeps the existing repository workbench—GitHub/GitLab/Gitea browsing, editing, commits, pull requests, issues, releases, Actions, SmartPush, Git LFS, folder/ZIP import, Time Machine, safeguards, dependency auditing, and the Neural Command Center—then adds durable governance, evidence, and recovery foundations without requiring paid AI.

For current version and qualification status, see the generated
[project state](docs/current/PROJECT_STATE.md). The feature inventory below
describes implemented and historical delivery, not provider parity, production
readiness, or completed hosted qualification.

## Run it

Node is pinned to the version in `package.json` (`engines.node`). The server
listens on `PORT`, defaulting to `10000`.

```bash
npm ci
NV_DEV_SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")"
export NV_DEV_SESSION_SECRET
SESSION_SECRET="$NV_DEV_SESSION_SECRET" npm start
```

Generate `NV_DEV_SESSION_SECRET` once per local session as shown; do not reuse a
production, provider, or snapshot-signing secret. Then open
`http://localhost:10000`.

A local run needs no database and no provider credentials: PostgreSQL is
optional outside production, and the workspace opens with a personal access
token pasted into the sign-in screen.

```text
GET /healthz   process liveness, and whether maintenance mode is on
GET /readyz    optional Neon readiness
GET /api/version
```

## Check the configuration

`npm run doctor` evaluates the current environment against
`src/config-registry.js`, which names all environment variables this
project reads — what each one does, when it becomes required, and what the code
falls back to without it. It calls the server's own configuration loaders rather
than repeating their rules, so a pass is the answer the process will give at
startup, and it exits non-zero when something the selected profile requires is
missing.

```bash
npm run doctor                      # runtime configuration for this profile
npm run doctor -- --all             # plus operator, CI and tooling groups
npm run doctor -- --group=ci        # what a live qualification dispatch needs
npm run doctor -- --json            # machine-readable, for a deploy step
```

It reports only whether a value is set, never the value, so it is safe to run on
a server and paste into an issue. Run it **before** deploying — on the machine
holding the environment you are about to deploy with, or on the host itself
through its shell.

## Verify a change

```bash
npm run lint                  # static identifier resolution, blocking
npm test                      # full unit chain
npm run test:e2e              # browser suite
npm run test:matrix           # every discovered test program
npm run verify                # build verification
npm run check:secrets         # embedded-credential scan
npm run a11y:audit            # axe, target size, focus, reflow: both themes
npm run design:review         # four-way screenshots for a human to look at
```

`npm run a11y:audit` and `npm run design:review` need the app running on
`http://127.0.0.1:21999`, or `NV_REVIEW_URL` pointing at wherever it is.

Deployment is documented separately in
[Render/Neon deployment](docs/operations/DEPLOY_RENDER_NEON.md), with the
pre-deploy sequence in the
[operator checklist](docs/operations/runbooks/OPERATOR_CHECKLIST.md).

## Current documentation

- [Documentation lifecycle index](docs/README.md)
- [Project state](docs/current/PROJECT_STATE.md), [roadmap](docs/current/ROADMAP.md), and [provider capabilities](docs/current/PROVIDER_CAPABILITIES.md)
- [Founder vision](docs/vision/FOUNDER_VISION.md), [product vision](docs/vision/PRODUCT_VISION.md), and [UX vision](docs/vision/UX_VISION.md)
- [Architecture](docs/architecture/ARCHITECTURE.md) and [architecture decisions](docs/architecture/ARCHITECTURE_DECISIONS.md)
- [Personal workspace foundation](docs/architecture/PERSONAL_WORKSPACE_FOUNDATION.md) — opt-in identity API; owner repository workflow follows separately
- [Public-alpha guide](docs/release/PUBLIC_ALPHA.md), [release gates](docs/release/RELEASE_SECURITY_GATES.md), and [evidence index](docs/release/EVIDENCE_INDEX.md)
- [Render/Neon deployment](docs/operations/DEPLOY_RENDER_NEON.md) and [security deployment](docs/operations/SECURITY_DEPLOYMENT.md)

## Historical evidence

See the [evidence index](docs/release/EVIDENCE_INDEX.md) for predecessor and
successor evidence applicability without rewritten outcomes.

The existing self-hosted deployment model remains:

```text
One Render Free web service
        +
Your existing optional Neon PostgreSQL database
```

The controlled hosted alpha instead plans one dedicated Render Free service and
one dedicated Neon Free project for the cohort. There is no Render database
resource and no required paid AI API.

## Phase 0 PWA privacy model

The application shell remains available offline. Private repository reads are **disabled by default** and can be enabled explicitly for the open repository from Settings. Eligible text/JSON responses use a network-first cache partitioned by an opaque account/session scope, with a 24-hour TTL, 100-entry ceiling, 1 MiB object ceiling, and 25 MiB total ceiling. Raw files, ZIP downloads, notifications, sessions, security, evidence, recovery and write responses are never persisted by the service worker.

Account changes, logout, session-revocation events and Emergency Shield containment purge scoped private caches and queued identity-bound writes. Browsers cannot be remotely erased while fully offline; organizations should still use device encryption and managed-device controls for highly sensitive repositories.

## Database migrations

Neon schema changes are applied from numbered, checksummed files in `db/migrations/`. Applied identifiers and checksums are recorded in `nv_schema_migrations`; changing an already-applied migration fails startup instead of silently drifting the database.


## Delivery history

The sections below record what each phase and task delivered, oldest concerns
last. They are a historical record rather than a description of current state:
for that, read the generated [project state](docs/current/PROJECT_STATE.md), and
for what changed most recently read the [changelog](CHANGELOG.md).

## Phase 1 secure access foundation (v5.3 alpha)


### Release readiness and Gitea correction (historical Task 21 implementation)

- Preserves immutable alpha.16.1 and alpha.16.2 evidence. Alpha.16.2 passed the Node 22 candidate matrix but failed live Gitea file mutation with HTTP 400 because Gitea's Git Data endpoints are read-only.
- Routes only Gitea file create, update and delete through its Contents API; GitHub's Git Data path and GitLab's Repository Files path remain unchanged.
- Performs each Gitea mutation on a disposable branch created from the exact expected head, then moves the target branch through Gitea's non-forced `old_commit_id`/`new_commit_id` compare-and-swap and always attempts cleanup.
- Rejects stale preflight heads and compare-and-swap races as `BRANCH_CHANGED`, preventing newer work from being overwritten.
- Keeps normalized Gitea governance scopes valid across the warn-mode policy-evaluation fallback.
- Classifies the current high-severity advisory as a dev-only Archiver traversal chain; production dependencies audit clean, and Nebulaverse does not invoke the vulnerable glob path.
- Candidate-bound Node 22 and fresh live-Gitea records for the immutable alpha.16.3 ZIP are indexed in the [evidence index](docs/release/EVIDENCE_INDEX.md); consult the [project state](docs/current/PROJECT_STATE.md) for current qualification status.

### End-to-End Staging Validation (Task 20 complete, alpha.16.1 blocked)

- Uses evidence schema `1.2.0` with exact release-candidate, catalog, command/procedure, and verified on-disk artifact binding.
- Completed all 19 mandatory executions: 18 passed and Gitea branch discovery failed.
- Preserves the Gitea failure as release-blocking evidence instead of waiving or reclassifying it.
- Retains the dependency-aware independent test matrix, reproducible report hash, provider/destructive harnesses, and behavioral Playwright specifications as Task 21 release-gate inputs.

### Governance Notifications, Webhooks and Signed Audit Exports (Task 19)

- Adds immutable governance event outbox records, repository-scoped notification preferences and read cursors.
- Adds administrator-managed HTTPS webhooks with DNS/IP SSRF defenses, pinned TLS delivery, HMAC signatures, bounded retries and dead-letter evidence.
- Adds bounded deterministic JSON/CSV evidence envelopes with formula-safe CSV cells, immutable hashes and verification endpoints.
- Adds a live-only Governance delivery interface without browser persistence.
- Defines the stable signed-export input contract for later Phase 5 storage, but does not implement external storage.

### Full Mutation Coverage and Bulk Operation Governance (Task 18)

- Adds an immutable route/action inventory and bounded execution contract for every Central Mutation Gateway action.
- Fails package contracts when a mutating repository route or provider helper is unclassified.
- Enforces provider-write ceilings and derives deterministic operation IDs before provider transport.
- Binds file batches to ordered item IDs, a batch hash, a 100-item ceiling, a 2 MiB canonical payload ceiling and a fresh expected branch head.
- Binds recovery policy/exception evaluation to the exact sealed branch-action list before any ref changes.
- Exposes explicit per-item partial recovery outcomes and forbids automatic replay of a consumed recovery authorization.
- Classifies Git receive-pack and each Git LFS write stage without changing provider or policy semantics.
- Adds no database migration, runtime dependency, Task 19 notification/export implementation or Phase 5 external storage.


### Policy Digital Twin Interface (Task 17)

- Adds a repository-scoped Governance workspace for current policy heads, active drafts, proposed immutable versions, review/simulation readiness, activation history, exceptions and runtime decisions.
- Consumes the Task 16 repeatable-read projection as the display source of truth and a bounded server-derived capability envelope for visible controls.
- Supports policy/baseline/draft, review, simulation, activation/rollback and exception workflows only through the existing authenticated governance API and Central Mutation Gateway.
- Keeps governance evidence network-only and memory-only; no governance policy, approval, exception or decision response is persisted in local storage, IndexedDB or private offline caches.
- Disables controls when provider authorization evidence expires and invalidates in-memory simulations when authoritative state changes.
- Adds explicit loading, empty, partial, stale and error states, responsive layouts, reduced-motion behavior, ARIA live feedback and labelled focus-contained confirmation dialogs.

### Policy Simulation and Explainable Impact (Tasks 9–10)

- Adds a pure deterministic evaluator for immutable proposed policy versions and one to 200 bounded, credential-free mutation scenarios.
- Reuses the exact Central Mutation Gateway action registry so design-time evidence cannot invent a separate action vocabulary.
- Compares proposed outcomes with the active immutable policy version or an explicit no-policy baseline.
- Reports matched rules, conflicts, unsupported policy actions, action classes, risk levels, strengthened or relaxed outcomes, and bounded warnings.
- Binds repository scope, policy documents, normalized scenarios and results with deterministic SHA-256 evidence hashes.
- Revalidates stored immutable document hashes before evaluation and rejects secret-like values, raw content, patches, diffs and authority claims in scenarios.
- Exposes explicit activation readiness: proposed conflicts, unsupported policy actions, or supported rules not exercised by any scenario block later activation review.
- Keeps simulation strictly read-only: no provider calls, mutation-gateway write, governance persistence, audit append, activation or enforcement.

### Exceptions, Waivers and Expiry Workflow (Task 14)

- Adds exact-scope, time-bounded exceptions for matched `deny` rules and waivers for matched `require-approval` rules.
- Requires a verified author request and a different verified administrator decision; administrators may revoke approved records.
- Binds every request to one provider authority, repository, policy, active immutable version, exact policy-head revision, document hash, verified human requester, registered gateway action, canonical mutation-target hash and one to fifty rule IDs.
- Enforces duration from five minutes to thirty days and applies expiry/supersession synchronously without a background-worker correctness dependency.
- Persists append-only request and event history through migration `012_governance_exceptions.sql` and records runtime application in the immutable policy-decision chain.
- Preserves original and effective effects, waived rule IDs, subject identity, target hash and exact applied-exception evidence.
- Caps applicable approved exceptions at 100 per repository/action with serialized approval and visible overflow failure.
- Introduces policy-decision engine version 2 and control catalog `1.1.0` while permanently retaining engine version 1 and catalog `1.0.0` for historical alpha.10 evidence.

### Runtime Policy Enforcement and Versioned Control Evidence (Tasks 12–13)

- Evaluates every registered repository mutation at the Central Mutation Gateway before any provider write executes.
- Loads the complete active-policy set for the exact provider authority, owner, and repository under a shared repository-scope lock; activation and rollback use the matching exclusive lock.
- Preserves legacy policy behavior by treating policy documents without an explicit enforcement setting as `observe`.
- Supports explicit `observe`, `warn`, and `block` policy modes. Observe records what would happen, warn allows with bounded response evidence, and block stops the provider operation before transport.
- Persists one immutable, descriptor-hashed policy decision per attempted mutation, including exact active version IDs, document hashes, head revisions, rollout result, and a linked HMAC decision chain. Decision history supports `afterSeq` cursor pagination and bounded repeatable-read chain verification.
- Exposes reader-authorized decision history and chain verification under `/api/repo/:owner/:repo/governance/decisions`.
- Derives non-authoritative compliance evidence from a versioned server catalog after evaluation. Control references can describe evidence relevance but never change allow, warn, or block behavior.
- Supports at most 100 simultaneously active policies per repository scope and fails migration/activation explicitly before that bound can break runtime evaluation.
- Uses `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn|block` for policy-evaluation failures. The Render template starts with `warn` to avoid an unexpected deployment lockout; production operators may choose `block` only after database and staging verification.
- Keeps governance recovery operations non-blocking at the policy layer, including when evaluation fails, so an authorized administrator can deactivate or roll back a problematic policy. Existing role, approval, simulation, revision, database, and audit protections still apply.

### Reviewer Assignment and Approval Workflow (Task 8)

- Adds repository-scoped reviewer self-claim using only the currently authenticated, server-verified human governance actor.
- Rejects browser-supplied reviewer identities, roles, access levels, installation permissions, and actor claims.
- Preserves GitHub App installation/human separation while supporting PAT, OAuth, GitLab, and Gitea.
- Stores immutable reviewer assignments and one immutable approve/reject decision per assigned human identity and version.
- Enforces author/reviewer separation when configured and requires a bounded rationale for rejection.
- Computes deterministic pending, approved, or rejected state from immutable evidence without activating policy.
- Serializes assignment, decision, and later activation paths with shared policy/version advisory locks.
- Routes both writes through the Central Mutation Gateway and supports optional hashed idempotent retries.

### Governance API and Policy Draft Workflow (Tasks 6–7)

- Adds an authenticated repository-scoped governance API that derives authority only from current server/provider evidence.
- Requires the optional Neon PostgreSQL database for governance operations; no cookie or process-memory persistence fallback is used.
- Provides durable author-owned drafts with one active draft per author and policy, bounded policy validation, and optimistic revision conflicts.
- Submits a draft transactionally into the next immutable policy version, removes the draft, and appends linked audit evidence.
- Routes policy creation and draft create/update/submit writes through the Central Mutation Gateway using the verified human actor.
- Supports optional hashed `Idempotency-Key` retry safety isolated by repository, human actor, and operation.
- Keeps templates, notifications, exports and the Policy Digital Twin UI for later Phase 1 tasks; activation, runtime enforcement and exceptions are implemented in Tasks 11–14.

### Provider Permission and Governance Role Resolver (Task 5)

- Derives one server-trusted, credential-free authorization snapshot for each repository mutation.
- Normalizes GitHub PAT/OAuth, GitLab, and Gitea repository permissions without trusting browser role claims.
- Separates an optional GitHub App installation execution principal from its verified human governance actor.
- Requires fresh installation and repository-selection evidence before accepting GitHub App human authority.
- Maps access conservatively to reader, author, reviewer, activator, and administrator roles; GitLab Maintainer remains distinct from Owner.
- Uses short-lived, bounded, authority/repository/identity-isolated caching with concurrent request coalescing.
- Attaches evidence to the Central Mutation Gateway but deliberately leaves active-policy enforcement to later Phase 1 tasks.

### Central Mutation Gateway Foundation (Task 4)

- Routes every known repository-changing workflow through one immutable, repository-scoped mutation context.
- Reasserts the gateway immediately before GitHub, Gitea, GitLab, Git push and Git LFS writes.
- Binds route intent to exact provider operation classes so one action cannot authorize a different write on the same repository.
- Requires the matching Task 1 step-up proof for repository deletion, hard reset and pull-request merge.
- Rejects unknown actions, unresolved targets, provider/scope mismatches, nested contexts and sensitive metadata before provider side effects.
- Keeps the gateway policy-neutral until provider roles and active-policy evaluation are added in later Phase 1 tasks.

The package includes the complete [documentation lifecycle](docs/README.md),
including generated continuity views, current guidance, immutable Phase 1
history, architectural decisions, and release evidence, so a new conversation
can recover project state from the ZIP alone.

### Governance persistence foundation (Task 3)

- Adds immutable, repository-scoped policy identities normalized by provider authority, owner, and repository.
- Stores canonical schema-v1 policy documents as ordered immutable versions with SHA-256 content hashes.
- Stores one immutable approve/reject decision per reviewer identity and blocks author self-approval by default.
- Freezes decisions after a version has ever been activated so historical approval evidence cannot change later.
- Serializes reviewer decisions against activation and activates versions transactionally through a monotonic revision check that rejects stale concurrent head changes.
- Represents rollback as a new immutable activation event targeting a version that was previously active.
- Links lifecycle events in a per-policy HMAC audit chain ordered by a database sequence.
- Rejects UPDATE, DELETE, and TRUNCATE against governance history tables at the database layer.
- Rejects secret-bearing fields and oversized JSON before policy or audit data reaches PostgreSQL.
- Requires the existing optional Neon database when governance is used; there is intentionally no cookie or process-memory durability fallback.

Task 3 provides the immutable data/store foundation now consumed by the governance API, review workflow, simulation, activation, runtime enforcement and exception workflow. The Policy Digital Twin interface and later operational capabilities remain future Phase 1 tasks.

### Optional GitHub App authentication (Task 2)

- Disabled safely unless the complete GitHub App configuration is present.
- Preserves GitHub PAT and OAuth, GitLab tokens, and Gitea tokens as first-class connection methods.
- Uses session- and identity-bound, signed, time-limited, single-use callback state.
- Verifies the authorizing GitHub user and confirms that the user can see the claimed installation before registering it.
- Stores only non-secret installation metadata; the App private key and short-lived installation tokens remain server-side.
- Resolves an ephemeral installation credential through one provider boundary only when a GitHub operation needs it.
- Coalesces concurrent token requests, refreshes near expiry, and invalidates cached credentials after disconnect or provider rejection.
- Provides installation health, repository-selection scope, authorizer identity, refresh, reauthorization, and local disconnect controls in Settings.
- Uses optional Neon tables `nv_github_app_installations` and `nv_github_app_audit`; it remains usable with encrypted session fallback when Neon is absent.

### Request security foundation (Task 1)

Unsafe authenticated requests use session- and active-identity-bound CSRF tokens plus same-origin enforcement. Repository deletion, hard reset, pull-request merge, and session-revocation paths require a short-lived, single-use, action-and-scope-bound step-up grant.

## Verified Intelligence foundation (v5.2)

### Verified live repository intelligence

- Creates an opt-in GitHub repository webhook from the Neural workspace.
- Verifies every delivery against the exact raw payload using `X-Hub-Signature-256` HMAC-SHA256.
- Rejects invalid signatures, malformed hook identifiers, repository mismatches, duplicate deliveries, and excessive delivery rates.
- Stores a minimized event record in the existing Neon database.
- Streams accepted events to the open Neural workspace through authenticated Server-Sent Events.
- Retains events for 90 days by default, configurable with `NV_EVENT_RETENTION_DAYS`.

### Deterministic risk engine

No LLM or paid AI is involved. Every score is reproducible and explains its reasons. Current rules identify signals such as:

- Force pushes and deleted references
- Direct writes to the default branch
- Protected-path changes
- GitHub Actions workflow changes
- Common credential/environment file paths
- Failed workflows and deployments
- Repository vulnerability alerts
- Unknown actors

### Explain this connection

Select two Neural nodes and Nebulaverse-X calculates the shortest relationship path using graph traversal. The result shows the exact nodes and edges connecting a session, actor, commit, branch, workflow, deployment, vulnerability, protected asset, or snapshot.

### Shadow Access Radar and incident replay

- Enumerates GitHub collaborators, deploy keys, and minimized webhook posture when the connected token permits it.
- Scores writable deploy keys, insecure webhook TLS, broad administrator access, stale/inactive integrations, and incomplete inventories with explicit reasons.
- Replays provider activity and signature-verified events chronologically.
- Uses a stable timestamp/event-ID cursor to catch up after reconnects without losing events that share the same database timestamp.
- Exports provider activity and available verified events as JSON, formula-safe CSV, or Markdown.

### Recovery Snapshot Lite and safe restore preview

- Compares a signed/local snapshot against current branches, tags, and an optional bounded file manifest.
- Shows branch moves, branch recreation, newer objects preserved, file differences, provider protection, truncation, and Nebulaverse-X policy blockers before any mutation.
- Accepts signed Emergency Shield manifests as recovery inputs.
- Requires a second typed confirmation before reference restoration, plus a short-lived server authorization bound to the previewed actions.
- Rechecks current branch heads immediately before mutation and rejects stale previews without changing any ref.

### Upload security gate

- Streams every upload to temporary storage, then performs a whole-file built-in malware test-signature scan before any provider write.
- Supports an optional bounded YARA CLI adapter with administrator-managed rules.
- Can fail uploads closed with `NV_REQUIRE_YARA=true` when YARA is required but unavailable.
- Keeps dependency-CVE detection separate through OSV/Dependabot rather than misusing YARA for package-version analysis.

### Shadow Access Radar

For GitHub repositories, the Neural Security and Governance modes inventory repository collaborators, deploy keys, and webhook destinations. A deterministic access-posture score highlights writable deploy keys, unverified keys, disabled webhook TLS verification, inactive integrations, broad administrator access, and incomplete inventories. Tokens, deploy-key material, webhook secrets, and full webhook URLs are never returned to the browser.

- Activity exports support JSON, Markdown, and formula-safe CSV.

### Verified recovery preview

Before a reference restore, Nebulaverse-X captures the current repository state and compares it with the selected snapshot. The preview reports branches that would move or be recreated, newer branches that remain preserved, file-manifest differences, truncation warnings, protected-provider branches, and policy conditions that block execution. The final restore still requires a separate typed confirmation. The server issues a short-lived encrypted authorization bound to the exact repository, identity, and previewed branch actions; it rejects reused/expired authorizations and aborts if any branch head changed after preview.

### Persistent safeguards

When Neon is configured, these controls are stored per connected identity and apply across devices and sessions:

- Read-only mode
- Synchronization freeze
- Exact protected files
- Protected folders
- Wildcard policies such as `.github/workflows/**`

Without Neon, the original encrypted-session fallback remains available.

### Signed recovery evidence

- Captures branches, tags, default branch, and an optional file manifest.
- Stores snapshots in Neon.
- Signs each snapshot with a dedicated, key-ID-bearing HMAC-SHA256 key.
- Continues verifying retained snapshots with explicitly configured retired keys until their retention expires.
- Reports signature validity when snapshots are read or exported.
- Appends security, webhook, and recovery actions to a chained evidence ledger.
- Exports recent events, signed snapshots, bounded evidence-chain records, and chain verification as JSON.

A signed reference snapshot is recovery evidence, not a complete independent Git/LFS backup. See [security deployment](docs/operations/SECURITY_DEPLOYMENT.md).

### Security and privacy hardening

- Authenticated API responses are network-only by default. Small allowlisted repository reads are stored only after explicit per-repository offline opt-in, inside an opaque account/session-scoped cache with TTL and size limits.
- Offline drafts and queued writes remain available through the application's own browser store.
- Markdown rendering fails closed if the sanitizer is unavailable.
- Active repository content such as HTML, SVG, and XML is forced to download.
- Stronger CSP directives, HSTS in production, CSRF app-header checks, and vendor proxy allowlists.
- GitLab/Gitea custom hosts are revalidated against SSRF rules and cross-origin redirects do not receive credentials.
- `/healthz` and `/readyz` distinguish process health from optional database readiness.
- Raw upload routes apply a bounded built-in malware test signature gate before provider writes.
- An optional local YARA adapter can be enabled only on deployments where a trusted YARA binary and rules file are installed; it is disabled by default and is not a full antivirus sandbox.

## Core product capabilities retained

### SmartPush and large files

Nebulaverse-X automatically routes uploads according to file size and provider capability:

| File size | Route |
|---|---|
| Up to 40 MB | Git Data API |
| Above 40 MB through the configured native ceiling (64 MB by default) | Native Git smart-HTTP push |
| Above the configured native ceiling | Git LFS negotiation, upload, verification, pointer commit, and `.gitattributes` management |

Practical upload size is also limited by the selected host's request, temporary-disk, memory, and timeout limits.

### Git workflow

- Repository and branch browser
- Code editing and staged atomic commits
- Pull requests, reviews, comments, and merge strategies
- Issues and comments
- Releases and release assets
- GitHub Actions visibility and reruns
- Compare, file history, commit history, and diffs
- File/folder rename and move while preserving Git modes
- Folder upload and bounded browser-side ZIP extraction with path, count, size, method, duplicate, ZIP64, and compression-ratio preflight
- Time Machine file, folder, and repository restoration
- Offline drafts and commit queue; repository-scoped drafts, recents, snapshots, incidents, and queued writes are purged on logout or account switch
- Multi-account GitHub/GitLab/Gitea connectivity

### Neural Command Center

Five operational views are included:

- **Security** — actors, sessions, protected assets, verified events, workflows, and vulnerabilities
- **Recovery** — references, tags, signed snapshots, and recovery gaps
- **Dependencies** — manifests, vulnerable packages, OSV/Dependabot findings
- **Governance** — protected paths, branch protection, safeguards, and evidence
- **Activity** — commits, pull requests, issues, releases, workflows, and verified provider events

See `NEURAL_COMMAND_CENTER.md` for the complete behavior.

## Deploy on Render Free with your existing Neon database

1. Put the project files at the root of a private GitHub repository.
2. In Render, create or update a Blueprint from that repository.
3. Confirm the Blueprint contains only one **Free** web service.
4. In **Render → Nebulaverse-X → Environment**, add your existing Neon pooled URL:

```text
DATABASE_URL=postgresql://...-pooler.../dbname?sslmode=require
```

5. Keep the independently generated `SESSION_SECRET` and `NV_SNAPSHOT_SIGNING_SECRET`. Do not copy a real secret into GitHub.
6. Deploy.

Render automatically supplies `RENDER_EXTERNAL_URL`, which Nebulaverse-X uses for the GitHub webhook callback. On another production host, set `PUBLIC_BASE_URL` to the application's canonical HTTPS URL.

### Required and optional environment variables

| Variable | Requirement | Purpose |
|---|---|---|
| `SESSION_SECRET` | Required in production | Encrypts sessions and stored webhook secrets |
| `NV_SNAPSHOT_SIGNING_KEY_ID` | Required in production | Non-secret active snapshot-signing key identifier |
| `NV_SNAPSHOT_SIGNING_SECRET` | Required in production | Dedicated active HMAC key for snapshots and emergency manifests |
| `NV_SNAPSHOT_RETIRED_KEYS_JSON` | Optional during rotation | Retired key-ID-to-secret map retained until matching snapshots expire |
| `NV_SNAPSHOT_LEGACY_KEYS_JSON` | Optional migration bridge | Old session-derived snapshot keys retained only for legacy bare signatures |
| `NV_EVIDENCE_LEGACY_SESSION_KEY` | Optional migration bridge | Set to `true` to keep verifying evidence records written before the ledger key was separated from `SESSION_SECRET` |
| `NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON` | Optional during rotation | Previous `SESSION_SECRET` values, so evidence written before a rotation still verifies |
| `NODE_ENV=production` | Required in production | Secure cookie/HSTS behavior |
| `DATABASE_URL` | Required for verified live intelligence | Existing Neon sessions, policies, events, snapshots, evidence |
| `PUBLIC_BASE_URL` | Optional on Render | Canonical HTTPS webhook callback on other/custom hosts |
| `NV_EVENT_RETENTION_DAYS` | Optional | Event retention, 7–730 days; default 90 |
| `NV_SESSION_RETENTION_DAYS` | Optional | Inactive session retention, 7–365 days; default 35 |
| `NV_LIVE_CLIENTS_PER_REPO` | Optional | Concurrent SSE clients per identity/repository, 1–20; default 5 |
| `NV_LIVE_CLIENTS_TOTAL` | Optional | Process-wide SSE client ceiling, 10–500; default 100 |
| `NV_SNAPSHOT_RETENTION_COUNT` | Optional | Signed snapshots retained per identity/repository, 5–200; default 50 |
| `NV_SNAPSHOT_MANIFEST_MAX` | Optional | Maximum manifest rows, 1,000–50,000; default 10,000 |
| `NV_GIT_DATA_MAX_MB` | Optional | Batch Git Data blob ceiling, 10–95 MB; default 64 |
| `NV_NATIVE_PUSH_MAX_MB` | Optional | In-memory native push ceiling, 10–95 MB; default 64 |
| `NV_UPLOAD_MAX_MB` | Optional | Maximum raw upload, 25–2,048 MB; default 2,048 |
| `NV_UPLOAD_CONCURRENCY` | Optional | Concurrent streamed uploads per process, 1–4; default 1 |
| `NV_UPLOAD_TIMEOUT_MINUTES` | Optional | Upload/upstream transfer timeout, 2–60 minutes; default 20 |
| `NV_STALE_UPLOAD_HOURS` | Optional | Temporary upload cleanup age, 1–72 hours; default 6 |
| `NV_GIT_HOST_ALLOWLIST` | Required in production for custom hosts | Comma-separated approved self-hosted GitLab/Gitea hostnames |
| `NV_YARA_RULES_PATH` | Optional, advanced hosting only | Absolute path to a trusted compiled/readable YARA rules file |
| `NV_YARA_BIN` | Optional | YARA executable name/path; default `yara` |
| `NV_YARA_TIMEOUT_SECONDS` | Optional | Per-file YARA timeout, 1–30 seconds; default 5 |
| `NV_REQUIRE_YARA` | Optional | Fail uploads closed when configured YARA is unavailable |
| `GITHUB_CLIENT_ID/SECRET` | Optional | GitHub OAuth; PAT login continues to work |

## Enable verified live events

1. Configure `DATABASE_URL` and deploy successfully.
2. Open a GitHub repository in Nebulaverse-X.
3. Open **Neural**.
4. Select **Connect verified live events**.
5. Approve webhook creation.

The connected GitHub credential must have permission to create repository webhooks. Existing events remain in Neon when the webhook is disconnected.

Rotating `SESSION_SECRET` intentionally invalidates existing sessions and stored webhook secrets. Snapshot verification uses its independent keyring. Before rotating a session key that signed pre-migration snapshots, retain that old value in `NV_SNAPSHOT_LEGACY_KEYS_JSON` only until those snapshots expire. Reconnect repository webhooks after a session-key rotation.

The evidence ledger has its own rotation path, because it keeps records rather than expiring them. Its hashing key is derived from `SESSION_SECRET`, so rotating that secret moves the key and records written under the previous one stop reproducing their hash — on a tamper-evident ledger that reads as tampering after nothing worse than routine key hygiene. Populate `NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON` with the outgoing value **before** rotating, not after. Records predating the key separation need `NV_EVIDENCE_LEGACY_SESSION_KEY=true` as well, which is a migration setting: leaving it on permanently means a leaked `SESSION_SECRET` can still forge evidence that verifies.

Neither value expires on its own. Remove one only once the evidence export reports `legacyRecords: 0` for every repository, or re-anchor the chain first; a deployment that declines the legacy opt-in while such records remain is told so by `legacyKeyRequired` rather than being left to read an unmigrated chain as tampering. `docs/operations/SECURITY_DEPLOYMENT.md` carries the full procedure.

## Important boundaries

- Protected paths are enforced by Nebulaverse-X. Provider rulesets are still required to prevent bypass through Git CLI, GitHub Desktop, or another integration.
- A signed snapshot preserves references and metadata; it does not independently store every Git object, LFS object, issue, review, or release asset.
- Webhook event retention is not an immutable compliance archive.
- Dependency scanning uses available OSV/Dependabot information and reports an incomplete result when OSV is unavailable. Raw uploads receive a bounded signature gate. Optional YARA execution requires a trusted binary/rules file and does not replace isolated antivirus/sandbox scanning.
- GitHub has the deepest feature coverage; GitLab and Gitea remain capability-limited where their APIs differ.

If `DATABASE_URL` is configured but Neon is unavailable, database-backed sessions fail closed instead of silently reverting to a revocation-resistant cookie.

Nebulaverse-X is designed to be useful without paid AI: its intelligence comes
from verified events, graph algorithms, transparent security rules, signed
evidence, and human-approved actions.
