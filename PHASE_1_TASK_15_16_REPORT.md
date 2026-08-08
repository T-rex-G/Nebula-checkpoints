# Phase 1 Tasks 15–16 Report — Policy Templates, Repository Baselines and Digital Twin Read Model

## Checkpoint

- Product: **Nebulaverse-X**
- Version: **v5.3.0-alpha.12**
- Phase: **Phase 1 — Policy Digital Twin and Governance Foundation**
- Tasks: **15 — Policy Templates and Repository Baselines** and **16 — Policy Digital Twin Read Model**
- Status: **Implemented and source-reviewed**

## Objective

Provide reproducible repository governance starting points and one authoritative read-only projection of governance state without creating hidden mutable state, weakening Tasks 1–14, automatically activating policy, or beginning the Task 17 user interface.

## Task 15 delivered behavior

### Immutable template catalog

- Added source-controlled catalog `nebulaverse-policy-template-catalog` version `1.0.0`.
- Added immutable built-in templates for an observe baseline, protected default branch and release change control.
- Template list and detail results are deeply frozen and deterministically ordered.
- Every template carries stable catalog, template and document hashes.
- Unknown template IDs fail with a bounded not-found error.

### Repository baseline generation

- Baselines are generated from one selected template and bounded repository facts resolved by the server through the authenticated provider connection.
- Supported facts include default branch, protected branches, pull-request capability, visibility, archived state and explicit branch-data completeness.
- Branch rules are deterministic and cover every resolved protected branch.
- Incomplete or truncated provider facts are reported through readiness warnings rather than silently presented as complete.
- Every baseline preserves exact scope, catalog/template provenance, repository-facts hash, document hash and baseline hash.
- Generated policy documents default to `observe`.
- Baseline generation performs no PostgreSQL write, draft creation, version submission, policy activation, audit append or provider mutation.

## Task 16 delivered behavior

### Authoritative read-only projection

- Added one reader-authorized repository/provider-authority scoped Policy Digital Twin read model.
- The store reads all sections in one PostgreSQL `REPEATABLE READ READ ONLY` transaction.
- No Digital Twin table or second mutable source of truth was introduced.
- The projection is deterministic, deeply frozen and credential-free.
- Every response carries one database snapshot timestamp, completeness flags and a deterministic `readModelHash`.

### State represented

The projection separates:

- **Current:** policies, active heads, active immutable versions and enforcement modes.
- **Proposed:** active drafts and relevant newer immutable versions with review state.
- **Effective:** active-policy count and authoritative active-exception summaries.
- **History:** bounded activation, exception and runtime-decision history with cursor continuation.

Proposed versions never claim activation readiness solely because review is approved. They explicitly require a fresh scenario-bound simulation before Task 11 activation can proceed.

### Evidence integrity and bounded reads

- Version evidence comes from one latest activation-evidence row, preventing hashes from different activations being combined.
- Active exception totals come from an authoritative summary independent of truncated exception-history pages.
- Policy/version/draft/exception/activation/decision totals and completeness are explicit.
- Runtime decision history uses a bounded sequence cursor.
- Query options reject decimals, negative values and oversized limits.
- Digital Twin SQL contains no INSERT, UPDATE, DELETE or TRUNCATE operation.

## API routes

All routes require fresh repository-reader authorization and return `Cache-Control: no-store`:

- `GET /api/repo/:owner/:repo/governance/templates`
- `GET /api/repo/:owner/:repo/governance/templates/:templateId`
- `POST /api/repo/:owner/:repo/governance/baselines/generate`
- `GET /api/repo/:owner/:repo/governance/digital-twin`

The baseline request accepts only the template ID. Repository facts are resolved internally and cannot be supplied by the browser.

## Deployment hardening completed during review

- Prevented Digital Twin evidence from mixing independent `MAX()` values belonging to different activation records.
- Added explicit branch-fact completeness and protected-branch truncation reporting.
- Generated deterministic rules for every resolved protected branch rather than only the default branch.
- Added active drafts and activation/simulation evidence references to the projection.
- Prevented old rollback/history versions from being mislabeled as current proposals.
- Added authoritative active-exception summaries instead of deriving operational totals from paginated history.
- Added SQL window totals so hard result caps never appear to be complete datasets.
- Made fresh simulation a mandatory visible activation-readiness blocker.
- Proved the Digital Twin transaction is read-only and snapshot-consistent.
- Exempted only the exact baseline-generation route from global read-only safeguards because it performs no mutation.
- Corrected Gitea branch discovery to use Gitea `limit`/`page` pagination instead of GitHub `per_page`, preventing silent incomplete baselines.

## Architecture boundaries preserved

Tasks 15–16 do not:

- create or activate policies automatically;
- rewrite immutable policy versions;
- modify Task 14 exception semantics;
- add a final Digital Twin interface;
- add organization inheritance;
- change Task 19 exports;
- implement Phase 5 external evidence storage;
- make GitHub App authentication mandatory.

Historical policy-decision engines 1 and 2 and control catalogs 1.0.0 and 1.1.0 remain distinguishable and verifiable.

## Source-level verification

Focused tests cover:

- immutable template/catalog behavior;
- deterministic baseline output and provenance;
- secret, scope and repository-fact rejection;
- branch completeness/truncation states;
- Digital Twin normalization, ordering, pagination and hashes;
- repeatable-read read-only SQL behavior;
- active draft, review, activation-evidence and active-exception projection;
- reader-authorized API and route contracts;
- absence of governance/provider mutation from baseline and Digital Twin reads.

The complete build report records the frozen workspace and clean-package verification results.

## Environment-backed verification still required

Before production promotion, run:

- clean `npm ci` and dependency audit;
- Express startup and route integration tests;
- Playwright browser tests;
- live Neon repeatable-read and pagination tests under concurrent governance writes;
- real GitHub, GitLab and Gitea repository-fact resolution;
- runtime release packaging through `archiver`.

## Next checkpoint

Proceed with:

- **Task 17 — Policy Digital Twin Interface**
- Target version: **v5.3.0-alpha.13**

Task 17 must consume the read model without duplicating policy state or adding direct governance writes outside the existing API and Central Mutation Gateway boundaries.
