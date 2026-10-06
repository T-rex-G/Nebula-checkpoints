# Beta 1.0.0 Qualification and Platform Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Status:** Proposed programme plan, reviewed against `main` at `be2f558` and against the running system on 6 October 2026. It is not qualification evidence and changes no gate: the generated project state keeps public alpha at **NO-GO** until the gates below pass for one exact candidate. Render redeploys `main` on every merge, so merging this document redeploys the service with one more document and no change in behavior. It authorizes no live-provider dispatch, migration, configuration change, vendor account, payment or cohort opening.

**Goal:** Ship `1.0.0-beta.1` — one candidate in which every visible capability is Supported and evidenced, every release gate has passed for its exact bytes, and nothing in the product or the current documents reads Experimental, Unqualified, Pending or NO-GO. Three platform layers qualify with it: Clerk identity, Stripe billing, and AI review grounded in the deterministic engines.

**Architecture:** One Node.js/Express service stays, with CommonJS, unbundled browser scripts and PostgreSQL (Neon) as the system of record. Clerk owns who a person is. Provider connections (GitHub, GitLab, Gitea) stay first-party and keep owning what that person may do in a repository. Stripe owns money; the product owns entitlements. They are derived from verified Stripe events into the product's own tables and enforced by the server-owned capability registry, as a third dimension beside provider and deployment. AI review is an advisory layer over Uranus, Exposure and the site check:

- it reads a deterministic finding and a bounded, secret-redacted context;
- it returns a schema-constrained verdict;
- it never changes a grade, closes a finding or writes to a repository by itself.

Each vendor is reached through its own guarded-transport profile.

**Tech Stack:**

- **Runtime and data:** Node.js (22.23.1 today; the uplift is decided in Task A3), Express, `pg`, PostgreSQL 17 and Playwright.
- **New runtime dependencies:** `@clerk/express`, `stripe` and `@anthropic-ai/sdk`. Each is pinned in the lockfile and covered by the production audit.
- **Claude API:** `claude-opus-5-5` with effort set explicitly per route. The integration uses structured outputs, prompt caching, the Message Batches API for scheduled re-review, and token counting for pre-flight cost.

## Where the product stands on 6 October 2026

Documents can lag behind the code, so every claim below was checked against the running system. Where a document and the system disagree, the observed value wins, and the disagreement is itself a residue. Every row is something this plan closes, and its ID is how the tasks refer to it.

### Verified against the running system on 6 October 2026

| What was checked | Observed | Source |
| --- | --- | --- |
| Deployed code | The live release digest `f5284335…96ad` equals the digest computed from `main` at `be2f558`: the service runs merged `main`. | `/api/version`; `computeReleaseFingerprint` on `be2f558` |
| Capability registry | The live projection matches `config/public-alpha-capabilities.json` entry for entry, for all three providers. | `/api/capabilities?provider=…` |
| Access mode | `off`. `render.yaml` declares `invite`, so the dashboard overrides the blueprint. | `/api/alpha/status`, `/api/config` |
| Hosted limits | Git data 95 MB, native push 95 MB, uploads 100 MB. `render.yaml` and the published known limitations both say 16 MB, 16 MB and 25 MB. | `/api/config` |
| GitHub App | Disabled; sign-in is OAuth only. | `/api/config` |
| Hosting | Render Free, one instance, auto-deploy of `main` on every commit. The first `/healthz` after idle timed out at 30 s; later calls answered in 0.3–0.7 s. | Render service `srv-dabg6ufqj5pc739takeg`; timed probes |
| Database | One Neon project at free-tier limits (0.25 CU, 1 GiB branch limit, 6-hour history). Migration `030` is applied. The `main` branch sits beside a leftover `recovery-pr53-before-028-20260925`, and there is no isolated restore target. | Neon project `ancient-field-09975665`; `/readyz` |
| Branch protection | `main` is `protected: false` and no rulesets apply. The API answers the read, so only applying a ruleset needs an administrator. | `GET …/branches/main`, `…/rulesets`, `…/rules/branches/main` |
| Live-provider history | 25 dispatched qualification runs:<br>• all three providers green on 3 September (run 70);<br>• GitHub alone green through 7 September (run 98);<br>• `hosted-live` never executed.<br>`main` is now 292 commits past run 98 and 450 past the recorded baseline. | Actions API, `public-alpha-alpha17.yml` |
| Automated qualification | The `automated` exact-archive job runs on every pull request and last passed on `edaeb5d` (run `37392053996`). The generated state still records only the August baseline. | Actions API |
| Server enforcement | 176 `/api` routes, of which 141 are behind `capabilityAccess`:<br>• 108 route guards carry `allowExperimental` opt-ins, across 26 features;<br>• `GET /api/repo/:owner/:repo/intelligence/events` and `GET /api/repo/:owner/:repo/evidence` have no capability guard;<br>• `branches.read` is advertised but no route names it (branch reads sit under `repository.read`);<br>• `lfs` is checked inside the upload handler rather than at the route. | `server.js` route table |
| Public copy | The landing page's proof row tells visitors features are marked "Experimental, with the reason". | `public/index.html` |

### Release gates

The last bytes recorded as qualified are the August baseline: tree `b0945a403beaa4c4242a1d6526aa7c3d80d48f08`, archive SHA-256 `58adb78f…d711`. No later candidate has been frozen and bound to evidence.

| Gate | State observed | Closed by |
| --- | --- | --- |
| G1 Automated exact-archive qualification | Runs on every pull request and passed on `edaeb5d`. Recorded only for the August baseline (run `32540542682`). | F1, F3 |
| G2 Independent review | Passed only for the August baseline (remediation review `4d47a6a5…`) | F3 |
| G3 Live provider: GitHub, GitLab, Gitea | Last executed on 3 September for all three and 7 September for GitHub; never on current `main` | F4 |
| G4 Hosted Render/Neon | Never executed | F5 |
| G5 Manual accessibility: VoiceOver iOS and a desktop screen reader | No record | F6 |
| G6 Final release | Not started | F8 |

### Capabilities that are not Supported

| Provider | Experimental | Unavailable |
| --- | --- | --- |
| GitHub | `repository.create`, `repository.delete`, `notifications` (Deterministic); `live-events` (Inferred) | none |
| GitLab | `dependency-audit`, `governance`, `recovery` | 21: `access-surface`, `code-audit`, `exposure.scan`, `file.batch`, `file.rename`, `folder.move`, `global-search`, `lfs`, `live-events`, `native-push`, `notifications`, `rate.read`, `releases.read`, `releases.write`, `repository.create`, `repository.delete`, `search`, `stars.read`, `stars.write`, `workflows.read`, `workflows.rerun` |
| Gitea | `dependency-audit`, `governance`, `recovery` (Deterministic); `tree.read` (Inferred) | 26: the GitLab list plus `branches.write`, `issues.read`, `issues.write`, `pulls.read`, `pulls.write` |

### Residue

- **R1 — main is unprotected.** The API reports `protected: false` with no rulesets. `config/github-main-ruleset.json` is proposed but has never been applied, because applying it needs an administrator. Its required checks also predate the CI split in PR #79 and do not name `browser (1)`–`browser (4)` or `release`.
- **R2 — deferred minor.** The CLI and store count label and revocation-reason limits in UTF-16 code units, while PostgreSQL counts code points.
- **R3 — runtime currency.** The application is locked to Node 22.23.1 (review disposition R3-N3). GitHub Actions warns that the pinned `actions/checkout` and `actions/setup-node` target the deprecated Node 20 action runtime.
- **R4 — off-by-default capabilities.** The rendered website audit (`NV_RENDERED_AUDIT_ENABLED`) is off by default, and optional YARA scanning is unavailable on the hosted service. Neither is qualified.
- **R5 — live events across instances.** A subscriber on one instance does not receive another instance's events in real time, and the `LIVE_CLIENTS` ceilings are per instance ([multi-instance state](../../architecture/2026-09-21-multi-instance-state.md)).
- **R6 — no-database sessions.** Sessions without a database are single-process and end on restart. That is fine locally, but a hosted beta must always run with the database.
- **R7 — approval spend ledger.** The live-dispatch approval spend ledger is a CI cache, so deleting it reopens the replay window inside 30 minutes.
- **R8 — the live service is not a cohort deployment.** On 6 October it still runs with invitation enforcement off (see R12). It is an operator-verification deployment, not a cohort.
- **R9 — oversized files.** `server.js` is 8,906 lines and `public/app.js` is 10,130. Three vendor integrations must not land in either.
- **R10 — alpha.17 lineage names.** The qualification lineage is named for alpha.17 throughout:
  - `.github/workflows/public-alpha-alpha17.yml`;
  - the `nvx-alpha17-` sandbox prefix;
  - `ci/*alpha17*` and the artifact names;
  - continuity schema 5.
- **R11 — founder vision scope.** The [founder vision](../../vision/FOUNDER_VISION.md) lists paid-AI dependencies and multi-tenancy as out of current scope. AI review, Stripe and team workspaces change that, so each needs a recorded decision.
- **R12 — configuration drift.** The live service's environment overrides `render.yaml`:
  - access mode is `off` where the blueprint says `invite`;
  - git data, native push and upload limits are 95, 95 and 100 MB where the blueprint and the published limitations say 16, 16 and 25 MB.

  Nothing detects the drift, so the published limits are false for the running service.
- **R13 — enforcement map gaps.**
  - 108 route guards still accept `allowExperimental`.
  - Two repository routes (`/intelligence/events`, `/evidence`) name no capability.
  - `branches.read` is advertised but enforced as `repository.read`.
  - `lfs` is checked inside the upload handler, not at the route.
- **R14 — evidence drift.** The generated state and continuity record describe a baseline 450 commits behind `main`. The per-pull-request `automated` qualification passes, but its result is never bound to a candidate.
- **R15 — cold start.** The first request after idle exceeded 30 seconds on the free instance.
- **R16 — database residue.** The Neon project holds a leftover recovery branch from 25 September and no isolated restore target, and its history window is 6 hours.

## What "qualified" means for 1.0.0-beta.1

1. **No Experimental entries in the beta registry.** The registry for the beta deployment holds zero Experimental entries. Every capability the interface can show is Supported, with evidence of one of two kinds:
   - Provider-verified, where it touches a provider;
   - Deterministic, where it works over a Provider-verified reader.

   Anything else is Unavailable and absent from the interface: not greyed, labelled or explained in place. The server still refuses it before transport.
2. **All gates pass on one exact candidate.** One commit, tree and archive SHA-256 passes G1–G6 and three new gates: G7 identity (Clerk), G8 billing (Stripe) and G9 AI review evaluation. Every gate's evidence binds to that candidate.
3. **Every R-item is closed for real.** Each is closed by code, by an applied setting that has been read back, or by a recorded decision that removes the surface it describes. None is closed by a limitation entry.
4. **Documents report beta truth.** Current documents and the generated state describe the beta candidate, and the alpha lineage moves to history unchanged. No current document, screen or API response contains Experimental, Unqualified, Pending or NO-GO for the beta candidate.
5. **No known serious defects.** The candidate has:
   - zero critical or high production-audit findings;
   - zero known critical or high defects;
   - zero serious or critical axe findings on the golden paths;
   - both manual screen-reader passes recorded.
6. **CI is fully green.** Every check on the final head passes, including every browser slice. Nothing merges with a red, cancelled or skipped required check.

## Decisions the owner makes

Each decision is needed before the phase named in the last column. The recommendation is the default if the owner agrees.

| ID | Decision | Recommendation | Needed by |
| --- | --- | --- | --- |
| D1 | Version line | `1.0.0-beta.1`, then `beta.N` per candidate and `1.0.0` at general availability. 5.3.0-alpha.17 was the internal alpha lineage. Semver puts 1.0.0-beta below it, which is harmless because nothing compares versions across lineages (the asset stamp is a digest); the reset is still recorded as an architecture decision. | F1 |
| D2 | GitLab and Gitea scope | GitHub complete. GitLab gains a repository reader (exposure, audit, access surface) and promotes its three experimental capabilities; Gitea promotes its four. Every other Unavailable capability is hidden. Each returns later, feature by feature, with its own live evidence. | A5 |
| D3 | Hosting | The standing rule is that hosting stays free. Free Render sleeps and cold-starts: a paying customer sees that, and it delays Stripe and Clerk webhooks. A second instance and the rendered audit's browser both need more than the free plan. Stay free through Phases A–D and decide at Task E3, before the first payment. | E3 |
| D4 | Plans and prices | Three plans:<br>• **Free**: the deterministic engines and a bounded number of repositories.<br>• **Pro**: one person, with AI review credits.<br>• **Team**: a Clerk organization with shared triage and governance and pooled credits.<br>The prices are the owner's to set. | C1 |
| D5 | AI data terms | Opt-in per workspace and off by default. Code leaves only as bounded, secret-redacted excerpts. Before customers can enable it, confirm the Anthropic account's commercial data and retention terms; zero data retention needs an agreement with Anthropic. | D1 |
| D6 | Domain | Clerk production instances need DNS records on a domain the owner controls; `*.onrender.com` cannot serve. | B1 |
| D7 | Sign-up mode | Beta opens through Clerk's waitlist and invitations, and the alpha invitation codes and pepper retire. | B1 |

## Owner actions

These cannot be delegated. Keys and credentials are entered as Render or GitHub Actions environment secrets, never pasted into chat or source.

- **Apply the corrected main ruleset** from Task A1 with an administrator account, then read it back.
- **Confirm the existing sandbox targets still work.** GitHub, GitLab and Gitea all qualified green in September, so their targets and credentials were in place then. Rotate any credential that has expired.
- **Add a GitHub qualification organization or bot account**, with credentials scoped to it alone, for repository create/delete and notifications.
- **Decide whether the GitHub App is enabled.** It is disabled on the live service today.
- **Create the vendor accounts:**
  - Clerk: development and production instances;
  - Stripe: test and live mode, including business verification;
  - Anthropic: an API organization.
- **Register the domain** (D6) and point its DNS.
- **Run, or commission, the two manual screen-reader passes** from the script in Task F6.
- **Approve the legal texts** (Task E5) and set `NV_SECURITY_CONTACT`.

## Global constraints

- **Red first.** Every behavior change starts with a failing test that captures the expected failure. Security boundaries are proven with real processes, real PostgreSQL and the vendor's own test mode, not with fakes alone.
- **No content at rest.** Never persist raw credentials, source excerpts, repository contents, probe response rows, AI prompts or AI free text. Persist identifiers, enumerations, counts, hashes and timestamps.
- **Guarded egress for every vendor.** Every outbound request goes through guarded transport, with three new profiles:
  - `identity`: the Clerk Backend API only;
  - `billing`: `api.stripe.com` only;
  - `ai-review`: `api.anthropic.com` only.

  Each SDK receives the transport through its fetch or HTTP-client hook, and an SDK that cannot take one is not used.
- **Additive migrations.** Migrations are additive and append-only, allocated from current `main` (`031` onward). No destructive SQL runs without the owner's explicit approval, and an applied migration is never edited.
- **Verified, idempotent webhooks.** Each vendor webhook is:
  - verified on the raw body before parsing;
  - deduplicated by event ID in `nv_single_use_guards`;
  - processed idempotently;
  - re-read from the vendor's API wherever event order matters.
- **Outages degrade, never fail open:**
  - Clerk down: no new sign-in.
  - Stripe down: stored entitlements stand.
  - Anthropic down: deterministic results stand, and AI review says it is unavailable.
- **New domains get their own route modules** under `src/routes/`, with injected dependencies, following the router pattern of the [multi-instance plan](2026-09-21-multi-instance-foundation.md) Task 7. `server.js` and `public/app.js` do not grow.
- **Merge only on a fully green head.** Every check must pass. Fixtures that resemble credentials are built from split strings.

## Phase A — Close the alpha residue

### Task A1: Protect main with the checks CI actually runs

**Files:** Modify `config/github-main-ruleset.json`. Create `test/github-main-ruleset.test.js` and register it in the unit chain.

**Red:** The test reads the job names the workflows emit on a pull request and asserts the ruleset requires each one: `verify`, `browser (1)`–`browser (4)`, `release`, `integration`, `automated` and `browser-matrix (1)`–`(4)`. It fails today.

**Green:** Update the JSON. The owner applies it under repository Settings → Rules and reads it back through `GET /repos/{owner}/{repo}/rulesets`; the read-back is recorded with the continuity state. Closes R1.

**Verify:** The new test, `npm test` and `npm run docs:check`.

### Task A2: Count characters the same way in JavaScript and PostgreSQL

**Files:** The alpha invite CLI and stores (`scripts/alpha-db.js`, `src/alpha-access-store.js`, `src/alpha-privacy-store.js`) and their tests.

**Red:** A label and a revocation reason made of astral-plane characters, at the limit. JavaScript and PostgreSQL disagree today.

**Green:** If Task B7 retires alpha access first, delete the surface with its tests and close R2 by removal. Otherwise, count code points in one shared helper wherever the database counts code points.

**Verify:** The focused tests and `npm run test:migrations`.

### Task A3: Bring the runtime and CI toolchain current

**Files:** `.nvmrc`, `package.json` `engines`, every workflow, `test/public-alpha-workflow-contract.test.js`, `test/ci-local.test.js`, and the Node pin in the qualification scripts.

**Red:** A contract keeps a reviewed table of pinned action SHAs and the runtime each declares, and asserts none targets Node 20. It fails today.

**Green:** Pin, by SHA, reviewed releases of `checkout`, `setup-node`, `upload-artifact`, `download-artifact` and `cache` that run on Node 24. Then decide the application runtime:

- either move to the current Node LTS as one candidate-wide change across `engines`, `.nvmrc`, every workflow, and both source and archive qualification;
- or record why 22 stays, with its end-of-life date.

Closes R3.

**Verify:** The full CI on the pull request.

### Task A4: Earn GitHub's four experimental capabilities

**Files:** The GitHub live harness (renamed in F1), `ci/provider-alpha17-common.js`, the registry, `docs/current/PROVIDER_CAPABILITIES.md`, and the registry contract.

**Red:** New harness steps, which fail until their targets exist:

- **Repository create:** through the product's own route, create `nvx-beta-<run>` in the qualification organization or bot account, then read it back by name and ID.
- **Repository delete:** delete it with step-up and full-name confirmation, then prove it is absent.
- **Notifications:** read them through a bot credential of the OAuth/classic kind, which the harness's fine-grained token cannot do.
- **Live events**, inside the hosted run (F5):
  1. register a webhook on the sandbox repository that points at the deployed candidate;
  2. push to the repository;
  3. observe the verified event in the event stream;
  4. remove the webhook and prove it is absent.

**Green:** The four entries move to Supported with Provider-verified evidence naming the run ID, and the interface drops their experimental opt-ins.

**Verify:** A sanitized live artifact, the registry contract and `npm run docs:check`.

### Task A5: Give GitLab a repository reader, then finish D2

**Files:**

- Create a provider-neutral reader interface beside `src/exposure-reader.js`, with a GitLab implementation.
- Inject the reader into `src/code-audit.js`, `src/code-audit-jobs.js`, the exposure modules and access surface.
- The registry and the GitLab harness.

**Red:** A fixture GitLab API serves a paginated repository tree, blobs, and commits with diffs for history, through the guarded transport's provider profile. The exposure scan and the audit must produce exactly the findings that the GitHub fixture of identical bytes produces. The live harness must read back a file it wrote and the commit that added it.

**Green:**

- **Reader-backed capabilities:** audit, exposure scanning and access surface become Supported over a Provider-verified reader, and dependency audit reads its manifests through the same reader.
- **Recovery** gains ref restore under the mutation gateway; it previews only today.
- **Governance** enforces active policies on GitLab mutations; it only displays them today. A mutation blocked in the live harness proves it.
- **The other 18 Unavailable capabilities** stay Unavailable and are hidden (Task A7).

**Verify:** The unit and browser suites and a live GitLab run.

### Task A6: Promote Gitea's four, hide the rest

**Files:** As Task A5, for the Gitea implementation and harness.

**Red:** The live harness reads a recursive tree it created and compares it with the files it wrote. That evidence is Inferred today.

**Green:** `tree.read` becomes Provider-verified. Dependency audit reads through the reader. Governance enforces policies on Gitea mutations, and recovery gains ref restore, each proven live. Everything else is hidden.

**Verify:** The unit and browser suites and a live Gitea run.

### Task A7: The interface shows only what is Supported

**Files:**

- `public/capability-ui.js`;
- the capability seam in `public/app.js`;
- every `data-allow-experimental` attribute in `public/index.html`;
- the landing proof row in `public/index.html`;
- `public/workspace-pulse.js`;
- the server's capability projection;
- every `capabilityAccess(…, { allowExperimental: true })` in `server.js`;
- the registry contract;
- a new route-capability contract;
- a new browser spec.

**Red:**

- For GitHub, GitLab and Gitea fixtures, a browser test asserts that no element renders an Experimental or Unavailable label or badge, and that no control bound to a non-Supported feature exists in the accessibility tree.
- An API test asserts the server still returns its typed refusal for each such feature.
- A route-capability contract parses the `/api` route table and asserts three things:
  1. every route either names its capability or sits on a reviewed, capability-free list (health, version, configuration, sign-in);
  2. every registry key is named by at least one route;
  3. no route carries `allowExperimental`.

  It fails today on the 108 opt-ins, the two unguarded repository routes and the unenforced `branches.read`.

**Green:**

- The registry contract rejects Experimental for the `hosted-beta` deployment.
- The experimental opt-in path is removed from both the server and the interface.
- `/intelligence/events` and `/evidence` name their capability.
- Branch reads name `branches.read`.
- The LFS strategy is checked at the route.
- Controls for Unavailable features are never rendered.
- The workspace pulse and the landing copy describe only Supported capabilities and their evidence.
- The vocabulary stays in the server, where it drives fail-closed refusal.

Closes R13.

**Verify:** The new spec and contract, `npm run test:e2e` and `npm test`.

### Task A8: Qualify or remove the rendered site audit and YARA

**Files:** `src/rendered-site-*.js`, `src/routes/rendered-audit.js`, the hosted documents and interface, and the upload-security claims.

**Red:**

- On paid hosting (D3): a hosted test runs the rendered audit inside its OS sandbox under the instance's memory cap and timeout.
- Otherwise: a contract asserts that the `hosted-beta` profile neither mounts nor advertises it.

**Green:** The rendered audit either qualifies in G4 and becomes Supported, or leaves the hosted product. YARA leaves the hosted claim entirely; it stays an operator-only local option outside the beta claim, or is deleted. Closes R4.

**Verify:** The focused tests and `npm run docs:check`.

### Task A9: Deliver live events across instances, or bound the deployment to one

**Files:** `src/live-stream.js`, the event store, and `test/multi-instance-contract.test.js`.

**Red:** An event published on instance B reaches a subscriber on instance A within a bounded delay, in commit order, with no duplicate. A revocation on A stops delivery from B before the next event.

**Green:** Durable cursor catch-up, plus an optional `LISTEN`/`NOTIFY` wake-up on a direct connection, within the database's idle budget. If E3 keeps one instance, record that as the deployment's capacity bound instead. Closes R5.

**Verify:** `npm run test:multi-instance`.

### Task A10: Give each new domain its own route module

**Files:** `src/routes/identity.js`, `src/routes/billing.js`, `src/routes/ai-review.js`, a route-characterization test, and the mount points in `server.js`.

**Red:** Characterize the `/api` middleware order: authentication, CSRF/origin, rate limit, capability, then handler. A router mounted without one of them must fail the test, and a contract fails if `server.js` grows.

**Green:**

- New code lands only in route modules with injected stores.
- `DATABASE_URL` becomes unconditional for the `hosted-beta` profile, which closes R6.
- R9 is closed as a standing growth rule.

**Verify:** The characterization test, `npm test` and `npm run test:e2e`.

### Task A11: Make the running configuration match a reviewed source

**Files:** `render.yaml`, `src/hosted-readiness.js`, the `check:deployment` script, the operator runbook and the known limitations.

**Red:** `npm run check:deployment` against the live service fails today on two counts:

- it reads `/api/config` and compares the access mode and every hosted limit with the profile's reviewed values;
- it reports any mismatch by name, without values that could identify a tester.

**Green:**

- The owner chooses the beta limits, and `render.yaml` records them.
- The service is synced from the blueprint, either through Render's blueprint sync or by setting the same values through the Render API, with each value read back.
- Drift fails the deployment check.
- The published limitations quote the values the running service reports.

Closes R12.

**Verify:** `npm run check:deployment` against the live service, and the hosted-readiness tests.

## Phase B — Identity with Clerk

### Task B1: Record the identity decision

**Files:** `docs/architecture/ARCHITECTURE_DECISIONS.md`, `docs/architecture/ARCHITECTURE.md`, `docs/vision/FOUNDER_VISION.md`.

**Green:**

- **Clerk owns:** sign-in, sign-up, multi-factor and passkeys, account recovery, sessions and organizations.
- **The product keeps:** principals, workspaces, provider connections, sealed provider credentials, step-up and governance roles.
- **Clerk's social sign-in is never a source of repository tokens.**
- **Open choices:**
  - Step-up: map it to Clerk's reverification, or keep the existing step-up bound to the Clerk session.
  - The production domain (D6).
  - The alpha access retirement (D7).
- **Team workspaces** move from out of scope to committed for beta in the founder vision. Closes R11 for identity.

**Verify:** `npm run docs:check`.

### Task B2: Map a Clerk user to a principal

**Files:** `db/migrations/031_identity_accounts.sql`, which adds `nv_identity_accounts(issuer, subject, principal_id, created_at, revoked_at)` with a unique `(issuer, subject)`; a new identity store; tests. The existing `nv_login_identities` table is untouched.

**Red:**

- Two concurrent first requests for one Clerk user create exactly one principal.
- A revoked mapping is refused.

**Green:** An idempotent upsert keyed by `(issuer, subject)`, with the principal created in the same transaction.

**Verify:** The store test against PostgreSQL and `npm run test:migrations`.

### Task B3: Authenticate every API request with Clerk

**Files:** `src/routes/identity.js`, a new `src/clerk-auth.js`, the one-line mount, and real-server tests.

**Red:** Against a Clerk development instance, missing, expired, wrong-issuer, wrong-authorized-party and replayed tokens are each refused before any store or provider call. CSRF/origin checks still apply to cookie-authenticated writes, and `/healthz` stays unauthenticated.

**Green:**

- **Token verification:** `@clerk/express` `clerkMiddleware()`, with `authorizedParties` pinned to the canonical origin and networkless verification through `CLERK_JWT_KEY`.
- **Principal resolution:** `getAuth(req)` resolves the principal.
- **Provider credentials:** the existing sealed session becomes the envelope for provider credentials. It is bound to the principal and the Clerk session ID, and ends when the Clerk session ends.
- **Step-up:** follows B1's choice, with both refusal paths tested.

**Verify:** The focused tests, `npm test` and `npm run test:integration`.

### Task B4: Sign in and switch organizations in the unbundled client

**Files:** `public/index.html`, a new `public/identity-ui.js`, the CSP in the server's headers, and `public/vendor/clerk-js/<version>/` if it is vendored.

**Red:** Browser tests check that:

- a signed-out landing offers sign-in;
- sign-in lands in the workspace;
- switching organization purges the `nv_audit:`, `nv_recent:` and `nv_view:` prefixes and in-memory state, exactly as an account switch does today;
- a CSP report-only run records no violation.

**Green:** ClerkJS is loaded pinned and integrity-checked, and it mounts sign-in, sign-up, the user button and the organization switcher. The CSP allows only Clerk's Frontend API origin on the owner's domain and its bot-protection challenge origin.

**Verify:** The new specs and `npm run test:e2e`.

### Task B5: Make teams Clerk organizations

**Files:** `db/migrations/032_team_workspaces.sql`, which adds a workspace kind (personal or team) and a unique Clerk organization ID; the workspace stores; tests.

**Red:**

- A member removed from the organization loses the team workspace on their next request and keeps their personal one.
- An organization administrator cannot read another member's provider credentials.
- Shared triage and governance follow the workspace.

**Green:** Repository authority is still resolved from provider permissions. Organization roles decide only workspace membership and billing roles.

**Verify:** The store and real-server tests.

### Task B6: Handle Clerk webhooks

**Files:** The webhook handler in `src/routes/identity.js`, verified with Clerk's webhook verifier (Svix signatures) on the raw body.

**Red:** A bad signature, a stale timestamp, a replayed event ID, and a `user.updated` that arrives after `user.deleted` are each handled safely.

**Green:**

- `user.deleted` runs the existing account purge.
- A deleted organization membership revokes team access.
- An ended or revoked session closes its provider-credential envelope.

**Verify:** The focused tests against PostgreSQL.

### Task B7: Retire alpha access

**Files:** The invite CLI, the access and privacy stores' hosted wiring, the `NV_ALPHA_*` configuration, and their tests.

**Green:**

- The `hosted-beta` profile no longer reads invitation codes, the pepper or the terms version.
- The tables stay. Their remaining rows follow the published retention schedule, or are removed only by an owner-approved operation.
- If chosen, this closes R2 by removal.

**Verify:** `npm test` and `npm run test:migrations`.

### Task B8: Run the identity gate (G7)

**Evidence:**

- **In CI:** the Clerk development instance.
- **Against the candidate:** a production-instance smoke test covering:
  1. sign-up by invitation;
  2. multi-factor enrolment and sign-in;
  3. creating an organization, inviting a member and removing them;
  4. revoking a session;
  5. deleting the account, with the purge verified both in the product's database and in Clerk.

## Phase C — Billing with Stripe

### Task C1: Record plans and entitlements

**Files:** `docs/architecture/ARCHITECTURE_DECISIONS.md`.

**Green:**

- Stripe Checkout in subscription mode and the Customer Portal.
- The Stripe Tax decision.
- The plans per D4.
- Entitlements are the product's own rows, never read live from Stripe on a request path.

### Task C2: Add the billing schema

**Files:** `db/migrations/033_billing.sql`, with these tables:

- `nv_billing_customers(workspace_id, stripe_customer_id unique)`;
- `nv_subscriptions(stripe_subscription_id, workspace_id, status, price_id, current_period_end, cancel_at_period_end, source_event_id)`;
- `nv_entitlements(workspace_id, feature, quota, source, valid_until)`;
- `nv_usage_ledger(workspace_id, feature, quantity, idempotency_key unique, reported_at)`.

No card data is stored, ever.

**Verify:** `npm run test:migrations` and the store tests.

### Task C3: Build checkout and the billing portal

**Files:** `src/routes/billing.js` and its tests.

**Red:**

- A member without the billing role is refused.
- A price ID outside the server's allow-list is refused.
- A second checkout for a workspace that already has an active subscription is sent to the portal instead.
- The success page reads "pending" until the webhook confirms.

**Green:** Checkout Sessions and portal sessions are created server-side for the signed-in workspace only.

### Task C4: Handle Stripe webhooks

**Files:** `src/routes/billing.js`. The raw-body route is mounted before the global `express.json` (`server.js` parses JSON with a 30 MB limit).

**Red:**

- A signature failure.
- A replayed event.
- Out-of-order delivery.
- A deleted-then-updated sequence.
- A failure mid-processing, followed by Stripe's retry.

**Green:**

- Verify with `stripe.webhooks.constructEvent`, deduplicate by event ID, and re-read the subscription from Stripe so the result does not depend on event order.
- Handle these events:
  - `checkout.session.completed`;
  - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`;
  - `invoice.paid` and `invoice.payment_failed`;
  - `entitlements.active_entitlement_summary.updated`.

### Task C5: Put entitlements in the capability registry

**Files:** `src/capability-registry.js`, the registry configuration, the capability UI seam, and tests.

**Red:**

- A Free workspace calling a Pro route receives a typed refusal before transport.
- A downgrade at period end removes access at exactly that moment.
- A failed payment enters the owner-set grace window, then restricts.

**Green:** A capability is available only when provider, deployment and plan entitlement all allow it. The interface offers an upgrade only where the plan, not the provider, is the limit.

### Task C6: Meter AI usage

**Files:** The usage ledger store and a Stripe Billing Meter reporter.

**Red:**

- A review reported twice is metered once.
- A workspace at its monthly cap is refused before any model call.

**Green:** Usage is reported idempotently per review. Each plan includes credits, and the per-workspace cap is enforced locally.

### Task C7: Run the billing gate (G8)

**Evidence:** In CI, Stripe test mode with test clocks walks one subscription through every state, and each state must be reflected in entitlements:

1. trial;
2. paid;
3. renewal;
4. declined card;
5. dunning;
6. recovery;
7. cancellation at period end;
8. reactivation;
9. refund.

Against the candidate, a live-mode smoke test makes one real low-value charge and refunds it.

## Phase D — AI review

### Task D1: Record the scope decision and threat model

**Files:** `docs/architecture/ARCHITECTURE_DECISIONS.md` and `docs/vision/FOUNDER_VISION.md`.

**Green:** Paid AI moves from out of scope to an opt-in beta layer that is never an authority. The threat model covers:

- prompt injection from repository content, such as a comment telling the model a finding is safe;
- exfiltration of repository content;
- cost abuse;
- the model refusing security content.

Closes R11 for AI review.

### Task D2: Define the review contract

**Files:** A new `src/ai-review.js` contract module, its JSON schema, and tests.

**Input:** one deterministic finding (rule, severity, CWE and trace path), plus the bounded excerpts Uranus already selected: source, sink and guard lines with a fixed window. The excerpts are redacted by the Exposure detectors before they leave, and whole files never leave.

**Output:** A structured output (`output_config.format`) with these fields:

- **verdict:** one of `agrees`, `likely-false-positive` or `needs-human`;
- **confidence band;**
- **decisive-fact ID**, from a fixed list;
- **fix class**, from a fixed list;
- **short rationale**, shown live only.

**What is persisted:** the verdict, confidence band, fact ID, fix class, model ID, effort, token counts and cost. Never the excerpt, the prompt or the rationale text.

**Injection defence:** repository content is wrapped as data, and the system prompt states that any instruction inside it is content under review.

**Red:**

- A corpus of injected comments must not flip any verdict.
- An excerpt containing a credential-shaped string must leave the process redacted.

### Task D3: Build the client

**Files:** `src/ai-review.js`, the guarded-transport `ai-review` profile, and tests with recorded responses.

**Green:**

- **SDK and egress:** `@anthropic-ai/sdk`, given the guarded fetch.
- **Model and effort:** `claude-opus-5-5`, with effort set explicitly per route:
  - `low` for explanation;
  - `medium` for triage;
  - `high` for pull-request review.
- **Prompt caching:** the frozen system prompt and rule catalogue carry `cache_control`.
- **Cost pre-flight:** `count_tokens` is checked against the workspace cap before every request.
- **Streaming:** used for long pull-request reviews.
- **Stop reason first:** `stop_reason` is checked before any content is read. A `refusal`, which security content can trigger, is recorded as "AI review unavailable" and never as a verdict. Server-side fallback is enabled with `fallbacks: "default"` and the `server-side-fallback-2026-07-01` beta header.
- **Errors:** typed SDK errors are mapped to retryable and non-retryable outcomes.

**Red:** Recorded refusal, `max_tokens`, malformed-output and rate-limit responses each produce their documented outcome, and none produces a verdict.

### Task D4: Ship the features

**Files:** `src/routes/ai-review.js`, the audit and exposure interfaces, Safe Passage, and the governed provider-comment path.

**Green:**

- **Lead triage:** for findings marked "to confirm", the model suggests which decisive fact holds. A person confirms through the existing `code-audit.finding.triage` action.
- **Pull-request review:** Uranus runs on the diff and the model writes a summary, posted as a governed provider comment. It is opt-in per repository.
- **Fix proposals:** delivered through Safe Passage as a branch and a pull request, never as a direct write. A person merges under governance.
- **Explanations:** a plain-language explanation of a finding.
- **Scheduled re-review:** open findings are re-reviewed on a schedule through the Message Batches API.

**Red:** No AI path can change a grade, a waiver, a merge gate or repository content without a governed human action.

### Task D5: Evaluate AI review (G9)

**Files:** An eval corpus built from the Uranus benchmark's 138 cases, plus labelled false positives and prompt-injection cases, and a script that runs it.

**Gate:**

- Zero true positives may move to `likely-false-positive`.
- Agreement and false-positive identification are recorded per model and effort.
- CI replays recorded responses with no live spend.
- A live evaluation runs once per candidate, within an owner-set budget.

### Task D6: Disclose and control

**Green:**

- **Opt-in:** each workspace opts in, with a plain statement of what leaves.
- **Subprocessor:** a subprocessor entry for Anthropic.
- **Budget and kill switch:** a per-workspace monthly budget and a kill switch.
- **Labelling:** AI output is always labelled and kept apart from deterministic evidence.
- **No effect without a person:** grades and merge gates ignore AI verdicts until a person triages.

## Phase E — A platform for paying users

### Task E1: Make jobs durable

**Green:** Audit, exposure and AI jobs move to a PostgreSQL job table with fenced leases, the same pattern as webhook delivery. They survive a restart, and the per-identity limits stay unchanged.

**Red:** Kill the process mid-job; the job resumes exactly once.

### Task E2: Observe without content

**Green:**

- Structured logs with correlation IDs and no secrets or repository content.
- Error reporting through a scrubbed vendor, which the owner picks.
- Uptime checks on `/readyz` and a status page.
- Alerts for a webhook backlog, failed Stripe events and AI spend.

### Task E3: Hosting and domain

**Green:**

- The owner decides D3. A first request after idle exceeded 30 seconds on 6 October; on the free plan, that delay is what a paying customer's first click would meet.
- The custom domain and TLS go live.
- The frozen candidate is redeployed with the `hosted-beta` profile and the database required.
- `npm run check:deployment` passes against it, which closes R8.

### Task E4: Back up and restore

**Green:**

- Either Neon point-in-time restore on a paid plan, or the existing encrypted backup. The free project keeps 6 hours of history today.
- A dedicated restore-target branch is created for the hosted gate. One restore drill runs per candidate and feeds G4.
- The leftover `recovery-pr53-before-028-20260925` branch is deleted only with the owner's explicit approval, once migrations `028`–`030` are proven by a restore drill.

Closes R16.

### Task E5: Legal and trust

**Green:**

- Terms, Privacy and a data-processing agreement.
- A subprocessor list: Clerk, Stripe, Anthropic, Render and Neon.
- A refund policy.
- `/.well-known/security.txt`, served from `NV_SECURITY_CONTACT`.
- A retention schedule that covers billing records: invoices are kept as the law requires, and everything else is purged.

### Task E6: Delete an account across vendors

**Red:** One test per vendor proves that purge:

- deletes the Clerk user;
- cancels the Stripe customer and anonymizes it, keeping invoices where the law requires;
- leaves no AI data behind.

### Task E7: Support and incidents

**Green:**

- Runbooks for Clerk, Stripe and Anthropic outages.
- A support route.
- A stop-sale procedure.

## Phase F — The beta qualification lineage

### Task F1: Rename the lineage and set the version

**Green:**

- **Renames:**
  - `public-alpha-alpha17.yml` becomes `public-beta-qualification.yml`;
  - the `nvx-alpha17-` prefix becomes `nvx-beta-`;
  - `ci/*alpha17*` becomes `ci/*beta*`;
  - artifact names and contracts follow.
- **Continuity:** the continuity schema moves to version 6, with gates G1–G9. A frozen candidate's `automated` result and archive hash are recorded in it, so the generated state follows the code instead of a baseline left behind. Closes R14.
- **Spend ledger:** the approval spend ledger moves from the CI cache to a durable store, which closes R7.
- **Version:** `1.0.0-beta.1` (D1), with its architecture decision. Closes R10.

### Task F2: Make the documents tell the beta truth

**Green:**

- The generated state, roadmap, release gates, provider capabilities and known limitations are rewritten for beta.
- The alpha documents move byte-for-byte under `docs/history/`, bound by the historical integrity baseline.

### Task F3: Pass G1 and G2

**Green:** Automated exact-archive qualification and an independent review, both on the frozen candidate.

### Task F4: Pass G3

**Green:** The live-provider gate for GitHub, GitLab and Gitea, including Task A4's create, delete and notification steps.

### Task F5: Pass G4

**Green:** The hosted gate: cold start, scale-to-zero wake, load, restore, rollback, the live-events webhook from Task A4, and tester purge.

### Task F6: Pass G5

**Green:** A written script covers sign-in, the workspace, audit, exposure, billing and AI review. One VoiceOver iOS pass and one desktop screen-reader pass (NVDA or VoiceOver for macOS) are run against it and recorded.

### Task F7: Bind G7, G8 and G9

**Green:** Tasks B8, C7 and D5 are re-run on the same frozen candidate.

### Task F8: Pass G6

**Green:** The final go/no-go and the signed decision, then the beta cohort opens per its checklist.

## Sequence

| Order | Work | Waits on |
| --- | --- | --- |
| 1 | A1–A3, A7 (registry and route-capability contracts, interface), A10, A11 | The owner applying A1 and choosing the limits in A11 |
| 2 | A4, A5, A6 | Sandbox targets and credentials |
| 3 | B1–B7 | Clerk accounts, the domain (D6), D7 |
| 4 | C1–C6 | Phase B (a customer belongs to a Clerk-backed workspace), D4 |
| 5 | D1–D6 | D5. The client and evaluation (D2, D3, D5) can start behind a disabled flag during step 4; customers see AI review only after C6 meters it |
| 6 | E1–E7, A8, A9 | D3 decided before the first live payment |
| 7 | F1–F8 | Everything above. Each new candidate restarts at G1 |

Each task lands as its own pull request. A pull request merges only when every check on its head has passed.

## Out of scope for 1.0.0-beta.1

- Bitbucket or any other new provider.
- GitLab or Gitea capabilities beyond D2. Each returns later with its own live evidence.
- Customer-controlled evidence retention (roadmap Phase 5).
- Autonomous AI action: the model never writes, merges, closes, waives or changes a grade.
- Self-hosted or on-premise distribution, and native mobile apps.

Technical basis:

- **Clerk:** the [Express SDK reference](https://clerk.com/docs/reference/express/overview) for `clerkMiddleware()`, `getAuth()`, `authorizedParties` and networkless verification.
- **Stripe:**
  - [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks);
  - [Checkout](https://docs.stripe.com/payments/checkout) and the [Customer Portal](https://docs.stripe.com/customer-management);
  - [entitlements](https://docs.stripe.com/billing/entitlements);
  - [usage-based billing meters](https://docs.stripe.com/billing/subscriptions/usage-based);
  - [test clocks](https://docs.stripe.com/billing/testing/test-clocks).
- **Anthropic:** the [Claude API documentation](https://platform.claude.com/docs) for structured outputs, prompt caching, message batches, token counting and refusal handling.

These sources support the design. They are not a claim that the planned implementation already passes.
