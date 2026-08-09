# Nebulaverse-X Controlled Hosted Public Alpha Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and qualify `Nebulaverse-X 5.3.0-alpha.17.0` as a safe invitation-only hosted alpha for 5–10 testers without modifying the qualified `alpha.16.3` predecessor or its Task 21 evidence.

**Architecture:** Work proceeds through six independently reviewable plans. Each plan starts from the accepted checkpoint of the preceding plan, uses test-driven changes, and ends with a local checkpoint and review gate. Remote branches, pull requests, provider mutations, Render deploys, Neon mutations, and secret-bearing validation remain separately authorized operations.

**Tech Stack:** Node.js 22, CommonJS, Express 4, PostgreSQL/Neon via `pg`, browser JavaScript, Playwright, Render Free, deterministic ZIP packaging, GitHub Actions.

## Global Constraints

- Qualified predecessor archive: `Nebulaverse-X-v5.3.0-alpha.16.3.zip`.
- Qualified predecessor SHA-256: `330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892`.
- Qualified publication/validation commit: `c19389f8b25cb67caad6fd56d000ca130ef8520f`.
- Final predecessor Push run: `30464094438`.
- Final predecessor pull-request run: `30464096155`.
- Target successor version: `5.3.0-alpha.17.0`.
- Suggested isolated branch: `public-alpha/alpha17-readiness`.
- Preserve `main`, alpha.16.1, alpha.16.2, alpha.16.3 and PRs #1–#3 unchanged, draft, open and unmerged.
- The predecessor archive is an immutable provenance input; never rebuild, rename or edit it.
- No remote write, deployment, secret-bearing provider test or database mutation is authorized by this plan.
- Controlled cohort: 5–10 invited testers for two weeks.
- Hosted stack: one dedicated Render Free service and one dedicated Neon Free project.
- GitHub is the full golden-path provider; GitLab and Gitea expose only release-qualified subsets.
- Sandbox/test repositories only; exact canonical repository allowlists are mandatory.
- Every visible feature is `Supported`, explicitly `Experimental`, or disabled as `Unavailable`.
- No known critical/high credential, access-boundary, evidence-integrity, cleanup, dependency, data-loss or accessibility defect may remain.
- Node.js `22.x` and an exact committed lockfile are mandatory.
- AI remains optional and outside the public-alpha golden path.
- Phase 2 and later feature work remains out of scope.

---

## Inputs and authoritative documents

- Approved design: `docs/superpowers/specs/2026-07-29-controlled-hosted-public-alpha-design.md`
- External Task 21 closeout: `Nebulaverse-X-v5.3.0-alpha.16.3-Task21-Closeout.md`
- Historical ADR ledger: `ARCHITECTURE_DECISIONS.md`
- Historical Phase 1 reports and Task 20/21 evidence remain immutable evidence, not current-state documentation.

## Plan order and review gates

| Order | Plan | Independent outcome | Review gate |
| ---: | --- | --- | --- |
| 1 | `2026-07-29-public-alpha-01-truth-successor-foundation.md` | Exact predecessor provenance, versioned successor, canonical documentation and server-owned provider capability model | Version/provenance, documentation truth and capability enforcement tests all pass |
| 2 | `2026-07-29-public-alpha-02-controlled-access.md` | One-time invites, alpha sessions, exact repository allowlists, abuse limits and operator CLI | Invite replay/expiry/revocation/enumeration and allowlist-bypass tests all pass |
| 3 | `2026-07-29-public-alpha-03-privacy-credential-lifecycle.md` | Provider disconnect, webhook cleanup, tester purge, retention, privacy-safe support and feedback | Credential-removal, cleanup, retention and deletion reports are proven |
| 4 | `2026-07-29-public-alpha-04-ux-accessibility.md` | Five-minute golden path, capability-aware states, safe errors and accessibility qualification | Desktop/mobile/keyboard/axe suites pass; manual checks are ready for evidence |
| 5 | `2026-07-29-public-alpha-05-hosted-operations.md` | Dedicated Render/Neon configuration, readiness, backup/restore, rollback and runbooks | Configuration, backup-format, restore rehearsal and smoke gates pass |
| 6 | `2026-07-29-public-alpha-06-qualification-release.md` | Automated, provider-live and hosted qualification; deterministic frozen successor archive | Every go criterion has release-bound evidence and every no-go condition is absent |

Do not combine plans 2–5 into one implementation batch. A reviewer must be able to accept or reject access control, privacy, UX and hosted operations independently.

## Checkpoint naming

Use local checkpoint labels without claiming release qualification:

| After plan | Local label |
| --- | --- |
| Plan 1 | `5.3.0-alpha.17.0-foundation` |
| Plan 2 | `5.3.0-alpha.17.0-access` |
| Plan 3 | `5.3.0-alpha.17.0-privacy` |
| Plan 4 | `5.3.0-alpha.17.0-ux` |
| Plan 5 | `5.3.0-alpha.17.0-hosted-rc` |
| Plan 6 | `5.3.0-alpha.17.0` only after all evidence passes |

These are review labels, not additional package versions. `package.json` remains `5.3.0-alpha.17.0` throughout successor work.

## Execution protocol

### Task 1: Create the isolated local successor root

**Files:**
- Input: `Nebulaverse-X-v5.3.0-alpha.16.3.zip`
- Create: isolated successor working tree selected by the execution environment
- Create: `PUBLIC_ALPHA_PROVENANCE.json` in Plan 1

**Interfaces:**
- Consumes: exact predecessor SHA-256 from Global Constraints.
- Produces: a clean extracted source tree whose only initial difference is the new provenance/version work described in Plan 1.

- [ ] **Step 1: Verify the predecessor before extraction**

Run:

```bash
sha256sum Nebulaverse-X-v5.3.0-alpha.16.3.zip
```

Expected:

```text
330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892  Nebulaverse-X-v5.3.0-alpha.16.3.zip
```

- [ ] **Step 2: Extract into a newly created isolated directory**

Run:

```bash
mkdir Nebulaverse-X-v5.3.0-alpha.17.0-work
unzip -q Nebulaverse-X-v5.3.0-alpha.16.3.zip -d Nebulaverse-X-v5.3.0-alpha.17.0-work
```

Expected: one archive root named `Nebulaverse-X-v5.3.0-alpha.16.3`.

- [ ] **Step 3: Move only the extracted root to the successor source name**

Run:

```bash
mv Nebulaverse-X-v5.3.0-alpha.17.0-work/Nebulaverse-X-v5.3.0-alpha.16.3 Nebulaverse-X-v5.3.0-alpha.17.0-work/Nebulaverse-X-v5.3.0-alpha.17.0
```

Expected: the immutable input ZIP remains outside the successor source root.

- [ ] **Step 4: Record a clean baseline inventory**

Run from the successor source root:

```bash
find . -type f -print0 | sort -z | xargs -0 sha256sum > ../alpha16.3-extracted-files.sha256
```

Expected: the inventory is an external working record and is not packaged.

### Task 2: Execute each plan with its own review

**Files:**
- Read: all six ordered plan documents listed above
- Modify: only files listed by the active plan

**Interfaces:**
- Consumes: previous plan's reviewed working tree.
- Produces: one independently testable checkpoint.

- [ ] **Step 1: Execute Plan 1**

Run its focused tests, then:

```bash
npm run check:syntax
npm test
```

Expected: PASS and a reviewer-approved truth/foundation checkpoint.

- [ ] **Step 2: Execute Plan 2**

Run its focused tests, then:

```bash
npm run check:syntax
npm test
```

Expected: PASS and a reviewer-approved access checkpoint.

- [ ] **Step 3: Execute Plan 3**

Run its focused tests, then:

```bash
npm run check:syntax
npm test
```

Expected: PASS and a reviewer-approved privacy checkpoint.

- [ ] **Step 4: Execute Plan 4**

Run:

```bash
npm run check:syntax
npm test
npm run test:e2e
```

Expected: PASS and a reviewer-approved UX/accessibility checkpoint.

- [ ] **Step 5: Execute Plan 5**

Run its focused operations tests and a restore rehearsal against an isolated database branch only after explicit authorization.

Expected: configuration and local script tests pass before any hosted change.

- [ ] **Step 6: Execute Plan 6**

Do not start secret-bearing or hosted steps without fresh explicit authorization. Freeze the final archive only after every automated, manual, provider-live and hosted gate is bound to the same release subject.

### Task 3: Preserve evidence separation

**Files:**
- Modify: `PROJECT_STATE.md`
- Create: `EVIDENCE_INDEX.md`
- Create: `staging/PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json` in Plan 6

**Interfaces:**
- Consumes: Task 20/21 predecessor evidence and new alpha.17 evidence.
- Produces: explicit applicability statements that never rewrite historical outcomes.

- [ ] **Step 1: Keep predecessor evidence immutable**

Verify:

```bash
sha256sum Nebulaverse-X-v5.3.0-alpha.16.3.zip
```

Expected: the exact predecessor digest from Global Constraints.

- [ ] **Step 2: Bind successor evidence only to successor bytes**

Every successor evidence record is constructed from runtime-bound values:

```js
const evidenceSubject = {
  product: 'Nebulaverse-X',
  version: '5.3.0-alpha.17.0',
  subjectSha256: process.env.NV_PUBLIC_ALPHA_SUBJECT_SHA256,
  sourceCommit: process.env.NV_PUBLIC_ALPHA_SOURCE_COMMIT,
  nodeVersion: process.version,
  latestMigration: '015_alpha_privacy',
  cleanupVerified: true
};
```

The verifier rejects missing environment bindings, a non-Node-22 runtime, or a subject/source value that does not match the frozen execution inputs.

- [ ] **Step 3: Reject evidence inheritance**

Add a qualification assertion that fails when any `alpha.16.3` archive hash is used as an `alpha.17.0` evidence subject.

Expected error code:

```text
PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH
```

## Final go/no-go authority

The release remains closed until Plan 6 proves all design Section 11 go criteria. A green credential-free matrix alone is insufficient. A live provider run alone is insufficient. A successful Render deploy alone is insufficient.

Any of the following immediately returns the programme to the relevant earlier plan:

- invite or repository-allowlist bypass → Plan 2;
- credential, webhook cleanup, retention or deletion defect → Plan 3;
- capability misrepresentation, inaccessible golden path or unsafe error state → Plan 4;
- backup, restore, migration, capacity or rollback defect → Plan 5;
- evidence binding, deterministic packaging or live qualification defect → Plan 6.

## Approved specification traceability

| Design requirement | Implemented by |
| --- | --- |
| Immutable alpha.16.3 provenance and isolated alpha.17 successor | Plan 1 Tasks 1 and 5; Plan 6 Tasks 8–10 |
| Six bounded readiness workstreams and later-phase exclusions | Master sequence; Plans 1–6 Global Constraints |
| Independent invitation and provider authorization layers | Plan 2 Tasks 1–5 |
| One-time digest-only invites, expiry, inactivity, revocation and abuse lockout | Plan 2 Tasks 2–6 |
| Exact canonical sandbox-repository allowlists | Plan 2 Tasks 2 and 5 |
| Server-owned provider/deployment capability truth | Plan 1 Tasks 2–3; Plan 4 Task 3 |
| Supported/Experimental/Unavailable and evidence-state vocabularies | Plan 1 Task 2; Plan 4 Tasks 3–4 |
| Five-minute tester golden path and complete UI state matrix | Plan 4 Tasks 2–5 |
| Safe correlated error contract | Plan 4 Tasks 1 and 4 |
| Credential disconnect, provider revocation guidance and webhook cleanup | Plan 3 Tasks 3–5 |
| Retention, purge, feedback privacy and cohort close | Plan 3 Tasks 1–2 and 4–7 |
| Render Free/Neon Free bounds and dedicated environment | Plan 5 Tasks 1–2 and 6 |
| Encrypted backup, isolated restore, migration safety and rollback | Plan 5 Tasks 3–4 and 7–8; Plan 6 Tasks 4 and 9 |
| Canonical documentation consolidation and accurate roadmap | Plan 1 Task 4 |
| Node 22 automated/security/dependency/browser gates | Plan 6 Tasks 1, 5 and 7–8 |
| WCAG 2.2 AA-targeted automated and manual qualification | Plan 4 Task 6; Plan 6 Task 6 |
| Release-bound live GitHub/GitLab/Gitea capability evidence | Plan 6 Tasks 3, 5 and 9 |
| Hosted cold-start, load, restart, interruption, rollback and purge evidence | Plan 5 Task 5; Plan 6 Tasks 4 and 9 |
| Exact go/no-go, deterministic archive and external closeout | Plan 6 Tasks 8–10 |
| 5–10 tester, two-week controlled cohort operation | Master sequence; Plan 6 Tasks 6 and 10 |

## Completion handoff

When all six plans are complete, hand back:

1. frozen `Nebulaverse-X-v5.3.0-alpha.17.0.zip`;
2. checksum sidecar;
3. public-alpha qualification record;
4. provider capability evidence matrix;
5. hosted qualification record;
6. backup/restore rehearsal record without secrets;
7. known minor limitations;
8. cohort operator checklist;
9. immutable source commit and draft PR references;
10. explicit confirmation that earlier branches, PRs and `main` did not move.
