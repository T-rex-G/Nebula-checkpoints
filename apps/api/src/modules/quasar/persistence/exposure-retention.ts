import {
  boundedInteger, MAX_SWEEP_BATCH, fail, requireScope, requireDigest, instant, historyScopeLockKey, rowsOf,
  type Fields
} from './exposure-records.ts';
import type { ExposureStoreContext } from './exposure-records.ts';

/*
 * Forgetting: a repository's scan history cleared on request, and scans
 * past their retention swept in bounded batches.
 */

/*
 * Clearing: everything this identity has recorded about this repository --
 * its scans, what they observed, its findings, and the verification and
 * readability history attached to them, which leave with their findings by
 * cascade. One transaction, so a clear is all of it or none of it.
 *
 * Refused while a scan is queued or running. Clearing underneath a scan
 * would leave it writing observations for findings that no longer exist,
 * and the reader would see results reappear a minute after pressing clear.
 * The refusal names the fix: cancel the scan first.
 *
 * Only this identity's rows, and only this repository's. Another person's
 * findings for the same repository are theirs, and a governance
 * administrator's decisions on their own copy are untouched. What does
 * survive is the governance ledger's record that a clear happened, which is
 * written by the route, not here -- so clearing the evidence of a decision
 * never clears the evidence of the clear.
 */
export async function clearHistory(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Clear identity');
  return store.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [historyScopeLockKey(scope, identityKey)]);
    const active = await client.query(
      `SELECT scan_id FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND state IN ('queued','running')
        FOR UPDATE`,
      [scope.provider, scope.authority, scope.owner, scope.repo, identityKey]
    );
    if (rowsOf(active).length) {
      fail('A scan is in progress; cancel it before clearing', 'EXPOSURE_SCAN_ACTIVE', 409);
    }
    const scans = await client.query(
      `DELETE FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND state IN ('complete','partial','failed','canceled')
       RETURNING scan_id`,
      [scope.provider, scope.authority, scope.owner, scope.repo, identityKey]
    );
    const findings = await client.query(
      `DELETE FROM nv_exposure_findings
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5
       RETURNING fingerprint`,
      [scope.provider, scope.authority, scope.owner, scope.repo, identityKey]
    );
    return Object.freeze({ scans: rowsOf(scans).length, findings: rowsOf(findings).length });
  }, 'clear exposure history');
}

/*
 * Retention. A bounded slice at a time, and only scans past their own
 * retention date -- the findings survive, because a finding is the durable
 * record and an observation is the detail of one measurement. Deleting a
 * scan therefore ages out what was seen where without forgetting that a
 * credential was ever exposed.
 */
export async function sweepExpiredScans(store: ExposureStoreContext, input: Fields = {}) {
  const now = instant(input.now == null ? Date.now() : input.now, 'Sweep time');
  const limit = boundedInteger(input.limit, store.sweepBatch, 1, MAX_SWEEP_BATCH);
  const deleted = await store.query(
    `DELETE FROM nv_exposure_scans
      WHERE ctid IN (
        SELECT ctid FROM nv_exposure_scans
         WHERE retain_until <= $1 AND state IN ('complete','partial','failed','canceled')
         ORDER BY retain_until
         LIMIT $2
      )
     RETURNING scan_id`,
    [now, limit],
    'sweep expired scans'
  );
  return rowsOf(deleted).length;
}
