# Recorded Alpha.17 Automated Qualification Baseline

This document records the last immutable alpha.17 candidate that completed the
automated exact-archive boundary. It is prior evidence, not a self-attestation
for the successor now being built.

## Immutable identity

- Repository: `T-rex-G/Nebula-checkpoints`
- Draft PR: `#1`
- Branch: `agent/alpha17-evidence-integrity`
- Branch-head commit: `3995a81e64ced1011f7e5c0662307f270c67e2b8`
- Pull-request merge commit: `379f96daa85709bbc4c002f60501819690b00de2`
- Tree shared by both commit identities: `b0945a403beaa4c4242a1d6526aa7c3d80d48f08`
- Candidate SHA-256: `58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711`
- Standard CI run: `32540542681`
- Qualification run: `32540542682`

## Automated proof

- Node.js `22.23.1` lockfile installation completed.
- 142/142 program tests passed.
- 60/60 browser tests passed across the desktop/mobile matrix.
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

The automated exact-archive gate passed. Independent review
`4d47a6a5-e9d9-4a92-8a59-3883615069e8` returned no actionable findings against
this baseline. Earlier baselines did not clear that gate: review
`912555dd-72ab-4662-9645-2313007eea3d` failed with 16 actionable findings and
8 nitpicks, and later rounds failed again before the inventory was remediated.

Public alpha remains **NO-GO**. Live-provider, hosted, manual accessibility and
final release are still pending, and no automated result stands in for them.
No live-provider dispatch is authorized. The baseline also does not prove live
providers, Render, Neon, manual assistive technology, backup/restore, or final
cohort readiness.

## Supersession rule

Every remediation changes deterministic package bytes. No hash in this file may
be relabelled as the remediation successor's identity. The successor must
complete source and extracted-archive qualification plus independent follow-up
review, then record its identity in external evidence before any live-provider
dispatch.
