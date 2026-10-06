# Beta 0.0.1 Qualification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Status:** Approved scope, owner decisions of 6 October 2026. Reviewed against `main` at `de0e10f` and against the running system the same day. It is not qualification evidence and changes no gate. The generated project state keeps public alpha at **NO-GO** until the gates below pass for one exact candidate. Render redeploys `main` on every merge, so merging a document redeploys the service with no change in behavior. This plan authorizes no live-provider dispatch, migration, configuration change or launch.

**Goal:** Qualify the product that exists today as `0.0.1-beta.1`, an open public beta with a recorded **GO**. Every capability the product shows is Supported and evidenced, and nothing anywhere is Experimental. Every release gate passes for one exact candidate, and no residue is left open. Nothing new is built except what qualification itself requires.

**Scope boundary:** Clerk identity, the AI layer, billing, and the deep comparison with Sentry, Strix and others come after this plan. They are listed under [After beta 0.0.1](#after-beta-001) and get plans of their own.

**Architecture:** Unchanged:

- one Node.js/Express service on Render Free;
- PostgreSQL on Neon Free;
- unbundled browser scripts;
- the server-owned capability registry.

This follows the infrastructure plan of 5 October: stay on free Render and Neon while they remain useful. Access is open to anyone:

- sign-in is GitHub OAuth;
- GitLab and Gitea connect with personal tokens;
- there is no invitation gate.

**Tech Stack:** Node.js 22.23.1 (uplift decided in Task A3), Express, `pg`, PostgreSQL 17 and Playwright. No new runtime dependency.

## Owner decisions

| Decision | Choice |
| --- | --- |
| Version | `0.0.1-beta.1`; a later qualified candidate becomes `0.0.1-beta.2`, and so on |
| GitLab and Gitea | Promote what exists, under names that say exactly what it does; prove each claim live; hide the rest |
| GitHub's four experimental capabilities | Qualify each one live |
| Access | Open to anyone, with no invitation gate |
| Hosting | Render Free and Neon Free |
| Limits | 16 MB git data, 16 MB native push, 25 MB upload, unless the owner sets others |

## Verified against the running system on 6 October 2026

Documents can lag behind the code, so every claim in this plan was checked against the system itself. Where a document and the system disagree, the observed value wins, and the disagreement becomes a residue below.

| What was checked | Observed | Source |
| --- | --- | --- |
| Deployed code | The live release digest `f41095e0…edd3` equals the digest computed from a clean checkout of `de0e10f`: the service runs merged `main`, including `proxy-addr` 2.0.8. | `/api/version`; `computeReleaseFingerprint`; Render deploy `dep-db2dn5vlk1mc738qfleg` |
| Capability registry | The live projection matches `config/public-alpha-capabilities.json` entry for entry, for all three providers. | `/api/capabilities?provider=…` |
| Access mode | `off`, which is right for an open beta. `render.yaml` declares `invite`, so the dashboard overrides the blueprint. | `/api/alpha/status`, `/api/config` |
| Hosted limits | Git data 95 MB, native push 95 MB, upload 100 MB. `render.yaml` and the published limitations say 16, 16 and 25 MB. | `/api/config` |
| GitHub App | Disabled; sign-in is OAuth only. | `/api/config` |
| Hosting | Render Free, one instance, auto-deploy of `main` on every commit. The first `/healthz` after idle timed out at 30 s; later calls answered in 0.3–0.7 s. | Render service `srv-dabg6ufqj5pc739takeg`; timed probes |
| Database | One Neon project at free-tier limits (0.25 CU, 1 GiB branch limit, 6-hour history), with migration `030` applied. The `main` branch sits beside a leftover `recovery-pr53-before-028-20260925`, and there is no isolated restore target. | Neon project `ancient-field-09975665`; `/readyz` |
| Branch protection | `main` is `protected: false`, and no rulesets apply. | `GET …/branches/main`, `…/rulesets` |
| Live-provider history | 25 dispatched qualification runs:<br>• all three providers green on 3 September (run 70);<br>• GitHub alone green through 7 September (run 98);<br>• `hosted-live` never executed.<br>`main` is now about 290 commits past run 98. | Actions API |
| Automated qualification | The `automated` exact-archive job runs on every pull request and passed on `4c8ee9f`. The generated state still records only the August baseline, about 450 commits back. | Actions API |
| Production audit | A critical advisory against `proxy-addr` (GHSA-jqcg-44mw-7w3h) turned every branch red on 6 October. It was fixed in PR #80 and is deployed. | `node scripts/audit-production.js` |
| Public copy | The landing page tells visitors that features are marked "Experimental, with the reason". It makes no AI claim: its FAQ states the audit is deterministic, not an AI. | `public/index.html` |

## Existence audit

Every capability was traced from registry to route, interface, tests and live probe, using the code rather than the documents.

- **GitHub: 33 Supported.**
  - The 26 Provider-verified capabilities each map to named probes in `src/qualification-evidence.js`. Examples: `file.write` maps to `expected-head-write`, `conditional-update`, `stale-head` and `permission-denial`; `lfs` maps to `lfs-object-upload`.
  - The 7 Deterministic capabilities are fixture-tested rules over a Provider-verified reader: access surface, code audit, dependency audit, governance, recovery, site check and upload security.
  - Four are Experimental: `repository.create`, `repository.delete`, `notifications` and `live-events`.
- **GitLab:** 13 Supported (11 Provider-verified), 3 Experimental, 21 Unavailable.
- **Gitea:** 7 Supported (5 Provider-verified), 4 Experimental, 26 Unavailable.
- **The probes have not run on current code.** They last ran on 3–7 September, against code about 290 commits older, so G3 must run again.
- **Server routes.** Of 176 `/api` routes, 141 sit behind `capabilityAccess`.
  - 108 of those guards accept `allowExperimental`, across 26 features.
  - `GET …/intelligence/events` and `GET …/evidence` name no capability.
  - `branches.read` is advertised but enforced as `repository.read`.
  - `lfs` is checked inside the upload handler rather than at the route.
- **Tests.**
  - The browser suite holds 846 tests in four slices, and every capability's routes are reached by unit or browser tests.
  - Seven governance routes have no direct path reference in any test: exceptions (list and create), exception decision, activations, activate, rollback and reset. They may be covered through module-level tests; Task A10 settles it.

### The target architecture against what exists today

The owner's prototype describes where the product is heading. Beta 0.0.1 qualifies only what exists, and it must not claim anything marked "Not yet".

| Layer in the prototype | Exists | Partial | Not yet |
| --- | --- | --- | --- |
| Entry points | Web application; outbound governance webhooks and signed exports for other systems | Notifications: governance notifications exist; the GitHub inbox is Experimental | AI assistant; public API with keys; MCP |
| AI orchestrator, model gateway | — | — | No model is called anywhere in the code |
| Context and evidence | Repository context (Galaxies: files, branches, pull/merge requests, issues, activity). Uranus with OSV, EPSS and CISA KEV, secret detection with verification, static analysis. History scans; verified live events | Runtime context: the site check reads hosted URLs; the rendered audit is off; YARA is optional and off | Telemetry, artifacts, environment configuration, Trivy |
| Analysis | Neural relationship graph with Explain this connection (shortest path) and recovery impact preview; risk scoring; Shadow Access Radar (GitHub); deterministic narration, Fix first and assistant prompts; leads "to confirm" with their decisive fact; credential verification; human triage | — | AI explanation and AI confidence |
| Policy and authorization | Governance policies through the mutation gateway, reviews with separation of duties, observe/warn/block, Safe Passage | Scoped grants: step-up, restore and single-use guards | Short-lived capability grants for agents |
| Execution | Repository actions; Uranus and Exposure; site check; read-only mode, protected paths, sync freeze, session revocation; recovery snapshots, emergency manifests, compare and restore preview | — | Isolated workers for untrusted jobs |
| Verification | Re-scan, compare kept audits, time-to-fix measurement, expected-head readback on writes | — | Running tests as verification |
| Audit and evidence ledger | Signed evidence exports; append-only governance decision chain; triage history; Neural timeline with incident replay; activity export as JSON, formula-safe CSV and Markdown | — | — |
| Data and storage | Neon PostgreSQL; restart-safe exposure scan jobs; leased governance webhook delivery queue | Audit jobs are held in memory; search uses the provider's code search, not an own index | Object storage |

## Documents that no longer describe the current state

Each of the 37 current documents in the manifest was read against the code and the live system; the 24 development plans and specifications are records and were not. Claims that check out are left alone: the Uranus benchmark (138 cases, 100% precision, 98% recall, re-run on 6 October), the audit platform guide, the capability counts generated from the registry, and README's descriptions of live events, recovery preview and activity export.

| Document | Stale claim | Observed truth | Fixed in |
| --- | --- | --- | --- |
| `docs/architecture/ARCHITECTURE.md`, `docs/release/PUBLIC_ALPHA.md`, `docs/qualification/PUBLIC_ALPHA_KNOWN_LIMITATIONS.md` | GitHub code/global search is "experimental" | `search` and `global-search` are Supported and Provider-verified | A11 |
| `docs/vision/FOUNDER_VISION.md` | Shadow Access Radar and Explain Connection with incident timeline replay are "Committed roadmap" | All three exist: `GET …/access-surface`, the Neural shortest-path explanation and the Neural timeline | A11 |
| `docs/reference/NEURAL_COMMAND_CENTER.md` | The workbench "repository trust bar" stands aside while Neural is open | No trust bar exists any more; the repository trust card was removed from the tool sections | A11 |
| `docs/operations/SECURITY_DEPLOYMENT.md`, runbooks `06-failed-deploy-rollback.md` and `07-database-backup-restore.md` | Restore runs or is verified "through migration `015_alpha_privacy`" | The latest migration is `030_code_audit_triage`; the restore runner derives the expected migration from the candidate and rejects 015 (remediation C2) | A11 |
| `docs/qualification/PRODUCT_REVIEW_REMEDIATION.md` | The ruleset requires `verify`, `automated` and `integration` | CI now also emits `browser (1)`–`browser (4)` and `release` (PR #79) | A1 |
| `docs/superpowers/plans/2026-09-21-multi-instance-foundation.md` (status note) | Webhook fencing, session merge and cross-process catch-up remain | Leased webhook delivery and revision-checked hosted session merge exist; only live events across instances remain, as `docs/architecture/2026-09-21-multi-instance-state.md` says | A11 |
| `README.md` | The product inventory ends with the Phase 1 alpha and v5.2 | Uranus, Exposure, the site check, Galaxies, Safeguards, triage, SBOM and licence policy are missing from the entry point | F2 |
| `docs/current/ROADMAP.md` | "Phase 2 — Repository Trust Digital Twin: planned"; public alpha is the next step | Much of the posture, access, dependency and evidence work is built; the next step is this beta plan | F2 |
| `docs/current/PROJECT_STATE.md`, `CONTINUATION_PROMPT.md`, `WORK_CONTINUITY.json` | The current state is the August baseline | `main` is about 450 commits further on; G1 passes on every pull request | F1 |
| `docs/operations/DEPLOY_RENDER_NEON.md` | "Deploy 5.3.0-alpha.17.0 Controlled Alpha", layered alpha.6, alpha.10 and Task 14 rollout steps | One current procedure is needed for the open beta: blueprint values, `npm run doctor`, the open-beta deployment check | F2 |
| `render.yaml` against the published limitations | Invitations on; 16, 16 and 25 MB | The live service runs invitations off and 95, 95 and 100 MB | A9 |
| Cohort and alpha documents: `PUBLIC_ALPHA.md`, known limitations, cohort checklist, operator checklist, runbooks `08`–`10` | An invitation-only cohort of five to ten testers on sandbox repositories | The owner chose open access | F2 |
| Deployment guides | `NV_SECURITY_CONTACT` and `NV_TRUSTED_PROXIES` are not mentioned | Both are read by the code and listed by `npm run doctor`; the owner sets `NV_SECURITY_CONTACT` | F2 |

## Release gates

| Gate | State observed | Closed by |
| --- | --- | --- |
| G1 Automated exact-archive qualification | Passes on every pull request; recorded only for the August baseline | F1, F3 |
| G2 Independent review | Passed only for the August baseline | F3 |
| G3 Live provider: GitHub, GitLab, Gitea | Last executed in September; never on current `main` | F4 |
| G4 Hosted Render/Neon | Never executed | F5 |
| G5 Manual accessibility: VoiceOver iOS and a desktop screen reader | No record | F6 |
| G6 Final release decision | Not started | F7 |

## What qualified means for 0.0.1-beta.1

1. **No Experimental entries.** The `hosted-beta` registry holds none. Every capability the interface shows is Supported, with one of two kinds of evidence:
   - Provider-verified, where it touches a provider;
   - Deterministic, over a Provider-verified reader.

   Everything else is Unavailable and absent from the interface: not greyed out, labelled or explained in place. The server still refuses it before transport.
2. **One exact candidate passes G1–G6.** Each gate's evidence names that candidate's commit, tree and archive SHA-256.
3. **Every residue is closed for real.** R1–R20 below are each closed by code, by an applied setting that has been read back, or by a recorded decision that removes the surface. None is closed by a limitation entry.
4. **The documents tell the beta truth.** Current documents and the generated state describe the beta, and the alpha lineage moves to history unchanged. No current document, screen or API response says Experimental, Unqualified, Pending or NO-GO for the beta candidate.
5. **No known serious defects.**
   - Zero critical or high production-audit findings.
   - Zero known critical or high defects.
   - Zero serious or critical axe findings on the golden paths.
   - Both manual screen-reader passes recorded.
6. **CI is fully green.** Every check on the final head passes, including every browser slice. Nothing merges with a red, cancelled or skipped required check.

## Capabilities not yet Supported, and how each resolves

| Provider | Today | Resolution under the owner's decisions | Task |
| --- | --- | --- | --- |
| GitHub | `repository.create`, `repository.delete`, `notifications` (Experimental, Deterministic) | Proven live with a qualification bot account or organization | A4 |
| GitHub | `live-events` (Experimental, Inferred) | Proven live inside the hosted run: webhook, push, verified event, cleanup | A4, F5 |
| GitLab, Gitea | `recovery` (Experimental) | Split. `recovery.compare` covers compare and preview, which exist, and becomes Supported after a live proof. Restore stays Unavailable and hidden. | A5 |
| GitLab, Gitea | `governance` (Experimental) | Split. `governance.view` covers policy views, which exist, and becomes Supported after a live proof. Enforcement on provider mutations stays Unavailable and hidden. | A5 |
| GitLab, Gitea | `dependency-audit` (Experimental) | Proven live: the harness writes a manifest fixture, and the product reports its packages | A5 |
| Gitea | `tree.read` (Experimental, Inferred) | Proven live: a recursive tree compared with the files written | A5 |
| GitLab, Gitea | 21 and 26 Unavailable | Hidden from the interface; the server still refuses them | A6 |

## Residue

- **R1 — main is unprotected.** No ruleset applies to `main`. `config/github-main-ruleset.json` has never been applied, and its required checks predate the CI split in PR #79.
- **R2 — deferred minor.** The CLI and store count label and revocation-reason limits in UTF-16 code units, while PostgreSQL counts code points.
- **R3 — runtime currency.** Node is locked to 22.23.1 (disposition R3-N3), and the pinned `actions/checkout` and `actions/setup-node` target the deprecated Node 20 action runtime.
- **R4 — unqualified capabilities.** The rendered website audit is off by default and unqualified, and optional YARA scanning is unavailable on the hosted service.
- **R5 — live events are per instance.** Events reach subscribers only on the instance that published them, and the client ceilings are per instance.
- **R6 — sessions without a database.** They are single-process and end on restart; a hosted beta must always have the database.
- **R7 — approval spend ledger.** The live-dispatch approval spend ledger is a CI cache.
- **R10 — alpha.17 names.** The qualification lineage is named for alpha.17 throughout: workflow, sandbox prefix, `ci/` scripts, artifacts and continuity schema 5.
- **R12 — configuration drift.** The live environment overrides `render.yaml` on access mode and every limit, and nothing detects the difference.
- **R13 — enforcement map gaps.** 108 `allowExperimental` guards, two repository routes with no capability, `branches.read` never named by a route, and `lfs` checked inside a handler.
- **R14 — evidence drift.** The generated state is about 450 commits behind `main`, and per-pull-request qualification is never recorded.
- **R15 — cold start.** The first request after idle exceeded 30 seconds.
- **R16 — database residue.** A leftover recovery branch from 25 September, no restore target, and a 6-hour history window.
- **R17 — open-access readiness.** The alpha's safety rested on invitations and sandbox-repository allowlists, and an open beta has neither. Anyone can now connect real repositories and run audits, site checks and scans on free-tier compute. Before the gate opens to everyone, the product needs:
  - published terms, privacy and retention;
  - abuse and quota controls;
  - a re-verified safety review of every write path against real repositories.
- **R18 — the deployment check has no open-beta purpose.** `check:deployment` knows `cohort`, which requires invitations, and `operator-verification`, and nothing for an open beta.
- **R19 — alpha-cohort documents.** The cohort checklist, known limitations and public-alpha contract describe an invitation-only cohort of five to ten testers on sandbox repositories.

- **R20 — stale documents.** The documents listed under "Documents that no longer describe the current state" say things about today's product that the code and the live service contradict.

R8 (the live service is not a cohort deployment) is subsumed by R12 and R17. R9 and R11 belong to the later platform plans.

## Global constraints

- **Red first.** Every behavior change starts with a failing test that captures the expected failure. Security boundaries are proven with real processes and real PostgreSQL.
- **No content at rest.** Never persist raw credentials, source excerpts, repository contents or probe response rows.
- **Guarded egress.** Every outbound request goes through guarded transport.
- **Additive migrations.** Migrations are additive and append-only, allocated from current `main` (`031` onward). No destructive SQL runs without the owner's explicit approval.
- **Live qualification stays confined.** It touches only pre-created `nvx-` sandbox targets and their disposable branches, and the qualification account or organization for create and delete.
- **Merge only on a fully green head.** Every check must pass. Fixtures that resemble credentials are built from split strings.

## Phase A — Close the residue

### Task A1: Protect main with the checks CI actually runs

**Files:** `config/github-main-ruleset.json`; a new `test/github-main-ruleset.test.js`, registered in the unit chain.

**Red:** The test reads the job names the workflows emit on a pull request and asserts the ruleset requires each one:

- `verify`;
- `browser (1)`–`browser (4)`;
- `release`;
- `integration`;
- `automated`;
- `browser-matrix (1)`–`(4)`.

It fails today.

**Green:** Update the JSON. The owner applies it under Settings → Rules, and the read-back through `GET …/rulesets` is recorded. Closes R1.

**Verify:** The new test and `npm test`.

### Task A2: Count characters the same way in JavaScript and PostgreSQL

**Files:** `scripts/alpha-db.js`, `src/alpha-access-store.js`, `src/alpha-privacy-store.js` and their tests.

**Red:** A label and a revocation reason made of astral-plane characters, at the limit.

**Green:** One shared helper counts code points everywhere the database does. Closes R2.

**Verify:** The focused tests and `npm run test:migrations`.

### Task A3: Bring the runtime and CI toolchain current

**Files:** `.nvmrc`, `package.json` `engines`, every workflow, `test/public-alpha-workflow-contract.test.js` and `test/ci-local.test.js`.

**Red:** A contract of reviewed action SHAs and their declared runtimes asserts none targets Node 20.

**Green:**

- Pin reviewed Node 24 releases of `checkout`, `setup-node`, `upload-artifact`, `download-artifact` and `cache`.
- Record the application-runtime decision. Either move to the current Node LTS as one candidate-wide change, or record why 22 stays and its end-of-life date.

Closes R3.

**Verify:** The full CI.

### Task A4: Qualify GitHub's four experimental capabilities

**Files:** The GitHub live harness, `ci/provider-alpha17-common.js`, `src/qualification-evidence.js`, the registry and its contract, and `docs/current/PROVIDER_CAPABILITIES.md`.

**Red:** New harness probes, through the product's own routes, fail until their targets exist:

- **Repository create:** create `nvx-beta-<run>` in the qualification account or organization, then read it back by name and ID.
- **Repository delete:** delete it with step-up and full-name confirmation, then prove it is absent.
- **Notifications:** read the inbox through a bot credential of the OAuth/classic kind.
- **Live events**, in the hosted run (F5):
  1. register a webhook on the sandbox repository that points at the candidate;
  2. push to the repository;
  3. observe the verified event in the stream;
  4. remove the webhook and prove it is absent.

**Green:** Each capability becomes Supported with Provider-verified evidence, and its probes join `PROVIDER_CAPABILITY_REQUIREMENTS`.

**Verify:** A sanitized live artifact and the registry contract.

### Task A5: Give GitLab and Gitea honest names, then prove them

**Files:**

- The registry and its contract.
- The recovery and governance route guards in `server.js`.
- The capability UI seam.
- `src/qualification-evidence.js`.
- The GitLab and Gitea harnesses.

**Red:**

- **Name contract:** a registry contract asserts that every capability name maps to exactly the routes that implement it. `recovery` on GitLab and Gitea covers restore routes that refuse, and `governance` covers enforcement that does not happen; both fail.
- **Live probes:**
  - compare two disposable refs and preview a restore without changing anything;
  - read a policy view;
  - write a manifest fixture and read back its packages;
  - read a recursive tree on Gitea.

**Green:**

- The splits are `recovery.compare` and `recovery.restore`, and `governance.view` and `governance.enforce`.
- GitHub keeps all four halves, at its current evidence.
- GitLab and Gitea gain `recovery.compare`, `governance.view`, `dependency-audit` and, on Gitea, `tree.read`, each as Supported once its probe passes.
- `recovery.restore` and `governance.enforce` stay Unavailable on GitLab and Gitea.

**Verify:** The unit and browser suites, and live GitLab and Gitea runs.

### Task A6: Show only what is Supported, and enforce exactly that

**Files:**

- `public/capability-ui.js` and the capability seam in `public/app.js`.
- Every `data-allow-experimental` attribute, and the landing proof row in `public/index.html`.
- `public/workspace-pulse.js`.
- Every `capabilityAccess(…, { allowExperimental: true })` in `server.js`.
- A new route-capability contract and a new browser spec.

**Red:**

- For GitHub, GitLab and Gitea fixtures, the browser spec asserts that:
  - no element renders an Experimental or Unavailable label or badge;
  - no control bound to a non-Supported feature exists in the accessibility tree.
- An API test asserts the server still refuses each non-Supported feature with its typed error.
- The route-capability contract asserts three things:
  1. every `/api` route names its capability or sits on a reviewed, capability-free list;
  2. every registry key is named by at least one route;
  3. no route accepts `allowExperimental`.

**Green:**

- The registry contract rejects Experimental for `hosted-beta`.
- The opt-in path is removed from the server and the interface.
- `/intelligence/events` and `/evidence` name their capability.
- Branch reads name `branches.read`.
- The LFS strategy is checked at the route.
- Unavailable controls are never rendered.
- The workspace pulse and the landing copy describe only Supported capabilities and their evidence.

Closes R13.

**Verify:** The new spec and contract, `npm run test:e2e` and `npm test`.

### Task A7: Qualify or remove the rendered site audit and YARA

**Files:** `src/rendered-site-*.js`, `src/routes/rendered-audit.js`, the hosted documents and interface, and the upload-security claims.

**Red:** A contract asserts that the `hosted-beta` profile neither mounts nor advertises the rendered audit or YARA.

**Green:**

- The rendered audit needs Chromium beside the server process, and the free instance's 512 MB cannot safely hold both under open traffic. It leaves the hosted beta and returns with paid hosting and its own qualification.
- YARA leaves every hosted claim.

Closes R4.

**Verify:** The focused tests and `npm run docs:check`.

### Task A8: Bound the deployment to one instance with a database

**Files:** `src/hosted-readiness.js`, the configuration validation in `src/config.js`, and `docs/architecture/2026-09-21-multi-instance-state.md`.

**Red:** The `hosted-beta` profile refuses to start without `DATABASE_URL` and reports its instance count.

**Green:**

- The database is unconditional for `hosted-beta`, which closes R6.
- The beta runs one instance, recorded as its capacity bound, and live events stay correct on that one instance, which closes R5.

**Verify:** `npm run test:multi-instance` and the configuration tests.

### Task A9: Make the running configuration match a reviewed source

**Files:** `render.yaml`, `src/hosted-readiness.js`, `scripts/check-deployment-readiness.js` and the operator runbook.

**Red:** `npm run check:deployment` with purpose `open-beta` fails today against the live service:

- the `open-beta` purpose does not exist;
- the live access mode, profile and every limit are compared with the reviewed values, and the limits do not match.

**Green:**

- `render.yaml` records `NV_ALPHA_ACCESS_MODE=off`, the `hosted-beta` profile and the chosen limits.
- The service is synced from the blueprint, or set through the Render API, and each value is read back.
- An `open-beta` purpose requires access mode `off` and every reviewed value.
- Drift fails the check.

Closes R12 and R18.

**Verify:** `npm run check:deployment` against the live service, and the hosted-readiness tests.

### Task A10: Prove the seven untested governance routes

**Files:** `test/governance-*.test.js`, and the governance browser specs if needed.

**Red:** For each of the seven routes, a real-server test exercises one success and one refusal:

- the list and create exception routes;
- the exception decision;
- activations, activate and rollback;
- reset.

The refusals cover a missing role, a stale version and an unavailable store.

**Green:** Where module-level tests already cover the logic, the route test pins the wiring. Where a test exposes a defect, it is fixed in the same change.

**Verify:** The focused tests and `npm test`.

### Task A11: Correct the documents that are wrong about today's product

**Files:** The documents marked A11 under "Documents that no longer describe the current state".

**Red:** A documentation contract fails while any current document:

- calls a Supported capability experimental;
- names a migration other than the latest as the restore target;
- describes interface elements that no longer exist.

Today it fails on the six rows marked A11.

**Green:**

- Each claim is corrected to the observed truth, citing the code that proves it.
- The founder vision's maturity labels move to Implemented where the code shows the feature.
- The contract keeps the corrections from drifting again.

Decisions about the beta itself wait for F2. Closes R20 for the claims about today's product.

**Verify:** `npm run docs:check` and the documentation tests.

## Phase O — Ready for open access

### Task O1: Abuse and quota controls

**Files:** `server.js` admission paths, `src/site-check.js`, `src/code-audit-jobs.js`, the exposure job admission, and `src/hosted-readiness.js`.

**Red:**

- Concurrent anonymous and authenticated load beyond the free instance's budget gets a typed 429 or 503, and the instance never runs out of memory.
- Instance-wide ceilings hold for running audits, site checks and exposure scans, in addition to the per-identity limits that already exist.
- Every unauthenticated route is listed, and none reaches a provider or the database without a bound.
- Maintenance mode stops new work and lets running work drain.

**Green:**

- Instance-wide ceilings, sized from a measured memory profile.
- A reviewed list of unauthenticated routes.
- Neon and Render quota use visible to the operator.
- Maintenance mode rehearsed.

Part of R17.

**Verify:** A load test against a local production build, plus the focused tests.

### Task O2: Make every write path safe on real repositories

**Files:** The mutation gateway, the routes for:

- file write, delete, rename and batch;
- folder moves;
- native push and LFS;
- branches;
- pulls (merge), issues and releases;
- repository create and delete;
- recovery restore;

plus `docs/operations/WRITE_PATH_REVIEW.md` (new).

**Red:** For every write route, a real-server test proves:

- a stale head is refused;
- a missing step-up is refused where one is required;
- an active policy blocks in block mode;
- read-only mode refuses the write;
- a protected path refuses every action that could change it.

**Green:** One reviewed document lists each write path, its guards and its test. Any route missing a guard is fixed. Part of R17.

**Verify:** The focused tests, `npm test` and `npm run test:integration`.

### Task O3: Publish the terms

**Files:** The terms, privacy notice and retention schedule pages, `/.well-known/security.txt` served from `NV_SECURITY_CONTACT`, the support route, and the account-deletion path.

**Red:**

- The pages are served from the candidate, and their retention periods equal the values the code enforces.
- `security.txt` names the configured contact.
- Account deletion removes sessions, sealed credentials, kept audits, scans and triage for that identity, and leaves only the permitted pseudonymous integrity metadata.

**Green:** The texts are approved by the owner, and the published retention matches runtime. Part of R17.

### Task O4: Keep the service awake and watched

**Files:** The operator runbook and the uptime check configuration.

**Green:**

- A free external uptime check calls `/healthz` every 10 minutes. That keeps the free instance from sleeping and records availability as evidence.
- `/healthz` reaches neither the database nor a provider, so Neon can still suspend.

Closes R15.

**Verify:** The first request after a quiet hour answers in under 2 seconds.

## Phase F — Qualify the candidate

### Task F1: Rename the lineage and set the version

**Green:**

- **Renames:**
  - `public-alpha-alpha17.yml` becomes `public-beta-qualification.yml`;
  - the `nvx-alpha17-` prefix becomes `nvx-beta-`;
  - `ci/*alpha17*` becomes `ci/*beta*`;
  - artifacts, contracts and the `hosted-alpha` profile become `hosted-beta`.
- **Version:** `0.0.1-beta.1` in `package.json`, `WORK_CONTINUITY.json` and the registry, with the version-line reset recorded as an architecture decision.
- **Continuity:** schema version 6 binds a frozen candidate's `automated` result and archive hash.
- **Spend ledger:** the approval spend ledger moves from the CI cache to a durable store.

Closes R7, R10 and R14.

### Task F2: Make the documents tell the beta truth

**Green:**

- The generated state, roadmap, release gates, provider capabilities and known limitations are rewritten for an open beta.
- An open-beta launch checklist replaces the cohort checklist.
- Every row marked F2 under "Documents that no longer describe the current state" is resolved.
- The alpha documents move byte-for-byte under `docs/history/`, bound by the historical integrity baseline.

Closes R19.

### Task F3: Pass G1 and G2

**Green:** Freeze the candidate. Automated exact-archive qualification and an independent review run on its exact bytes.

### Task F4: Pass G3

**Green:** Live runs for GitHub, GitLab and Gitea on the frozen candidate, including the A4 and A5 probes. The owner first confirms the existing sandbox targets and credentials still work, and adds the GitHub qualification account or organization.

### Task F5: Pass G4

**Green:** The hosted run on the deployed candidate covers:

- cold start and scale-to-zero wake;
- open-beta load within the O1 ceilings;
- an encrypted backup, and an isolated restore into a dedicated Neon restore branch;
- rollback;
- the live-events webhook from A4;
- account deletion.

The leftover `recovery-pr53-before-028-20260925` branch is deleted only with the owner's explicit approval, once the restore drill has proven migrations `028`–`030`. Closes R16.

### Task F6: Pass G5

**Green:** A written script covers:

- sign-in;
- the workspace;
- audit and exposure;
- governance and safeguards;
- account deletion.

One VoiceOver iOS pass and one desktop screen-reader pass (NVDA or VoiceOver for macOS) are recorded against the frozen candidate by the owner or someone they commission.

### Task F7: Pass G6 and launch

**Green:**

- Every gate is bound to the same candidate.
- The signed **GO** decision is recorded.
- The open-beta launch checklist is executed.
- `0.0.1-beta.1` is tagged.

## Sequence

| Order | Work | Waits on |
| --- | --- | --- |
| 1 | A1, A2, A3, A6, A7, A8, A9, A10, A11 | The owner applying the A1 ruleset |
| 2 | O1–O4 | Owner approval of the texts (O3) |
| 3 | A4, A5 | The GitHub qualification account; working sandbox credentials |
| 4 | F1, F2 | Everything above merged |
| 5 | F3–F7 | One frozen candidate. Each new candidate restarts at G1 |

Each task lands as its own pull request. A pull request merges only when every check on its head has passed.

## After beta 0.0.1

These are separate plans, written after the beta qualifies. They are not part of this plan.

- **Identity with Clerk:** sign-up, multi-factor, organizations; the product keeps principals, provider connections and governance roles.
- **The AI layer, following the 5 October research:**
  - contracts first: Canonical Finding, Evidence Envelope, Actor Envelope, Verification Result and Audit Event;
  - then a read-only investigator;
  - then a Tool Registry and a Policy Decision Point before any write;
  - the model never holds a broad token, and only verified outcomes close findings.

  The prototype diagram is the north star.
- **Billing**, and plans and entitlements.
- **The deep comparison** with Sentry Seer, Strix, Semgrep, TruffleHog, GitLab, GitHub and Aikido/XBOW.
- **The infrastructure path** from the 5 October plan: Render and Neon while free; then one OVH VPS-3 behind Cloudflare, with off-provider encrypted backups, after load, restore and rollback tests; workers split first.
- **Platform work:**
  - GitLab and Gitea parity: a repository reader, real restore, and enforcement;
  - durable audit jobs;
  - the rendered audit on paid hosting;
  - live events across instances;
  - decomposing `server.js` and `public/app.js`.

## Out of scope for 0.0.1-beta.1

- Anything in [After beta 0.0.1](#after-beta-001).
- New capabilities, other than the capability splits and the qualification probes this plan names.
- Paid hosting, a custom domain or a second instance.
