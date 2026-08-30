# Nebulaverse-X Founder Vision

Nebulaverse-X should make repository security, governance, controlled action,
and recovery understandable in one visual system without pretending that an
idea, an implemented capability, and a release-qualified capability are the
same thing.

**Vision is not qualification evidence.** Delivery and release status come from
the generated [project state](../current/PROJECT_STATE.md), the approved
[roadmap](../current/ROADMAP.md), and the
[release security gates](../release/RELEASE_SECURITY_GATES.md).

## Maturity vocabulary

| Label | Meaning |
|---|---|
| **Implemented** | Behavior exists in the candidate. Availability still follows provider capability and qualification gates. |
| **Committed roadmap** | Approved product direction, but not claimed delivered. |
| **Exploratory** | A founder idea preserved for later design, threat modelling, and evidence. |
| **Out of current scope** | Deliberately excluded from the controlled hosted alpha. |

## Trust and event foundation

- **Implemented** — Cross-provider GitHub, GitLab, and Gitea repository
  connectivity with one server-owned capability vocabulary and fail-closed
  unsupported operations.
- **Implemented** — Verified event intake, normalized evidence, deduplication,
  live-state presentation, and bounded catch-up behavior for the supported
  provider paths.
- **Implemented** — The Neural Command Center as a visual connection between
  repositories, events, risks, evidence, governance, and recovery state.
- **Committed roadmap** — A deeper Repository Trust Digital Twin that combines
  permissions, controls, dependencies, CI/CD, evidence freshness, governance
  drift, and explainable posture over time.

## Deterministic security intelligence

- **Implemented** — Deterministic risk and evidence states that distinguish
  provider-verified facts, deterministic derivation, inference, stale evidence,
  and unavailable evidence.
- **Committed roadmap** — Shadow Access Radar for visualizing effective access,
  stale or excessive authorization, indirect exposure, and the evidence behind
  each relationship.
- **Committed roadmap** — Explain Connection and incident timeline replay so a
  user can understand why a relationship or risk exists and how it changed.
- **Exploratory** — Optional open-source intelligence modules that can assist
  analysis without becoming an authority, hiding deterministic evidence, or
  requiring a paid AI service.
- **Out of current scope** — Behavioural machine learning, autonomous security
  judgment, and paid-AI dependencies in the controlled-alpha golden path.

## Governance and Protected Files

- **Implemented** — A central mutation gateway, verified human authority,
  policy drafts and immutable versions, review and separation of duties,
  simulation, activation/rollback, exceptions, templates, enforcement modes,
  notifications, and signed evidence exports.
- **Implemented** — Observe, warn, and block policy behavior with explicit
  failure policy and evidence-bound decisions.
- **Implemented** — Protected Paths as an operator-friendly control. One
  declared pattern covers every action that can change it — writes, deletes,
  uploads, renames, batches, directory moves and restores from history — along
  with the directories holding it, and the expansion states which actions it
  could not narrow to that path rather than leaving the gap to be discovered.
- **Committed roadmap** — Mapping those same paths to repository-native
  protection where a provider offers it, through CODEOWNERS, branch protection
  and rulesets, and stating clearly where provider-side enforcement is
  incomplete beside what the gateway enforces itself.
- **Committed roadmap** — Organization-wide governance inheritance, portfolio
  visibility, prioritization, and remediation tracking after repository-level
  trust behavior is proven.
- **Out of current scope** — Full provider feature parity or provider-agnostic
  enforcement claims where GitHub, GitLab, and Gitea expose different controls.

## Emergency Shield and containment

- **Implemented** — Identity-bound session containment, active-session
  revocation, provider disconnect, verified temporary-resource cleanup, and
  browser purge boundaries.
- **Implemented** — Bounded read-only and freeze-compatible safeguards in the
  governance and recovery control plane, with fail-closed authorization around
  consequential mutations.
- **Committed roadmap** — Emergency Shield as one guided incident surface for
  session containment, read-only mode, scheduled synchronization freeze,
  evidence export, and an explicit recovery checklist.
- **Exploratory** — Cross-provider emergency manifests that describe intended
  containment actions before execution and preserve provider-specific limits.
- **Out of current scope** — Autonomous destructive containment or silent
  provider-wide shutdown.

## Recovery and game days

- **Implemented** — Signed recovery snapshots, comparison, restore preview,
  bounded ref restoration, backup-format validation, and explicit limits that
  distinguish reference snapshots from complete disaster-recovery backups.
- **Committed roadmap** — Verified Recovery Game Day workflows that measure
  recovery point and time, execute isolated restore rehearsals, verify results,
  preserve evidence, and track remediation.
- **Committed roadmap** — Independently encrypted Git/LFS/metadata backup
  guidance outside the source provider and outside Render ephemeral storage.
- **Exploratory** — Broader disaster-recovery orchestration after provider,
  hosting, data-loss, and rollback boundaries have dedicated qualification.
- **Out of current scope** — A claim that current recovery snapshots preserve
  every Git object, LFS object, issue, review, release asset, webhook, or
  organization setting.

## Evidence ownership and provider expansion

- **Implemented** — Tamper-evident local evidence chains and signed export
  envelopes that preserve historical outcomes without rewriting failures.
- **Committed roadmap** — Customer-controlled evidence retention in
  S3-compatible storage under customer credentials, region, lifecycle, and
  retention policy after the signed export boundary remains stable.
- **Committed roadmap** — Continued GitHub golden-path depth plus honest,
  evidence-bound GitLab and Gitea expansion feature by feature.
- **Exploratory** — Additional providers only when concrete demand justifies
  their authorization, mutation, evidence, cleanup, and recovery contracts.
- **Out of current scope** — Bitbucket, multi-tenancy, production-scale
  autoscaling, and complete provider parity for the first controlled alpha.

## Controlled-alpha promise

The first hosted cohort remains invitation-only, limited to 5–10 testers, and
restricted to exact allowlisted sandbox repositories. Every visible feature is
Supported, Experimental, or Unavailable for the selected provider and
deployment. Nothing in this vision opens the cohort: the exact successor must
still pass automated, live-provider, hosted, manual-accessibility, cleanup,
backup/restore, and final go/no-go gates.
