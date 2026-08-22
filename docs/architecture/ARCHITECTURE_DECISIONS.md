# Nebulaverse-X Architecture Decisions

This file records durable decisions that future tasks and conversations must preserve unless an explicit, reviewed replacement decision is approved.

## ADR-001 — Product identity

**Decision:** The official product name is **Nebulaverse-X**.

**Reason:** Release metadata, package identity, UI and project communications must remain consistent.

## ADR-002 — Cost-conscious deployment

**Decision:** The supported deployment remains one Render Free web service with an optional existing Neon PostgreSQL database. No Render database resource or paid AI API is required.

**Consequence:** Durable governance features require Neon when used, while unrelated product capabilities continue without it. Governance must not pretend to be durable through process memory or cookies.

## ADR-003 — Authentication compatibility

**Decision:** GitHub PAT, GitHub OAuth, GitLab token and Gitea token connectivity remain first-class. GitHub App authentication remains optional.

**Consequence:** New architecture must use capability/credential boundaries rather than hard-code GitHub App assumptions.

## ADR-004 — Request security foundation

**Decision:** Unsafe authenticated requests require application/same-origin checks and session/identity-bound CSRF. Critical actions require short-lived, single-use, action-and-scope-bound step-up grants.

**Consequence:** Later policy approval does not replace Task 1 request security; both layers are required.

## ADR-005 — Server-only GitHub App credentials

**Decision:** The App private key and installation tokens remain server-side. Installation tokens are short-lived, scoped, authorizer-isolated and never returned to browser JavaScript or audit details.

## ADR-006 — Repository-scoped governance

**Decision:** Governance policy identity is provider authority + repository owner/path + repository name, not the current login identity.

**Reason:** Multiple distinct people must be able to author, review and activate policy for the same repository. Self-hosted provider authority prevents cross-instance collisions.

## ADR-007 — Immutable governance history

**Decision:** Policy versions, reviewer decisions, activation/rollback events and audit records are append-only. Rollback creates a new event; it never rewrites history.

**Consequence:** PostgreSQL triggers reject update/delete/truncate on history tables. One mutable policy-head pointer uses optimistic revisions.

## ADR-008 — Separation of duties

**Decision:** The version author cannot self-approve by default, reviewer decisions are immutable, any rejection blocks activation and decisions freeze after a version has ever been activated.

## ADR-009 — Central Mutation Gateway

**Decision:** Every outbound repository-changing provider operation must execute inside one immutable mutation context and must be asserted again at the provider helper/transport boundary.

**Reason:** Route middleware alone can be forgotten; helper assertions fail closed. Helper assertions alone lack user/action intent; route descriptors provide it. Both are required.

## ADR-010 — Action-to-operation binding

**Decision:** A gateway context is authorized only for the lower-level provider operation classes registered to its exact action.

**Reason:** Provider/repository scope matching alone would let a lower-risk context authorize a different write on the same repository.

## ADR-011 — Policy-neutral Task 4 boundary

**Decision:** Task 4 records and validates mutation intent but does not yet allow, warn or deny based on policy.

**Consequence:** Task 5 resolves permissions and roles; later tasks add policy evaluation at the gateway without rewriting all mutation routes.

## ADR-012 — Credential-free descriptors and evidence

**Decision:** Mutation descriptors, governance documents, audit details, exports and continuity records must never contain credentials, cookies, authorization headers, private keys, raw file content or unbounded user-controlled strings.

## ADR-013 — Fail-closed unknowns

**Decision:** Unknown actions, unknown provider write operations, unresolved repository targets, identity/scope mismatches, missing step-up proof and unavailable durable governance state fail closed.

## ADR-014 — Test-first and independent review

**Decision:** Security- and governance-sensitive behavior requires a failing test first, focused green proof, full regression checks where the environment permits, independent read-only review and clean-package validation.

## ADR-015 — File-based continuity

**Decision:** Versioned ZIP packages and embedded checkpoint documents are the source of truth across conversations; chat history and shared links are supporting context only.

**Consequence:** Every meaningful release checkpoint updates project state, roadmap, decisions, report, checksum and continuation prompt.

## ADR-016 — Server-derived authorization snapshots

**Decision:** Provider repository permissions and governance roles are resolved only from authenticated server/provider evidence and normalized into one deeply immutable, credential-free snapshot before mutation descriptor creation.

**Consequence:** Browser-supplied roles, access levels, installation permissions and provider response bodies are never trusted as authorization inputs.

## ADR-017 — Execution principal and governance actor separation

**Decision:** A GitHub App installation is the execution principal, while the human who authorized it is a separately identified governance actor whose current repository role must be revalidated.

**Reason:** Installation capability does not prove that a human may author, review, activate or administer governance policy.

## ADR-018 — Conservative governance-role derivation

**Decision:** Governance roles derive deterministically from normalized base access: read grants reader, write/Developer grants author, maintain/Maintainer grants reviewer, and repository Admin/Owner grants activator and administrator. Unknown, incomplete, stale or contradictory evidence grants no governance role.

**Consequence:** GitLab Maintainer remains distinct from Owner, custom provider roles cannot elevate above their base access, and role booleans cannot be supplied independently of normalized access.

## ADR-019 — Authorization evidence compatibility boundary

**Decision:** Task 5 attaches authorization evidence to every mutation but does not yet block existing repository operations when provider-role evidence is unavailable. Governance APIs introduced in Task 6 must fail closed on missing, stale or insufficient evidence.

**Reason:** Permission discovery must not regress established PAT/OAuth/GitHub App/GitLab/Gitea workflows before a dedicated governance authorization boundary exists.

## ADR-020 — One governance API authorization boundary

**Decision:** Every governance API operation is authorized server-side against a fresh Task 5 snapshot, exact provider authority/repository scope and one required governance role before the governance store is called.

**Consequence:** Browser roles, actor identities, access levels and installation capabilities are never accepted as authority. Governance fails closed when PostgreSQL or resolved permission evidence is unavailable.

## ADR-021 — Durable mutable drafts, immutable submitted versions

**Decision:** Policy drafts are durable, author-owned and optimistically revisioned. Submission atomically creates an immutable ordered version, removes the draft and appends audit evidence.

**Reason:** Authors need safe iterative editing, while reviewer and activation workflows require a stable immutable artifact.

## ADR-022 — Human attribution for GitHub App governance writes

**Decision:** Governance mutation descriptors and ownership bind to the verified human governance actor, not the GitHub App installation execution principal.

**Consequence:** Installation capability can execute authentication without being mistaken for a human author, reviewer or administrator.

## ADR-023 — Transactional hashed idempotency

**Decision:** Governance writes may use a bounded idempotency key that is hashed and isolated by repository scope, human actor and operation. Reservation, write, audit and response capture share one PostgreSQL transaction.

**Consequence:** Exact retries replay the original result, conflicting reuse fails, raw keys never enter persistence or evidence, and cleanup after 24 hours bounds storage.

## ADR-024 — Reviewer assignment by verified self-claim

**Decision:** Task 8 reviewer assignment is a self-claim by the currently authenticated, server-verified human governance actor. The browser cannot nominate another identity or supply reviewer authority.

**Reason:** Self-claim behaves consistently across PAT, OAuth, optional GitHub App, GitLab and Gitea without ambiguous third-party identity lookup or browser-trusted identity claims. Administrator-directed assignment may be designed later only with a separate server-side identity-resolution contract.

## ADR-025 — Immutable assigned decisions and deterministic finality

**Decision:** A Task 8 decision is accepted only from an immutable reviewer assignment for the same human and version. One rejection makes the review rejected; otherwise the configured number of distinct approvals makes it approved. Approved and rejected states are terminal for Task 8.

**Consequence:** Legacy approval primitives without Task 8 assignments cannot satisfy review or activation. Task 8 computes review readiness but never activates policy.

## ADR-026 — Review and activation serialization boundary

**Decision:** Reviewer claims and decisions acquire the same per-policy advisory lock used by activation, plus a per-version review lock.

**Reason:** A decision, rejection or new assignment must not race with policy activation. State is always re-read after locks and before append-only writes.


## ADR-027 — Simulations are pure, deterministic and non-persistent

**Decision:** Tasks 9–10 use a pure evaluator over immutable policy documents and bounded normalized scenarios. Simulation reads the current active version only for comparison and performs no provider call, mutation-gateway write, database write or audit append.

**Reasoning:** Simulation must be safely repeatable before activation. Persisting results or treating them as enforcement would prematurely couple Tasks 9–10 to activation and runtime policy evaluation.

## ADR-028 — Gateway action vocabulary and deterministic precedence

**Decision:** Simulation accepts only exact actions registered by the Central Mutation Gateway. Matching effects resolve deterministically as `deny` over `require-approval` over `allow`, while all conflicting matched rules remain visible in evidence. No matching rule simulates the explicit no-policy behavior `allow`.

**Reasoning:** One action taxonomy prevents drift between design-time policy evidence and later runtime enforcement. Conflict visibility avoids hiding ambiguous policy intent.

## ADR-029 — Hashes bind scope, scenarios and results

**Decision:** Simulation evidence contains normalized repository scope, immutable policy hashes, scenario-set hash, per-policy evaluation hashes, result hash and an overall simulation hash. Stored policy document hashes are recomputed before evaluation.

**Reasoning:** Later activation can bind approval to exact deterministic evidence without storing credentials or claiming that simulation proves provider behavior. Proposed conflicts, unsupported policy actions and supported proposed rules not exercised by any scenario make `activationReadiness` ineligible and must block Task 11 activation.

## ADR-030 — Server-recomputed activation evidence

**Decision:** Activation and rollback accept a reviewed simulation hash plus the bounded simulation request, then recompute Task 9–10 evidence server-side against the current immutable target and active baseline. Browser-provided reports are never authoritative.

**Reason:** A hash alone cannot prove current baseline, rule coverage or blocker state. Recalculation and store-level binding reject stale or forged evidence.

## ADR-031 — Lock-time activator revalidation

**Decision:** Policy activation and rollback require repository access level 50 and revalidate its expiry after acquiring the shared policy and review locks.

**Reason:** A request must not wait behind PostgreSQL contention and write after its provider-derived authority expires.

## ADR-032 — One-to-one immutable activation evidence

**Decision:** Every Task 11 activation or rollback appends a separate immutable evidence row bound by composite foreign keys to the same policy, activation, target version, baseline and optional rollback source.

**Consequence:** Existing activation history remains compatible, while Task 11 events prove exact simulation and authorization provenance without rewriting historical rows.

## ADR-033 — Rollback is a new evidence-backed head transition

**Decision:** Rollback is permitted only to a version with a prior Task 11 evidence-backed activation. It recomputes current impact evidence, records the source activation and advances the optimistic head revision.

**Consequence:** Rollback never restores state by editing history and cannot cross policy boundaries or silently reuse stale evidence.

## ADR-034 — Runtime policy evaluation belongs only at the Central Mutation Gateway

**Decision:** Routes, browsers and provider helpers cannot provide policy decisions, rollout modes or control mappings. The gateway evaluates the exact normalized mutation descriptor before provider execution.

## ADR-035 — Legacy policy versions default to observe without hash migration

**Decision:** `enforcement.mode` is optional in schema version 1. Absence means `observe` and remains absent during canonicalization so historical immutable document hashes do not change during upgrade.

## ADR-036 — Repository active-policy sets use shared/exclusive scope locking

**Decision:** Runtime evaluations take a transaction-scoped shared advisory lock for the repository scope before reading active heads. Activation and rollback take the matching exclusive lock before changing a head. This permits concurrent mutation evaluation while preventing active-set phantoms.

## ADR-037 — Runtime policy decisions use a separate immutable evidence chain

**Decision:** Attempted mutation evaluations are stored in an append-only repository-scope ledger separate from lifecycle audit history. Each record binds the normalized descriptor, active policy heads, control mapping, previous hash and HMAC record hash before provider execution.

## ADR-038 — Versioned control mapping is non-authoritative evidence

**Decision:** Compliance-control mapping is server-derived after evaluation from a versioned canonical catalog, uses relationship `supports`, is deterministically hashed, and can never modify allow, warn or block behavior. Unknown mappings remain explicit. Any catalog version referenced by immutable decision evidence must remain supported permanently; new versions are additive and cannot reinterpret historical mappings.

## ADR-039 — Runtime evaluator failure mode is explicit and recovery-safe

**Decision:** Deployments choose validated `warn` or `block` behavior through `NV_GOVERNANCE_RUNTIME_FAILURE_MODE`; Render starts at `warn`. Active policies and evaluator failure cannot block governance recovery/control-plane actions, whose existing authorization, approval, simulation, database and audit controls remain in force.

## ADR-040 — Runtime active-policy sets are explicitly bounded

**Decision:** A repository scope may have at most 100 simultaneously active policies. Activation rejects a 101st policy, runtime loading detects overflow before evaluation, and migration 011 aborts when existing data violates the bound.

**Consequence:** Decision evidence remains bounded and deployment cannot silently enter evaluator-unavailable mode because an earlier version accumulated an unsupported active set.

## ADR-041 — Customer-controlled evidence storage is S3-compatible and integrity-preserving

**Decision:** Customers may configure their own S3-compatible object storage as the durable sink for signed governance evidence and audit exports. One S3-compatible client serves all targets (AWS S3, Cloudflare R2, Backblaze B2, MinIO, S3-compatible NAS gateways) through endpoint/region/path-style configuration; providers are not special-cased in code.

**Binding constraints:**
- **Server-only credentials.** Customer storage credentials are held server-side only. They never appear in browser responses, mutation descriptors, the audit chain, logs, or any evidence export. (Extends ADR-012.)
- **Integrity survives the round-trip.** The HMAC-linked evidence chain's tamper-evidence must be independently verifiable *after* write to and read from customer storage. Storing evidence externally must never weaken the integrity guarantee that makes it audit-grade.
- **Fail-closed without evidence loss.** If customer storage is unreachable, evidence is not silently dropped: it remains durably queued in Neon and syncs on recovery, or the operation surfaces an explicit degraded state. Evidence integrity outranks availability.
- **SSRF-guarded endpoint.** A customer-supplied storage endpoint is a customer-supplied fetch target. It is validated (https, no private/internal/link-local addresses, no embedded credentials) using the same discipline as custom provider base URLs.
- **Retention/WORM awareness.** Where the target supports it (S3 Object Lock, B2 equivalent), immutable/WORM retention is offered so evidence cannot be deleted before the audit window closes.
- **Credential-free evidence.** Objects written to customer storage remain bounded and credential-free, consistent with ADR-012.

**Reason:** Compliance buyers need a full audit window of tamper-evident evidence under their own keys, region and retention control — a data-residency and retention requirement that operator-hosted storage alone cannot satisfy. This is a compliance-trust capability, not merely a storage feature.

**Consequence:** Depends on the Task 19 signed-export format as its input contract; built as its own versioned checkpoint after Task 19, not folded into it.

## ADR-042 — Bitbucket is intentionally out of scope pending demand

**Decision:** Supported providers remain GitHub, GitLab and Gitea. Bitbucket is deliberately unsupported; governance scope normalization rejects it with `GOVERNANCE_SCOPE_INVALID`.

**Reason:** A fourth provider multiplies the per-provider surface across the mutation gateway, permission resolver, simulation engine and enforcement layer. Until a paying customer requires Bitbucket specifically, the integration is cost without validated demand.

**Consequence:** The clean rejection is the correct posture — no partial Bitbucket support. Revisit only on concrete customer demand, at which point it is scoped as its own phase.


## ADR-043 — Exceptions are exact-scope, two-person and time-bounded

**Decision:** A policy exception or waiver is an immutable request bound to one provider authority, repository, policy, active version, exact policy-head revision, document hash, verified human requester, registered gateway action, bounded canonical mutation-target fingerprint and bounded rule set. A verified author may request it; a different verified administrator must approve or reject it; an administrator may revoke it. Runtime expiry is synchronous and does not depend on a background worker.

**Consequence:** Exceptions never edit policy documents or heads, cannot become permanent, and any head transition supersedes them even if the same version is later reactivated. They cannot cross scope, version, human-actor or normalized-target boundaries, and cannot bypass provider authorization, step-up, mutation classification or governance identity checks. Optional GitHub App execution remains bound to the verified human governance actor rather than the installation principal.

## ADR-044 — Historical policy decisions retain their original engine and control catalog

**Decision:** Task 14 policy decisions use engine version 2 and control catalog `1.1.0`. Engine version 1 and the exact control catalog `1.0.0` remain supported for historical alpha.10 records. Normalization and chain verification use the version recorded in each immutable decision.

**Reason:** Adding gateway actions changes catalog coverage and therefore its deterministic hash. Replacing catalog `1.0.0` in place would invalidate previously signed evidence. Historical evidence must never be reinterpreted through a later catalog.

## ADR-045 — Active exceptions are bounded and evaluated at one operation timestamp

**Decision:** At most 100 approved, unexpired and unrevoked exceptions may apply to one repository scope and gateway action. Approval is serialized by a repository/action advisory lock, runtime loading detects overflow, and revocation remains available as the recovery path. Approval and revocation applicability are both evaluated against the same post-lock operation timestamp.

**Consequence:** Concurrent administrators cannot create an unsupported 101st active exception, and events committed after evaluation begins cannot retroactively change an earlier runtime decision. Overflow never silently grants a bypass and follows the configured evaluator failure mode.

## ADR-046 — Policy templates and baselines are immutable, provenance-bound and non-activating

**Decision:** Built-in policy templates live in a source-controlled, immutable and versioned catalog. Repository baselines are generated deterministically from one selected template plus bounded server-resolved repository facts, and preserve the catalog ID, catalog version, catalog hash, template ID, template hash, repository-facts hash, policy-document hash and baseline hash. Generated documents default to `observe` and baseline generation never creates a draft, submits a version, changes a policy head or activates enforcement.

**Consequence:** A baseline is a reproducible recommendation rather than an authority-changing operation. Browser-supplied repository facts cannot influence it, existing immutable policy versions are never rewritten, and future catalog revisions must use a new version instead of reinterpreting prior provenance.

## ADR-047 — The Policy Digital Twin is a repeatable-read derived projection

**Decision:** The Policy Digital Twin read model is not stored as a second mutable source of truth. It is derived from authoritative governance tables inside one PostgreSQL `REPEATABLE READ READ ONLY` transaction and returned as a deterministic, credential-free, repository-scoped projection with explicit freshness, completeness, pagination and source-evidence hashes.

**Consequence:** Current policy heads, active drafts, proposed versions, reviews, activation evidence, active exceptions and histories cannot be combined from contradictory database moments. Partial or truncated inputs remain visible, and Task 17 may build the interface on this contract without duplicating governance state or adding write paths.

## ADR-048 — The governance interface is live, permission-projected and non-persistent

**Decision:** The Policy Digital Twin interface consumes the repeatable-read server projection plus a bounded server-derived access envelope. It does not persist governance state in browser storage or offline API caches, does not infer authority from visible controls, and disables controls when authorization evidence expires. Every lifecycle write continues through the existing authenticated governance API and Central Mutation Gateway.

**Consequence:** Browser state is a disposable view and workflow coordinator, not a governance source of truth. Repository/account transitions and authoritative read-model changes invalidate in-memory evidence; DOM tampering cannot grant authority; optional GitHub App execution remains visibly separate from the verified human governance actor.

## ADR-049 — Mutation coverage is machine-verifiable and execution-bounded

**Decision:** Every registered repository/provider mutation action has one immutable route inventory entry and one immutable execution contract describing mode, item bound, payload bound, provider-write bound, atomicity and partial-failure semantics. The Central Mutation Gateway enforces the provider-write bound and derives deterministic operation IDs before provider transport. Static package contracts fail when a mutating route, provider helper or registered action drifts outside the inventory.

**Consequence:** Mutation coverage is a build invariant rather than a manually maintained assurance statement. Adding a provider write requires an explicit action, route/helper classification, execution bound and regression contract before the package can pass.

## ADR-050 — Aggregate mutations are exact-item-bound and explicit about atomicity

**Decision:** Aggregate mutations bind deterministic item IDs and a batch hash into the gateway descriptor before policy and exception evaluation. File batches, path restoration and directory moves require optimistic branch-head evidence and use all-or-nothing single-provider-commit semantics. Recovery reference restoration is a bounded sequential partial-success workflow whose sealed branch-action authorization is at-most-once and whose per-item results carry deterministic provider operation IDs.

**Consequence:** A policy or exception decision cannot authorize an unspecified bulk target, partial provider success is never hidden, and automatic replay cannot repeat already-applied recovery actions. Task 19 may notify or export this evidence later but does not define its mutation semantics.

## ADR-051 — Governance delivery uses an immutable outbox and failure-isolated worker

**Decision:** Governance lifecycle and runtime decisions append bounded immutable event references in the same authoritative database boundary. Notification and webhook delivery is performed asynchronously from leased outbox records. Delivery failure, retry or dead-letter state cannot roll back or rewrite governance evidence. The HTTPS worker resolves and pins a validated public address, sends directly to that destination, never follows redirects, and treats every 3xx response as a terminal failure rather than re-resolving a `Location` target.

**Consequence:** Events survive process restarts and temporary provider outages without coupling governance availability to third-party endpoints. Duplicate attempts remain observable and idempotent; response bodies and credentials are never retained.

## ADR-052 — Signed evidence envelopes are the stable boundary before external storage

**Decision:** Task 19 defines deterministic, versioned, credential-free JSON/CSV evidence envelopes with bounded event count/size, formula-safe CSV, source-hash linkage and HMAC verification. This format is the only approved future input to customer-controlled evidence storage.

**Consequence:** Historical exports remain independently verifiable and Phase 5 can persist envelopes without redesigning governance records. Task 19 does not implement S3-compatible storage, customer credentials, retention/WORM controls or external synchronization.

## ADR-053 — Staging readiness is an expiring evidence gate, not a release assertion

**Decision:** Task 20 readiness is evaluated from a versioned immutable catalog of required checks and canonical evidence records. Missing, blocked, failed, stale, duplicated or malformed evidence keeps the gate closed. Live provider, Neon, browser and destructive checks cannot be replaced by source-level mocks or narrative confirmation.

**Consequence:** Alpha.16 may deliver the validation harness while Task 20 remains incomplete. Task 21 and stable v5.3 release readiness cannot begin until every required Task 20 record is a fresh verified pass. Optional GitHub App evidence may be absent only when the feature is not configured.

## ADR-054 — Staging evidence is candidate-, catalog-, command-, and artifact-bound

**Decision:** Task 20 evidence schema `1.2.0` binds every validation record to the exact release-candidate SHA-256, immutable validation-catalog hash, prescribed command or canonical procedure ID, and at least one verified non-secret artifact file for a pass or fail. The verifier requires the expected candidate hash out of band, rejects mixed or synthetic command evidence, reopens bounded regular artifact files under `staging/evidence/` and recomputes their hashes, and computes a report hash that is stable across verification times while the evidence remains fresh.

**Reason:** Shape-valid JSON alone is not proof that the intended candidate or procedure was tested. Alpha.16 could be opened by manually constructed pass records and its report hash changed merely because verification ran at a different time.

**Consequence:** Evidence created for another candidate, another catalog, or another command cannot open the gate. The all-zero committed template is blocked by design and must be regenerated for each exact candidate. This strengthens ADR-053 without changing the rule that live provider, Neon, browser, destructive, and delivery evidence cannot be replaced by mocks or narrative confirmation.

## ADR-055 — Controlled hosted alpha access is independent from provider authorization

**Status:** Accepted

An invitation proves cohort access only. It never grants repository access. Provider authorization remains a separate boundary, and every repository request is additionally constrained by the tester's exact canonical repository allowlist.

## ADR-056 — Provider and deployment capability truth is server-owned and release-evidence-bound

**Status:** Accepted

One validated server-owned registry defines whether a feature is Supported, Experimental or Unavailable for a provider and deployment. The browser consumes a read-only projection, while the server rejects unavailable operations before provider transport. A Supported public-alpha claim remains release-blocked until Plan 6 binds applicable live evidence to the exact candidate.

## ADR-057 — Alpha invitation secrets are one-time, digest-only and managed outside the public web surface

**Status:** Accepted

The first cohort uses operator-issued high-entropy invitation codes. PostgreSQL stores only a keyed digest. Redemptions are single-use, transactional, rate-limited and enumeration-resistant. Cohort administration remains a local CLI so privileged invite operations do not enlarge the hosted web attack surface.

## ADR-058 — Provider cleanup is a verified lifecycle and deletion fails closed while cleanup is pending

**Status:** Accepted

Provider disconnect removes token-bearing application state, but it does not falsely claim provider-side PAT/OAuth/App revocation. Alpha-created webhooks and temporary resources must be deleted or verified absent. A failed cleanup creates a non-secret pending task and blocks completed data deletion and cohort close.

## ADR-059 — Public-alpha success is verification-gated and every conclusion carries an evidence state

**Status:** Accepted

The interface distinguishes provider-verified, deterministic, inferred, stale and unavailable evidence. A mutation does not display success until readback and required cleanup are complete. Tester-facing failures describe provider-change uncertainty, current safe state, next action and a correlation ID without exposing credentials or payloads.

## ADR-060 — Hosted-alpha migrations are backup-gated and verified by the web process

**Status:** Accepted

The hosted web process does not silently apply unknown migrations. An operator
creates and verifies an encrypted external backup, applies migrations with the
dedicated CLI, and rehearses restore into an isolated Neon branch. Readiness
fails on schema mismatch. Rollback requires a recorded compatibility decision
or maintenance mode plus database restore.

## ADR-061 — Live qualification is exact-job and exact-target authorized

**Status:** Accepted

Every secret-bearing alpha.17 qualification activation uses authorization
schema `1.2.0`. Its Ed25519-signed envelope binds the exact selected job set and
one canonical SHA-256 target identity per job in addition to the workflow,
source parent, source commit, candidate archive hash, event, authorization ID,
and expiry. Provider target identities include the pre-created disposable
repository and canonical API URL. Hosted target identity includes the service
origin; exact Render service; cohort and restore Neon project/branch
identifiers; the `isolated-neon-branch` classification; and the out-of-band
reviewed restore-target fingerprint.

Provider repositories are created before dispatch, must use the
`nvx-alpha17-` prefix, and are never deleted by the qualification harness. Only
the per-run `nvx-alpha17-<run-id>-...` branch and bounded proof files are
created and removed. Each live job verifies its signed target without secrets
before its credential-bearing step, and each harness rechecks the same binding
before its first network request. A changed, absent, malformed, or extra target
or job fails closed and produces no provider/hosted request.

## ADR-062 — Documentation lifecycle and generated continuity are release contracts

**Status:** Accepted

Repository documentation is physically separated by lifecycle and completely
classified in `docs/DOCUMENTATION_MANIFEST.json`. Root Markdown is limited to
the README and changelog. `WORK_CONTINUITY.json` is the sole authored source for
operational continuity, and the project-state and continuation-prompt views are
deterministically generated from it. Repository validation, packaging, and CI
must reject manifest gaps, invalid lifecycle placement, broken current links,
changed approved-plan bytes, stale current-release claims, or generated drift.

**Consequence:** Current instructions, vision, operations, qualification
evidence, and immutable history remain distinguishable in both source and
release archives. A documentation-only change can block release when it makes
the candidate's operational truth ambiguous or irreproducible.

## ADR-063 — Release archives cannot self-attest exact candidate identity

**Status:** Accepted

A file contained in a release archive cannot truthfully embed that archive's
final SHA-256 without changing the bytes being identified. In-repository
continuity therefore records the last immutable qualified baseline, the current
gate states, and the next authorized action, but never claims the current
archive's commit, tree, hash, run IDs, or evidence hashes. Those identifiers are
recorded as external, content-addressed qualification evidence after the exact
candidate is frozen and packaged.

**Consequence:** Candidate identity has one non-circular authority boundary.
Archives remain resumable without self-attestation, while promotion and live
dispatch continue to require externally verified exact-candidate evidence.

## ADR-064 — Provider operation IDs use a versioned canonical preimage

**Status:** Accepted

Provider-write operation IDs use the domain
`nebulaverse-x.provider-write.operation-id.v1` and a fixed ordered field set:
domain, mutation ID, one-based provider-write index, method, classified
operation, canonical repository scope key, transport, and the complete request
path. Every field is UTF-8 encoded and preceded by unsigned 32-bit big-endian
byte lengths for its field name and value before the complete stream is hashed
with SHA-256.

The target path is never silently truncated. A target outside the explicit
64-KiB safety bound is rejected before a provider write rather than mapped to a
colliding prefix. This contract replaces the historical pipe-delimited,
1,000-character target representation without rewriting the immutable Task 18
specification that recorded the earlier design state.

**Consequence:** Operation IDs are stable for the same authorized write,
distinct across field boundaries and full targets, and versioned for any future
canonicalization migration.

## ADR-065 — Destructive database restore requires an exact isolated-target fingerprint

**Status:** Accepted

Before `pg_restore --clean`, the operator CLI requires a reviewed SHA-256
fingerprint over a versioned record containing each database host, port, name,
role, pooling mode, and explicit `sslmode=verify-full`; the cohort and restore
Neon project and branch IDs; and the exact `isolated-neon-branch` classification.
The cohort and restore branch identities must differ. A credential-free preview
prints only the sanitized identity and fingerprint; operators verify its project
and branch values against Neon out of band before authorizing restore.

**Consequence:** Merely changing a hostname or database name cannot authorize a
destructive restore. Stale URLs, wrong branches, missing isolation context, and
unreviewed targets fail before decryption or `pg_restore` begins.

## ADR-066 — Recovery snapshots use an independently rotatable signing keyring

**Status:** Accepted

Snapshots and emergency manifests are signed with a dedicated HMAC-SHA256 key,
not `SESSION_SECRET`. Every new signature carries a version and non-secret key
ID. Verification accepts the active key and a bounded explicit retired-key map;
an optional bounded legacy key list verifies pre-migration bare signatures only
for the remaining snapshot-retention window.

Production requires the active snapshot secret to differ from the session
secret. Rotation creates a new key ID, retains the old pair until its signed
snapshots expire, and then removes it. Existing database rows need no migration
because the version and key ID are encoded in the signature text.

**Consequence:** Session rotation can invalidate sessions and encrypted webhook
material without destroying retained recovery evidence, while retired signing
authority has an explicit, time-bounded removal path.

## ADR-067 — Hosted evidence observes the deployed release tree

**Status:** Accepted

The release packager and runtime share one path-inclusion contract. Both the
deployed process and the hosted qualification harness compute a versioned,
length-delimited SHA-256 over the sorted releasable paths, byte lengths, and
exact file bytes. Dependency directories, runtime logs, environment files, and
qualification evidence are excluded by the same release boundary used for
packaging. Releasable symbolic links, special files, unsafe paths, unstable
reads, and bounded-size violations fail closed.

Before any hosted smoke, load, or mutation step, the harness independently
computes the digest from the frozen candidate and compares it with the digest
served by the deployed process at `/api/version`. Hosted evidence records that
observed digest as `deploymentSha256`; it cannot substitute a value derived
from the authorized target identity or candidate archive hash.

**Consequence:** A healthy service at the authorized Render origin is not
accepted as the candidate merely because its target metadata is correct. An
old, partial, or otherwise different deployed release stops qualification
before credential-bearing traffic or mutations.

## ADR-068 — Provider delete qualification is negative-and-positive head-bound proof

**Status:** Accepted

Provider `file.delete` qualification first attempts deletion with a stale
expected head and proves both zero branch advancement and file retention. A
subsequent valid deletion must return a commit that equals the independently
observed post-delete branch head, advance that head, and leave the file absent.
Cleanup absence remains a separate final prerequisite.

**Consequence:** A successful HTTP status cannot by itself create a delete
claim. Stale-head enforcement, provider result integrity, observable state
change, and cleanup are all bound into the capability evidence.

## ADR-069 — Destructive Neon restore requires control-plane and live-session ownership proof

**Status:** Accepted

ADR-065's reviewed fingerprint remains necessary but is not sufficient. Before
printing a restore preview and again immediately before decryption or
`pg_restore --clean`, the operator CLI uses the official Neon connection-URI
endpoint to bind both declared project/branch IDs to the configured source and
target connection identities. It then opens the target and verifies
`current_database()` and `current_user`. Requests use a fixed HTTPS origin,
bounded responses, no redirects, and a timeout. The transient `NEON_API_KEY`
is never passed to database child processes or written to evidence.

**Consequence:** Operator labels, URL fingerprints, or hostname assumptions
cannot authorize destructive work against a misdeclared branch. Control-plane
failure, connection-identity mismatch, and live-session mismatch all fail
before backup decryption and destructive restore execution.

## ADR-070 — Production snapshot compatibility is an explicit operator keyring

**Status:** Accepted

Production never adds `SESSION_SECRET` implicitly to legacy snapshot
verification. Only secrets deliberately present in
`NV_SNAPSHOT_LEGACY_KEYS_JSON` may verify pre-keyring bare signatures. Local
development may retain its compatibility fallback, and production still
compares the active snapshot secret with `SESSION_SECRET` to prevent key reuse.

**Consequence:** Rotating the session secret cannot silently preserve snapshot
signing authority. Operators must stage and later remove any genuinely needed
legacy key, making compatibility bounded, reviewable, and auditable.

## ADR-071 — Continuity accepts exact transport-specific commits paired to one tree

**Status:** Superseded by ADR-083

Qualification publication can create a local source commit and a different
published pull-request commit with identical trees. Continuity schema 4 records
both exact commit IDs and their one accepted tree. Resume validation accepts
only an ancestry entry whose commit is one of those two IDs and whose tree is
the recorded tree. It also records the independent-review gate separately from
automated qualification.

**Consequence:** Local and published histories can both prove the same accepted
bytes without treating every commit that recreates those bytes as trusted. An
unrelated ancestor with the accepted tree fails the boundary, and a green
automated run cannot hide a failed independent review.

## ADR-072 — Deployed release identity remains runtime-observed and non-circular

**Status:** Accepted

ADR-063 and ADR-067 remain the release-identity authority. The server computes
the release-tree fingerprint synchronously from deployed bytes at process
startup and serves that observation from `/api/version`. It does not trust a
precomputed digest embedded in the same release tree, because that digest would
either exclude itself or circularly claim bytes it cannot represent.

**Consequence:** Startup performs one bounded filesystem observation, while
requests reuse the computed value. Build metadata cannot substitute for the
hosted harness's independent comparison against the frozen candidate.

## ADR-073 — Activation and rollback require idempotency before persistence access

**Status:** Accepted

Activation and rollback reject a missing or malformed `Idempotency-Key` after
request authentication/shape validation but before any governance-store read.
The browser generates a fresh bounded key for every Policy Digital Twin write;
accepted keys retain ADR-023's scoped hashing and transactional replay rules.

**Consequence:** A transport retry cannot create a second active-head
transition, and an unkeyed request cannot learn governance state through a
store-side failure. This current boundary supersedes the immutable historical
Task 11 text that described the key as optional without rewriting that record.

## ADR-074 — Unsupported active rules are evaluator failures, never implicit allows

**Status:** Accepted

If any rule in an active policy set is outside the deployed evaluator contract,
evaluation throws `POLICY_UNSUPPORTED_ACTIVE_RULES`. Ordinary mutations then
block before provider transport regardless of the general runtime failure mode.
Governance recovery mutations retain the separately authorized recovery-safe
behavior in ADR-039.

**Consequence:** Adding or corrupting an unknown active rule cannot weaken the
effective policy to allow. The unsupported state remains visible and can be
recovered without turning the control plane into a policy bypass.

## ADR-075 — Governance advisory locks have one nested acquisition order

**Status:** Accepted

When a transaction needs more than one governance advisory lock, it preserves
this relative order: repository active-policy-set lock, policy lock,
version/review lock, exception lock, then repository/action active-exception
lock. An operation that needs only a subset keeps that subset in the same order;
serialization locks for audit/export chains are acquired only inside their
separate append boundary.

**Consequence:** Review, activation, runtime loading, exception decisions, and
revocation do not form opposing nested-lock cycles. This records the current
implementation contract that supersedes ambiguous historical Task 8 prose.

## ADR-076 — Governance webhook delivery is at-least-once and receiver-deduplicated

**Status:** Accepted

Retries preserve the immutable delivery UUID in both
`X-Nebulaverse-Delivery` and `Idempotency-Key`. Receivers verify the signature
over delivery ID, timestamp, and exact body, enforce a narrow timestamp window,
and deduplicate the delivery ID for at least the retry/dead-letter horizon.
Redirects remain terminal under ADR-051.

**Consequence:** A successful transport attempt is not misrepresented as
exactly-once side-effect execution. Receiver replay duties are explicit without
rewriting the immutable Task 19 design checkpoint.

## ADR-077 — Private offline responses require server-confirmed cache bindings

**Status:** Accepted

Private API caching is opt-in for bounded text/JSON read routes. The server
recomputes the HMAC session/identity scope and canonical provider/repository key
after authentication, echoes both only on an exact request match, and keeps all
other API responses `no-store`. The service worker rejects a response whose
echoed scope or repository differs from its request decision. Identity changes
also broadcast a purge/reload boundary to every same-origin tab.

**Consequence:** A stale tab cannot authenticate as a newly selected account
and place that account's response in the prior account's cache, even if its old
request headers survive long enough to reach the service worker.

## ADR-078 — Exact-archive qualification uses an allowlisted process environment

**Status:** Accepted

Candidate qualification creates isolated home, temporary, and npm-cache roots;
inherits only the explicit runtime/locale/certificate/browser allowlist;
disables npm lifecycle scripts during clean install; and invokes the reviewed
vendor-copy step explicitly. Candidate tests do not inherit ambient CI tokens,
npm credentials, `NODE_OPTIONS`, or unrelated operator variables. Matrix output
is snapshotted before browser execution so a later candidate process cannot
rewrite an earlier pass.

**Consequence:** Install hooks and ambient environment variables cannot silently
expand the qualification authority. This is process/env isolation, not an
egress sandbox for deliberately hostile candidate code.

## ADR-079 — Hosted operational claims retain signed-attestation provenance

**Status:** Accepted

Console/database checks that cannot safely run in the GitHub-hosted job use a
fresh exact-candidate Ed25519-signed operational record. Isolated restore is a
separate workflow-runner claim: after exact-target authorization, the reviewed
candidate runner creates and removes a fresh encrypted backup, verifies the
control-plane and live target, restores through the expected migration, and
emits a bounded credential-free record. That record binds nonzero hashes for
the encrypted backup and manifest, reviewed target fingerprint, sanitized
restore evidence, and distinct source/target identities. The final hosted
envelope retains both complete records and independently recomputed SHA-256
digests; only the operator record has an operator key ID and signature.

**Consequence:** Hosted evidence cannot relabel a human observation as a
workflow execution or reduce either provenance to `status: pass`. The operator
record cannot claim restore, and a hosted restore claim is accepted only when
the exact workflow-runner record is present, bound, complete, and cleanup-safe.

## ADR-080 — Live qualification credentials assume an independently reviewed candidate

**Status:** Accepted

Each live job binds the exact source/archive and target through the signed
activation envelope, uses repository-scoped disposable credentials, and runs
behind the protected qualification environment. Because the frozen candidate
contains the provider harness that receives those credentials, dispatch also
requires a passing independent review of those exact bytes. Arbitrary untrusted
candidate execution requires a separately trusted harness or egress-isolated
runner and is outside this workflow's claim.

**Consequence:** Exact target authorization limits accidental and reviewed
behavior but is not described as a sandbox against malicious candidate code.
The residual authority is explicit and credentials have no production reach.

## ADR-081 — Provider claims equal the proof-bearing qualification subset

**Status:** Accepted

The provider evidence catalog contains only registry capabilities marked both
`Supported` and `Provider-verified` that the disposable harness proves. Each
provider envelope has an exact capability/claim set and ten ordered checks for
repository/default-branch reads, disposable branch creation, expected-head
write, UTF-8 hash readback, stale-write zero-commit, permission denial,
stale-delete file retention, head-bound valid deletion/file absence, and final
cleanup.

**Consequence:** A broad `Supported` UI claim cannot inherit provider evidence
from a narrower mutation test, and an HTTP success without state-change and
cleanup proof cannot qualify `file.write` or `file.delete`.

## ADR-082 — Credential-bearing outbound requests never follow redirects

**Status:** Accepted

Provider API, OAuth token exchange, Git LFS batch, webhook, and authenticated
archive-discovery requests treat redirects as errors or manually validate one
credential-free destination. GitHub archives permit only an exact same-repository
`https://codeload.github.com/.../legacy.zip/...` hop; the follow-up request
contains no provider authorization and itself rejects redirects.

**Consequence:** Provider credentials cannot be replayed to a redirect target,
while the one documented GitHub API-to-codeload transition remains usable under
an exact origin/path/repository constraint.

## ADR-083 — Continuity records a state, not one frozen position

**Status:** Accepted

Supersedes ADR-071. Schema 5 keeps that decision's insight — one accepted tree,
reached through more than one commit identity — and drops the two assumptions
that made it unusable.

The first was arity. ADR-071 named exactly two identities, `sourceCommit` and
`publishedCommit`, and required them to differ. That described one transport
pair: a local source commit and its published counterpart. It could not describe
a branch head and the pull-request merge commit that carries the same tree into
a workflow checkout, nor a single identity when work happens directly in the
repository of record. Schema 5 records `commits` as a set of role-tagged
identities, each resolving to the accepted tree, and resume validation accepts
any of them.

The second was that the validator encoded the project's position as the schema.
The review gate had to read `failed`, the actionable count had to exceed zero,
and the candidate had to be `not-qualified`. Advancing a gate therefore required
editing the validator, so the record could not track the work it exists to
describe, and the documents generated from it stated a position the project had
already left. Schema 5 validates shape, format and cross-field agreement, plus
two policy rules: a gate never reports `passed` without an evidence run behind
it, and final release never reports `passed` while any preceding gate has not.

Public-alpha position is derived from the final-release gate rather than stored,
so no document can assert GO while a gate is outstanding.

**Consequence:** Continuity can record progress and regression alike without a
code change, while an unrelated ancestor carrying the accepted tree still fails
the boundary and a green automated run still cannot hide a failed independent
review. The cost is that the record no longer proves by construction which
position the project is in; that now rests on the evidence run identifiers each
gate carries.
