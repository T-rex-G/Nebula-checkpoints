# Alpha.17 Independent Review Dispositions

Review: `912555dd-72ab-4662-9645-2313007eea3d`

Public alpha: **NO-GO**

This record maps all 16 actionable findings and 8 nitpicks from the failed
independent review to the remediation boundary. It does not qualify its own
bytes. The exact remediation candidate and follow-up review result remain
external release evidence.

Immutable historical plans under `docs/history/` were not rewritten. Where a
review comment targeted a historical statement, the current executable
boundary was verified or strengthened and the disposition is explicit below.

| ID | Disposition | Remediation and verification boundary |
|---|---|---|
| A1 | Applied | `.env.example` leaves the snapshot key ID empty and retains the sample only as a comment, preventing an empty-secret startup trap. |
| A2 | Applied | Provider delete qualification now proves stale-head rejection with zero commit/file retention, then binds the valid delete result to the observed advanced head and file absence; `test/alpha17-provider-harness.test.js` rejects a forged delete commit. |
| A3 | Current boundary already satisfied | The immutable historical privacy plan remains unchanged. `server.js` and `AlphaPrivacyStore` reject `description` and other unsupported fields; privacy tests cover descriptions, repository content, and provider payloads. |
| A4 | Applied | The credential-exposure runbook requires verified-live-events reconnection and independent webhook-health verification after `SESSION_SECRET` rotation. |
| A5 | Applied | Failed-deploy health and readiness probes use `curl --fail`. |
| A6 | Applied | Snapshot legacy compatibility is staged and verified before `SESSION_SECRET` rotation; reconnection and webhook-health verification follow rotation. |
| A7 | Applied with supersession | Continuity is schema 4, not the stale schema 2/3 narration. It adds exact dual commit/tree identity and the failed independent-review gate. |
| A8 | Applied | The architecture design now names two root Markdown files plus machine-readable `WORK_CONTINUITY.json`. |
| A9 | Applied | Restore preview and destruction require official Neon control-plane URI matches for both declared branches plus a live target database/role session check before decryption or `pg_restore --clean`. |
| A10 | Applied | `resume-work` accepts only the recorded local-source or published commit paired with the accepted tree; an unrelated same-tree ancestor is rejected by test. |
| A11 | Rejected as weaker design | A precomputed digest embedded in the release would be circular/self-attested. ADR-072 reaffirms the ADR-063/067 runtime observation, and the server computes it once at startup. |
| A12 | Applied | Production no longer adds `SESSION_SECRET` implicitly to legacy snapshot verification; only `NV_SNAPSHOT_LEGACY_KEYS_JSON` grants compatibility. |
| A13 | Applied | `test/release-contract.test.js` computes expected release identity once before server spawn and reuses that frozen expectation. |
| A14 | Applied | Capacity verification probes use HTTPS-only `curl --fail`. |
| A15 | Applied | The manual accessibility template records and externally retains start/end `/api/version` responses and requires both runtime fingerprints to equal the frozen candidate. |
| A16 | Applied | Mobile and desktop manual audit entries require 320 CSS-pixel or 400% zoom reflow. |
| N1 | Current boundary proved | ADR-051 already forbids redirects and makes 3xx terminal. The worker regression test proves one transport call and terminal `WEBHOOK_HTTP_302`. |
| N2 | Applied | Restore fingerprint tests cover wrong, short, and non-hex values and fail through the intended validation path. |
| N3 | Applied | Secret-scanner tests cover the non-Git archive walk and excluded metadata/dependency/build directories. |
| N4 | Applied | The pinned Node version is checked at the first line of candidate qualification, before archive reads or extraction. |
| N5 | Applied | Automated, provider, and hosted evidence producers import the single `EVIDENCE_SCHEMA_VERSION` authority. |
| N6 | Applied | Release-fingerprint and secret-scanner exclusion collections use frozen arrays, avoiding the false immutability claim of a frozen mutable `Set`. |
| N7 | Applied | Server test fixtures use deterministic snapshot keys independent from their session-secret fixtures. |
| N8 | Applied | Render/Neon deployment verification includes `releaseTreeSha256` and requires equality with the frozen candidate fingerprint. |

The previously reported zero-read archive comparison loop is also closed: an
incomplete read fails immediately rather than retrying forever, with a focused
regression probe in `test/qualify-candidate-archive.test.js`.
