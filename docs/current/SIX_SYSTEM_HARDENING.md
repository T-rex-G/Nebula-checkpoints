# Six-system hardening review — PR #81

Review date: 10 October 2026. Baseline: `c508a798af7739f785d080bb92998d2f266feae8`.
Scope: the six named product systems, their server routes, browser lifecycle,
worker cancellation, durable evidence and policy enforcement. GitHub remains
the only supported repository provider and golden qualification target.

This is a code and regression review for an **open, unmerged PR**, not an
enterprise certification or release approval. The product remains public-alpha
NO-GO until candidate-bound live, hosted, accessibility and release gates pass.

## Confirmed defects and corrections

| System | Reproduced failure | Correction and regression evidence |
| --- | --- | --- |
| Pulsar Map | The selected branch could be connected to another branch's commits; list order invented ancestry. Failed sources appeared empty/healthy, and interrupted catch-up could lose events. | Request the selected ref; use provider parent SHAs and actual ref heads. Preserve explicit unavailable/truncated source states, signature validity and critical exposure risk. Accept event pages with their cursor, reconnect cached views, and discard cancelled/stale loads. `pulsar-reliability.test.js` and a real local HTTP activity test exercise these cases. |
| Kepler Twin | Rollback/reactivation bypassed the 100-active-policy limit, making runtime evaluation unavailable. Exact retries recomputed against the changed head and rejected their own successful receipt. “Recent” decisions showed the oldest page. | Serialize every inactive-to-active admission; retain existing receipt fingerprints while binding replayed scenarios and authorization. Recompute new transitions under the transaction's locks. Use latest-first decision pages with an older-than cursor; retain explicit ascending API compatibility. Real PostgreSQL tests cover concurrent admission, replay, isolation, runtime denial and pagination. |
| Quasar Scanner | Stopping at the previous scan tip missed an older-dated side branch merged later. Pagination outlived lease/access/deadline checks. Out-of-order verification changed disposition, repeated sightings inflated counts, and older reports borrowed a later scan's commit. | Re-read bounded reachable history and expose budget limits; check access/deadline before each page. Reconcile verdicts monotonically, deduplicate per-scan commit sightings, derive report provenance from that scan, and serialize history clearing against scan creation. Reports have bound cursors and the browser reads all five possible 100-row pages. Public finding paths are redacted. Reader/worker, real PostgreSQL and client regression tests cover these boundaries. |
| Uranus Engine | Incomplete detector/advisory evidence could mark old findings resolved; cancelled work continued through workers and history. Concurrent completions could duplicate resolution records; delayed older audits could erase the latest dependency watch. A nested package could borrow an unrelated root lock version, and an overflow manifest or malformed/paginated advisory response could look clean. | Cancel queued/running analysis and guard every persistence stage. Serialize repository history per identity; preserve chronological watch inventories and refuse resolution claims from older observations. Resolve findings only with complete evidence; retain separate analysis completeness rather than relabel file coverage. Treat omitted semantic inventory and incomplete advisory answers as unknown. Bind npm lock resolution to the applicable package/workspace. Incomplete or legacy-unknown analysis cannot present a current merge gate. Module, worker, route-seam and real PostgreSQL tests prove the changed behavior. |
| Parallax Probe | A pre-cancelled scan still made requests; shared robots groups were misread; invalid security policy values and a root debug console could look protective. Rendered evidence could describe a later error page; target secrets appeared in polling URLs. Disposing a pending browser launch orphaned it. | Link cancellation to DNS/network/worker budgets; parse grouped exclusions and policy tokens conservatively; inspect root debug signatures. Validate the final main document throughout capture, reject credential-bearing target queries, redact display URLs and poll/cancel by an identity-bound run identifier. Cancel delayed launch acknowledgments. Synthetic transports and real Chromium regressions cover these cases. |
| Corona Guard | A successful containment purged its own UI context, then reported failure. A failed durable safety read fell back to permissive session state; a concurrent protected-path edit could undo emergency controls. In-flight session saves recreated revoked SIDs. Ref preflight followed by force update overwrote a concurrent push; hosted-alpha activation set global controls that its UI could not release. | Preserve operation context across purge and separate containment from evidence-download status. Configured safety lookup failures block writes; explicit safety changes apply under an identity lock to the latest stored state; existing SIDs are update-only and fresh sign-in rotates a missing SID. Ref recovery creates absent branches only; existing-ref reset grants are refused before provider access. Hosted alpha refuses identity-wide Emergency Shield before effects. Real HTTP/PostgreSQL fault and race tests, plus actual route/UI execution tests, cover the failures. |

Shared audit capacity now remains occupied until underlying work actually
settles, even after its visible result is cancelled, forgotten or timed out.
Closing a guarded network session also cancels pending DNS work. These bounds
prevent repeated cancellation from admitting unbounded concurrent work.

## Compatibility and operation

- Apply the additive migrations through the normal reviewed migration process
  before starting this candidate. Migration 031 records unique history commit
  sightings; migration 032 retains analysis completeness separately from file
  completeness. Old evidence is not silently relabeled as complete. Stop and
  drain application requests and scan workers before upgrading or rolling back;
  concurrent old/new writers against safety state, audit history or the observation ledger
  are not supported. The database
  default remains unknown unless the new writer explicitly records exactness.
- Previously inflated history counts cannot be reconstructed exactly from
  aggregated records alone. Legacy history counts are returned as unknown (`null`),
  while new sightings are deduplicated; no backfill invents exact counts.
- Existing durable sessions cannot be resurrected by a late save. A fresh,
  successful authentication can issue a new SID; the revoked cookie remains
  unusable. Already-dispatched provider requests cannot be universally recalled.
- Restoring an existing branch's file contents remains available through commit
  restoration, which creates a commit and uses a non-force ref update. Snapshot
  reference restoration now only recreates missing branches. Do not emulate an
  atomic reset with another preflight read: GitHub's ref PATCH has no
  expected-old compare-and-swap parameter.
- Hosted-alpha operators use repository Safeguards and session revocation.
  Identity-wide Emergency Shield is unavailable there; a future repository-wide
  containment feature needs its own recoverable scope and authorization model.
- History scanning repeats a bounded reachable-history read instead of assuming
  the prior tip is an ancestry boundary. This costs more reads; reaching the
  budget is partial coverage, never proof that all history is clean.
- Rendered audit schema 2 includes sanitized requested/final page URLs and
  final status. Ordinary query parameters still select the requested public
  page; known credential/signed parameters are refused rather than stripped.
  Polling and cancellation no longer repeat the target URL. Browser routing
  does not intercept every subsequent redirect hop; the deny-by-default proxy
  can therefore make redirected pages unavailable. This fails closed rather
  than providing a complete rendered report for those pages.
- Rollback means reverting the application change under the normal deployment
  review. Do not drop evidence tables or manufacture complete flags to make an
  older client look healthy. No deployment or rollback was executed for this PR.

## Verification and review boundaries

Focused regressions were first observed failing against the affected behavior,
then passing after the correction. The tests use Node 22.23.1, disposable
PostgreSQL 17 databases, synthetic provider responses and local Chromium/WebKit.
They do not exercise customer repositories or discovered live credentials.

The PR handoff records the integrated syntax, lint, type, unit, PostgreSQL,
restore, browser and exact-head CI results. A previous green run belongs to
its previous commit. Read the checks attached to this PR's current head before
reviewing or approving it.

The next reviewer should concentrate on transaction lock order and receipt
compatibility; migration/backfill semantics; cancellation during persistence;
unknown versus complete evidence; cursor isolation; and recovery refusal before
provider mutation. The public GitHub-only and documentation-cleanup constraints
remain part of that review.

## Remaining qualification gaps

These are explicit limits and follow-up work, not completed enhancements:

1. **Sensitive filenames at rest.** Public finding DTOs redact credential-shaped
   path segments. The internal exact Git path is still retained to re-read and
   fingerprint a finding. A credential embedded in a filename can therefore
   remain in database metadata. Encrypted locators or immutable blob references
   require a migration and key/retention design; the product must not claim that
   no possible credential can occur in stored metadata.
2. **Probe admission across requests/instances.** Verification requires explicit
   authorization and bounded transports. Batch limits/backoff do not establish
   a durable, shared per-provider cooldown for independent single-finding
   requests. Shared admission and Retry-After persistence remain to qualify.
3. **Analysis bounds.** Lexical/data-flow checks, package inventory, history scans,
   graph nodes and Twin inventories are bounded. Missing coverage is evidence
   of uncertainty. Policy simulation is scenario-based, not proof of the full
   runtime fact space or every active-policy/exception combination.
4. **Containment is not atomic across services.** Provider snapshot capture,
   application controls, session revocation and evidence persistence are separate
   steps. A capture failure can prevent activation; a later failure can leave
   some controls active. The UI says an interrupted result needs verification.
   App-local controls do not revoke external GitHub tokens or stop provider-side
   automation. A recovery manifest is not a Git object/LFS backup.
5. **Hosted and scale proof.** No new live GitHub qualification, production
   incident drill, multi-instance load/SLO exercise, Chromium process-memory
   guarantee, manual screen-reader pass or independent final AI review is
   claimed. Rendered checks are anonymous, bounded samples, not an arbitrary
   site's full functional/security/accessibility certification.

Leave PR #81 open for independent review. Merge, deployment and cohort opening
remain outside this handoff.
