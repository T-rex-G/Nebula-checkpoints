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
detail remains under `docs/history/phase-1/`, while the last automated alpha.17
baseline is summarized in `docs/release/QUALIFICATION_BASELINE.md`.

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

## Recorded alpha.17 automated baseline

| Identity or result | Recorded value |
|---|---|
| Local source commit | `c67d92edb8c63f11ada74cfdc7835f8a4b387a1c` |
| Published draft-PR commit | `d6628de48a32c3a2790dabeec60ec7b7b2ebab49` |
| Shared tree | `7bcc2c27029cc1013f176d1070e2cd38a8e69811` |
| Candidate SHA-256 | `1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed` |
| Standard CI | `31494468827` — passed |
| Exact-archive qualification | `31494468853` — passed |
| Automated matrix | 141/141 programs and 56/56 browser checks passed |
| Independent review | `912555dd-72ab-4662-9645-2313007eea3d` — failed: 16 actionable, 8 nitpicks |
| Latest remediation review | `04b93d36-47ea-402d-abda-ca6dfb2a9290` — failed raw inventory: 30 actionable (18 inline plus 12 summary/failed-post), 9 nitpicks; its successor remains unqualified |
| Decision | automated qualification passed; independent review failed; public-alpha NO-GO |

The portability failures remain evidence rather than being erased. Run
`31321447041` failed before authorization because the pull-request lineage
referred to a local-only accepted commit; live jobs were skipped. Earlier runs
`31290968279` and `31314330832` likewise stopped at continuity boundaries with
live jobs skipped. Their corrections established the published-tree continuity
model and do not convert those failed runs into passes.

## Independent-review remediation successor qualification: pending

The recorded baseline's automated gate is green but its independent review is
failed. Remediation changes packaged bytes. Qualification remains pending until
external evidence binds all automated results and a passing follow-up review to
the new source commit, tree, and archive SHA-256. Provider and hosted harnesses
remain source controls rather than executed live evidence.

Expected external records include the qualification JSON and closeout Markdown,
provider and hosted evidence artifacts, the signed manual accessibility audit,
dependency/security classifications, backup and isolated-restore proof,
rollback proof, and cohort cleanup/purge records. Executed evidence, provider
credential logs, database backup manifests, and raw provider responses do not
belong in the source archive.
