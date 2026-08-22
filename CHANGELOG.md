# Changelog

## Unreleased

### Continuity State and Release-Identity Correctness

- Added a static identifier-resolution gate (`eslint.config.js`, `no-undef` only)
  that declares the real cross-script global surface of the no-bundler app shell,
  and made `npm run lint` blocking in both the CI and alpha.17 qualification
  workflows.
- Fixed an unresolved identifier in the notification-preferences dialog, where
  `escapeHtml` was called outside the closure that defines it; the four sibling
  governance dialogs already used the app-shell `esc` helper.
- Closed a unit-gate inventory gap: two test programs existed but were never
  executed by the gate chain. Added them (140 to 142 programs) and added a drift
  guard that fails when any discovered `test/*.test.js` is absent from the chain.
- Made the static-asset stamp injective by construction. Deriving it from the
  release-numeric prefix collapsed every 5.3.0 prerelease onto `530`, so a
  returning tester kept a stale service-worker shell cache against a freshly
  deployed server. The stamp now encodes the version's own UTF-8 bytes as
  fixed-width decimal groups and decodes back to the exact version.
- Replaced a hardcoded shell-cache name in the browser matrix and two static
  assertions that passed regardless of the asset stamp, because `express.static`
  ignores the query string.
- Replaced continuity schema 4 with schema 5, which separates shape validation
  from stored values so the record can move as gates advance. Schema 4 accepted
  exactly one frozen position and rejected every legitimate advance as malformed,
  which is why the generated documents kept asserting a state the project had
  already left. Commit identity became a role-tagged set, so one accepted tree
  can be proven through several transport-specific commits. Added ADR-083,
  superseding ADR-071.
- Bound generated gate prose to gate status. The evidence and restriction text in
  `PROJECT_STATE.md` and `CONTINUATION_PROMPT.md` was fixed, so a passed gate
  would have rendered beside prose insisting its evidence was still missing.
- Made the exported `publicAlphaPosition` validate the continuity record before
  returning a release position, so a caller outside the module cannot be told
  `GO` by a hand-built object that never satisfied the gate schema, the run-id
  contract, or the final-release ratchet.

### Key Separation and Dependency Determinism

- Gave every keyed construction its own HKDF-SHA256 derived key. One
  `SESSION_SECRET` previously backed the session cookie, CSRF tokens, step-up
  grants, GitHub App OAuth state, the evidence-ledger hash chain and the
  governance audit secret, while its SHA-256 digest served simultaneously as the
  AES-256-GCM session key and as the HMAC key for offline cache scopes and for
  GitHub App state replay detection. Nothing was exploitable, because the
  message shapes are disjoint and the token codec tags its own kind inside the
  signed payload, but that safety was an unwritten invariant rather than a
  property of the design. The snapshot-signing reuse check still compares
  against the raw secret, which is what it exists to do.
- Pinned every dependency to an exact version and made the lockfile agree.
  A lockfile does not make a range safe: `npm ci` honours the lock but
  `npm install` re-resolves and silently rewrites it, and `express ^4.19.2` had
  already drifted to 4.22.2 and `pg ^8.11.5` to 8.22.0 with no deliberate
  upgrade. Added a contract guard that rejects any range and any disagreement
  between the declared version and the locked one.
- Kept existing evidence chains provable across that key rotation. The ledger is
  tamper-evident, so a record that cannot reproduce its hash is reported as
  tampering; changing the hashing key would have made every record written
  under the old one accuse itself on first deploy. Verification now tries the
  active key and then the retired one and reports which matched, the same shape
  the snapshot signatures already use, and the export states how many records
  verified under the retired key.
- Made that retired key opt-in rather than permanent. Accepting the raw session
  secret forever would have undone half the point of separating it, leaving a
  leaked `SESSION_SECRET` able to forge evidence that verifies. Production now
  accepts it only when `NV_EVIDENCE_LEGACY_SESSION_KEY=true`, matching the rule
  already applied to legacy snapshot keys, and development keeps the
  compatibility path. A deployment that declines the opt-in while still holding
  pre-separation records is told so: verification reports `legacyKeyRequired`
  rather than a bare failure, so an unmigrated chain is distinguishable from
  tampering.
- Kept evidence provable across a `SESSION_SECRET` rotation. The evidence key is
  derived from that secret, so rotating it moved the derived key and every
  record written under the old one stopped reproducing its hash — the same false
  alarm the retired key already prevented for pre-separation records, reachable
  through nothing worse than routine key hygiene. Operators now carry previous
  secrets forward in `NV_EVIDENCE_RETIRED_SESSION_SECRETS_JSON`, bounded to
  eight, and malformed input fails at startup rather than silently shrinking the
  keyring.

### Documentation Truth Architecture

- Separated current, vision, architecture, release, operations, qualification,
  reference, historical, and development records under `docs/`.
- Made `WORK_CONTINUITY.json` schema v4 the machine-readable state authority and
  generated project state and continuation instructions deterministically.
- Recorded the exact green alpha.17 automated baseline while keeping the
  documentation successor, live providers, hosted environment, manual
  accessibility, and public alpha explicitly unqualified.
- Recovered the broader founder vision with implemented, committed-roadmap,
  exploratory, and out-of-current-scope maturity labels.
- Preserved historical Task reports/specifications and imported three approved
  public-alpha plans with their original SHA-256 values.

## 5.3.0-alpha.17.0

- Began the controlled hosted public-alpha successor from the qualified alpha.16.3 archive.
- Preserved alpha.16.3 and Task 21 evidence as immutable predecessor records.
- Added explicit provider/deployment capability truth and public-alpha release gates.
- Made the continuity collector accept verified detached CI checkouts while retaining named-branch mismatch, accepted-boundary ancestry, and worktree-state enforcement.
- Added a real temporary-Git regression covering detached JSON and human-readable continuity output.
- Published that four-file correction as sandbox commit `7f721a770df8e658e00163e05ebc259502f99c09`; qualification run `31314330832` then failed safely before authorization because its two-commit checkout could not prove ancestry from the older accepted boundary.
- Required full Git history for the automated qualification job and added an explicit continuity preflight before dependency installation so a future checkout regression fails early with a direct diagnostic.
- Added real-Git negative regressions proving a wrong named branch and an unrelated detached commit remain rejected.

## 5.3.0-alpha.16.3 — Gitea File Mutation Compatibility (Phase 1 Task 21 in progress)

- Preserved alpha.16.1 and alpha.16.2 as immutable failed release candidates.
- Reproduced alpha.16.2's live Gitea HTTP 400 at the real server boundary: the shared GitHub path attempted `POST /git/blobs`, while Gitea file writes are exposed through `/contents/{filepath}`.
- Added a provider-specific Gitea file mutation adapter for create, update and delete without changing GitHub or GitLab transports.
- Creates a disposable branch from the exact expected head, mutates it through the Gitea Contents API, moves the target branch with a non-forced old/new commit compare-and-swap, verifies the resulting head and cleans the disposable branch.
- Added preflight stale-head and post-preflight compare-and-swap race regressions, plus real-server create/delete coverage that rejects every mutating `/git/*` request.
- Made normalized Gitea governance scopes idempotent so warn-mode policy-evaluation fallback does not fail before provider transport.
- Requires a new immutable alpha.16.3 archive, checksum and fresh Node 22 and live Gitea evidence before the gate can open.

## 5.3.0-alpha.16.2 — Gitea Compatibility Correction and Release Requalification (Phase 1 Task 21, release-blocked)

- Preserved immutable alpha.16.1 and its final Task 20 result of 18 passed, 1 failed and 0 unexecuted.
- Added one provider-aware repository-branch normalizer: GitHub reads `commit.sha`; GitLab and Gitea read `commit.id`.
- Routed GitHub, GitLab and Gitea repository detail responses through the same tested normalization boundary.
- Added an independent three-provider regression, including missing-commit behavior.
- Classified the reported high-severity advisory as a dev-only Archiver traversal chain; the production audit is clean and the release packager does not invoke the vulnerable glob path.
- Kept the lockfile unchanged because npm reports no available fix and no supported runtime path is reachable.
- Made release archives byte-deterministic by appending the already sorted file bytes to Archiver in order instead of allowing asynchronous file reads to reorder ZIP entries.
- Added a four-build byte-identity regression and made it part of the default test suite.
- Produced immutable candidate SHA-256 `1a83ddc3a94a42caa5c252e2a4833788c31f540ec8c21860e5aa333d22493564`.
- Passed the credential-free Node 22 candidate matrix, then failed live Gitea requalification during the bounded file write with HTTP 400 because the shared path used Gitea's read-only Git Data API.

## 5.3.0-alpha.16.1 — Candidate-Bound Staging Evidence Hardening (Phase 1 Task 20 in progress)

- Upgraded Task 20 evidence to schema `1.2.0` and bound every record to the exact candidate, catalog, prescribed command/procedure, and verified pass/fail artifact files.
- Made report hashing reproducible across verification times while evidence remains fresh.
- Added a dependency-aware independent test-matrix runner with per-program classification and hashed output.
- Replaced presence-only browser checks with behavioral keyboard, mobile Governance, Cache Storage, and offline-failure assertions.
- Added ADR-054. Task 20 remains incomplete, the staging gate remains closed, and Task 21 remains blocked.

## 5.3.0-alpha.16 — Fail-Closed Staging Validation Checkpoint (Phase 1 Task 20 in progress)

- Added immutable Task 20 validation catalog, canonical evidence schema and deterministic gate report hash.
- Added blocked evidence-plan generation and verification CLI.
- Added browser/accessibility staging specifications and CI contracts.
- Task 20 remains incomplete until live runtime, browser, Neon, provider, destructive and delivery evidence passes.

## 5.3.0-alpha.15 — Governance Notifications, Webhooks and Signed Audit Exports (Phase 1 Task 19)

- Added migration 013 with immutable governance event outbox, notification preferences, webhook configurations, delivery attempts and signed export records.
- Added versioned credential-free event schemas, HMAC-signed webhook payloads and bounded JSON/CSV evidence envelopes.
- Added SSRF-safe webhook validation, DNS revalidation, TLS address pinning, bounded retry/dead-letter behavior and one-time secret rotation.
- Added live-only notification, webhook and export workflows to the Governance interface.
- Added ADR-051 and ADR-052; Task 20 is the next alpha.16 checkpoint.
- External customer-controlled evidence storage remains Phase 5 and was not implemented.

## 5.3.0-alpha.14 — Full Mutation Coverage and Bulk Operation Governance (Phase 1 Task 18)

- Added the immutable machine-readable repository mutation route/action inventory and execution-contract catalog.
- Added provider-write ceilings and deterministic operation IDs inside the Central Mutation Gateway.
- Added bounded, target-bound file-batch normalization with ordered item IDs, batch hash, payload ceiling and required expected branch head.
- Bound recovery policy/exception evaluation to the exact sealed branch-action set and exposed per-item partial outcomes.
- Classified Git receive-pack and Git LFS batch/upload/verification side effects explicitly.
- Added static route/helper coverage, gateway execution and bulk-security regression contracts.
- Added ADR-049 and ADR-050 and set Task 19 as the next alpha.15 checkpoint.
- Added no database migration, dependency, notification/export implementation or external evidence storage.

## 5.3.0-alpha.13 — Policy Digital Twin Interface (Phase 1 Task 17)

- Added one accessible, responsive repository Governance workspace over the Task 16 repeatable-read Digital Twin.
- Added a credential-free server access projection containing only exact repository scope, verified human login, execution type, bounded capability booleans and evidence expiry.
- Added a pure XSS-safe `public/governance-ui.js` renderer for current, proposed, effective and historical policy evidence, including loading, empty, partial, stale and error states.
- Added live workflows for policy creation, server-derived baselines, drafts, immutable versions, simulation, reviewer decisions, activation/rollback, exceptions and decision-chain evidence.
- Kept all governance data network-only and memory-only; repository/account transitions and authoritative read-model changes clear stale client evidence.
- Added authorization-expiry control disabling, complete-versus-limit-bounded verification messaging, responsive layouts, reduced-motion support and labelled focus-contained dialogs.
- Added Task 17 access, renderer, client, workflow, server and UI contracts with no new dependency or database migration.
- Added ADR-048 and set Phase 1 Task 18 as the next alpha.14 checkpoint.

## 5.3.0-alpha.12 — Policy Templates, Repository Baselines and Digital Twin Read Model (Phase 1 Tasks 15–16)

- Added immutable versioned built-in policy templates with deterministic catalog, template and document hashes.
- Added observe-only repository baseline generation from bounded server-resolved facts with exact provenance and readiness warnings.
- Added explicit branch-data completeness and protected-branch truncation evidence and deterministic rules for all resolved protected branches.
- Kept exact baseline generation available in read-only safeguard mode and corrected Gitea branch pagination to prevent silent incomplete facts.
- Added a reader-authorized, credential-free Policy Digital Twin projection derived in one PostgreSQL repeatable-read read-only transaction.
- Added current, proposed, effective and historical sections with active drafts, review state, activation evidence, active-exception summaries, histories, pagination, freshness and completeness.
- Prevented evidence hashes from different activations being combined and prevented truncated history pages from defining operational totals.
- Added four no-store governance read routes without adding a database migration or final UI.
- Added ADR-046 and ADR-047 and set Phase 1 Task 17 as the next alpha.13 checkpoint.

## 5.3.0-alpha.11 — Exceptions, Waivers and Expiry Workflow (Phase 1 Task 14)

- Added immutable, exact-scope policy exception and waiver requests bound to the verified human requester and exact canonical mutation target, with separate author request and administrator approval/rejection.
- Added administrator revocation, synchronous expiry and active-policy-version supersession.
- Added migration `012_governance_exceptions.sql` with append-only request/event tables, composite policy/version constraints, bounded target JSON and deterministic target hashes.
- Added three Central Mutation Gateway actions and repository-scoped governance API routes.
- Added wrong-actor and wrong-target rejection, including verified-human binding for optional GitHub App execution.
- Applied approved records only to covered matched rules, preserving original/effective results, subject identity, target hash and exact runtime evidence.
- Added a 100-active-exception bound per repository/action with serialized approval and runtime overflow detection.
- Preserved historical alpha.10 decisions by retaining engine version 1 and control catalog `1.0.0`; Task 14 uses engine version 2 and catalog `1.1.0`.
- Fixed point-in-time approval/revocation races by evaluating both against one post-lock operation timestamp.
- Updated continuity documents and set combined Phase 1 Tasks 15–16 as the next alpha.12 checkpoint.

## 5.3.0-alpha.10.1 — Planning Records: External Evidence Retention and Provider Scope

- Inserted Phase 5 — Customer-Controlled Evidence Retention under later phases without changing Phase 1 or Task 19.
- Added ADR-041 for future S3-compatible, integrity-preserving customer-controlled evidence storage after Task 19.
- Added ADR-042 recording that Bitbucket remains intentionally unsupported pending concrete customer demand.
- Updated continuity and package contracts for 42 sequential ADRs, four later roadmap phases and the alpha.10.1 canonical package.
- Made no runtime, database, provider, enforcement or Phase 1 sequencing changes; Task 14 remains the next implementation checkpoint and alpha.11 remains reserved for it.

## 5.3.0-alpha.10 — Runtime Policy Enforcement and Control Evidence (Phase 1 Tasks 12–13)

- Hardened deployment with cursor-paginated runtime decision history, repeatable-read chunk verification, a 100-active-policy preflight/activation bound, scoped evaluator-failure logs, and accurate mixed rollout warning evidence.

- Integrated deterministic active-policy evaluation into the Central Mutation Gateway before every registered provider write.
- Added backward-compatible `observe`, bounded `warn`, and pre-provider `block` rollout modes.
- Preserved historical policy hashes by leaving absent legacy enforcement fields absent and interpreting them as observe.
- Added repository-scope shared/exclusive active-policy-set locking across runtime evaluation, activation and rollback.
- Added immutable descriptor-bound policy decisions with active version, document hash, head revision, effect and rollout evidence.
- Added migration `011_governance_policy_decisions.sql` with append-only triggers and relational/JSON consistency constraints.
- Added reader-authorized decision history and HMAC-chain verification endpoints.
- Added a versioned server-side control catalog with deterministic `supports` mappings and explicit unmapped actions.
- Added validated `NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn|block`; Render defaults to warn for initial rollout.
- Kept governance recovery/control-plane mutations non-blocking at the policy layer, including evaluator failures, while preserving existing authorization and lifecycle controls.
- Added bounded policy outcome headers and non-secret runtime failure logs.
- Updated deployment guidance, continuity artifacts and set Phase 1 Task 14 as the next alpha.11 checkpoint.

## 5.3.0-alpha.9 — Evidence-Backed Policy Activation and Rollback (Phase 1 Task 11)

- Added activator-authorized policy activation, rollback and activation-history APIs.
- Added critical Central Mutation Gateway actions for activation and rollback with verified human attribution.
- Recomputed reviewed Task 9–10 simulation evidence against the current target and active baseline before every write.
- Required final Task 8 approval, no rejection, exact policy-head revision and fresh level-50 repository authority.
- Revalidated activator evidence after policy/review lock acquisition to prevent lock-wait expiry races.
- Added immutable migration `010_governance_activation_evidence.sql` with same-policy composite provenance.
- Added atomic activation event, policy-head transition, evidence persistence, HMAC audit append and idempotent response capture.
- Required rollback targets to have prior evidence-backed activation and preserved source activation provenance.
- Added canonical no-policy baseline verification and bounded activation-specific input/error contracts.
- Preserved PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon compatibility.
- Updated continuity documents and set combined Phase 1 Tasks 12–13 as the next alpha.10 checkpoint.

## 5.3.0-alpha.8 — Policy Simulation and Explainable Impact (Phase 1 Tasks 9–10)

- Added a deterministic, read-only policy simulation engine using the Central Mutation Gateway action registry.
- Added bounded repository mutation scenarios with exact registered actions and credential/raw-content rejection.
- Added exact rule matching, deterministic effect precedence, conflict evidence and default-allow simulation behavior.
- Added active-policy or no-policy comparison with strengthened, relaxed and unchanged impact classifications.
- Added repository scope, scenario-set, evaluation, result and complete simulation hashes.
- Added action-class, risk-level, unsupported-action and bounded warning evidence for later activation review.
- Added a reader-authorized simulation API route with no provider, governance-store, audit or mutation-gateway write.
- Reverified stored immutable policy document hashes before simulation.
- Preserved PAT, OAuth, optional GitHub App, GitLab, Gitea, Render Free and optional Neon compatibility.
- Updated continuity documents and set Phase 1 Task 11 as the next alpha.9 checkpoint.

## 5.3.0-alpha.7 — Reviewer Assignment and Approval Workflow (Phase 1 Task 8)

- Added repository-scoped reviewer self-claim from fresh server-derived reviewer authority.
- Added immutable reviewer assignments and immutable approve/reject decisions.
- Added deterministic pending, approved, rejected, quorum, and terminal review state.
- Enforced author/reviewer separation when configured and required rationale for rejection.
- Preserved optional GitHub App installation/human identity separation and PAT/OAuth/GitLab/Gitea compatibility.
- Added Central Mutation Gateway actions `governance.reviewer.assign` and `governance.approval.decide`.
- Added optional hashed idempotency for reviewer claims and decisions.
- Added append-only migration `009_governance_reviews.sql`.
- Excluded legacy unassigned approval primitives from Task 8 review and future activation counts.
- Added bounded review input, stale-evidence, credential-text, scope, concurrency, finality, and retry protections.
- Updated continuity documents and set combined Phase 1 Tasks 9–10 as the next alpha.8 checkpoint.

## 5.3.0-alpha.6 — Governance API and Policy Draft Workflow (Phase 1 Tasks 6–7)

- Added one authenticated, repository-scoped governance API authorization boundary.
- Added durable author-owned policy drafts with optimistic revisions.
- Added atomic submission into ordered immutable policy versions and linked audit evidence.
- Added four Central Mutation Gateway governance actions with verified human attribution.
- Added optional hashed, transactionally isolated idempotency for governance writes.
- Added migration `008_governance_drafts.sql`.
- Added optional stable `NV_GOVERNANCE_AUDIT_SECRET` configuration.
- Preserved GitHub PAT/OAuth, optional GitHub App, GitLab and Gitea compatibility.
- Corrected case-sensitive self-hosted Gitea scope comparison and rejected prototype-control keys in governance JSON.
- Updated continuity documents and set Phase 1 Task 8 as the next implementation gate.

## 5.3.0-alpha.5 — Provider Permission and Governance Role Resolver (Phase 1 Task 5)

- Added deeply immutable, credential-free repository authorization snapshots.
- Added server-derived GitHub PAT/OAuth, GitLab and Gitea permission normalization.
- Kept GitHub App installation capability separate from verified human governance authority.
- Added exact GitHub App repository-selection proof before human role resolution.
- Added conservative reader, author, reviewer, activator and administrator derivation.
- Kept GitLab Maintainer distinct from Owner to prevent privilege inflation.
- Added bounded fail-closed evidence states, cache expiry, identity isolation and request coalescing.
- Added snapshot consistency, sensitive-field, repository-scope and mutation-actor validation.
- Attached authorization evidence to every Central Mutation Gateway descriptor without enabling policy enforcement yet.
- Updated continuity documents and set Phase 1 Task 6 as the next implementation gate.

## 5.3.0-alpha.4 — Central Mutation Gateway Foundation (Phase 1 Task 4)

- Added a canonical registry of 28 repository mutation actions.
- Added immutable provider-authority/repository/actor/route-bound mutation descriptors.
- Added `AsyncLocalStorage` execution context for route-to-provider propagation.
- Added fail-closed write assertions to GitHub, Gitea, GitLab, Git push, and Git LFS paths.
- Added action-to-provider-operation binding to prevent same-repository authority confusion.
- Preserved Task 1 step-up proof requirements for deletion, hard reset, and pull merge.
- Added bounded credential-free mutation metadata and minimized lifecycle events.
- Added exact route-coverage, action-binding, continuity, syntax, and package contracts.
- Added self-contained project state, 21-task roadmap, architecture decisions, and continuation prompt.
- Preserved PAT/OAuth/GitLab/Gitea connectivity and optional GitHub App authentication.

## 5.3.0-alpha.3 — Governance Persistence Foundation (Phase 1 Task 3)

- Added provider-authority/repository-scoped governance policy identities that support genuinely distinct authors, reviewers, and activators.
- Added bounded schema-v1 policy documents with deterministic canonicalization, unique rule IDs, explicit effects, and SHA-256 content hashes.
- Added immutable ordered policy versions, immutable reviewer decisions, transactional active-version heads, activation history, and rollback provenance.
- Added default separation of duties, one decision per reviewer identity, rejection gates, approval thresholds, and decision finality after activation.
- Added optimistic policy revisions plus PostgreSQL advisory/row locking for concurrent review, version, activation, rollback, and audit operations.
- Added an HMAC-linked, sequence-ordered governance audit chain with complete/partial verification status.
- Added database triggers that reject UPDATE, DELETE, and TRUNCATE on policy versions, approvals, activations, and governance audit history.
- Added sensitive-field and size rejection so credentials cannot be persisted in policy or audit JSON.
- Added governance model, migration, store, concurrency, rollback, finality, audit-chain, release, and regression tests.

## 5.3.0-alpha.2 — Optional GitHub App Foundation (Phase 1 Task 2)

- Added opt-in GitHub App configuration that fails safely when absent or incomplete.
- Added signed, session/identity-bound, expiring, single-use user-authorization and installation-claim state.
- Added authorizing-user verification and installation ownership checks before local registration.
- Added a server-only GitHub App JWT and short-lived installation-token broker with refresh margin, request coalescing, and cache invalidation.
- Added a single provider-credential boundary so stored GitHub App accounts remain tokenless while PAT, OAuth, GitLab, and Gitea behavior stays compatible.
- Added optional Neon installation metadata and non-secret lifecycle audit tables.
- Added Settings UI for installation scope, authorizer, health refresh, reauthorization, and local disconnect.
- Added configuration, broker, ownership, persistence, server, disabled-mode, UI, and regression tests.

## 5.3.0-alpha.1 — Phase 1 Security Foundation (Task 1)

- Added signed, session- and active-identity-bound CSRF tokens for authenticated unsafe API requests.
- Added Fetch Metadata and explicit Origin enforcement while retaining the existing application-request header.
- Added five-minute, action- and scope-bound, single-use step-up authorization grants.
- Added provider-backed confirmation for repository deletion, hard reset, pull-request merge, and revoking other sessions.
- Added bounded replay protection for parallel requests and cleared grants before sensitive handlers execute.
- Preserved PAT, OAuth, GitLab, and Gitea flows; GitHub App remains optional.
- Added security-foundation unit, integration-contract, and server-smoke coverage.

> Prerelease note: this is Task 1 of the approved 21-task Phase 1 plan, not the final v5.3 release.

## 5.2.2 — Phase 0 Stabilization

- Adopted **Nebulaverse-X** as the official package, UI and Render service name.
- Made `package.json` the single authored release-version source.
- Replaced the shared permanent API cache with opt-in, repository-scoped, account/session-isolated offline caches.
- Added 24-hour TTL, 100-entry, 1 MiB object and 25 MiB total private-cache limits.
- Added identity-boundary cache purging and fail-safe local logout cleanup.
- Added numbered, checksummed Neon migrations with an advisory lock.
- Added release hygiene, deterministic ZIP packaging, CI and browser-regression foundations.

## 5.2.0 — Verified Intelligence Edition

### Added

- GitHub webhook creation and HMAC-SHA256 raw-payload verification
- Neon-backed normalized intelligence-event history
- Authenticated Server-Sent Events for Neural live updates
- Deterministic repository-event risk scoring with explicit reasons
- Shortest-path “Explain this connection” graph analysis
- Shadow Access Radar for collaborators, deploy keys, webhook posture, and deterministic access risk
- Stable timestamp/event-ID event cursors with persisted SSE catch-up
- JSON/CSV/Markdown activity export including available verified intelligence events
- Upload-scanner posture nodes in the Neural Security/Dependencies views
- Snapshot comparison, restore-impact preview, typed recovery confirmation, short-lived preview authorization, replay rejection, and stale-branch preflight
- Signed server-side Emergency Shield containment manifest
- Whole-file built-in upload signature scanning and optional administrator-managed bounded YARA adapter
- Persistent read-only, synchronization-freeze, and protected-path state
- Folder and wildcard protected-path policies
- Signed reference/file-manifest snapshots with verification status
- Chained evidence records and JSON evidence export
- `/readyz` database-readiness endpoint
- Event/session retention maintenance
- Indexed session ownership for complete identity-scoped containment
- Bounded ZIP/archive preflight before decompression
- Bounded evidence-chain records in JSON export
- Explicit partial snapshot and dependency-scan availability states
- Webhook delivery abuse limiting
- Repository vulnerability alert event support

### Security
- Neutralized spreadsheet formula injection in downloaded CSV activity reports and added dedicated regression tests.

- JSON/CSV activity export neutralizes spreadsheet formula injection in provider-controlled cells

- Network-only service-worker handling for all authenticated APIs
- Markdown preview fails closed when DOMPurify is unavailable
- Stronger CSP with `object-src`, `base-uri`, and `form-action`
- Exact vendor/font proxy allowlists and bounded upstream response sizes
- Configured Neon sessions fail closed during database outages
- Parent-folder restore/move policies are evaluated against every affected child path
- Repository-local drafts, recents, snapshots, incidents, and queued writes are purged at logout/account boundaries
- Provider avatar attributes and label colors are escaped or format-constrained before HTML insertion
- Graceful SIGTERM/SIGINT shutdown closes live streams and the Neon pool
- Production webhook callback no longer trusts an arbitrary Host header
- Case-insensitive protected-repository matching
- Public npm registry lockfile URLs

### Preserved

- Render Free web service
- Existing optional Neon database
- Existing GitHub/GitLab/Gitea features
- SmartPush/Git LFS, Time Machine, safeguards, dependency audit, and Neural UI

### Known boundaries

- GitHub-only verified webhooks in v5.2
- Provider-side protected-path enforcement not yet automated
- Signed snapshots are not complete off-platform backups
- Full isolated antivirus/malware sandbox worker not included; optional local YARA adapter is disabled by default
