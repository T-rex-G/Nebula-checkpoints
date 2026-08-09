# Recorded Alpha.17 Automated Qualification Baseline

This document records the last immutable alpha.17 candidate that completed the
automated exact-archive boundary. It is prior evidence, not a self-attestation
for the documentation-truth successor now being built.

## Immutable identity

- Repository: `T-rex-G/Nebula-checkpoints`
- Draft PR: `#1`
- Branch: `agent/alpha17-evidence-integrity`
- Commit: `4aa3c378475dd7fdb490b206e0ca3cb88d027bbf`
- Tree: `29112ef5d5d9b4912b3e3ee1e71e44bfe36a9fdb`
- Candidate SHA-256: `d3e86f3aa16faefc165dca8acd726ca22f8a8f10fd5c943ef3addddbab40d2cc`
- Standard CI run: `31322778221`
- Qualification run: `31322778223`

## Automated proof

- Node.js `22.23.1` lockfile installation completed.
- 137/137 program tests passed.
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

The recorded baseline is **provider-stage GO** and **public-alpha NO-GO**.
It authorizes consideration of one later serialized provider-stage dispatch for
those exact bytes; it does not prove live providers, Render, Neon, manual
assistive technology, backup/restore, or final cohort readiness.

## Supersession rule

Markdown is part of the deterministic package. The documentation architecture
therefore creates a successor with different bytes. No hash in this file may be
relabelled as that successor's identity. The successor must complete the same
source and extracted-archive qualification, then record its identity in
external evidence before any live-provider dispatch.
