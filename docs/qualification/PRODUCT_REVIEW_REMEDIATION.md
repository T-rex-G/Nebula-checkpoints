# Product review remediation — PR #72

This change addresses the 2 October 2026 product review on top of PR #72.
Its scope is source remediation and repeatable qualification. Merge, production
deployment, cohort admission and independent release approval remain separate.

**7 October scope update:** The current successor supports GitHub only in the
product and golden qualification. Retired-provider implementation details below
record the PR #72 remediation history; they do not advertise an active
integration or require new retired-provider qualification.

## Findings and evidence

| Finding | Change | Repeatable evidence / remaining requirement |
| --- | --- | --- |
| C1: idle PostgreSQL disconnect terminates the process | Pool and checked-out connection errors invalidate readiness without an unhandled event; reconnect generation guards prevent a stale healthy state | `npm run test:database-resilience`: actual backend termination, readiness drain/recovery, live HTTP process, checked-out and active-query failure |
| C2: restore runner expects migration 015 | Runner and signed-record validation derive the latest migration from the candidate inventory | Restore contract regressions reject 015 for this candidate. `npm run test:restore-integration` runs real dump, encrypted backup, verify and restore on PostgreSQL 17, then verifies restored data |
| C3: missing current live/manual qualification | Historical runs are labelled as history; current candidate evidence is kept separate | Fresh disposable GitHub, hosted restore, independent witness and manual accessibility evidence remain required |
| W1: availability presented as verification | Workspace pulse separates Supported / Experimental / Unavailable from provider evidence; missing evidence earns no verification credit | Workspace pulse unit and browser tests cover unknown, partial and complete evidence |
| W2: copied local cookie survives logout indefinitely | Signed absolute lifetime plus bounded revocation store; restarting the single-process local profile invalidates old cookies | Local session tests reproduce saved-cookie replay, expiry, restart, non-sliding lifetime and full revocation capacity |
| W3: provider DNS validation is separated from connection | HTTPS provider transport pins each socket to validated public DNS answers and preserves hostname verification; redirects are refused | Real TLS transport tests cover binary writes, DNS rebinding, private/transition addresses, TLS failure, redirects, body limits and stalled bodies. Real HTTP route tests prove failed ZIP/raw streams and client cancellations leave the server alive |
| W4: direct callers can choose forwarded rate-limit identity | Proxy trust defaults off; explicit verified IP/CIDR allowlist replaces hop-count trust | Real-server rotating-XFF flood plus trusted/untrusted proxy-chain tests |
| W5: main lacks enforced review/check rules | Reviewable `config/github-main-ruleset.json` requires PR approval, last-push review, resolved threads and the configured required CI checks, and blocks force push/deletion | **Proposed, not installed.** An administrator must apply and read back the ruleset after confirming actual check names and access. Protected settings returned HTTP 403 to the connected token |
| W6: New file writes before promised preview | Creation stages locally; commit review names repository, branch, expected head, message and actual diff. Changed scope or staged content invalidates review | Browser cancellation/confirmation, existing-file and unreadable-original refusal, and pending-preview invalidation; server concurrency checks remain authoritative |
| W7: onboarding overstates limits and token safety | Show runtime upload limits before connection; selected-repository fine-grained token guidance and configured GitHub App path; accurate HttpOnly browser-cookie copy | Connection-screen browser test checks actual runtime ceilings and permission guidance |
| W8: current documentation contradicts registry and workflow | Current capability counts are generated; availability and evidence use separate columns; dispatch instructions describe the run-minted envelope accurately | `npm run docs:check`, continuity generation and documentation contracts; historical archives remain historical |
| W9: browser CI failures lose diagnostics | CI, exact-archive automation and browser shards retain failure traces/screenshots with unique artifact names and three-day retention | Workflow contracts plus actual failing browser trace creation. These jobs use synthetic credentials; live jobs do not upload browser session traces |
| W10: browser fixtures skip server/database integration and WebKit | Separate Chromium and WebKit journey exercises real application routes, PostgreSQL encrypted sessions, provider TCP boundary, file commit/readback and logout replay refusal. Layout-driven editor refresh and deferred chart redraw fix WebKit reload/resize defects | `npm run test:integration`, repeated from the extracted release archive. Upstream GitHub is a disposable synthetic HTTP adapter; this is not live-provider qualification or manual assistive-technology testing |
| W11: readiness and query budgets are incomplete | Connection, statement, query, lock and idle-transaction deadlines; candidate-bound deployment readiness command | Real PostgreSQL fault/lock/timeout tests. `npm run check:deployment` refuses missing DB, maintenance, schema/fingerprint mismatch, gate-off cohort mode, redirects and stalled responses |
| W12: mobile repository choice is below the fold | Compact repository introduction and collapsible summary keep filter and repository choices visible | 320 px and 390 px viewport assertions in both designs and themes; desktop/mobile browser suite |
| W13: observed Render service has access gate off | Cohort readiness requires invitation mode; explicit operator-verification purpose is labelled separately | Read-only deployment gate and runbook. This PR does not change the observed service or claim it runs this candidate |

## Qualification boundaries

The new integration gates run on PostgreSQL 17 with Chromium and WebKit. The
browser calls the real application over HTTP; only the fixed GitHub upstream
is replaced by a loopback HTTP service. No browser API interception is used.
The backup test replaces only Neon ownership verification with an adapter
restricted to newly created scratch databases. PostgreSQL data, TLS verification,
dump, encryption, decryption, restore and migration checks are real. These local
tests deliberately do not mint a hosted or provider attestation.

Exact-archive automation runs the new database fault, encrypted restore and
browser integration gates against the extracted candidate. The integration
report records archive SHA-256, source commit and report digest. Any failure
fails the job. Existing broad fixture coverage and signed qualification gates
remain in place; passing these added checks does not complete all release gates.

## Operational handoff

1. Review and merge only after CI is green on the final PR commit and an
   independent reviewer has assessed the change. The PR's live check status is
   authoritative; this document does not predeclare a successful future run.
2. Apply and read back the proposed main ruleset with administrator access.
   Check that `verify`, `automated` and `integration` are emitted by GitHub
   Actions for the intended branch. No bypass actor is supplied.
3. Freeze a release archive and independently review its exact bytes. Use
   verified disposable targets for fresh live-provider and hosted qualification.
   The connected token cannot read the target variables; earlier target names
   are insufficient evidence that current configured targets match.
4. Use PostgreSQL 17 clients for backup and restore. Production CLI still
   requires `sslmode=verify-full`, reviewed isolated target identity and Neon
   ownership checks. Never direct qualification restore at the cohort database.
5. Off Render, set verified `NV_TRUSTED_PROXIES` ingress ranges before hosted
   traffic tests; on Render exactly one ingress hop is trusted by default.
   Run `npm run check:deployment` from the frozen candidate with
   `NV_ALPHA_BASE_URL` and `NV_EXPECTED_RELEASE_TREE_SHA256` from that archive.
   The default cohort purpose requires invitation mode. Operator verification
   may inspect a gate-off service but does not authorize cohort admission.
6. Complete manual keyboard/screen-reader testing and an independent restore
   witness, then run the existing final qualification gate. CI signatures and
   synthetic tests cannot substitute for either record.

Database-free sessions are intentionally single-process and require sign-in
after restart. A full revocation store refuses sign-out with an explicit error
rather than evicting an unexpired revocation. Hosted sessions continue to use
the shared database. Query deadlines may reject operations that previously
hung indefinitely; use sanitized SQLSTATE/correlation evidence to investigate.
