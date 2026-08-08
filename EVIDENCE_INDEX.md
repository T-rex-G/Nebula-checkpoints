# Evidence Index

This index records which evidence applies to which checkpoint. Historical
records remain immutable; no earlier outcome is rewritten as successor proof.

## Qualified predecessor: 5.3.0-alpha.16.3

- Archive: `Nebulaverse-X-v5.3.0-alpha.16.3.zip`
- SHA-256: `330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892`
- Qualified publication/validation commit:
  `c19389f8b25cb67caad6fd56d000ca130ef8520f`
- Companion Push run: `30464094438`
- Pull-request run: `30464096155`
- Decision: Task 21 qualified alpha checkpoint; not merged, promoted, deployed,
  or declared production-ready.

The Task 20 GitHub/GitLab evidence applies to the predecessor paths retained
unchanged and rechecked by the Task 21 candidate matrix. The fresh Gitea
evidence in run `30464094438` applies specifically to the corrected
expected-head Contents API path, readback, denial, and cleanup. Those evidence
classes have different applicability and neither is automatically an
alpha.17.0 hosted pass.

The external immutable closeout record is
`Nebulaverse-X-v5.3.0-alpha.16.3-Task21-Closeout.md`. Historical in-repository
detail remains in `BUILD_REPORT.md`, `PHASE_1_TASK_20_REPORT.md`,
`PHASE_1_TASK_21_REPORT.md`, `staging/`, and the Phase 1 specifications/plans.

## Successor foundation: 5.3.0-alpha.17.0

| Evidence | Applicability |
| --- | --- |
| `PUBLIC_ALPHA_PROVENANCE.json` and `test/public-alpha-provenance.test.js` | Successor identity and predecessor-hash input |
| Task 1 report; commit `14d9568766107c4f9d0f9c51d4d5aeefd2573745` | Provenance/version foundation only |
| Task 2 report; commits `6f6d10230f28fc12f1019e8264d36ea30f39fe3d`, `f714f9c704e335032b180267788cf9fd677965fd` | Registry creation and fixed-vocabulary validation only |
| Task 3 report; commits `ba3ecbf`, `d8b12e6a0f9bf355edfc246250525d05f5116870` | Server capability enforcement and gap corrections only |
| Task 4 report; commits `0a26401e499c3d031b8af15dec6cfa286b8aa25b`, `24d29c9100beb01263219afc2c4298d56ecc97fa` | Canonical documentation truth, ownership, and reviewed provider mappings only |
| Task 5 report; commits `a0bb77c7d08e0446eb849cd99f735e716be6535b`, `5c96315b31222d99b242851b8a2ba13da7b635f1` | Foundation build/test integration and direct/Render package gating only |

These successor records prove only Plan 1 successor foundation work and do not prove hosted-public-alpha qualification.
They also do not prove invitation access, privacy lifecycle, hosted operations,
live provider parity, production readiness, or cohort qualification.

Future qualification must bind fresh source, package, live-provider,
accessibility, Render, Neon, backup/restore, rollback, cleanup, and purge
evidence to the exact frozen successor candidate.
