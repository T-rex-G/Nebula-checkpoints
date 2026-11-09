/*
 * Where a scan and its findings are kept.
 *
 * One rule decides the whole shape of this file: the server stores what it
 * learned about a repository and never any part of the repository itself. No
 * file contents, no source excerpt, no redacted line, no probe response, no
 * provider credential. `db/migrations/022_exposure_scans.sql` carries the half
 * of that which a schema can hold -- fingerprints and digests constrained to
 * fixed-length hex, the placeholder matched against a generated-label pattern,
 * and the locations of a credential inside a file stored as integer arrays,
 * which cannot hold a secret at all. This file carries the other half: every
 * row that leaves here is built field by field from named columns, never by
 * spreading a row, so a column added later is invisible until somebody adds it
 * to a serializer on purpose.
 *
 * The second theme is that nothing here concludes a credential is gone unless
 * it has the evidence to. A scan that was canceled, failed, truncated, run
 * under a different rule set or run against a different ref cannot mark a
 * finding as no longer present, because none of those things is evidence of
 * absence -- and a wall of findings quietly marked resolved is worse than no
 * scan at all. `concludeRemovedFromTree` refuses with a reason rather than
 * doing its best.
 *
 * And even when it does conclude, the word is not "resolved". A credential
 * that is no longer at HEAD is still in the repository's history, reachable by
 * anyone with a clone. `removed-from-tree` says exactly that much and no more.
 */

import { createHmac } from 'node:crypto';
/* A scan's states are the jobs contract's; its coverage is evidence. */
import { SCAN_STATES, TERMINAL_SCAN_STATES as TERMINAL_STATES } from '../../../../../../packages/contracts/src/jobs.ts';
import { EXPOSURE_COVERAGE as COVERAGE } from '../../../../../../packages/contracts/src/evidence.ts';
import { errorCode, type PoolClient, type QueryOutcome, type TransactionalPool } from '../../../platform/persistence/queryable.ts';
import {
  DEFAULT_CURSOR_KEY, boundedInteger, DEFAULT_SWEEP_BATCH, MAX_SWEEP_BATCH, fail, ExposureStoreError, type Fields
} from './exposure-records.ts';
import {
  requestScan, claimScan, renewClaim, recordObservations, finalizeScan, cancelScan, concludeRemovedFromTree
} from './exposure-scan-writes.ts';
import {
  markCredentialRejected, recordVerification, listVerifications, recordReadabilityProbe, latestAnswers,
  latestLocations, listReadabilityProbes, acceptRisk
} from './exposure-verifications.ts';
import {
  getScan, getFinding, workspaceSummary, workspaceTrend, workspaceFindings, listFindings, listFindingsPage,
  listObservations, listScans, scanRuleCounts, scanReport, scanReportPage
} from './exposure-reads.ts';
import { clearHistory, sweepExpiredScans } from './exposure-retention.ts';
import type { ExposureStoreContext } from './exposure-records.ts';
export {
  EXPOSURE_CONFIG_VERSION, SCAN_MODES, DECODINGS, SKIPPED_REASONS, DISPOSITIONS, DEFAULT_VERIFICATION_FRESHNESS_MS,
  DEFAULT_PROBE_FRESHNESS_MS, MAX_OCCURRENCES, MAX_FINDINGS_PER_SCAN, ExposureStoreError
} from './exposure-records.ts';
export type {
  Disposition, ExposureScope, ScanRecord, FindingRecord, ObservationRecord, VerificationRecord, ReadabilityProbeRecord
} from './exposure-records.ts';

export { COVERAGE, SCAN_STATES, TERMINAL_STATES };

/* ---- The store --------------------------------------------------------- */

export interface ExposureStoreOptions {
  readonly pool?: TransactionalPool | null;
  readonly cursorKey?: string | Buffer | null;
  readonly sweepBatch?: unknown;
}

export class ExposureStore {
  readonly pool: TransactionalPool;
  readonly cursorKey: Buffer;
  readonly sweepBatch: number;

  constructor(options: ExposureStoreOptions = {}) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('ExposureStore requires a pg-compatible pool');
    }
    this.pool = pool;
    this.cursorKey = createHmac('sha256', options.cursorKey || DEFAULT_CURSOR_KEY)
      .update('exposure-findings-cursor-v1').digest();
    this.sweepBatch = boundedInteger(options.sweepBatch, DEFAULT_SWEEP_BATCH, 1, MAX_SWEEP_BATCH);
  }

  /* What the store's operations read of it, as the class holds it when each runs. */
  get #context(): ExposureStoreContext {
    return {
      query: (sql, params, label) => this.#query(sql, params, label),
      transaction: (work, label) => this.#transaction(work, label),
      cursorKey: this.cursorKey,
      sweepBatch: this.sweepBatch
    };
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>, label: string): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      fail(`Exposure storage is unavailable: ${String(errorCode(error) || 'connect failed')}`);
    }
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is going away anyway */ }
      if (error instanceof ExposureStoreError || error instanceof TypeError) throw error;
      return fail(`Exposure storage could not ${label}: ${String(errorCode(error) || 'query failed')}`);
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  async #query(sql: string, params: readonly unknown[], label: string): Promise<QueryOutcome> {
    try {
      return await this.pool.query(sql, params);
    } catch (error) {
      return fail(`Exposure storage could not ${label}: ${String(errorCode(error) || 'query failed')}`);
    }
  }

  requestScan(input: Fields = {}) {
    return requestScan(this.#context, input);
  }

  claimScan(input: Fields = {}) {
    return claimScan(this.#context, input);
  }

  renewClaim(input: Fields = {}) {
    return renewClaim(this.#context, input);
  }

  recordObservations(input: Fields = {}) {
    return recordObservations(this.#context, input);
  }

  finalizeScan(input: Fields = {}) {
    return finalizeScan(this.#context, input);
  }

  cancelScan(input: Fields = {}) {
    return cancelScan(this.#context, input);
  }

  concludeRemovedFromTree(input: Fields = {}) {
    return concludeRemovedFromTree(this.#context, input);
  }

  markCredentialRejected(input: Fields = {}) {
    return markCredentialRejected(this.#context, input);
  }

  recordVerification(input: Fields = {}) {
    return recordVerification(this.#context, input);
  }

  listVerifications(input: Fields = {}) {
    return listVerifications(this.#context, input);
  }

  recordReadabilityProbe(input: Fields = {}) {
    return recordReadabilityProbe(this.#context, input);
  }

  latestAnswers(input: Fields = {}) {
    return latestAnswers(this.#context, input);
  }

  latestLocations(input: Fields = {}) {
    return latestLocations(this.#context, input);
  }

  listReadabilityProbes(input: Fields = {}) {
    return listReadabilityProbes(this.#context, input);
  }

  acceptRisk(input: Fields = {}) {
    return acceptRisk(this.#context, input);
  }

  getScan(input: Fields = {}) {
    return getScan(this.#context, input);
  }

  getFinding(input: Fields = {}) {
    return getFinding(this.#context, input);
  }

  workspaceSummary(input: Fields = {}) {
    return workspaceSummary(this.#context, input);
  }

  workspaceTrend(input: Fields = {}) {
    return workspaceTrend(this.#context, input);
  }

  workspaceFindings(input: Fields = {}) {
    return workspaceFindings(this.#context, input);
  }

  listFindings(input: Fields = {}) {
    return listFindings(this.#context, input);
  }

  listFindingsPage(input: Fields = {}) {
    return listFindingsPage(this.#context, input);
  }

  listObservations(input: Fields = {}) {
    return listObservations(this.#context, input);
  }

  listScans(input: Fields = {}) {
    return listScans(this.#context, input);
  }

  scanRuleCounts(input: Fields = {}) {
    return scanRuleCounts(this.#context, input);
  }

  scanReport(input: Fields = {}) {
    return scanReport(this.#context, input);
  }

  scanReportPage(input: Fields = {}) {
    return scanReportPage(this.#context, input);
  }

  clearHistory(input: Fields = {}) {
    return clearHistory(this.#context, input);
  }

  sweepExpiredScans(input: Fields = {}) {
    return sweepExpiredScans(this.#context, input);
  }
}
