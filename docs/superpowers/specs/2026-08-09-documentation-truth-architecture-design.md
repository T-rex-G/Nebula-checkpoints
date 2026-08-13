# Nebulaverse-X Documentation Truth Architecture — Design Specification

**Status:** Approved for specification by the user on 2026-08-09

**Date:** 2026-08-09

**Target:** `5.3.0-alpha.17.0` documentation-truth successor candidate

**Repository:** `T-rex-G/Nebula-checkpoints`

**Draft pull request:** `#1`

**Qualified input head:** `4aa3c378475dd7fdb490b206e0ca3cb88d027bbf`

**Qualified input tree:** `29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb`

**Qualified input archive SHA-256:** `d3e86f3aa16faefc165dca8acd726ca22f8a8f10fd5c943ef3addddbab40d2cc`

## 1. Decision

Nebulaverse-X will correct documentation truth and structure on the existing
alpha.17 candidate line before any live-provider dispatch.

The project will not delete GitHub candidates, rewrite historical outcomes,
merge the draft pull request, touch `main`, or create a replacement repository
during this correction. The existing draft branch remains the only active
alpha.17 candidate line and may advance only by verified, non-force
fast-forward.

The checkpoint repository remains the qualification and provenance ledger. A
separate canonical `Nebulaverse-X` product repository may be created only after
the exact candidate passes live-provider, hosted, manual-accessibility, and
final release gates. If that later promotion is approved, it must copy the
exact qualified tree and retain `Nebula-checkpoints` as immutable provenance.

## 2. Why this correction is release-blocking

The qualified input archive is code-correct but documentation-inconsistent:

- 48 Markdown files occupy the repository root;
- current operational truth and immutable Phase 1 history are mixed together;
- `CONTINUATION_PROMPT.md`, `PHASE_1_ROADMAP.md`, and `BUILD_REPORT.md` describe
  obsolete alpha.16.3 work;
- `DEPLOY_RENDER_NEON.md` and `SECURITY_DEPLOYMENT.md` contain older release
  labels or superseded deployment statements;
- `WORK_CONTINUITY.json` records the pre-correction baseline rather than the
  successful alpha.17 automated qualification;
- tests require some obsolete text and therefore convert documentation drift
  into a false green result;
- the existing product vision is intentionally short and does not retain the
  broader founder intent recorded in approved project conversations and
  handoff plans; and
- three approved public-alpha design/plan records exist outside the repository.

Markdown files are included in the deterministic release archive. Any move or
content correction therefore changes the archive hash and requires a complete
new exact-archive qualification before live execution.

## 3. Considered approaches

### 3.1 Preserve history and migrate in place — selected

Fast-forward the existing draft branch from its qualified head, reorganize the
documentation using a manifest and generated continuity files, and refreeze the
same candidate line.

Benefits:

- retains one active source of truth;
- preserves GitHub evidence and failed-run history;
- keeps the correction reviewable as a bounded successor delta;
- avoids repeating repository setup and authorization; and
- allows the new archive to prove direct ancestry from the qualified input.

Cost: every path consumer and release contract must be updated together.

### 3.2 Start a clean repository now — rejected for this gate

A new repository would look tidy immediately, but it would split current truth,
disconnect the candidate from its qualification history, require new branch and
workflow protection, and make it easier to certify the wrong tree. It remains a
possible promotion step only after final release qualification.

### 3.3 Delete old candidates and restart — rejected

Deletion would remove useful incident, failure, and provenance evidence without
improving the current candidate. Historical candidates and runs are evidence,
not clutter. They may be indexed or archived later, but not erased as part of a
documentation correction.

## 4. Documentation source-of-truth hierarchy

The repository will use the following authority order:

1. `package.json` owns the authored application version.
2. `WORK_CONTINUITY.json` owns tracked operational state, the last recorded
   immutable baseline, gate status, limitations, and the next authorized action.
3. `PUBLIC_ALPHA_PROVENANCE.json` owns predecessor/successor provenance facts.
4. `config/public-alpha-capabilities.json` owns provider capability truth.
5. `ARCHITECTURE_DECISIONS.md` records accepted architectural decisions after it
   moves under `docs/architecture/`.
6. External GitHub qualification evidence owns the identity and result of the
   exact archive currently under test.
7. Generated Markdown presents machine-readable state but never overrides it.
8. Historical documents preserve what was claimed at their checkpoint and are
   never treated as current release truth.

This ordering resolves the self-reference problem: a file inside an archive
cannot truthfully contain that archive's final SHA-256. In-repository continuity
records the last immutable input and the intended next gate. The current
candidate's commit, tree, archive hash, run IDs, and evidence hashes are recorded
externally after qualification.

## 5. Target structure

Only `README.md`, `CHANGELOG.md`, and `WORK_CONTINUITY.json` remain as
documentation/state entry points at the repository root.

```text
README.md
CHANGELOG.md
WORK_CONTINUITY.json

docs/
├── README.md
├── DOCUMENTATION_MANIFEST.json
├── current/
│   ├── PROJECT_STATE.md
│   ├── ROADMAP.md
│   ├── CONTINUATION_PROMPT.md
│   └── PROVIDER_CAPABILITIES.md
├── vision/
│   ├── FOUNDER_VISION.md
│   ├── PRODUCT_VISION.md
│   └── UX_VISION.md
├── architecture/
│   ├── ARCHITECTURE.md
│   └── ARCHITECTURE_DECISIONS.md
├── release/
│   ├── PUBLIC_ALPHA.md
│   ├── RELEASE_SECURITY_GATES.md
│   ├── QUALIFICATION_BASELINE.md
│   └── EVIDENCE_INDEX.md
├── operations/
│   ├── DEPLOY_RENDER_NEON.md
│   ├── SECURITY_DEPLOYMENT.md
│   └── runbooks/
├── qualification/
│   ├── accessibility/
│   ├── PUBLIC_ALPHA_COHORT_CHECKLIST.md
│   └── PUBLIC_ALPHA_KNOWN_LIMITATIONS.md
├── reference/
│   └── NEURAL_COMMAND_CENTER.md
├── history/
│   ├── phase-0/
│   ├── phase-1/
│   │   ├── ROADMAP.md
│   │   ├── reports/
│   │   └── specifications/
│   ├── public-alpha/
│   │   └── approved-plans/
│   └── upgrades/
└── superpowers/
    ├── plans/
    └── specs/
```

### 5.1 Exact migration classes

| Current class | Destination | Lifecycle |
|---|---|---|
| `PROJECT_STATE.md`, `ROADMAP.md`, `PROVIDER_CAPABILITIES.md` | `docs/current/` | Current authored or generated truth |
| `CONTINUATION_PROMPT.md` | `docs/current/` | Generated; edits are forbidden |
| `PRODUCT_VISION.md`, `UX_VISION.md` | `docs/vision/` | Current product intent |
| New `FOUNDER_VISION.md` | `docs/vision/` | Founder intent with explicit maturity labels |
| `ARCHITECTURE.md`, `ARCHITECTURE_DECISIONS.md` | `docs/architecture/` | Current architecture and append-only decisions |
| `PUBLIC_ALPHA.md`, `RELEASE_SECURITY_GATES.md`, `EVIDENCE_INDEX.md` | `docs/release/` | Current release contract and recorded prior evidence |
| `BUILD_REPORT.md` | `docs/release/QUALIFICATION_BASELINE.md` | Recorded prior qualified baseline, never a self-attestation |
| `DEPLOY_RENDER_NEON.md`, `SECURITY_DEPLOYMENT.md` | `docs/operations/` | Current operator guidance |
| Existing `docs/runbooks/*` | `docs/operations/runbooks/` | Current operator runbooks |
| Existing `docs/accessibility/*` | `docs/qualification/accessibility/` | Qualification record/template |
| Existing `docs/qualification/*` | `docs/qualification/` | Current qualification contract |
| `NEURAL_COMMAND_CENTER.md` | `docs/reference/` | Current feature reference |
| `PHASE_0_COVERAGE.md` | `docs/history/phase-0/` | Historical checkpoint |
| `PHASE_1_ROADMAP.md` | `docs/history/phase-1/ROADMAP.md` | Historical Phase 1 plan, corrected only to close Task 21 accurately |
| `PHASE_1_TASK_*_REPORT.md` | `docs/history/phase-1/reports/` | Historical evidence; content preserved |
| `TASK_*_SPEC.md` | `docs/history/phase-1/specifications/` | Historical specifications; content preserved |
| `UPGRADE_FROM_V5_2_1.md` | `docs/history/upgrades/` | Historical upgrade guide |
| Three approved 2026-07-29 handoff plans | `docs/history/public-alpha/approved-plans/` | Imported historical approved inputs |
| Existing `docs/superpowers/*` | Remains under `docs/superpowers/` | Development design/plan record |

Moved historical reports and specifications keep their original bytes where
possible. Classification is carried by the manifest and directory index, not
by rewriting historical conclusions.

The imported handoff inputs are byte-bound to these SHA-256 values:

| File | SHA-256 |
|---|---|
| `2026-07-29-controlled-hosted-public-alpha-design.md` | `ce326ff597e36e16ea364fab7666c5ea353dc67d6de345222649aec8e08380bc` |
| `2026-07-29-public-alpha-03-privacy-credential-lifecycle.md` | `84d948bcaa3100326447581f1448f2ee2b5324eb03326731c6b93d1c222e7ebc` |
| `2026-07-29-public-alpha-master-sequence.md` | `1793df39b70de37a862ff4f81240d37948cdd7b7419c7b0dd43c74edacd6ce26` |

## 6. Documentation manifest

`docs/DOCUMENTATION_MANIFEST.json` will enumerate every tracked Markdown file
with these fields:

```json
{
  "path": "docs/current/PROJECT_STATE.md",
  "lifecycle": "current",
  "authority": "generated-from-work-continuity",
  "releaseIncluded": true,
  "immutableHistory": false
}
```

Allowed lifecycle values are:

- `entrypoint` — root navigation or changelog;
- `current` — active project/release truth;
- `vision` — intent, not delivery evidence;
- `architecture` — current design or accepted decision;
- `operational` — instructions for operators;
- `qualification` — gate, checklist, limitation, or prior evidence;
- `historical` — superseded checkpoint material; and
- `development-record` — Superpowers design/plan material.

The manifest must cover every tracked `.md` file exactly once. A file absent
from the manifest, a duplicate path, an unknown lifecycle, a missing target, or
a historical file classified as current fails CI.

## 7. Generated continuity

### 7.1 Machine-readable state

`WORK_CONTINUITY.json` advances to schema version 4 and records:

- project and package version;
- the accepted ancestor tree used for continuity validation;
- the last published and automatically qualified immutable baseline;
- repository, branch, pull request, workflow-run, commit, tree, and archive
  identifiers for that recorded baseline;
- separate gate states for automated, live-provider, hosted,
  manual-accessibility, and final release qualification;
- immutable failed-run summaries;
- limitations;
- the exact next authorized action; and
- a statement that current candidate identity is external evidence.

The qualified input `4aa3c378...` / `29112ef5...` / `d3e86f3...` becomes the
recorded immutable baseline. The successor documentation candidate must not
claim it has passed until its own external qualification completes.

### 7.2 Generator

`scripts/generate-continuity-docs.js` deterministically renders:

- `docs/current/PROJECT_STATE.md`; and
- `docs/current/CONTINUATION_PROMPT.md`.

The prompt will identify the current version, the last immutable baseline, the
public-alpha GO/NO-GO state, pending gates, limitations, next action, canonical
read order, and the rule that current artifact identity must come from external
qualification evidence.

`npm run docs:generate` updates generated files. `npm run docs:check` renders to
memory and fails if tracked output differs. Packaging and CI run
`docs:check`; they never silently rewrite the source tree.

## 8. Founder vision recovery

`docs/vision/FOUNDER_VISION.md` will consolidate intent from:

- approved Nebulaverse-X project conversations;
- the approved 2026-07-29 hosted-alpha design and master plan;
- current product, UX, roadmap, architecture, and release documents; and
- confirmed implemented behavior in the candidate.

Every vision item must carry one of four maturity labels:

| Label | Meaning |
|---|---|
| `Implemented` | Present in the candidate; release availability still follows capability and qualification gates |
| `Committed roadmap` | Approved direction in the current roadmap but not claimed delivered |
| `Exploratory` | Preserved founder idea requiring later design and evidence |
| `Out of current scope` | Explicitly excluded from the controlled alpha |

The document will preserve ideas including cross-provider telemetry and
controls, Shadow Access Radar, deterministic risk and explanation, Protected
Files, Emergency Shield, session containment, bounded read-only/freeze actions,
recovery snapshots and game days, optional open-source intelligence, external
evidence retention, and provider expansion. It must link delivery claims to
current documentation and must never serve as a qualification artifact.

## 9. Current-content corrections

The migration will correct, at minimum:

- Phase 1 Task 21 from `In progress` to its qualified historical outcome;
- the continuation prompt from alpha.16.3 execution to the alpha.17
  documentation-truth successor and its actual pending gates;
- the qualification baseline from the obsolete alpha.16.3 build report to the
  successful `d3e86f3...` automated baseline;
- project state to distinguish automated provider-stage GO from public-alpha
  NO-GO;
- release gates to mark exact automated qualification passed for the recorded
  baseline while keeping live-provider, hosted, manual-accessibility, and final
  gates pending;
- deployment titles and instructions to the controlled alpha.17 topology;
- stale Task 4 and pre-migration wording in security deployment guidance;
- evidence index coverage for the successful PR qualification and its failed
  portability runs; and
- README navigation and every relative path affected by the migration.

Historical alpha.16.x facts remain where they are valid evidence. Tests must
reject obsolete current-state wording without banning legitimate historical
references.

## 10. Architecture decisions

Two append-only decisions will be added:

- **ADR-062:** Documentation lifecycle and generated continuity are enforced as
  release contracts.
- **ADR-063:** A release archive cannot self-attest its own identity; exact
  candidate qualification identity remains external, content-addressed
  evidence.

Existing ADR-001 through ADR-061 remain byte-preserved except for relocation.

## 11. Verification design

Implementation follows red/green/refactor. Before moving or generating current
documents, tests must fail for the existing layout and stale state.

### 11.1 New checks

`test/documentation-architecture.test.js` will prove:

- the root Markdown allowlist is exact;
- the manifest covers every Markdown file once;
- every manifest target exists and has a valid lifecycle;
- current and historical classes do not overlap;
- every repository-relative Markdown link resolves;
- canonical README links point to the new structure;
- imported approved plans match the three approved SHA-256 values; and
- current documents reject known stale release markers.

`test/continuity-generation.test.js` will prove:

- schema version 4 validation;
- package/continuity version agreement;
- deterministic project-state and prompt generation;
- byte-for-byte generated-file drift detection;
- separate automated/provider/hosted/accessibility/final gate states;
- correct handling when Git metadata is unavailable in an extracted archive;
  and
- absence of self-referential current archive or commit claims.

### 11.2 Updated checks

The implementation will update all exact-path consumers, including:

- `scripts/verify.js`;
- `scripts/package-release.js` and package-release tests;
- `test/public-alpha-documentation.test.js`;
- `test/continuity-contract.test.js`;
- `test/work-continuity.test.js`;
- `test/package-contract.test.js`;
- deployment and runbook contract tests;
- workflow/package contract tests; and
- README/documentation link assertions.

No compatibility shim or duplicate root Markdown file will remain after the
migration. A temporary duplicate would recreate two sources of truth.

### 11.3 Qualification gate

Before the remote branch moves, the successor must pass:

1. focused documentation and continuity red/green tests;
2. complete `npm test` and posttest under Node.js `22.23.1`;
3. syntax and expanded secret scanning;
4. production and development dependency audits;
5. the complete program matrix;
6. the 56-case desktop/mobile browser matrix;
7. two byte-identical deterministic archives;
8. safe fresh extraction and install from the archive root;
9. exact-archive program/browser/evidence qualification; and
10. independent recomputation of archive and evidence bindings.

The archive hash `d3e86f3...` is intentionally superseded only after all local
gates pass. The existing draft branch then advances by exact-tree verified,
non-force fast-forward. Automatic GitHub checks must pass before any provider
dispatch is considered.

## 12. Publishing and safety boundaries

This design authorizes local source changes, local commits, deterministic
packaging, tests, and a verified fast-forward update of the existing draft PR
branch after all local gates pass.

It does not authorize:

- merging any pull request;
- modifying `main` or the sandbox base;
- deleting branches, candidates, runs, artifacts, or repositories;
- deploying Render or mutating Neon;
- dispatching live GitHub, GitLab, Gitea, or hosted qualification;
- opening the public-alpha cohort; or
- presenting the successor as production-ready.

Live execution remains a later exact-job/exact-target signed gate.

## 13. Rollback

The qualified input head, tree, and archive remain immutable. Until the remote
branch fast-forwards, rollback is simply discarding the isolated successor
work. After a fast-forward, the prior commit remains its direct ancestor; no
force-push or destructive reset is required. If GitHub checks fail, the branch
stays draft and public-alpha remains NO-GO while a tested child correction is
prepared.

## 14. Acceptance criteria

The documentation architecture is complete only when:

- root entry points are limited to two approved Markdown files plus the machine-readable `WORK_CONTINUITY.json` source;
- every Markdown document has exactly one lifecycle classification;
- current, vision, operational, qualification, historical, and development
  records are physically separated;
- the founder vision is restored with explicit maturity labels;
- `WORK_CONTINUITY.json` is the sole tracked continuity source;
- project state and continuation prompt are deterministic generated outputs;
- no current document instructs alpha.16.3 Task 21 work;
- historical outcomes remain preserved and navigable;
- all relative links and exact path consumers pass;
- the complete source and exact-archive qualification passes for the successor;
- the draft PR records the new external candidate identity; and
- live-provider dispatch remains blocked until that new identity is green.
