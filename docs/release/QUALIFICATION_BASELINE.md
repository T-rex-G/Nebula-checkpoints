# Recorded Alpha.17 Automated Qualification Baseline

This document records the last immutable alpha.17 candidate that completed the
automated exact-archive boundary. It is prior evidence, not a self-attestation
for the independent-review remediation successor now being built.

## Immutable identity

- Repository: `T-rex-G/Nebula-checkpoints`
- Draft PR: `#1`
- Branch: `agent/alpha17-evidence-integrity`
- Local source commit: `c67d92edb8c63f11ada74cfdc7835f8a4b387a1c`
- Published draft-PR commit: `d6628de48a32c3a2790dabeec60ec7b7b2ebab49`
- Tree shared by both commit identities: `7bcc2c27029cc1013f176d1070e2cd38a8e69811`
- Candidate SHA-256: `1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed`
- Standard CI run: `31494468827`
- Qualification run: `31494468853`

## Automated proof

- Node.js `22.23.1` lockfile installation completed.
- 141/141 program tests passed.
- 56/56 browser tests passed across the desktop/mobile matrix.
- Production and development audits reported zero vulnerabilities.
- Syntax and expanded repository secret scanning passed.
- Two release builds were byte-identical.
- The candidate was extracted into a fresh root, installed from its lockfile,
  and qualified again from those exact archive bytes.
- Program, browser, canonical-content, exact-file, archive, and evidence hashes
  were independently recomputed and matched.
- Provider, hosted, manual-accessibility, and final-gate jobs were skipped on
  the pull-request event as designed.

## Decision boundary

The automated exact-archive gate passed, but independent review
`912555dd-72ab-4662-9645-2313007eea3d` failed with 16 actionable findings and
8 nitpicks. The recorded baseline and public alpha are therefore **NO-GO**.
No live-provider dispatch is authorized. The baseline also does not prove live
providers, Render, Neon, manual assistive technology, backup/restore, or final
cohort readiness.

## Supersession rule

Every remediation changes deterministic package bytes. No hash in this file may
be relabelled as the remediation successor's identity. The successor must
complete source and extracted-archive qualification plus independent follow-up
review, then record its identity in external evidence before any live-provider
dispatch.
