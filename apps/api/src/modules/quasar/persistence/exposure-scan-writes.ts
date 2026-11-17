import { randomUUID } from 'node:crypto';
import { TERMINAL_SCAN_STATES as TERMINAL_STATES } from '../../../../../../packages/contracts/src/jobs.ts';
import { EXPOSURE_COVERAGE as COVERAGE } from '../../../../../../packages/contracts/src/evidence.ts';
import { trimmedText } from '../../../platform/values/fields.ts';
import {
  boundedInteger, fail, requireScope, requireDigest, requireText, requireCommit, instant, DEFAULT_RETENTION_MS,
  requireMember, SCAN_MODES, requireVersion, EXPOSURE_CONFIG_VERSION, historyScopeLockKey, rowsOf, scanOf,
  DEFAULT_LEASE_MS, MAX_LEASE_MS, claimToken, MAX_FINDINGS_PER_SCAN, normalizeFinding, SKIPPED_REASONS, scanFromRow,
  type Fields
} from './exposure-records.ts';
import type { ExposureStoreContext } from './exposure-records.ts';

/*
 * A scan's life in the store: requested once per repository and key, claimed
 * under a lease by one worker, renewed while it runs, written in batches of
 * observations, finished or cancelled, and the findings a later scan no
 * longer sees concluded. Each write is one statement or one transaction, and
 * the lease is checked in the same statement that writes under it.
 */

/*
 * Requesting a scan. Idempotency and single-ownership are both the
 * database's, and one insert settles both.
 *
 * `ON CONFLICT DO NOTHING` without a target covers every unique index on the
 * table, which is what makes the two outcomes distinguishable afterwards: no
 * row and a matching idempotency key means this is a repeat of a request
 * already accepted, and no row with no matching key means the conflict was
 * the partial index that allows one live scan per repository. Naming one
 * constraint in the conflict clause would have made the other an exception
 * instead of an answer.
 */
export async function requestScan(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const requestedBy = requireText(input.requestedBy, 'Scan actor', 255);
  const refName = requireText(input.refName, 'Scan ref', 255);
  const commitSha = requireCommit(input.commitSha);
  const keyId = input.fingerprintKeyId == null ? null : requireDigest(input.fingerprintKeyId, 'Fingerprint key id');
  const idempotencyKey = requireText(input.idempotencyKey, 'Scan idempotency key', 200);
  if (idempotencyKey.length < 8) throw new TypeError('Scan idempotency key must be at least 8 characters');
  const scanId = trimmedText(input.scanId) || randomUUID();
  const now = instant(input.now == null ? Date.now() : input.now, 'Scan time');
  const retainUntil = input.retainUntil == null
    ? new Date(now.getTime() + DEFAULT_RETENTION_MS)
    : instant(input.retainUntil, 'Scan retention');
  const scanMode = input.scanMode == null ? 'tree' : requireMember(input.scanMode, SCAN_MODES, 'Scan mode');
  const versions = {
    rules: requireVersion(input.rulesVersion, 'Rules version'),
    engine: requireVersion(input.engineVersion, 'Engine version'),
    fingerprintKey: requireVersion(input.fingerprintKeyVersion, 'Fingerprint key version'),
    config: requireVersion(input.configVersion == null ? EXPOSURE_CONFIG_VERSION : input.configVersion, 'Config version')
  };

  return store.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [historyScopeLockKey(scope, identityKey)]);
    /* The prior tip remains provenance only. The worker re-reads bounded
       reachable history because a date-ordered tip is not an ancestry fence. */
    const inserted = await client.query(
      `INSERT INTO nv_exposure_scans (
         scan_id, provider, authority, owner_login, repo_name, identity_key, requested_by,
         ref_name, commit_sha, rules_version, engine_version, fingerprint_key_version,
         config_version, state, coverage, idempotency_key, retain_until, created_at, fingerprint_key_id,
         scan_mode, history_base_commit
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued','unknown',$14,$15,$16,$17,$18::text,
         CASE WHEN $18::text = 'history' THEN (
           SELECT previous.commit_sha FROM nv_exposure_scans AS previous
            WHERE previous.provider=$2 AND previous.authority=$3 AND previous.owner_login=$4
              AND previous.repo_name=$5 AND previous.identity_key=$6 AND previous.ref_name=$8
              AND previous.scan_mode='history' AND previous.state='complete'
              AND previous.rules_version=$10 AND previous.engine_version=$11
              AND previous.fingerprint_key_version=$12 AND previous.config_version=$13
              AND previous.fingerprint_key_id IS NOT DISTINCT FROM $17
            ORDER BY previous.finished_at DESC, previous.scan_id DESC
            LIMIT 1) ELSE NULL END)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        scanId, scope.provider, scope.authority, scope.owner, scope.repo, identityKey, requestedBy,
        refName, commitSha, versions.rules, versions.engine, versions.fingerprintKey,
        versions.config, idempotencyKey, retainUntil, now, keyId, scanMode
      ]
    );
    const created = rowsOf(inserted)[0];
    if (created) {
      return Object.freeze({ scan: scanOf(created), created: true });
    }

    const existing = await client.query(
      `SELECT * FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND idempotency_key=$5 AND identity_key=$6`,
      [scope.provider, scope.authority, scope.owner, scope.repo, idempotencyKey, identityKey]
    );
    const repeated = rowsOf(existing)[0];
    if (repeated) {
      return Object.freeze({ scan: scanOf(repeated), created: false });
    }
    return fail(
      'This repository already has a scan in progress',
      'EXPOSURE_SCAN_ALREADY_ACTIVE',
      409
    );
  }, 'accept a scan request');
}

/*
 * Claiming work. One statement, and it is worth being exact about which part
 * of it makes two workers unable to claim one scan -- because sabotaging the
 * obvious candidate does not break it.
 *
 * The guarantee is the predicate. Under READ COMMITTED, a second claimer
 * that blocks on the row's lock re-evaluates the qualifying conditions once
 * the first commits, and by then the row is `running` with a live lease and
 * no longer qualifies, so the second claimer gets nothing. `FOR UPDATE SKIP
 * LOCKED` is a throughput choice on top of that: it lets a second worker
 * move on to another scan instead of queueing behind a row it is about to be
 * told it cannot have.
 *
 * The fencing token is fresh per claim, which is what stops a worker that
 * stalled through its lease from finalising a job somebody else now owns: it
 * still holds the old token, and every write it can attempt matches on the
 * current one. A running scan whose lease has expired is claimable again,
 * which makes a killed worker's job recoverable without anything having to
 * notice that it died -- no heartbeat to trust, no `finally` block to hope
 * ran.
 */
export async function claimScan(store: ExposureStoreContext, input: Fields = {}) {
  const now = instant(input.now == null ? Date.now() : input.now, 'Claim time');
  const leaseMs = boundedInteger(input.leaseMs, DEFAULT_LEASE_MS, 1000, MAX_LEASE_MS);
  const owner = claimToken();
  const claimed = await store.query(
    `UPDATE nv_exposure_scans AS target
        SET state='running',
            claim_owner=$1,
            claim_expires_at=$2::timestamptz + ($3::double precision / 1000.0) * interval '1 second',
            started_at=COALESCE(target.started_at, $2)
      WHERE target.scan_id = (
              SELECT candidate.scan_id FROM nv_exposure_scans AS candidate
               WHERE candidate.state='queued'
                  OR (candidate.state='running' AND candidate.claim_expires_at <= $2)
               ORDER BY candidate.created_at
               LIMIT 1
               FOR UPDATE SKIP LOCKED
            )
        AND (target.state='queued' OR (target.state='running' AND target.claim_expires_at <= $2))
     RETURNING *`,
    [owner, now, leaseMs],
    'claim a scan'
  );
  const row = rowsOf(claimed)[0];
  if (!row) return null;
  return Object.freeze({ scan: scanOf(row), claimOwner: owner });
}

/* Extending a lease, only for the holder of the token. */
export async function renewClaim(store: ExposureStoreContext, input: Fields = {}) {
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
  const now = instant(input.now == null ? Date.now() : input.now, 'Renew time');
  const leaseMs = boundedInteger(input.leaseMs, DEFAULT_LEASE_MS, 1000, MAX_LEASE_MS);
  const renewed = await store.query(
    `UPDATE nv_exposure_scans
        SET claim_expires_at=$3::timestamptz + ($4::double precision / 1000.0) * interval '1 second'
      WHERE scan_id=$1 AND claim_owner=$2 AND state='running' AND claim_expires_at > $3
     RETURNING scan_id`,
    [scanId, claimOwner, now, leaseMs],
    'renew a claim'
  );
  return rowsOf(renewed).length > 0;
}

/*
 * Writing what a scan saw. One transaction, because a finding row and its
 * observation are one fact: a finding with no observation is a claim with no
 * evidence, and an observation with no finding has nothing to be about.
 *
 * The finding upsert is careful about what it does not overwrite. A
 * disposition is a decision somebody made or a provider gave, and seeing the
 * credential again does not undo it -- except for `removed-from-tree`, which
 * is a statement that the credential is no longer in the tree and is simply
 * false once it is seen again.
 */
export async function recordObservations(store: ExposureStoreContext, input: Fields = {}) {
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
  const now = instant(input.now == null ? Date.now() : input.now, 'Observation time');
  const findings = Array.isArray(input.findings) ? input.findings : [];
  if (findings.length > MAX_FINDINGS_PER_SCAN) {
    throw new TypeError('A scan may not record more findings than the per-scan ceiling');
  }
  const normalized = findings.map(normalizeFinding);

  return store.transaction(async client => {
    const owned = await client.query(
      `SELECT * FROM nv_exposure_scans
        WHERE scan_id=$1 AND claim_owner=$2 AND state='running' AND claim_expires_at > $3
        FOR UPDATE`,
      [scanId, claimOwner, now]
    );
    const scan = rowsOf(owned)[0];
    if (!scan) {
      fail('This scan is not held by this worker', 'EXPOSURE_SCAN_NOT_OWNED', 409);
    }
    const existing = await client.query(
      'SELECT fingerprint FROM nv_exposure_observations WHERE scan_id=$1', [scanId]
    );
    const fingerprints = new Set(rowsOf(existing).map(row => row.fingerprint));
    for (const finding of normalized) fingerprints.add(finding.fingerprint);
    if (fingerprints.size > MAX_FINDINGS_PER_SCAN) {
      fail('A scan may not exceed its finding ceiling', 'EXPOSURE_FINDING_LIMIT', 409);
    }

    let written = 0;
    for (const finding of normalized) {
      /*
       * The versions on a finding have to be the versions the scan ran
       * under. A finding written with someone else's rule version would be
       * compared against scans it was never produced by.
       */
      if (finding.fingerprintKeyVersion !== scan.fingerprint_key_version
        || finding.rulesVersion !== scan.rules_version
        || finding.engineVersion !== scan.engine_version) {
        fail(
          'A finding must carry the versions its scan ran under',
          'EXPOSURE_FINDING_VERSION_MISMATCH',
          409
        );
      }

      await client.query(
        `INSERT INTO nv_exposure_findings (
           provider, authority, owner_login, repo_name, fingerprint, identity_key,
           fingerprint_key_version, rules_version, engine_version, rule, file_path, placeholder,
           first_observed_at, last_observed_at, commit_sha
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
         ON CONFLICT (provider, authority, owner_login, repo_name, fingerprint, identity_key) DO UPDATE
            SET last_observed_at=GREATEST(nv_exposure_findings.last_observed_at, $13),
                /* A sighting in the tree moves the read-back commit to the
                   newest tree; a sighting in history only fills one in when
                   there is none, so it never pulls a finding that is in the
                   tree back to the commit that first added it. */
                commit_sha=CASE
                  WHEN $15::boolean AND $13 >= nv_exposure_findings.last_observed_at THEN EXCLUDED.commit_sha
                  WHEN nv_exposure_findings.commit_sha IS NULL THEN EXCLUDED.commit_sha
                  ELSE nv_exposure_findings.commit_sha END,
                disposition=CASE
                  WHEN nv_exposure_findings.disposition='removed-from-tree' THEN 'open'
                  ELSE nv_exposure_findings.disposition END,
                disposition_at=CASE
                  WHEN nv_exposure_findings.disposition='removed-from-tree' THEN NULL
                  ELSE nv_exposure_findings.disposition_at END`,
        [
          scan.provider, scan.authority, scan.owner_login, scan.repo_name, finding.fingerprint,
          scan.identity_key, finding.fingerprintKeyVersion, finding.rulesVersion, finding.engineVersion,
          finding.rule, finding.path, finding.placeholder, now,
          /* The commit it can be read back at: the scan's own when it is in
             the tree, the one that introduced it when it is only in history. */
          finding.inTree ? scan.commit_sha : finding.introducedCommit,
          finding.inTree
        ]
      );

      /*
       * One observation per credential per scan, however many places the
       * scan saw it. A scan that reads history can see one credential in the
       * tree and in the commit that added it, and the two are merged: in the
       * tree if either says so, with the tree's lines when there are any --
       * that is where a reader can go and look today -- and the earliest
       * introduction, because history is read oldest first and the first
       * one recorded is kept.
       */
      const observation = await client.query(
        `INSERT INTO nv_exposure_observations (
           scan_id, fingerprint, occurrence_count, occurrence_lines, occurrence_columns, truncated,
           verification_state, verification_reason, verification_adapter, verification_subject_digest,
           verification_observed_at, verification_freshness_deadline, verification_retry_after_ms,
           observed_at, in_tree, introduced_commit, introduced_at, history_commits, decoded_from, history_count_exact
         ) VALUES ($1,$2,$3,$4::integer[],$5::integer[],$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           CASE WHEN $16::text IS NULL THEN NULL ELSE 1 END, $18, true)
         ON CONFLICT (scan_id, fingerprint) DO UPDATE SET
           occurrence_count=CASE WHEN EXCLUDED.in_tree AND nv_exposure_observations.in_tree IS FALSE
             THEN EXCLUDED.occurrence_count ELSE nv_exposure_observations.occurrence_count END,
           occurrence_lines=CASE WHEN EXCLUDED.in_tree AND nv_exposure_observations.in_tree IS FALSE
             THEN EXCLUDED.occurrence_lines ELSE nv_exposure_observations.occurrence_lines END,
           occurrence_columns=CASE WHEN EXCLUDED.in_tree AND nv_exposure_observations.in_tree IS FALSE
             THEN EXCLUDED.occurrence_columns ELSE nv_exposure_observations.occurrence_columns END,
           truncated=CASE WHEN EXCLUDED.in_tree AND nv_exposure_observations.in_tree IS FALSE
             THEN EXCLUDED.truncated ELSE nv_exposure_observations.truncated END,
           in_tree=(nv_exposure_observations.in_tree IS NOT FALSE) OR EXCLUDED.in_tree,
           introduced_commit=COALESCE(nv_exposure_observations.introduced_commit, EXCLUDED.introduced_commit),
           introduced_at=CASE WHEN nv_exposure_observations.introduced_commit IS NULL
             THEN EXCLUDED.introduced_at ELSE nv_exposure_observations.introduced_at END,
           history_commits=COALESCE(nv_exposure_observations.history_commits, EXCLUDED.history_commits),
           decoded_from=COALESCE(nv_exposure_observations.decoded_from, EXCLUDED.decoded_from)
         RETURNING (xmax = 0) AS inserted`,
        [
          scanId, finding.fingerprint, finding.occurrenceCount, finding.lines, finding.columns,
          finding.truncated,
          finding.verification && finding.verification.state,
          finding.verification && finding.verification.reason,
          finding.verification && finding.verification.adapter,
          finding.verification && finding.verification.subjectDigest,
          finding.verification && finding.verification.observedAt,
          finding.verification && finding.verification.freshnessDeadline,
          finding.verification && finding.verification.retryAfterMs,
          now,
          finding.inTree,
          finding.introducedCommit,
          finding.introducedAt,
          finding.decodedFrom
        ]
      );
      if (finding.introducedCommit) {
        const sighting = await client.query(
          `INSERT INTO nv_exposure_history_sightings (scan_id, fingerprint, commit_sha)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING commit_sha`,
          [scanId, finding.fingerprint, finding.introducedCommit]
        );
        if (rowsOf(sighting).length) {
          await client.query(
            `UPDATE nv_exposure_observations SET history_commits=(
               SELECT count(*)::integer FROM nv_exposure_history_sightings
                WHERE scan_id=$1 AND fingerprint=$2)
             WHERE scan_id=$1 AND fingerprint=$2`,
            [scanId, finding.fingerprint]
          );
        }
      }
      const outcome = rowsOf(observation)[0];
      if (outcome && outcome.inserted) written += 1;
    }
    return Object.freeze({ recorded: written, submitted: normalized.length });
  }, 'record observations');
}

/*
 * Finishing. The state and coverage combinations the schema permits are the
 * only ones that can be written, so a caller cannot record a partial scan
 * that claims complete coverage.
 */
export async function finalizeScan(store: ExposureStoreContext, input: Fields = {}) {
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
  const state = requireMember(input.state, TERMINAL_STATES, 'Terminal scan state');
  const coverage = requireMember(input.coverage, COVERAGE, 'Scan coverage');
  const skippedReason = input.skippedReason == null
    ? null
    : requireMember(input.skippedReason, SKIPPED_REASONS, 'Skipped reason');
  const now = instant(input.now == null ? Date.now() : input.now, 'Finish time');
  const filesScanned = boundedInteger(input.filesScanned, 0, 0, 2_000_000_000);
  const bytes = input.bytesScanned;
  const bytesScanned = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0;
  const parentScanId = trimmedText(input.parentScanId) || null;
  const count = (value: unknown): number | null => (Number.isInteger(value) ? boundedInteger(value, 0, 0, 2_000_000_000) : null);
  const filesTotal = count(input.filesTotal);
  const filesSkippedBinary = count(input.filesSkippedBinary);
  const filesSkippedOther = count(input.filesSkippedOther);
  const commitsTotal = count(input.commitsTotal);
  const commitsScanned = count(input.commitsScanned);
  const commitsSkipped = count(input.commitsSkipped);
  const archivesScanned = count(input.archivesScanned);
  const archiveMembersScanned = count(input.archiveMembersScanned);

  if (coverage === 'complete' && state !== 'complete') {
    throw new TypeError('Only a complete scan may claim complete coverage');
  }
  if (state === 'partial' && coverage !== 'partial') {
    throw new TypeError('A partial scan has partial coverage');
  }

  const finalized = await store.query(
    `UPDATE nv_exposure_scans
        SET state=$3, coverage=$4, skipped_reason=$5, files_scanned=$6, bytes_scanned=$7,
            parent_scan_id=$8, finished_at=$9, claim_owner=NULL, claim_expires_at=NULL,
            files_total=$10, files_skipped_binary=$11, files_skipped_other=$12,
            commits_total=$13, commits_scanned=$14, commits_skipped=$15,
            archives_scanned=$16, archive_members_scanned=$17
      WHERE scan_id=$1 AND claim_owner=$2 AND state='running' AND claim_expires_at > $9
     RETURNING *`,
    [
      scanId, claimOwner, state, coverage, skippedReason, filesScanned, bytesScanned, parentScanId, now,
      filesTotal, filesSkippedBinary, filesSkippedOther,
      commitsTotal, commitsScanned, commitsSkipped, archivesScanned, archiveMembersScanned
    ],
    'finalize a scan'
  );
  const row = rowsOf(finalized)[0];
  if (!row) {
    return fail('This scan is not held by this worker', 'EXPOSURE_SCAN_NOT_OWNED', 409);
  }
  return scanOf(row);
}

/* Cancellation is the reader's, so it does not need a claim -- but it does
   need the identity boundary, and it leaves coverage as whatever was
   actually achieved rather than claiming anything. */
export async function cancelScan(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const now = instant(input.now == null ? Date.now() : input.now, 'Cancel time');
  const canceled = await store.query(
    `UPDATE nv_exposure_scans
        SET state='canceled', coverage=CASE WHEN coverage='unknown' THEN 'unknown' ELSE 'partial' END,
            skipped_reason='canceled', finished_at=$3, claim_owner=NULL, claim_expires_at=NULL
      WHERE scan_id=$1 AND identity_key=$2 AND state IN ('queued','running')
        AND provider=$4 AND authority=$5 AND owner_login=$6 AND repo_name=$7
     RETURNING *`,
    [scanId, identityKey, now, scope.provider, scope.authority, scope.owner, scope.repo],
    'cancel a scan'
  );
  return scanFromRow(rowsOf(canceled)[0] || null);
}

/*
 * Concluding that a credential is no longer in the tree, which is the one
 * operation here that changes a finding on the strength of an absence. Every
 * condition below is a way that absence can be an artefact of the scan
 * rather than a fact about the repository.
 *
 * It returns a refusal with a reason instead of doing nothing quietly,
 * because "nothing was resolved" and "we could not tell" look identical from
 * the outside and only one of them is worth showing a reader.
 */
export async function concludeRemovedFromTree(store: ExposureStoreContext, input: Fields = {}) {
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const now = instant(input.now == null ? Date.now() : input.now, 'Conclusion time');

  return store.transaction(async client => {
    const loaded = await client.query(
      'SELECT * FROM nv_exposure_scans WHERE scan_id=$1 AND identity_key=$2',
      [scanId, identityKey]
    );
    const scan = rowsOf(loaded)[0];
    if (!scan) {
      return Object.freeze({ concluded: false, reason: 'scan-not-found', removed: 0 });
    }

    /* Only a scan that finished, and finished having read everything. */
    if (scan.state !== 'complete') {
      return Object.freeze({ concluded: false, reason: 'scan-not-complete', removed: 0 });
    }
    if (scan.coverage !== 'complete') {
      return Object.freeze({ concluded: false, reason: 'coverage-not-complete', removed: 0 });
    }
    if (!scan.parent_scan_id) {
      return Object.freeze({ concluded: false, reason: 'no-comparable-predecessor', removed: 0 });
    }

    const parentRows = await client.query(
      'SELECT * FROM nv_exposure_scans WHERE scan_id=$1',
      [scan.parent_scan_id]
    );
    const parent = rowsOf(parentRows)[0];
    if (!parent) {
      return Object.freeze({ concluded: false, reason: 'no-comparable-predecessor', removed: 0 });
    }
    if (parent.identity_key !== scan.identity_key) {
      return Object.freeze({ concluded: false, reason: 'identity-mismatch', removed: 0 });
    }

    /*
     * The same repository and the same ref. A scan of `main` says nothing
     * about what is on a feature branch, and comparing across the two would
     * report every credential unique to one of them as removed.
     */
    const sameScope = parent.provider === scan.provider && parent.authority === scan.authority
      && parent.owner_login === scan.owner_login && parent.repo_name === scan.repo_name;
    if (!sameScope || parent.ref_name !== scan.ref_name) {
      return Object.freeze({ concluded: false, reason: 'ref-lineage-mismatch', removed: 0 });
    }
    if (parent.state !== 'complete' || parent.coverage !== 'complete') {
      return Object.freeze({ concluded: false, reason: 'predecessor-not-complete', removed: 0 });
    }

    /*
     * And the same versions, which is the condition that stops a key
     * rotation or a rule change from resolving the entire backlog. Every
     * fingerprint changes when any of these move, so every previous finding
     * would be missing from this scan for a reason that has nothing to do
     * with the repository.
     */
    if (parent.rules_version !== scan.rules_version
      || parent.engine_version !== scan.engine_version
      || parent.fingerprint_key_version !== scan.fingerprint_key_version
      || parent.fingerprint_key_id !== scan.fingerprint_key_id
      || parent.config_version !== scan.config_version) {
      return Object.freeze({ concluded: false, reason: 'incompatible-versions', removed: 0 });
    }

    const removed = await client.query(
      `UPDATE nv_exposure_findings AS finding
          SET disposition='removed-from-tree', disposition_at=$6
        WHERE finding.provider=$1 AND finding.authority=$2
          AND finding.owner_login=$3 AND finding.repo_name=$4
          AND finding.disposition='open' AND finding.identity_key=$11
          AND finding.fingerprint_key_version=$7
          AND finding.rules_version=$8
          AND finding.engine_version=$9
          AND EXISTS (
                SELECT 1 FROM nv_exposure_observations AS before
                 WHERE before.scan_id=$5 AND before.fingerprint=finding.fingerprint)
          AND NOT EXISTS (
                SELECT 1 FROM nv_exposure_observations AS after
                 WHERE after.scan_id=$10 AND after.fingerprint=finding.fingerprint)
       RETURNING finding.fingerprint`,
      [
        scan.provider, scan.authority, scan.owner_login, scan.repo_name,
        parent.scan_id, now, scan.fingerprint_key_version, scan.rules_version,
        scan.engine_version, scan.scan_id, identityKey
      ]
    );
    return Object.freeze({
      concluded: true,
      reason: null,
      removed: rowsOf(removed).length,
      fingerprints: Object.freeze(rowsOf(removed).map(row => row.fingerprint))
    });
  }, 'conclude removal');
}
