# Nebulaverse-X Roadmap

## Roadmap governance

This is the controlled working roadmap for Phase 1. Tasks 1–19 implemented the product and governance foundation. Task 20 completed its 19-check evidence cycle at 18/19 and blocked alpha.16.1. Task 21 owns the test-first Gitea correction, dependency classification, fresh candidate packaging and repeated release gate. The security and compatibility constraints in `PROJECT_STATE.md` remain binding.

## Phase 1 — Secure Access and Policy Digital Twin

Target release: **v5.3**

| # | Task | Status | Primary outcome |
|---:|---|---|---|
| 1 | Security Foundation | Complete | CSRF, same-origin enforcement and single-use step-up authorization |
| 2 | Optional GitHub App Foundation | Complete | Optional installation authentication and server-only credential broker |
| 3 | Governance Persistence Foundation | Complete | Immutable policies, approvals, activation, rollback and audit storage |
| 4 | Central Mutation Gateway Foundation | Complete | One fail-closed boundary for every provider repository write |
| 5 | Provider Permission and Governance Role Resolver | Complete | Server-derived repository permissions and governance actor roles |
| 6 | Governance API and Authorization Boundary | Complete | Authenticated APIs for policies and lifecycle operations with ownership checks |
| 7 | Policy Draft and Immutable Version Workflow | Complete | Create, edit, validate and submit immutable policy versions |
| 8 | Reviewer Assignment and Approval Workflow | Complete | Distinct reviewer selection, decisions, quorum and rejection handling |
| 9 | Policy Simulation Engine | Complete | Evaluate proposed rules against normalized mutation and repository scenarios |
| 10 | Simulation Evidence and Impact Diff | Complete | Explain affected actions, conflicts, risk and policy changes before activation |
| 11 | Policy Activation and Rollback Service | Complete | Authorized activation, optimistic concurrency and evidence-backed rollback |
| 12 | Gateway Policy Evaluation Integration | Complete | Evaluate active policy at the central mutation boundary |
| 13 | Observe, Warn and Block Enforcement Modes | Complete | Controlled rollout modes with fail-safe behavior and measurable decisions |
| 14 | Exceptions, Waivers and Expiry Workflow | Complete | Time-bounded, independently approved, actor/target-bound exceptions with automatic expiry and audit evidence |
| 15 | Policy Templates and Repository Baselines | Complete | Immutable versioned templates and deterministic server-derived repository baselines |
| 16 | Policy Digital Twin Read Model | Complete | Repeatable-read projection of current, proposed, effective and historical governance state |
| 17 | Policy Digital Twin Interface | Complete | Accessible UI for policy state, simulations, approvals, activation and history |
| 18 | Full Mutation Coverage and Bulk Operation Governance | Complete | Coverage proof for every mutation and bounded governance for batch operations |
| 19 | Governance Notifications, Webhooks and Audit Exports | Complete | Non-secret lifecycle notifications, signed events and formula-safe evidence exports |
| 20 | End-to-End Staging, Security, Concurrency and Accessibility | Complete (18/19; alpha.16.1 blocked) | Real-provider, Neon, browser, abuse, race and accessibility validation |
| 21 | v5.3 Release Readiness, Migration, Documentation and Packaging | Complete (alpha.16.3 qualified) | Corrected Gitea normalization and mutation transport, preserved immutable failed candidates, and completed the candidate-bound release gate |

## Phase 1 completion definition

Phase 1 is complete only when:

- all repository mutations pass through the gateway and active policy evaluation;
- provider permissions and governance roles are derived server-side;
- policy drafting, immutable versions, review, approval, simulation, activation, exceptions and rollback are usable end to end;
- the Policy Digital Twin accurately shows proposed, active and historical state;
- PAT, OAuth, optional GitHub App, GitLab and Gitea compatibility is preserved;
- Render Free plus optional Neon remains deployable;
- real Neon, GitHub App, browser and destructive-operation staging checks pass;
- the final v5.3 archive is deterministic, checksum-verified and independently reviewed.

## Later phases

### Phase 2 — Repository Trust Digital Twin

Target: **v5.4**

Continuously model repository trust posture, branch controls, permissions, CI/CD, dependencies, security configuration, governance drift, evidence and explainable trust scoring.

### Phase 3 — Verified Recovery Game Day

Target: **v5.5**

Prove recovery readiness through controlled exercises, restore validation, recovery-point/recovery-time measurements, evidence, after-action review and remediation tracking.

### Phase 4 — Organization-Wide Intelligence

Target: **v6.0**

Add multi-repository and organization-wide governance visibility, inherited policy structures, portfolio risk/trust analysis, trends, executive reporting, prioritized remediation and aggregated evidence.

### Phase 5 — Customer-Controlled Evidence Retention

Target: **v6.1**

Let customers persist signed governance evidence and audit exports to their own S3-compatible object storage, under their own credentials, region and retention policy — so a full audit window of tamper-evident evidence lives in infrastructure the customer controls, not only in the operator's Neon database.

**Depends on:** Phase 1 Task 19 (signed evidence export format) must be complete and stable first. The export record shape is this feature's input contract.

**Scope:** one S3-compatible client with configurable endpoint, region and path-style addressing. Cloudflare R2, Backblaze B2, MinIO and S3-compatible NAS gateways are supported through endpoint configuration, not separate code paths.

Detailed task counts for Phases 2–5 are intentionally not fixed until the preceding phase provides enough implementation evidence to plan them responsibly.
