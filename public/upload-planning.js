/* Nebulaverse-X upload planning — how a queue of files becomes commits. */
'use strict';
(function universal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NebulaUploadPlanning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildUploadPlanning() {
  /*
   * The server commits at most this many operations in one atomic batch. The
   * number is mirrored here so the queue can be planned before a single blob is
   * uploaded; a contract test holds it equal to the server's own limit, because
   * the two drifting apart is exactly how a queue gets uploaded and then
   * refused.
   */
  const MAX_BATCH_ITEMS = 100;

  /*
   * Split a queue into the commits it will actually take.
   *
   * One group is one atomic commit. More than one group is more than one
   * commit, and that has to be said rather than implied: "all as one commit" is
   * a promise the queue can outgrow.
   */
  function planBatchCommits(count, limit = MAX_BATCH_ITEMS) {
    const total = Number(count);
    const size = Number(limit);
    if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('Upload queue size must be a whole number');
    if (!Number.isSafeInteger(size) || size < 1) throw new TypeError('Batch limit must be a positive whole number');
    if (total === 0) return Object.freeze({ total, limit: size, commits: 0, groups: Object.freeze([]), atomic: true });
    const groups = [];
    for (let start = 0; start < total; start += size) {
      groups.push(Object.freeze({ start, end: Math.min(start + size, total), size: Math.min(size, total - start) }));
    }
    return Object.freeze({
      total,
      limit: size,
      commits: groups.length,
      groups: Object.freeze(groups),
      atomic: groups.length === 1
    });
  }

  /*
   * How one file gets carried, and who decides.
   *
   * The transport used to be decided by size alone: anything above the native
   * push ceiling went to Git LFS whether or not that was wanted, and there was
   * no way to ask for ordinary Git and be given it. A reader who had pushed
   * 60-80 MB videos through Git before had no control left at all.
   *
   * So the request comes first and the ceiling second. `git` and `lfs` are
   * honoured whenever the deployment can honour them; when one cannot be
   * honoured the other is used and the swap is named, so an upload that has
   * already been transferred is never thrown away over a preference. Only when
   * neither transport can carry the file is it refused.
   *
   * The browser calls this to label a queued file and the server calls it to
   * route the upload, so what is shown and what happens are one decision
   * rather than two that agree by luck.
   */
  const TRANSPORT_CHOICES = Object.freeze(['auto', 'git', 'lfs']);
  /* `force` was the old wire value for "use LFS". Callers that still send it
   * keep working; it is not offered as a choice. */
  const TRANSPORT_ALIASES = Object.freeze({ force: 'lfs' });

  function normalizeTransportChoice(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    const resolved = TRANSPORT_ALIASES[raw] || raw;
    return TRANSPORT_CHOICES.includes(resolved) ? resolved : 'auto';
  }

  function planUploadTransport(options) {
    const settings = options || {};
    /*
     * Numbers only, and real ones. Coercing would turn a missing size into
     * Number(null) === 0 and plan a file nobody measured as a small one --
     * a guess dressed as a decision.
     */
    const measured = (value, label, minimum) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
        throw new TypeError(`${label} must be a finite number of at least ${minimum}`);
      }
      return value;
    };
    const size = measured(settings.size, 'Upload size', 0);
    const gitPushMaxBytes = measured(settings.gitPushMaxBytes, 'gitPushMaxBytes', 1);
    const gitDataMaxBytes = measured(settings.gitDataMaxBytes, 'gitDataMaxBytes', 1);
    const lfsAvailable = !!settings.lfsAvailable;
    const requested = normalizeTransportChoice(settings.requested);

    /* The ceiling in the reader's units, taken from the ceiling itself so the
     * number in the sentence cannot drift from the number being enforced. */
    const gitPushMaxMb = Math.round(gitPushMaxBytes / 1048576);
    const overGitCeiling = size > gitPushMaxBytes;
    const gitRoute = size > gitDataMaxBytes ? 'git-push' : 'git-data';

    const plan = (route, fallback) => Object.freeze({
      requested, route, lfsAvailable, gitPushMaxMb,
      fallback: fallback ? Object.freeze(fallback) : null,
      refusal: null
    });
    const refuse = (message) => Object.freeze({
      requested, route: null, lfsAvailable, gitPushMaxMb,
      fallback: null,
      refusal: Object.freeze({ status: 413, message })
    });

    if (requested === 'lfs') {
      if (lfsAvailable) return plan('lfs', null);
      /* Asked for LFS where there is none. Git can still carry a file under the
       * ceiling, so it does, and the swap is reported rather than performed
       * quietly under a label the reader did not choose. */
      if (!overGitCeiling) {
        return plan(gitRoute, { from: 'lfs', to: 'git', reason: 'Git LFS is GitHub-only on this deployment' });
      }
      return refuse(`Files over ${gitPushMaxMb} MB require Git LFS on this deployment, which is GitHub-only for now`);
    }

    if (requested === 'git') {
      if (!overGitCeiling) return plan(gitRoute, null);
      /* Asked for ordinary Git above what this deployment will push. LFS is the
       * safe fallback, not a refusal: the bytes are already here. */
      if (lfsAvailable) {
        return plan('lfs', {
          from: 'git', to: 'lfs',
          reason: `the file is over the ${gitPushMaxMb} MB native Git push ceiling on this deployment`
        });
      }
      return refuse(`Native Git push is limited to ${gitPushMaxMb} MB on this deployment, and Git LFS is GitHub-only for now`);
    }

    if (overGitCeiling) {
      if (lfsAvailable) return plan('lfs', null);
      return refuse(`Files over ${gitPushMaxMb} MB require Git LFS on this deployment, which is GitHub-only for now`);
    }
    return plan(gitRoute, null);
  }

  return { MAX_BATCH_ITEMS, planBatchCommits, TRANSPORT_CHOICES, normalizeTransportChoice, planUploadTransport };
});
