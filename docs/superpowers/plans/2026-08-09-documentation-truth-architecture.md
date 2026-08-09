# Nebulaverse-X Documentation Truth Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed, stale root-document collection with a lifecycle-enforced documentation architecture whose current state and continuation prompt are deterministically generated from `WORK_CONTINUITY.json` before a successor archive can qualify.

**Architecture:** `WORK_CONTINUITY.json` is the sole authored operational-state source. `src/work-continuity.js` validates schema version 3 and renders the two generated current-state documents; `scripts/generate-continuity-docs.js` writes or checks those views. A complete `docs/DOCUMENTATION_MANIFEST.json` and repository-level validator enforce physical lifecycle separation, link integrity, historical immutability, approved-plan hashes, and the root allowlist.

**Tech Stack:** Node.js `22.23.1`, CommonJS, built-in `assert`/`fs`/`path`/`crypto`, Git path migration, deterministic ZIP packaging, existing program-matrix and Playwright qualification.

## Global Constraints

- Work only on `docs/alpha17-documentation-truth`, forked from local specification commit `5f924184748957494007c2fc43a8c63a024bf734`.
- Preserve the qualified input identity: commit `4aa3c378475dd7fdb490b206e0ca3cb88d027bbf`, tree `29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb`, archive SHA-256 `d3e86f3aa16faefc165dca8acd726ca22f8a8f10fd5c943ef3addddbab40d2cc`.
- Keep `main`, `sandbox/alpha17-live-qualification`, draft PR #1, live-provider jobs, Render, and Neon unchanged during local implementation.
- Root documentation/state entry points are exactly `README.md`, `CHANGELOG.md`, and `WORK_CONTINUITY.json`; only the first two are Markdown.
- Historical reports and specifications retain their bytes except `PHASE_1_ROADMAP.md`, whose Task 21 status is corrected before relocation.
- Current successor identity is external qualification evidence; no file inside the candidate may claim the successor archive hash or successful successor qualification.
- Imported approved plans must retain the three SHA-256 values in the specification.
- Every behavior-changing slice follows observed RED, minimal GREEN, regression verification, and a focused commit.
- Use the exact Node runtime by prepending `/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin` to `PATH`.

---

### Task 1: Enforce the physical documentation lifecycle

**Files:**
- Create: `test/documentation-architecture.test.js`
- Create: `docs/DOCUMENTATION_MANIFEST.json`
- Create: `docs/README.md`
- Move: current, vision, architecture, release, operations, qualification, reference, history, runbook, accessibility, report, specification, and upgrade Markdown files to the exact destinations in the approved design
- Import: `docs/history/public-alpha/approved-plans/2026-07-29-controlled-hosted-public-alpha-design.md`
- Import: `docs/history/public-alpha/approved-plans/2026-07-29-public-alpha-03-privacy-credential-lifecycle.md`
- Import: `docs/history/public-alpha/approved-plans/2026-07-29-public-alpha-master-sequence.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the exact migration table and plan hashes from `docs/superpowers/specs/2026-08-09-documentation-truth-architecture-design.md`.
- Produces: one manifest entry per repository Markdown file with `{ path, lifecycle, authority, releaseIncluded, immutableHistory }` and a validator program included in `test:unit`.

- [ ] **Step 1: Write the failing architecture validator**

Create a real repository-artifact test with these fixed contracts:

```js
const ROOT_MARKDOWN = ['CHANGELOG.md', 'README.md'];
const LIFECYCLES = new Set([
  'entrypoint', 'current', 'vision', 'architecture', 'operational',
  'qualification', 'historical', 'development-record'
]);

assert.deepStrictEqual(discoverMarkdown(root).filter(file => !file.includes('/')).sort(), ROOT_MARKDOWN);
assert.deepStrictEqual([...manifestPaths].sort(), discoverMarkdown(root).sort());
assert.strictEqual(manifestPaths.size, manifest.documents.length);
for (const record of manifest.documents) {
  assert(LIFECYCLES.has(record.lifecycle), `unknown lifecycle ${record.lifecycle}`);
  assert(fs.existsSync(path.join(root, record.path)), `missing documented path ${record.path}`);
  assert.strictEqual(record.immutableHistory, record.lifecycle === 'historical');
}
```

The same test must reject a current path classified as historical or a history path classified as current and hash the three approved imported plans. Link resolution, README navigation, and stale-current-content checks are added after content correction in Tasks 3 and 4 so this migration slice can finish with a meaningful green signal.

- [ ] **Step 2: Run the validator and observe RED**

Run:

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/documentation-architecture.test.js
```

Expected: failure because root Markdown exceeds the exact allowlist and `docs/DOCUMENTATION_MANIFEST.json` does not exist.

- [ ] **Step 3: Perform the exact path migration**

Use mechanical `git mv` operations for the classes below:

```bash
git mv PROJECT_STATE.md ROADMAP.md CONTINUATION_PROMPT.md PROVIDER_CAPABILITIES.md docs/current/
git mv PRODUCT_VISION.md UX_VISION.md docs/vision/
git mv ARCHITECTURE.md ARCHITECTURE_DECISIONS.md docs/architecture/
git mv PUBLIC_ALPHA.md RELEASE_SECURITY_GATES.md EVIDENCE_INDEX.md docs/release/
git mv BUILD_REPORT.md docs/release/QUALIFICATION_BASELINE.md
git mv DEPLOY_RENDER_NEON.md SECURITY_DEPLOYMENT.md docs/operations/
git mv docs/runbooks docs/operations/runbooks
git mv docs/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md docs/qualification/accessibility/
git mv NEURAL_COMMAND_CENTER.md docs/reference/
git mv PHASE_0_COVERAGE.md docs/history/phase-0/
git mv PHASE_1_ROADMAP.md docs/history/phase-1/ROADMAP.md
git mv PHASE_1_TASK_*_REPORT.md docs/history/phase-1/reports/
git mv TASK_*_SPEC.md docs/history/phase-1/specifications/
git mv UPGRADE_FROM_V5_2_1.md docs/history/upgrades/
```

Copy the three approved handoff plan inputs byte-for-byte from `/workspace/scratch/777d9b79cd5c/Nebulaverse-X-v5.3.0-alpha.17.0-Plan3-Continuity-Handoff/plans/` to `docs/history/public-alpha/approved-plans/`, then verify their hashes against the specification.

- [ ] **Step 4: Add the manifest and documentation index**

Create a manifest record for every discovered Markdown path. Assign root navigation to `entrypoint`, `docs/current/*` and `docs/reference/*` to `current`, `docs/vision/*` to `vision`, `docs/architecture/*` to `architecture`, `docs/operations/*` to `operational`, `docs/qualification/*` and `docs/release/*` to `qualification`, `docs/history/*` to `historical`, and `docs/superpowers/*` to `development-record`. `docs/README.md` is `entrypoint`.

Create `docs/README.md` as the lifecycle navigation page with links to current state, vision, architecture, release, operations, qualification, history, and development records; state that historical documents are evidence rather than current instructions.

- [ ] **Step 5: Register and run the validator**

Add `node test/documentation-architecture.test.js` immediately after `node test/public-alpha-documentation.test.js` in `test:unit`.

Run:

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/documentation-architecture.test.js
```

Expected: the physical-layout, manifest-coverage, approved-plan-hash, and lifecycle checks pass.

- [ ] **Step 6: Commit the independently reviewable migration**

```bash
git add package.json docs test/documentation-architecture.test.js
git commit -m "docs: enforce documentation lifecycle structure"
```

### Task 2: Make continuity machine-authored and generated

**Files:**
- Create: `src/work-continuity.js`
- Create: `scripts/generate-continuity-docs.js`
- Create: `test/continuity-generation.test.js`
- Modify: `WORK_CONTINUITY.json`
- Modify: `scripts/resume-work.js`
- Replace generated output: `docs/current/PROJECT_STATE.md`
- Replace generated output: `docs/current/CONTINUATION_PROMPT.md`
- Modify: `test/work-continuity.test.js`
- Modify: `test/continuity-contract.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateContinuity(value)`, `readContinuity(file)`, `renderProjectState(state)`, `renderContinuationPrompt(state)`, and `generatedDocuments(state)` from `src/work-continuity.js`.
- Produces: `scripts/generate-continuity-docs.js --check` with exit 0 only when both tracked views match deterministic rendering.
- Consumes: schema version 3 state and package version `5.3.0-alpha.17.0`.

- [ ] **Step 1: Write schema and generation tests first**

The failing test must independently assert:

```js
assert.strictEqual(state.schemaVersion, 3);
assert.strictEqual(state.version, pkg.version);
assert.strictEqual(state.acceptedTree, '29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb');
assert.deepStrictEqual(Object.fromEntries(Object.entries(state.gates).map(([name, gate]) => [name, gate.status])), {
  automated: 'passed',
  liveProvider: 'pending',
  hosted: 'pending',
  manualAccessibility: 'pending',
  finalRelease: 'pending'
});
assert.strictEqual(renderProjectState(state), fs.readFileSync(projectStatePath, 'utf8'));
assert.strictEqual(renderContinuationPrompt(state), fs.readFileSync(promptPath, 'utf8'));
```

It must mutate each required field to prove validation fails, render twice to prove byte equality, run `--check` after a one-byte temporary drift to prove non-zero exit, and exercise a copied archive fixture without `.git` through `scripts/resume-work.js`.

- [ ] **Step 2: Observe RED**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/continuity-generation.test.js
```

Expected: failure because `src/work-continuity.js` and schema version 3 do not exist.

- [ ] **Step 3: Implement schema version 3 and pure rendering**

Implement validation with exact required keys and fail-closed status values. Record `4aa3c378475dd7fdb490b206e0ca3cb88d027bbf` / `29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb` / `d3e86f3aa16faefc165dca8acd726ca22f8a8f10fd5c943ef3addddbab40d2cc` as `recordedBaseline`; store green run IDs `31322778221` and `31322778223`; preserve the known failed-run records; declare the current successor unqualified and its identity external.

The renderer output must include a generated-file warning, last immutable baseline, separate gate table, limitations, exact next authorized action, canonical read order, and public-alpha `NO-GO`. It must not include a current successor commit, tree, or archive hash.

- [ ] **Step 4: Implement write/check CLI and reuse validation in resume**

```js
const check = process.argv.slice(2).includes('--check');
const outputs = generatedDocuments(readContinuity(statePath));
for (const [relative, content] of Object.entries(outputs)) {
  if (check && fs.readFileSync(path.join(root, relative), 'utf8') !== content) {
    throw new Error(`Generated continuity document is stale: ${relative}`);
  }
  if (!check) fs.writeFileSync(path.join(root, relative), content, 'utf8');
}
```

Keep `resume-work.js` source-control probing and accepted-ancestor-tree behavior, but replace its schema-2 constants and duplicated validation with `readContinuity`.

- [ ] **Step 5: Generate views and reach GREEN**

Add scripts:

```json
"docs:generate": "node scripts/generate-continuity-docs.js",
"docs:check": "node scripts/generate-continuity-docs.js --check"
```

Add `node test/continuity-generation.test.js` after `node test/continuity-contract.test.js` in `test:unit`, and add both new JavaScript files to `check:syntax` and `scripts/verify.js` required paths.

Run:

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run docs:generate
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/continuity-generation.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/work-continuity.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/continuity-contract.test.js
```

- [ ] **Step 6: Commit generated-continuity behavior**

```bash
git add WORK_CONTINUITY.json package.json src/work-continuity.js scripts/generate-continuity-docs.js scripts/resume-work.js scripts/verify.js test/continuity-generation.test.js test/work-continuity.test.js test/continuity-contract.test.js docs/current/PROJECT_STATE.md docs/current/CONTINUATION_PROMPT.md
git commit -m "feat: generate continuity from machine state"
```

### Task 3: Recover founder vision and close current release truth

**Files:**
- Create: `docs/vision/FOUNDER_VISION.md`
- Modify: `docs/vision/PRODUCT_VISION.md`
- Modify: `docs/vision/UX_VISION.md`
- Modify: `docs/current/ROADMAP.md`
- Modify: `docs/current/PROVIDER_CAPABILITIES.md`
- Modify: `docs/release/PUBLIC_ALPHA.md`
- Modify: `docs/release/RELEASE_SECURITY_GATES.md`
- Modify: `docs/release/QUALIFICATION_BASELINE.md`
- Modify: `docs/release/EVIDENCE_INDEX.md`
- Modify: `docs/history/phase-1/ROADMAP.md`
- Modify: `docs/operations/DEPLOY_RENDER_NEON.md`
- Modify: `docs/operations/SECURITY_DEPLOYMENT.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/DOCUMENTATION_MANIFEST.json`
- Modify: `test/public-alpha-documentation.test.js`
- Modify: `test/governance-enforcement-deployment-contract.test.js`

**Interfaces:**
- Consumes: generated current status from Task 2 and capability truth from `config/public-alpha-capabilities.json`.
- Produces: founder intent whose every capability is visibly labelled `Implemented`, `Committed roadmap`, `Exploratory`, or `Out of current scope` without serving as release evidence.

- [ ] **Step 1: Make release-truth assertions RED**

Update `test/public-alpha-documentation.test.js` to use relocated paths and require the recorded automated baseline, public-alpha `NO-GO`, five separated gate states, and absence of alpha.16.3 execution instructions from current/release/operational lifecycles. Update the deployment contract to read `docs/operations/*`.

Run:

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/public-alpha-documentation.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/governance-enforcement-deployment-contract.test.js
```

Expected: failures on the obsolete qualification baseline, release-gate statuses, deployment labels, and missing founder vision.

- [ ] **Step 2: Write the classified founder vision**

Create sections for trust/event foundation, deterministic intelligence, governance/control, containment and Emergency Shield, recovery/game days, cross-provider expansion, optional open-source intelligence, customer-controlled evidence retention, and explicit controlled-alpha exclusions. Prefix every capability row or bullet with one of the four maturity labels and link delivery status back to `../current/PROJECT_STATE.md`, `../current/ROADMAP.md`, and `../release/RELEASE_SECURITY_GATES.md`.

- [ ] **Step 3: Correct current release and operations content**

Record only the qualified input baseline as passed. Mark live-provider, hosted, manual accessibility, and final gates pending. Rename the build report to a prior qualification baseline, close Task 21 accurately in the historical Phase 1 roadmap, update controlled-alpha deployment topology and API version, remove stale Task 4/migration instructions, and append an unreleased documentation-truth entry to `CHANGELOG.md`.

- [ ] **Step 4: Verify focused content contracts**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/public-alpha-documentation.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/governance-enforcement-deployment-contract.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/documentation-architecture.test.js
```

Expected: all three programs pass and the manifest now covers `docs/vision/FOUNDER_VISION.md`.

- [ ] **Step 5: Commit content truth separately from path mechanics**

```bash
git add CHANGELOG.md docs test/public-alpha-documentation.test.js test/governance-enforcement-deployment-contract.test.js
git commit -m "docs: restore vision and current release truth"
```

### Task 4: Repair navigation, consumers, and architectural decisions

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/ARCHITECTURE.md`
- Modify: `docs/architecture/ARCHITECTURE_DECISIONS.md`
- Modify: all moved Markdown files containing repository-relative links
- Modify: `scripts/verify.js`
- Modify: `test/package-contract.test.js`
- Modify: `test/package-release.test.js`
- Modify: `test/runbook-contract.test.js`
- Modify: `test/documentation-architecture.test.js`
- Modify: any additional exact-path consumer found by `rg`

**Interfaces:**
- Produces: ADR-062 and ADR-063 after unchanged ADR-001 through ADR-061, and zero references from executable consumers to removed root paths.
- Consumes: final destinations from Task 1 and generated-current authority from Task 2.

- [ ] **Step 1: Update path-contract tests before consumers**

Extend `test/documentation-architecture.test.js` to resolve every repository-relative Markdown link, verify README links to the new canonical paths, and reject known stale markers only in `current`, `release`, and `operational` lifecycle documents. Change expected package members, canonical-document paths, runbook root, accessibility path, historical report/specification paths, and ADR count from 61 to 63. Require sequential ADR numbers and exact headings:

```js
assert(decisions.includes('## ADR-062 — Documentation lifecycle and generated continuity are release contracts'));
assert(decisions.includes('## ADR-063 — Release archives cannot self-attest exact candidate identity'));
assert.deepStrictEqual(adrNumbers, Array.from({ length: 63 }, (_, index) => index + 1));
```

- [ ] **Step 2: Observe RED across moved consumers**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node scripts/verify.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-contract.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-release.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/runbook-contract.test.js
```

Expected: failures identify old exact paths and missing ADR decisions.

- [ ] **Step 3: Repair all consumers and navigation**

Update README to link the documentation index and canonical lifecycle destinations. Update `scripts/verify.js`, package contracts, runbook root, deployment paths, qualification paths, and all relative Markdown links. Append ADR-062 and ADR-063 without changing ADR-001 through ADR-061.

Run the stale-path inventory until only intentional historical prose remains:

```bash
rg -n "(?:^|[('\x60])(?:PROJECT_STATE|CONTINUATION_PROMPT|PHASE_1_ROADMAP|BUILD_REPORT|DEPLOY_RENDER_NEON|SECURITY_DEPLOYMENT|ARCHITECTURE_DECISIONS|EVIDENCE_INDEX|PUBLIC_ALPHA|RELEASE_SECURITY_GATES|PRODUCT_VISION|UX_VISION)\.md|docs/(?:runbooks|accessibility)/" . --glob '!node_modules/**' --glob '!docs/history/**'
```

- [ ] **Step 4: Reach GREEN on integration contracts**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node scripts/verify.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-contract.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-release.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/runbook-contract.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/documentation-architecture.test.js
```

- [ ] **Step 5: Commit path and ADR integration**

```bash
git add README.md docs scripts/verify.js test/package-contract.test.js test/package-release.test.js test/runbook-contract.test.js
git commit -m "docs: repair navigation and release consumers"
```

### Task 5: Make generated documentation a release gate

**Files:**
- Modify: `scripts/package-release.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/public-alpha-alpha17.yml`
- Modify: `test/package-release.test.js`
- Modify: `test/public-alpha-workflow-contract.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `npm run docs:check` from Task 2.
- Produces: source CI, deterministic packaging, and exact-archive qualification all fail when either generated continuity view drifts from `WORK_CONTINUITY.json`.

- [ ] **Step 1: Add a failing drift integration test**

Temporarily alter one generated view, invoke the real packager outside the source root, and assert a non-zero result containing `Generated continuity document is stale`. Add workflow-contract assertions that standard CI and qualification execute `npm run docs:check` before package creation.

- [ ] **Step 2: Observe RED**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-release.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/public-alpha-workflow-contract.test.js
```

Expected: the packager accepts generated drift and workflows omit the explicit check.

- [ ] **Step 3: Gate packaging and workflows**

Invoke the generator check through `process.execPath` in the packager before manifest discovery. Add `npm run docs:check` to both workflows before deterministic builds. Ensure `check:syntax` covers the generator and work-continuity module.

- [ ] **Step 4: Reach GREEN and run the full source suite**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/package-release.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node test/public-alpha-workflow-contract.test.js
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run docs:check
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm test
```

- [ ] **Step 5: Commit release-gate integration**

```bash
git add package.json scripts/package-release.js .github/workflows test/package-release.test.js test/public-alpha-workflow-contract.test.js
git commit -m "ci: gate releases on generated documentation"
```

### Task 6: Freeze and qualify the successor candidate

**Files:**
- Create outside repository: two deterministic release directories and final qualification evidence
- Do not modify: tracked repository files after the qualifying commit

**Interfaces:**
- Consumes: clean committed source tree and exact Node `22.23.1` runtime.
- Produces: one byte-identical successor ZIP pair, SHA-256 checksum, program/browser reports, and claim-bound automated evidence for the exact archive.

- [ ] **Step 1: Run source verification from a clean commit**

```bash
git status --porcelain=v1
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run docs:check
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm test
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run check:syntax
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run check:secrets
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm audit --omit=dev
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm audit
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH npm run test:runtime:matrix
```

Expected: clean status, all programs passed, no blocked/failed programs, and both audits report zero vulnerabilities.

- [ ] **Step 2: Run the 56-case browser matrix**

Use the already-proven transient Chromium runtime only as an execution dependency; do not add it to the project. Run the complete desktop/mobile Playwright configuration and preserve its JSON report.

- [ ] **Step 3: Build twice outside the source tree and compare bytes**

```bash
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node scripts/package-release.js /tmp/nvx-docs-release-a
PATH=/tmp/nvx-node22-5Sbv1j/node_modules/node-linux-x64/bin:$PATH node scripts/package-release.js /tmp/nvx-docs-release-b
sha256sum /tmp/nvx-docs-release-a/Nebulaverse-X-v5.3.0-alpha.17.0.zip /tmp/nvx-docs-release-b/Nebulaverse-X-v5.3.0-alpha.17.0.zip
cmp /tmp/nvx-docs-release-a/Nebulaverse-X-v5.3.0-alpha.17.0.zip /tmp/nvx-docs-release-b/Nebulaverse-X-v5.3.0-alpha.17.0.zip
```

- [ ] **Step 4: Qualify entirely from the extracted archive**

Run `scripts/qualify-candidate-archive.js` against the frozen ZIP with the transient browser cache. Require a fresh lockfile install inside the single extracted root, all program tests, all browser tests, audits, syntax, secret scan, and a claim-bound evidence envelope.

- [ ] **Step 5: Independently recompute every binding**

Recompute the archive SHA-256, program canonical hash, exact program-report file hash, exact browser-report file hash, every claim state, commit/tree identity, and clean status without trusting the runner summary.

- [ ] **Step 6: Stop at the publication boundary**

Do not push automatically from this task. Record the successor commit, tree, archive hash, test counts, evidence paths, and any environmental limitation. Then use the branch-finishing procedure to present the authorized draft-PR fast-forward or local-preservation choice.
