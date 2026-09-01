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

  return { MAX_BATCH_ITEMS, planBatchCommits };
});
