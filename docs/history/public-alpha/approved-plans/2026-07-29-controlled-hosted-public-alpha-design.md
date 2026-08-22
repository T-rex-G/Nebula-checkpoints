# Nebulaverse-X Controlled Hosted Public Alpha — Design Specification

**Status:** Approved  
**Date:** 2026-07-29  
**Approved by user:** 2026-07-29  
**Target successor:** `5.3.0-alpha.17.0`  
**Qualified predecessor:** `5.3.0-alpha.16.3`  
**Release model:** Invitation-only hosted alpha for 5–10 external testers  
**Primary hosted stack:** One Render Free web service and one dedicated Neon Free project  

## 1. Decision

Nebulaverse-X will prepare a controlled hosted public alpha before beginning Phase 2.

The release target is not “every future idea is complete.” It is a polished, safe and dependable experience in which:

- every visible and advertised feature works within its declared provider and hosting scope;
- incomplete features are disabled or labelled `Experimental`;
- unsupported provider combinations are not presented as available;
- no known critical or high-severity security, credential, evidence-integrity, cleanup or data-loss defect remains;
- the complete tester journey passes against the real hosted environment;
- the qualified `5.3.0-alpha.16.3` archive and Task 21 evidence remain immutable.

The successor will use a new version because public-alpha readiness requires code, documentation, configuration and hosted validation changes. It must not be presented as a documentation-only rebuild of `alpha.16.3`.

## 2. Evidence and immutability boundary

The following predecessor facts are fixed:

- Qualified archive: `Nebulaverse-X-v5.3.0-alpha.16.3.zip`
- SHA-256: `330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892`
- Qualified publication/validation commit: `c19389f8b25cb67caad6fd56d000ca130ef8520f`
- Final Push run: `30464094438`
- Final pull-request run: `30464096155`
- Task 21 decision: qualified alpha checkpoint, not merged, promoted, deployed or production-ready

The publication/validation commit is not automatically described as the archive’s original build-source commit. That relationship remains unclaimed unless a byte- and tree-level source mapping proves it.

Public-alpha work must:

1. verify the predecessor ZIP before extraction;
2. extract it into a new isolated working root;
3. record the predecessor archive hash as the successor’s provenance input;
4. assign the new version before changing product bytes;
5. produce fresh source, package, hosted and live-provider evidence;
6. preserve PRs #1–#3 as draft, open and unmerged unless the user later gives explicit instructions;
7. leave `main`, alpha.16.1, alpha.16.2 and alpha.16.3 unchanged.

Suggested isolated branch name: `public-alpha/alpha17-readiness`.

No remote branch, PR, deployment or provider mutation is authorized merely by approval of this design. Each secret-bearing live validation or deployment remains an explicit execution gate.

## 3. Scope

### 3.1 Included

The public-alpha readiness programme includes six bounded workstreams:

1. **Product truth and documentation**
2. **Controlled tester access and sandbox-repository enforcement**
3. **Credential, privacy, retention and deletion controls**
4. **Provider capability truth and tester-facing UX**
5. **Render/Neon operational readiness**
6. **Automated and live hosted release qualification**

### 3.2 Excluded

The following are not public-alpha blockers:

- Phase 2 Trust Digital Twin additions;
- multi-tenancy;
- organisation-wide intelligence;
- Bitbucket or another provider;
- paid-AI dependencies;
- behavioural machine learning;
- autonomous remediation;
- complete disaster-recovery orchestration;
- customer-controlled S3-compatible evidence retention;
- a complete frontend framework replacement;
- production-scale availability or autoscaling;
- full provider feature parity.

Optional YARA remains an advanced self-hosted capability. The hosted Render Free alpha must expose the built-in bounded upload signature gate honestly and must not imply that a full malware sandbox is active.

## 4. Release architecture

### 4.1 Environment separation

The alpha uses:

- one dedicated Render Free service;
- one dedicated Neon Free project used only for this cohort;
- a private source repository or private release branch;
- sandbox/test repositories only;
- no production repository credentials or production data;
- no dependency on the Render filesystem for persistent state.

The alpha environment must have a distinct service name, database, secrets and callback origin. It must not reuse any production service if one is later created.

### 4.2 Request boundary

The hosted application has two independent authorization layers:

1. **Alpha access** — proves that the visitor is an invited tester and limits the repositories they may use.
2. **Provider authorization** — proves the GitHub, GitLab or Gitea identity and permissions used for repository operations.

Passing the invite gate never grants repository access. Provider login never bypasses the invite gate.

All application APIs except the deliberately public health, version, configuration and invite-redemption endpoints require a valid alpha-access session. Existing repository and governance APIs retain their current provider, CSRF, step-up, role and mutation-gateway checks.

### 4.3 Controlled access model

The release uses one-time, high-entropy invite codes instead of email delivery or a paid identity service.

Invite format:

```text
nvx_alpha_<public-id>.<random-secret>
```

Rules:

- the database stores only a keyed digest, never the plaintext invite;
- `NV_ALPHA_INVITE_PEPPER` is a stable random secret of at least 32 bytes;
- one invite maps to one tester label, expiry and exact repository allowlist;
- an invite is single-use unless the operator explicitly issues a replacement;
- default invite validity before redemption is seven days;
- redeemed tester access lasts seven days maximum and expires after 24 hours of inactivity;
- revocation invalidates all alpha and provider sessions associated with that tester;
- five failed redemptions from one IP in 15 minutes produce a 15-minute lockout;
- redemption responses do not reveal whether an invite ID exists, expired or was revoked.

No web-based administrator console is added for the first cohort. A local operator CLI uses `DATABASE_URL` to issue, list, revoke and purge invitations. This keeps privileged cohort management outside the public web surface.

The access feature is enabled only when:

```text
NV_ALPHA_ACCESS_MODE=invite
NV_ALPHA_INVITE_PEPPER=<32+ random bytes>
NV_ALPHA_TERMS_VERSION=2026-07-29
```

Production startup fails closed when invite mode is enabled without PostgreSQL, the pepper or a terms version.

### 4.4 Sandbox repository enforcement

Each invite contains exact allowed repository scopes:

```text
provider:authority/owner/repository
```

Examples:

```text
github:github.com/acme/nvx-alpha-demo
gitlab:gitlab.com/acme/nvx-alpha-demo
gitea:gitea.example.com/acme/nvx-alpha-demo
```

All repository reads and writes are checked against the active tester’s allowlist after provider URL canonicalisation and before provider transport. A mismatched repository returns a fail-closed `403 ALPHA_REPOSITORY_NOT_ALLOWED`.

Repository naming conventions alone are insufficient. Exact allowlisting is mandatory.

The onboarding copy must require testers to use repositories created specifically for the alpha and must prohibit:

- production repositories;
- irreplaceable source or data;
- active deployment credentials;
- real secrets;
- regulated or personal data;
- repositories whose loss would cause material harm.

## 5. Provider capability truth

### 5.1 Status vocabulary

Every tester-visible capability uses one of these statuses:

| Status | Meaning |
| --- | --- |
| `Supported` | Passed the required automated and live hosted tests for this provider and release. |
| `Experimental` | Safe to try, isolated from the golden path and labelled with a specific limitation. |
| `Unavailable` | Hidden or disabled for this provider/deployment with a clear reason. |

Evidence claims use a separate vocabulary:

| Evidence state | Meaning |
| --- | --- |
| `Provider-verified` | Confirmed from live provider evidence. |
| `Deterministic` | Derived by a tested deterministic rule from available evidence. |
| `Inferred` | Based on incomplete evidence and explicitly uncertain. |
| `Stale` | Previously available but outside its freshness boundary. |
| `Unavailable` | Required evidence is absent, unsupported or inaccessible. |

The UI must never use `Supported` as a synonym for `Provider-verified`.

### 5.2 Central capability registry

Provider and deployment capability decisions must come from one server-owned registry. The browser consumes a read-only projection and uses it to:

- display supported features;
- disable unavailable actions before interaction;
- provide the exact limitation reason;
- label experimental features;
- prevent direct API calls from bypassing the UI decision.

The server remains authoritative and rejects unsupported operations even if a client manipulates the interface.

The registry must describe at least:

- repository list and details;
- branches, tree, file read/write/delete and bounded batch operations;
- pulls/merge requests;
- issues;
- actions/workflows;
- releases;
- search and notifications;
- Git LFS/native push;
- folder move;
- live verified events;
- access-surface analysis;
- dependency audit;
- snapshots, comparison, preview and ref restore;
- governance policy lifecycle;
- governance notifications, webhooks and exports;
- upload security adapter state.

### 5.3 Provider promise

For the first cohort:

- **GitHub** is the full golden-path provider.
- **GitLab** and **Gitea** are supported providers with narrower, explicitly tested capability subsets.
- A GitLab or Gitea feature remains unavailable until its exact hosted workflow passes for that provider.
- Provider differences are visible before connection and within each feature surface.

Public copy such as “pushes of any size” must be removed. The alpha advertises bounded operations under declared hosted limits.

## 6. Tester experience

### 6.1 Golden path

An invited tester must be able to complete this flow:

1. Open the alpha and see the controlled-alpha notice.
2. Redeem a one-time invite.
3. Read and accept the current alpha terms and test-repository rule.
4. Choose a supported provider.
5. See requested permissions, storage behavior and revocation guidance.
6. Connect a least-privilege provider credential.
7. Select an allowlisted sandbox repository.
8. See connection freshness, health, risk and evidence state.
9. Open one evidence-backed event or finding.
10. Complete one provider-supported controlled action with preview or scope confirmation.
11. See provider verification and cleanup status.
12. Disconnect the provider.
13. End the alpha-access session and request data removal.

The initial value demonstration should be achievable within five minutes after the provider grants access, excluding Render and Neon cold-start delay.

### 6.2 Information hierarchy

The primary dashboard answers, in this order:

1. Is the provider and repository connection current?
2. Is the application and evidence pipeline healthy?
3. Is a risk or governance issue present?
4. What is the recommended next action?
5. What evidence supports it?

The existing dark, technical Nebulaverse-X identity, blue/cyan accents and Neural Command Centre remain. The release improves hierarchy, copy, state handling, focus, contrast and responsiveness without replacing the interface with a generic administration template.

### 6.3 State requirements

Every golden-path screen supports:

- cold start/waking;
- loading;
- empty;
- connected/current;
- stale;
- partial;
- degraded;
- recoverable error;
- blocked action;
- verified success;
- unavailable provider capability;
- access revoked;
- session expired.

Success is not displayed until verification and required cleanup complete.

### 6.4 Error contract

Each tester-facing error explains:

- what happened;
- whether the provider or repository changed;
- what state is safe now;
- the next action;
- a copyable support correlation ID.

Internal error codes remain available in details. Credentials, full provider payloads and secrets must never appear in error messages or support exports.

## 7. Credential and privacy design

### 7.1 Preferred provider authorization

The interface recommends, in order:

1. GitHub App with selected repositories and least-privilege permissions, when configured;
2. GitHub OAuth where its configured scope matches the advertised capability;
3. a narrowly scoped, short-lived provider token.

PAT/token login remains supported for GitHub, GitLab and Gitea but must show:

- the minimum scope required for the selected capability;
- that Nebulaverse-X disconnect does not necessarily revoke the credential at the provider;
- the provider page where the tester can revoke it;
- that production credentials are prohibited in the alpha.

The product must not claim that a classic GitHub `repo` token is least privilege.

### 7.2 Disconnect and removal

The UI distinguishes:

- **Disconnect from Nebulaverse-X** — removes token-bearing application session state and broker cache;
- **Revoke at provider** — opens or explains the provider-side revocation/uninstallation step;
- **Delete alpha data** — requests purge of tester-scoped retained alpha data.

Logout and account removal must clear:

- provider credentials from the active server session;
- step-up grants;
- browser repository state;
- private API caches;
- offline write queues;
- GitHub App broker cache;
- alpha-access session binding when the tester chooses “end alpha session.”

Provider webhooks created by the alpha must be disconnected or recorded as cleanup-required before the application claims deletion is complete.

### 7.3 Data inventory and retention

The public-alpha privacy notice lists:

- opaque tester and invite identifiers;
- provider identity metadata;
- allowlisted repository identifiers;
- encrypted session data;
- verified events and governance evidence;
- recovery snapshots and signed evidence;
- operational logs and correlation IDs;
- feedback submitted by the tester.

Default alpha retention:

```text
Alpha access and provider sessions: 7 days maximum
Verified events: 30 days
Operational logs: 14 days where platform controls permit
Snapshots and evidence exports: 30 days
Invite and revocation metadata: 30 days after cohort close
```

The operator must run a purge after the cohort and produce a non-secret deletion report. Immediate purge may preserve minimal pseudonymous integrity metadata only when deleting it would invalidate a shared tamper-evident chain; this limitation must be disclosed before consent.

No repository source content is retained merely for analytics or feedback.

### 7.4 Feedback privacy

Feedback collection must not automatically attach repository content, credentials, diffs, full API payloads or private event bodies. The default support bundle includes only:

- release version;
- correlation ID;
- provider name;
- feature and capability status;
- sanitized error code;
- timestamp;
- browser/runtime metadata;
- tester-entered description.

## 8. Hosted operational design

### 8.1 Render Free constraints

The release explicitly designs for the documented Render Free boundary:

- 512 MB RAM;
- 0.1 CPU;
- spin-down after 15 minutes without inbound traffic;
- approximately one minute to wake;
- ephemeral local filesystem;
- 750 free instance hours per workspace per month;
- possible suspension for unusually high service-initiated public traffic;
- rollback limited to the two most recent prior deploys.

Render Free is suitable for a small test cohort, not production.

Initial hosted limits:

```text
NV_EVENT_RETENTION_DAYS=30
NV_SESSION_RETENTION_DAYS=7
NV_LIVE_CLIENTS_PER_REPO=2
NV_LIVE_CLIENTS_TOTAL=10
NV_SNAPSHOT_RETENTION_COUNT=10
NV_SNAPSHOT_MANIFEST_MAX=5000
NV_GIT_DATA_MAX_MB=16
NV_NATIVE_PUSH_MAX_MB=16
NV_UPLOAD_MAX_MB=25
NV_UPLOAD_CONCURRENCY=1
NV_UPLOAD_TIMEOUT_MINUTES=10
NV_STALE_UPLOAD_HOURS=2
```

These are public-alpha product limits, not hidden deployment details. Hosted load testing may lower them. Raising them requires a measured memory, timeout and cleanup pass on the 512 MB instance.

All durable state lives in Neon or a provider. Temporary upload state is disposable and must be cleaned after success, failure, timeout, restart or spin-down.

### 8.2 Neon Free constraints

The release explicitly designs for:

- 0.5 GB storage per project;
- 100 compute-unit hours per project per month;
- up to 10 branches per project;
- mandatory scale-to-zero on the Free plan after five minutes of inactivity.

Database readiness distinguishes:

- connected and migrated;
- waking/retrying;
- capacity or quota warning;
- unavailable;
- migration mismatch.

Governance, invite and persistent-session functions fail closed when PostgreSQL is required and unavailable. Read-only public health information remains available.

### 8.3 Backup and restore

For the first cohort:

- create an encrypted `pg_dump` before every migration and release deploy;
- create an encrypted weekly checkpoint while testers are active;
- store the encrypted backup outside Render’s filesystem;
- test one restore into an isolated Neon branch before opening the cohort;
- record backup time, database schema version, file digest and restore result;
- never place database dumps in GitHub Actions artifacts or the source repository.

Nebulaverse-X recovery snapshots are not represented as database or Git disaster-recovery backups.

### 8.4 Deployment and rollback

Deployment uses an immutable release commit and exact package lock.

Before traffic:

1. verify environment configuration without printing secrets;
2. apply and checksum migrations;
3. verify `/healthz`, `/readyz` and `/api/version`;
4. redeem a dedicated smoke-test invite;
5. execute the GitHub golden path against a disposable repository;
6. verify cleanup and data retention jobs;
7. record the deploy commit, candidate hash, schema version and test evidence.

Rollback uses one of the two prior Render deploys only after determining whether the database migration is backward-compatible. If application rollback cannot safely operate on the new schema, the service enters maintenance mode while the documented database restore procedure runs.

### 8.5 Operational runbooks

The release must include concise, executable runbooks for:

- service cold start and outage;
- Neon outage or quota exhaustion;
- provider API outage or rate limiting;
- credential exposure or suspected compromise;
- orphaned webhook or temporary branch cleanup;
- failed deploy and application rollback;
- database backup and restore;
- tester revocation and data deletion;
- capacity saturation;
- complete alpha shutdown.

Each runbook identifies the trigger, immediate containment, verification, recovery and evidence to preserve.

## 9. Documentation design

The successor establishes a small authoritative documentation set:

1. `PROJECT_STATE.md` — current version, qualification state and evidence applicability
2. `ROADMAP.md` — actual Phase 1 closure and Phases 2–5
3. `PRODUCT_VISION.md` — positioning, principles and deliberate non-goals
4. `PROVIDER_CAPABILITIES.md` — provider/deployment support matrix
5. `ARCHITECTURE.md` plus the existing ADR ledger
6. `RELEASE_SECURITY_GATES.md` — automated, live and hosted release conditions
7. `PUBLIC_ALPHA.md` — tester scope, onboarding, privacy, limits and support
8. `UX_VISION.md` — preserved identity and prioritised experience requirements

Historical task reports and specifications remain evidence. They are not rewritten to claim current status and are listed in an evidence index rather than competing with current truth.

Required corrections include:

- mark Task 21 complete for `alpha.16.3`;
- distinguish implemented, qualified, alpha-supported, experimental, planned and unsupported;
- restore the real roadmap: Phase 2 Trust Digital Twin, Phase 3 Recovery Game Day, Phase 4 Organisation Intelligence and Phase 5 customer-controlled evidence retention;
- state that GitHub/GitLab evidence from Task 20 and fresh Gitea evidence have different applicability;
- remove stale deployment versions and stale `/api/version` examples;
- replace “pushes of any size” and equivalent unlimited claims;
- describe Render and Neon limitations;
- keep AI optional;
- classify Phase 5 external evidence retention as an accepted later-phase direction, not an uncommitted idea;
- avoid claiming complete accessibility certification before the public-alpha audit passes.

The four product documents in the post-Task-21 notice pack are treated as source material, not committed truth. Their useful content is consolidated into the canonical set after correcting repository-state contradictions.

## 10. Security and reliability gates

### 10.1 Automated gates

The successor cannot release unless all of these pass on Node.js 22:

- exact lockfile clean install;
- complete unit and contract suite;
- syntax validation;
- secret scan;
- deterministic double package build;
- safe fresh extraction and clean-install verification;
- production dependency audit with zero critical/high findings;
- full development-audit classification;
- browser desktop and mobile golden paths;
- provider capability/UI/server consistency tests;
- invite redemption, replay, expiry, revocation and enumeration-resistance tests;
- repository allowlist bypass tests;
- credential removal and browser-cache purge tests;
- webhook and disposable-branch cleanup tests;
- retention and purge tests;
- cold-start/degraded-state UI tests;
- backup/restore script validation;
- rate-limit and abuse tests.

### 10.2 Accessibility gates

Supported golden-path workflows target WCAG 2.2 AA behavior and require:

- automated axe checks with zero critical or serious violations;
- full keyboard navigation;
- visible focus;
- dialog focus containment and restoration;
- labelled controls and landmarks;
- screen-reader status announcements;
- non-colour-only risk and trust states;
- reduced-motion behavior;
- verified text and control contrast;
- 200% zoom/reflow without loss of core operation;
- mobile viewport checks;
- one manual VoiceOver pass on iOS;
- one manual desktop screen-reader pass before cohort opening.

Passing these gates is described as a public-alpha accessibility qualification, not a legal certification.

### 10.3 Live provider gates

Every `Supported` capability in the registry must have a release-bound live result for its provider.

The GitHub golden path is mandatory. GitLab and Gitea must each pass their advertised subset. Unsupported features are not counted as failures only when they are disabled before interaction and documented accurately.

Live mutation tests use disposable repositories, files and branches; prove stale-head handling; verify readback; deny insufficient permissions; and prove cleanup absent before the run passes.

### 10.4 Hosted gates

The exact Render/Neon release must pass:

- cold start;
- Neon scale-to-zero wake;
- five concurrent invited testers performing read workflows;
- one bounded mutation at a time;
- memory and restart observation;
- invite revocation during an active session;
- provider credential disconnect;
- service restart with no required filesystem state;
- database interruption and recovery;
- provider 429 and outage behavior;
- deployment rollback;
- tested database restore;
- final purge on a disposable tester identity.

Release evidence records exact service version, commit, archive hash, schema version, Node version, test times and cleanup result without storing secrets.

## 11. Release decision

### 11.1 Go criteria

The controlled cohort may open only when:

- all automated and hosted gates pass;
- all supported provider capabilities have applicable evidence;
- no known critical/high release defect remains;
- all visible features are `Supported`, safely `Experimental`, or disabled as `Unavailable`;
- invite and repository allowlist enforcement are active;
- privacy notice, terms, retention and deletion behavior match the running system;
- backup and rollback are proven;
- the operator can revoke any tester promptly;
- known minor limitations are published;
- the exact successor archive and checksum are frozen.

### 11.2 No-go criteria

The release remains closed for:

- any credential leak or session-boundary defect;
- invite or repository-allowlist bypass;
- unverified provider mutation success;
- incomplete temporary-resource cleanup;
- destructive operation outside an allowlisted sandbox;
- inconsistent capability claims;
- database migration without a tested restore;
- critical/high production dependency finding;
- serious/critical accessibility violation on the golden path;
- inability to revoke a tester or remove token-bearing state;
- hosted instability under the five-tester qualification load.

### 11.3 Cohort operation

The first cohort is limited to 5–10 invited testers and runs for a defined two-week evaluation window. New invitations stop if capacity, cleanup, credential or evidence integrity degrades.

The operator reviews:

- service and database capacity daily;
- errors, provider rate limits and orphan-cleanup warnings daily;
- tester feedback at least twice during the window;
- retained data and pending deletion requests weekly.

At cohort close, the operator revokes remaining access, disconnects alpha-created webhooks, purges retained data according to policy, exports a non-secret closeout report and decides whether to issue a correction candidate or expand the cohort.

## 12. Implementation decomposition

After this specification is approved, implementation planning will be split into independently reviewable plans:

1. **Truth and successor foundation** — provenance, version, canonical docs and capability model.
2. **Controlled alpha access** — invite lifecycle, repository allowlists, abuse limits and tests.
3. **Privacy and credential lifecycle** — disconnect, revoke guidance, purge, retention and support bundle.
4. **UX readiness** — onboarding, status vocabulary, capability-aware UI, cold-start/error states and accessibility.
5. **Hosted operations** — Render/Neon configuration, migrations, limits, backup/restore and runbooks.
6. **Qualification and release** — complete automated matrix, live-provider matrix, hosted load/rollback/restore and deterministic checkpoint.

Each plan must preserve predecessor evidence, use test-driven changes, end in an independently testable checkpoint and require review before the next plan begins.

## 13. External platform references

- Render Free limitations: <https://render.com/docs/free>
- Render instance types: <https://render.com/docs/compute-plans>
- Render deployment filesystem behavior: <https://render.com/docs/deploys>
- Neon plans: <https://neon.com/docs/introduction/plans>
- Neon Free scale-to-zero: <https://neon.com/docs/guides/scale-to-zero-guide>
