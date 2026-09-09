# Nebulaverse-X Documentation

This directory separates current project truth from vision, operator guidance,
qualification evidence, immutable history, and development records. Start with
the generated [project state](current/PROJECT_STATE.md), then use the sections
below according to the decision you need to make.

## Current state

- [Project state](current/PROJECT_STATE.md) — generated release and gate status
- [Continuation prompt](current/CONTINUATION_PROMPT.md) — generated handoff for the next working session
- [Roadmap](current/ROADMAP.md) — approved delivery direction
- [Provider capabilities](current/PROVIDER_CAPABILITIES.md) — capability and evidence boundaries

## Product intent

- [Founder vision](vision/FOUNDER_VISION.md) — complete intent with explicit maturity labels
- [Product vision](vision/PRODUCT_VISION.md)
- [UX vision](vision/UX_VISION.md)

Vision describes intent; it never proves delivery or qualification.

## Architecture and release

- [Architecture](architecture/ARCHITECTURE.md)
- [Architecture decisions](architecture/ARCHITECTURE_DECISIONS.md)
- [Personal workspace foundation](architecture/PERSONAL_WORKSPACE_FOUNDATION.md) — scope, API, setup, recovery, and legacy compatibility
- [Public-alpha contract](release/PUBLIC_ALPHA.md)
- [Release security gates](release/RELEASE_SECURITY_GATES.md)
- [Recorded qualification baseline](release/QUALIFICATION_BASELINE.md)
- [Evidence index](release/EVIDENCE_INDEX.md)

## Operations and qualification

- [Render and Neon deployment](operations/DEPLOY_RENDER_NEON.md)
- [Security deployment](operations/SECURITY_DEPLOYMENT.md)
- [Operator runbooks](operations/runbooks/OPERATOR_CHECKLIST.md)
- [Public-alpha cohort checklist](qualification/PUBLIC_ALPHA_COHORT_CHECKLIST.md)
- [Known limitations](qualification/PUBLIC_ALPHA_KNOWN_LIMITATIONS.md)
- [Manual accessibility audit](qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md)

## Reference, history, and development records

- [Neural Command Center reference](reference/NEURAL_COMMAND_CENTER.md)
- [Phase 1 historical roadmap](history/phase-1/ROADMAP.md)
- [Approved public-alpha plans](history/public-alpha/approved-plans/2026-07-29-public-alpha-master-sequence.md)
- [Development plans](superpowers/plans/2026-08-09-documentation-truth-architecture.md)
- [Approved documentation architecture](superpowers/specs/2026-08-09-documentation-truth-architecture-design.md)

Files under `docs/history/` preserve checkpoint evidence. They are not current
instructions and must not override `WORK_CONTINUITY.json` or generated current
state. Every Markdown file is classified exactly once in
`DOCUMENTATION_MANIFEST.json`. Its historical records are byte-bound by the
referenced `config/historical-document-integrity.json` SHA-256 baseline.
