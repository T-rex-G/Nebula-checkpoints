'use strict';

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

const crypto = require('crypto');

/*
 * The version of the scanning configuration -- the caps a scan runs under.
 * It is part of a finding's identity because a finding produced under a
 * 100-file ceiling is not comparable with one produced under a 10,000-file
 * ceiling: the second scan looked in places the first never saw, so a
 * comparison between them would read "appeared" for credentials that were
 * always there. Changing any cap moves this number.
 */
const EXPOSURE_CONFIG_VERSION = 1;

const SCAN_STATES = Object.freeze(['queued', 'running', 'complete', 'partial', 'failed', 'canceled']);
const TERMINAL_STATES = Object.freeze(['complete', 'partial', 'failed', 'canceled']);
const COVERAGE = Object.freeze(['unknown', 'complete', 'partial']);
const SKIPPED_REASONS = Object.freeze([
  'file-count-limit', 'byte-limit', 'time-limit', 'tree-truncated',
  'unreadable-files', 'canceled', 'transport-refused',
  /*
   * The session that authorised the read is gone. Distinct from a transport
   * refusal because it is not a network problem and retrying will not help:
   * somebody disconnected the provider or revoked the grant, and the scan
   * stopped rather than keeping the credential to try again with.
   */
  'authorization-revoked'
]);
const DISPOSITIONS = Object.freeze(['open', 'credential-rejected', 'accepted-risk', 'removed-from-tree']);

const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/*
 * How long a provider's answer stays current. It matches the verifier's own
 * window: an attempt that outlived its deadline is not a rejection, it is an
 * answer nobody should still be relying on.
 */
const DEFAULT_VERIFICATION_FRESHNESS_MS = 24 * 60 * 60 * 1000;
/*
 * Shorter than a verification's, and on purpose. Whether a token still works
 * changes when somebody revokes it; whether a table is readable changes when
 * somebody edits a policy, which is a far more ordinary thing to do in an
 * afternoon. A readability answer from yesterday is history, not news.
 */
const DEFAULT_PROBE_FRESHNESS_MS = 60 * 60 * 1000;
const MAX_OCCURRENCES = 20;
const MAX_FINDINGS_PER_SCAN = 500;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SWEEP_BATCH = 200;
const MAX_SWEEP_BATCH = 2000;

class ExposureStoreError extends Error {
  constructor(message, code = 'EXPOSURE_STORE_UNAVAILABLE', status = 503) {
    super(message);
    this.name = 'ExposureStoreError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) {
  throw new ExposureStoreError(message, code, status);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireText(value, label, max) {
  const out = text(value);
  if (!out || out.length > max) throw new TypeError(`${label} is required and must be at most ${max} characters`);
  return out;
}

function requireScope(scope) {
  const source = scope && typeof scope === 'object' ? scope : {};
  return Object.freeze({
    provider: requireText(source.provider, 'Scan provider', 40),
    authority: requireText(source.authority, 'Scan authority', 255),
    owner: requireText(source.owner, 'Scan owner', 255),
    repo: requireText(source.repo, 'Scan repository', 255)
  });
}

function requireDigest(value, label) {
  const out = text(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${label} must be a sha-256 digest`);
  return out;
}

function requireCommit(value) {
  const out = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(out)) throw new TypeError('Scan commit must be a 40-character object id');
  return out;
}

function requireVersion(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function requireMember(value, allowed, label) {
  const out = text(value);
  if (!allowed.includes(out)) throw new TypeError(`${label} must be one of ${allowed.join(', ')}`);
  return out;
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function instant(value, label) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${label} must be a time`);
  return new Date(ms);
}

/*
 * A fencing token rather than a worker name. The claim is what authorises a
 * write, so it has to be something a reclaimed worker cannot still hold: a
 * fresh random token per claim means a process that stalled through its lease
 * and woke up finalising a job somebody else now owns matches zero rows, with
 * no heartbeat to trust and no clock comparison to get wrong.
 */
function claimToken() {
  return crypto.randomBytes(16).toString('hex');
}

/* ---- Serializers ------------------------------------------------------- */

/*
 * Named columns only. Spreading a row would publish whatever the schema grows
 * next, and the whole privacy claim here is about what does not leave.
 */
function iso(value) {
  return value instanceof Date ? value.toISOString() : (value == null ? null : String(value));
}

function scanFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    scanId: row.scan_id,
    scope: Object.freeze({
      provider: row.provider, authority: row.authority, owner: row.owner_login, repo: row.repo_name
    }),
    requestedBy: row.requested_by,
    refName: row.ref_name,
    commitSha: row.commit_sha,
    rulesVersion: row.rules_version,
    engineVersion: row.engine_version,
    fingerprintKeyVersion: row.fingerprint_key_version,
    configVersion: row.config_version,
    state: row.state,
    coverage: row.coverage,
    skippedReason: row.skipped_reason || null,
    filesScanned: row.files_scanned,
    bytesScanned: Number(row.bytes_scanned),
    parentScanId: row.parent_scan_id || null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    retainUntil: iso(row.retain_until)
  });
}

function findingFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    fingerprint: row.fingerprint,
    scope: Object.freeze({
      provider: row.provider, authority: row.authority, owner: row.owner_login, repo: row.repo_name
    }),
    fingerprintKeyVersion: row.fingerprint_key_version,
    rulesVersion: row.rules_version,
    engineVersion: row.engine_version,
    rule: row.rule,
    path: row.file_path,
    placeholder: row.placeholder,
    disposition: row.disposition,
    dispositionAt: iso(row.disposition_at),
    dispositionBy: row.disposition_by || null,
    firstObservedAt: iso(row.first_observed_at),
    lastObservedAt: iso(row.last_observed_at)
  });
}

function observationFromRow(row) {
  if (!row) return null;
  const lines = Array.isArray(row.occurrence_lines) ? row.occurrence_lines : [];
  const columns = Array.isArray(row.occurrence_columns) ? row.occurrence_columns : [];
  return Object.freeze({
    scanId: row.scan_id,
    fingerprint: row.fingerprint,
    occurrenceCount: row.occurrence_count,
    occurrences: Object.freeze(lines.map((line, index) => Object.freeze({
      line: Number(line), column: Number(columns[index])
    }))),
    truncated: Boolean(row.truncated),
    verification: row.verification_state
      ? Object.freeze({
        state: row.verification_state,
        reason: row.verification_reason || null,
        adapter: row.verification_adapter || null,
        subjectDigest: row.verification_subject_digest || null,
        observedAt: iso(row.verification_observed_at),
        freshnessDeadline: iso(row.verification_freshness_deadline),
        retryAfterMs: row.verification_retry_after_ms == null ? null : Number(row.verification_retry_after_ms)
      })
      : null,
    observedAt: iso(row.observed_at)
  });
}

function verificationFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    verificationId: row.verification_id,
    fingerprint: row.fingerprint,
    requestedBy: row.requested_by,
    adapter: row.adapter || null,
    adapterVersion: row.adapter_version == null ? null : Number(row.adapter_version),
    targetId: row.target_id || null,
    authorizationId: row.authorization_id || null,
    state: row.state,
    reason: row.reason,
    subjectDigest: row.subject_digest || null,
    retryAfterMs: row.retry_after_ms == null ? null : Number(row.retry_after_ms),
    observedAt: iso(row.observed_at),
    freshnessDeadline: iso(row.freshness_deadline)
  });
}

function readabilityProbeFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    probeId: row.probe_id,
    fingerprint: row.fingerprint,
    requestedBy: row.requested_by,
    authorizationId: row.authorization_id || null,
    projectRef: row.project_ref || null,
    relation: row.relation || null,
    /* Stored joined because the grant was signed over the joined form; split
       on the way out so a caller never has to know that. */
    projection: Object.freeze(row.projection ? String(row.projection).split(',') : []),
    state: row.state,
    reason: row.reason,
    testedRole: row.tested_role || null,
    rowCount: row.row_count == null ? 0 : Number(row.row_count),
    observedAt: iso(row.observed_at),
    freshnessDeadline: iso(row.freshness_deadline)
  });
}

/* ---- Input normalisation ----------------------------------------------- */

/*
 * The findings a scan writes are the sanitized objects `exposure-findings.js`
 * produces. Re-validated here anyway: this is the boundary where they stop
 * being a value in a process and start being a row, and a value that arrives
 * as a parameter has not been checked just because it arrived as a parameter.
 */
function normalizeFinding(finding) {
  const source = finding && typeof finding === 'object' ? finding : {};
  const occurrences = Array.isArray(source.occurrences) ? source.occurrences : [];
  if (!occurrences.length) throw new TypeError('A finding must carry at least one location');
  if (occurrences.length > MAX_OCCURRENCES) throw new TypeError('A finding carries more locations than the schema admits');

  const lines = [];
  const columns = [];
  for (const occurrence of occurrences) {
    const line = occurrence && occurrence.line;
    const column = occurrence && occurrence.column;
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      throw new TypeError('A location must be a positive line and column');
    }
    lines.push(line);
    columns.push(column);
  }

  const occurrenceCount = Number.isInteger(source.occurrenceCount) ? source.occurrenceCount : lines.length;
  if (occurrenceCount < lines.length) throw new TypeError('A location count cannot be smaller than the locations');

  const placeholder = requireText(source.placeholder, 'Finding placeholder', 80);
  if (!/^<[a-z-]+ #[0-9]+>$/.test(placeholder)) {
    /*
     * The pattern is the guard against a partial redaction arriving here. A
     * caller that decided to show the first eight characters of a token would
     * be storing eight characters of a credential, and the database would
     * refuse it -- but refusing here says why.
     */
    throw new TypeError('Finding placeholder must be a generated label, not a redacted credential');
  }

  return {
    fingerprint: requireDigest(source.fingerprint, 'Finding fingerprint'),
    fingerprintKeyVersion: requireVersion(source.fingerprintKeyVersion, 'Fingerprint key version'),
    rulesVersion: requireVersion(source.rulesVersion, 'Rules version'),
    engineVersion: requireVersion(source.engineVersion, 'Engine version'),
    rule: requireText(source.rule, 'Finding rule', 64),
    path: requireText(source.path, 'Finding path', 1024),
    placeholder,
    lines,
    columns,
    occurrenceCount,
    truncated: occurrenceCount > lines.length,
    verification: normalizeVerification(source.verification)
  };
}

/*
 * A verification record from `credential-verification.js`, reduced to the
 * bounded fields the schema admits. Notably absent: any response text, any
 * transport error message, any provider login. The subject arrives already
 * digested and is stored as the digest.
 */
function normalizeVerification(verification) {
  if (verification == null) return null;
  const source = verification && typeof verification === 'object' ? verification : {};
  const state = requireMember(source.state, ['verified', 'rejected', 'unverifiable'], 'Verification state');
  const reason = text(source.reason);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(reason)) throw new TypeError('Verification reason must be a bounded reason code');
  const adapter = text(source.adapter);
  if (adapter && !/^[a-z][a-z0-9-]{2,63}$/.test(adapter)) throw new TypeError('Verification adapter must be a bounded identifier');
  const subjectDigest = text(source.subjectDigest);
  if (subjectDigest && !/^[0-9a-f]{32}$/.test(subjectDigest)) throw new TypeError('Verification subject must arrive already digested');
  return {
    state,
    reason,
    adapter: adapter || null,
    subjectDigest: subjectDigest || null,
    observedAt: instant(Date.parse(text(source.observedAt)) || source.observedAt, 'Verification time'),
    freshnessDeadline: source.freshnessDeadline
      ? instant(Date.parse(text(source.freshnessDeadline)) || source.freshnessDeadline, 'Verification deadline')
      : null,
    retryAfterMs: Number.isFinite(source.retryAfterMs)
      ? Math.min(Math.max(Math.round(source.retryAfterMs), 1000), 3_600_000)
      : null
  };
}

/*
 * An observation from `anonymous-readability-probe.js`, reduced to the bounded
 * fields the schema admits. Notably absent: the key, the response body and
 * anything from inside a row. `rowCount` is a count the prober capped at one
 * and is the whole payload -- "a row came back" is the entire finding, and
 * keeping the row would turn a security check into a second copy of somebody's
 * data.
 *
 * A relation or projection the prober refused is stored as null rather than as
 * typed. It was never asked, `reason` says so, and a column constrained to
 * hold only askable names could not hold it anyway.
 */
function normalizeReadabilityProbe(observation) {
  if (observation == null) return null;
  const source = observation && typeof observation === 'object' ? observation : {};
  const state = requireMember(source.state, ['readable', 'denied', 'unverifiable'], 'Probe state');
  const reason = text(source.reason);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(reason)) throw new TypeError('Probe reason must be a bounded reason code');
  const projectRef = text(source.projectRef);
  if (projectRef && !/^[a-z]{20}$/.test(projectRef)) throw new TypeError('Probe project reference must be twenty lowercase letters');
  const relation = text(source.relation);
  const relationStorable = /^[a-z_][a-z0-9_]{0,62}$/.test(relation);
  const projection = (Array.isArray(source.projection) ? source.projection : []).map(text);
  const projectionStorable = projection.length > 0 && projection.length <= 8
    && projection.every(column => /^[a-z_][a-z0-9_]{0,62}$/.test(column));
  const testedRole = text(source.testedRole);
  if (testedRole && !['anon', 'publishable'].includes(testedRole)) {
    throw new TypeError('Probe tested role must be the anonymous role');
  }
  const rowCount = Number.isInteger(source.rowCount) ? source.rowCount : 0;
  if (rowCount < 0 || rowCount > 1) throw new TypeError('A probe asks for one row and counts at most one');
  /*
   * The schema says a row was seen exactly when the state is `readable`, so a
   * record disagreeing with itself is refused here rather than arriving at the
   * database as a constraint violation nobody can read.
   */
  if ((rowCount > 0) !== (state === 'readable')) {
    throw new TypeError('A probe row count must agree with its state');
  }
  return {
    state,
    reason,
    projectRef: projectRef || null,
    relation: relationStorable ? relation : null,
    projection: projectionStorable ? projection.join(',') : null,
    testedRole: testedRole || null,
    rowCount,
    observedAt: instant(Date.parse(text(source.observedAt)) || source.observedAt, 'Probe time'),
    freshnessDeadline: source.freshnessDeadline
      ? instant(Date.parse(text(source.freshnessDeadline)) || source.freshnessDeadline, 'Probe deadline')
      : null
  };
}

/* ---- The store --------------------------------------------------------- */

class ExposureStore {
  constructor(options = {}) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('ExposureStore requires a pg-compatible pool');
    }
    this.pool = pool;
    this.sweepBatch = boundedInteger(options.sweepBatch, DEFAULT_SWEEP_BATCH, 1, MAX_SWEEP_BATCH);
  }

  async #transaction(work, label) {
    let client;
    try {
      client = await this.pool.connect();
    } catch (error) {
      fail(`Exposure storage is unavailable: ${(error && error.code) || 'connect failed'}`);
    }
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is going away anyway */ }
      if (error instanceof ExposureStoreError || error instanceof TypeError) throw error;
      return fail(`Exposure storage could not ${label}: ${(error && error.code) || 'query failed'}`);
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  async #query(sql, params, label) {
    try {
      return await this.pool.query(sql, params);
    } catch (error) {
      return fail(`Exposure storage could not ${label}: ${(error && error.code) || 'query failed'}`);
    }
  }

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
  async requestScan(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Scan identity');
    const requestedBy = requireText(input.requestedBy, 'Scan actor', 255);
    const refName = requireText(input.refName, 'Scan ref', 255);
    const commitSha = requireCommit(input.commitSha);
    const idempotencyKey = requireText(input.idempotencyKey, 'Scan idempotency key', 200);
    if (idempotencyKey.length < 8) throw new TypeError('Scan idempotency key must be at least 8 characters');
    const scanId = text(input.scanId) || crypto.randomUUID();
    const now = instant(input.now == null ? Date.now() : input.now, 'Scan time');
    const retainUntil = input.retainUntil == null
      ? new Date(now.getTime() + DEFAULT_RETENTION_MS)
      : instant(input.retainUntil, 'Scan retention');
    const versions = {
      rules: requireVersion(input.rulesVersion, 'Rules version'),
      engine: requireVersion(input.engineVersion, 'Engine version'),
      fingerprintKey: requireVersion(input.fingerprintKeyVersion, 'Fingerprint key version'),
      config: requireVersion(input.configVersion == null ? EXPOSURE_CONFIG_VERSION : input.configVersion, 'Config version')
    };

    const inserted = await this.#query(
      `INSERT INTO nv_exposure_scans (
         scan_id, provider, authority, owner_login, repo_name, identity_key, requested_by,
         ref_name, commit_sha, rules_version, engine_version, fingerprint_key_version,
         config_version, state, coverage, idempotency_key, retain_until, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued','unknown',$14,$15,$16)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        scanId, scope.provider, scope.authority, scope.owner, scope.repo, identityKey, requestedBy,
        refName, commitSha, versions.rules, versions.engine, versions.fingerprintKey,
        versions.config, idempotencyKey, retainUntil, now
      ],
      'accept a scan request'
    );
    if (inserted.rows.length) {
      return Object.freeze({ scan: scanFromRow(inserted.rows[0]), created: true });
    }

    const existing = await this.#query(
      `SELECT * FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND idempotency_key=$5 AND identity_key=$6`,
      [scope.provider, scope.authority, scope.owner, scope.repo, idempotencyKey, identityKey],
      'read a scan request'
    );
    if (existing.rows.length) {
      return Object.freeze({ scan: scanFromRow(existing.rows[0]), created: false });
    }
    return fail(
      'This repository already has a scan in progress',
      'EXPOSURE_SCAN_ALREADY_ACTIVE',
      409
    );
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
  async claimScan(input = {}) {
    const now = instant(input.now == null ? Date.now() : input.now, 'Claim time');
    const leaseMs = boundedInteger(input.leaseMs, DEFAULT_LEASE_MS, 1000, MAX_LEASE_MS);
    const owner = claimToken();
    const claimed = await this.#query(
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
       RETURNING *`,
      [owner, now, leaseMs],
      'claim a scan'
    );
    if (!claimed.rows.length) return null;
    return Object.freeze({ scan: scanFromRow(claimed.rows[0]), claimOwner: owner });
  }

  /* Extending a lease, only for the holder of the token. */
  async renewClaim(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
    const now = instant(input.now == null ? Date.now() : input.now, 'Renew time');
    const leaseMs = boundedInteger(input.leaseMs, DEFAULT_LEASE_MS, 1000, MAX_LEASE_MS);
    const renewed = await this.#query(
      `UPDATE nv_exposure_scans
          SET claim_expires_at=$3::timestamptz + ($4::double precision / 1000.0) * interval '1 second'
        WHERE scan_id=$1 AND claim_owner=$2 AND state='running'
       RETURNING scan_id`,
      [scanId, claimOwner, now, leaseMs],
      'renew a claim'
    );
    return renewed.rows.length > 0;
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
  async recordObservations(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
    const now = instant(input.now == null ? Date.now() : input.now, 'Observation time');
    const findings = Array.isArray(input.findings) ? input.findings : [];
    if (findings.length > MAX_FINDINGS_PER_SCAN) {
      throw new TypeError('A scan may not record more findings than the per-scan ceiling');
    }
    const normalized = findings.map(normalizeFinding);

    return this.#transaction(async client => {
      const owned = await client.query(
        `SELECT * FROM nv_exposure_scans
          WHERE scan_id=$1 AND claim_owner=$2 AND state='running'
          FOR UPDATE`,
        [scanId, claimOwner]
      );
      if (!owned.rows.length) {
        fail('This scan is not held by this worker', 'EXPOSURE_SCAN_NOT_OWNED', 409);
      }
      const scan = owned.rows[0];

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
             first_observed_at, last_observed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
           ON CONFLICT (provider, authority, owner_login, repo_name, fingerprint) DO UPDATE
              SET last_observed_at=GREATEST(nv_exposure_findings.last_observed_at, $13),
                  disposition=CASE
                    WHEN nv_exposure_findings.disposition='removed-from-tree' THEN 'open'
                    ELSE nv_exposure_findings.disposition END,
                  disposition_at=CASE
                    WHEN nv_exposure_findings.disposition='removed-from-tree' THEN NULL
                    ELSE nv_exposure_findings.disposition_at END`,
          [
            scan.provider, scan.authority, scan.owner_login, scan.repo_name, finding.fingerprint,
            scan.identity_key, finding.fingerprintKeyVersion, finding.rulesVersion, finding.engineVersion,
            finding.rule, finding.path, finding.placeholder, now
          ]
        );

        const observation = await client.query(
          `INSERT INTO nv_exposure_observations (
             scan_id, fingerprint, occurrence_count, occurrence_lines, occurrence_columns, truncated,
             verification_state, verification_reason, verification_adapter, verification_subject_digest,
             verification_observed_at, verification_freshness_deadline, verification_retry_after_ms,
             observed_at
           ) VALUES ($1,$2,$3,$4::integer[],$5::integer[],$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (scan_id, fingerprint) DO NOTHING
           RETURNING fingerprint`,
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
            now
          ]
        );
        if (observation.rows.length) written += 1;
      }
      return Object.freeze({ recorded: written, submitted: normalized.length });
    }, 'record observations');
  }

  /*
   * Finishing. The state and coverage combinations the schema permits are the
   * only ones that can be written, so a caller cannot record a partial scan
   * that claims complete coverage.
   */
  async finalizeScan(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const claimOwner = requireText(input.claimOwner, 'Claim token', 200);
    const state = requireMember(input.state, TERMINAL_STATES, 'Terminal scan state');
    const coverage = requireMember(input.coverage, COVERAGE, 'Scan coverage');
    const skippedReason = input.skippedReason == null
      ? null
      : requireMember(input.skippedReason, SKIPPED_REASONS, 'Skipped reason');
    const now = instant(input.now == null ? Date.now() : input.now, 'Finish time');
    const filesScanned = boundedInteger(input.filesScanned, 0, 0, 2_000_000_000);
    const bytesScanned = Number.isFinite(input.bytesScanned) ? Math.max(0, Math.round(input.bytesScanned)) : 0;
    const parentScanId = text(input.parentScanId) || null;

    if (coverage === 'complete' && state !== 'complete') {
      throw new TypeError('Only a complete scan may claim complete coverage');
    }
    if (state === 'partial' && coverage !== 'partial') {
      throw new TypeError('A partial scan has partial coverage');
    }

    const finalized = await this.#query(
      `UPDATE nv_exposure_scans
          SET state=$3, coverage=$4, skipped_reason=$5, files_scanned=$6, bytes_scanned=$7,
              parent_scan_id=$8, finished_at=$9, claim_owner=NULL, claim_expires_at=NULL
        WHERE scan_id=$1 AND claim_owner=$2 AND state='running'
       RETURNING *`,
      [scanId, claimOwner, state, coverage, skippedReason, filesScanned, bytesScanned, parentScanId, now],
      'finalize a scan'
    );
    if (!finalized.rows.length) {
      return fail('This scan is not held by this worker', 'EXPOSURE_SCAN_NOT_OWNED', 409);
    }
    return scanFromRow(finalized.rows[0]);
  }

  /* Cancellation is the reader's, so it does not need a claim -- but it does
     need the identity boundary, and it leaves coverage as whatever was
     actually achieved rather than claiming anything. */
  async cancelScan(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const identityKey = requireDigest(input.identityKey, 'Scan identity');
    const now = instant(input.now == null ? Date.now() : input.now, 'Cancel time');
    const canceled = await this.#query(
      `UPDATE nv_exposure_scans
          SET state='canceled', coverage=CASE WHEN coverage='unknown' THEN 'unknown' ELSE 'partial' END,
              skipped_reason='canceled', finished_at=$3, claim_owner=NULL, claim_expires_at=NULL
        WHERE scan_id=$1 AND identity_key=$2 AND state IN ('queued','running')
       RETURNING *`,
      [scanId, identityKey, now],
      'cancel a scan'
    );
    return scanFromRow(canceled.rows[0] || null);
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
  async concludeRemovedFromTree(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const identityKey = requireDigest(input.identityKey, 'Scan identity');
    const now = instant(input.now == null ? Date.now() : input.now, 'Conclusion time');

    return this.#transaction(async client => {
      const loaded = await client.query(
        'SELECT * FROM nv_exposure_scans WHERE scan_id=$1 AND identity_key=$2',
        [scanId, identityKey]
      );
      if (!loaded.rows.length) {
        return Object.freeze({ concluded: false, reason: 'scan-not-found', removed: 0 });
      }
      const scan = loaded.rows[0];

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
      if (!parentRows.rows.length) {
        return Object.freeze({ concluded: false, reason: 'no-comparable-predecessor', removed: 0 });
      }
      const parent = parentRows.rows[0];

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
        || parent.config_version !== scan.config_version) {
        return Object.freeze({ concluded: false, reason: 'incompatible-versions', removed: 0 });
      }

      const removed = await client.query(
        `UPDATE nv_exposure_findings AS finding
            SET disposition='removed-from-tree', disposition_at=$6
          WHERE finding.provider=$1 AND finding.authority=$2
            AND finding.owner_login=$3 AND finding.repo_name=$4
            AND finding.disposition='open'
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
          scan.engine_version, scan.scan_id
        ]
      );
      return Object.freeze({
        concluded: true,
        reason: null,
        removed: removed.rows.length,
        fingerprints: Object.freeze(removed.rows.map(row => row.fingerprint))
      });
    }, 'conclude removal');
  }

  /*
   * The provider said no. This is the only disposition that means the exposure
   * is actually over, and it is the provider's word rather than ours -- so it
   * is recorded without an actor, because nobody here decided it.
   */
  async markCredentialRejected(input = {}) {
    const scope = requireScope(input.scope);
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const identityKey = requireDigest(input.identityKey, 'Finding identity');
    const now = instant(input.now == null ? Date.now() : input.now, 'Rejection time');
    const updated = await this.#query(
      `UPDATE nv_exposure_findings
          SET disposition='credential-rejected', disposition_at=$6, disposition_by=NULL
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$7
          AND disposition <> 'accepted-risk'
       RETURNING *`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, now, identityKey],
      'record a rejected credential'
    );
    return findingFromRow(updated.rows[0] || null);
  }

  /*
   * Recording what the provider said.
   *
   * Two writes in one transaction, because they are one fact. The attempt is
   * appended -- always, whatever the answer -- and a `rejected` answer also
   * moves the finding, because the issuing provider refusing a credential is
   * the only thing that means the exposure is over.
   *
   * The disposition move is deliberately narrow. It does not touch a finding
   * somebody has already accepted the risk of: a person's decision is not
   * overturned by a later provider answer, and a provider saying no to an
   * accepted risk is simply good news recorded in the attempt history.
   */
  async recordVerification(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Verification identity');
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const requestedBy = requireText(input.requestedBy, 'Verification actor', 255);
    const attempt = normalizeVerification(input.record);
    if (!attempt) throw new TypeError('A verification attempt requires a record');
    const verificationId = text(input.verificationId) || crypto.randomUUID();
    const adapterVersion = Number.isInteger(input.adapterVersion) ? input.adapterVersion : null;
    const targetId = text(input.targetId) || null;
    const authorizationId = text(input.authorizationId) || null;
    /*
     * A record without a deadline gets the store's own, rather than being
     * written with none: an attempt that never goes stale would read as
     * current forever.
     */
    const freshnessDeadline = attempt.freshnessDeadline
      || new Date(attempt.observedAt.getTime() + DEFAULT_VERIFICATION_FRESHNESS_MS);

    return this.#transaction(async client => {
      const owned = await client.query(
        `SELECT fingerprint FROM nv_exposure_findings
          WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
            AND fingerprint=$5 AND identity_key=$6
          FOR UPDATE`,
        [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey]
      );
      if (!owned.rows.length) {
        fail('That finding does not exist for this identity', 'EXPOSURE_FINDING_NOT_FOUND', 404);
      }

      const inserted = await client.query(
        `INSERT INTO nv_exposure_verifications (
           verification_id, provider, authority, owner_login, repo_name, fingerprint,
           identity_key, requested_by, adapter, adapter_version, target_id, authorization_id,
           state, reason, subject_digest, retry_after_ms, observed_at, freshness_deadline
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          verificationId, scope.provider, scope.authority, scope.owner, scope.repo, fingerprint,
          identityKey, requestedBy, attempt.adapter, adapterVersion, targetId, authorizationId,
          attempt.state, attempt.reason,
          /* Only a verdict names an account; the schema insists on it too. */
          attempt.state === 'verified' ? attempt.subjectDigest : null,
          attempt.retryAfterMs, attempt.observedAt, freshnessDeadline
        ]
      );

      let finding = null;
      if (attempt.state === 'rejected') {
        const moved = await client.query(
          `UPDATE nv_exposure_findings
              SET disposition='credential-rejected', disposition_at=$6, disposition_by=NULL
            WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
              AND fingerprint=$5 AND disposition <> 'accepted-risk'
           RETURNING *`,
          [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, attempt.observedAt]
        );
        finding = findingFromRow(moved.rows[0] || null);
      }
      return Object.freeze({
        verification: verificationFromRow(inserted.rows[0]),
        finding
      });
    }, 'record a verification');
  }

  /*
   * The attempts for one finding, newest first. The history is the point: a
   * `verified` on Tuesday and a `rejected` on Friday is what proves somebody's
   * revocation worked, and keeping only the latest answer would throw that
   * away.
   */
  async listVerifications(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Verification identity');
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const limit = boundedInteger(input.limit, 20, 1, MAX_LIST_LIMIT);
    const found = await this.#query(
      `SELECT * FROM nv_exposure_verifications
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$6
        ORDER BY observed_at DESC, verification_id
        LIMIT $7`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey, limit],
      'list verifications'
    );
    return Object.freeze(found.rows.map(verificationFromRow));
  }

  /*
   * Recording what the project allowed the anonymous role to read.
   *
   * Appended, never updated, and appended whatever the answer -- including the
   * attempts that never reached the network. An attempt refused for its shape
   * is evidence too: it says this server was asked to probe something it will
   * not probe, and a history that kept only the requests that went out could
   * not show that.
   *
   * Unlike a verification this moves no disposition, and that is the honest
   * behaviour rather than an omission. A readable table is not the credential
   * being live and a denied one is not the exposure ending: what the anonymous
   * role can reach says nothing about whether this particular key still works,
   * so inferring a disposition from it would be inventing a fact.
   */
  async recordReadabilityProbe(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Probe identity');
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const requestedBy = requireText(input.requestedBy, 'Probe actor', 255);
    const attempt = normalizeReadabilityProbe(input.record);
    if (!attempt) throw new TypeError('A readability probe requires an observation');
    const probeId = text(input.probeId) || crypto.randomUUID();
    const authorizationId = text(input.authorizationId) || null;
    const freshnessDeadline = attempt.freshnessDeadline
      || new Date(attempt.observedAt.getTime() + DEFAULT_PROBE_FRESHNESS_MS);

    return this.#transaction(async client => {
      const owned = await client.query(
        `SELECT fingerprint FROM nv_exposure_findings
          WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
            AND fingerprint=$5 AND identity_key=$6
          FOR UPDATE`,
        [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey]
      );
      if (!owned.rows.length) {
        fail('That finding does not exist for this identity', 'EXPOSURE_FINDING_NOT_FOUND', 404);
      }
      const inserted = await client.query(
        `INSERT INTO nv_exposure_readability_probes (
           probe_id, provider, authority, owner_login, repo_name, fingerprint,
           identity_key, requested_by, authorization_id,
           project_ref, relation, projection,
           state, reason, tested_role, row_count, observed_at, freshness_deadline
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          probeId, scope.provider, scope.authority, scope.owner, scope.repo, fingerprint,
          identityKey, requestedBy, authorizationId,
          attempt.projectRef, attempt.relation, attempt.projection,
          attempt.state, attempt.reason, attempt.testedRole, attempt.rowCount,
          attempt.observedAt, freshnessDeadline
        ]
      );
      return Object.freeze({ probe: readabilityProbeFromRow(inserted.rows[0]) });
    }, 'record a readability probe');
  }

  /*
   * The latest answer of each kind for a page of findings, in two queries
   * rather than two per finding.
   *
   * This exists because a screen that only shows what was asked in the current
   * session is a screen that forgets. A verification from yesterday and a
   * readability answer from last week are the evidence a reader came back for,
   * and making them appear by re-asking would mean using somebody's credential
   * again to redisplay a fact already recorded.
   *
   * Only the latest of each, because that is what a list can show. The full
   * sequence -- which is what proves a revocation or a policy change landed --
   * stays behind the history reads, where a reader asks for one finding.
   */
  async latestAnswers(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Answer identity');
    const fingerprints = [...new Set(
      (Array.isArray(input.fingerprints) ? input.fingerprints : [])
        .map(value => text(value).toLowerCase())
        .filter(value => /^[0-9a-f]{64}$/.test(value))
    )].slice(0, MAX_LIST_LIMIT);
    if (!fingerprints.length) {
      return Object.freeze({ verifications: Object.freeze({}), probes: Object.freeze({}) });
    }
    const parameters = [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, fingerprints];
    const [verifications, probes] = await Promise.all([
      this.#query(
        `SELECT DISTINCT ON (fingerprint) * FROM nv_exposure_verifications
          WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
            AND identity_key=$5 AND fingerprint = ANY($6)
          ORDER BY fingerprint, observed_at DESC, verification_id`,
        parameters,
        'read the latest verifications'
      ),
      this.#query(
        `SELECT DISTINCT ON (fingerprint) * FROM nv_exposure_readability_probes
          WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
            AND identity_key=$5 AND fingerprint = ANY($6)
          ORDER BY fingerprint, observed_at DESC, probe_id`,
        parameters,
        'read the latest readability probes'
      )
    ]);
    const index = (rows, map) => Object.freeze(Object.fromEntries(
      rows.map(row => [row.fingerprint, map(row)])
    ));
    return Object.freeze({
      verifications: index(verifications.rows, verificationFromRow),
      probes: index(probes.rows, readabilityProbeFromRow)
    });
  }

  /*
   * The probes for one finding, newest first. The history is the point here
   * too: "readable on Tuesday, denied on Friday" is what shows somebody's
   * policy change landed, and it is the only evidence that it did.
   */
  async listReadabilityProbes(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Probe identity');
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const limit = boundedInteger(input.limit, 20, 1, MAX_LIST_LIMIT);
    const found = await this.#query(
      `SELECT * FROM nv_exposure_readability_probes
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$6
        ORDER BY observed_at DESC, probe_id
        LIMIT $7`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, identityKey, limit],
      'list readability probes'
    );
    return Object.freeze(found.rows.map(readabilityProbeFromRow));
  }

  /* A person decided. It records who, and the schema insists on that. */
  async acceptRisk(input = {}) {
    const scope = requireScope(input.scope);
    const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
    const identityKey = requireDigest(input.identityKey, 'Finding identity');
    const actor = requireText(input.actor, 'Accepting actor', 255);
    const now = instant(input.now == null ? Date.now() : input.now, 'Acceptance time');
    const updated = await this.#query(
      `UPDATE nv_exposure_findings
          SET disposition='accepted-risk', disposition_at=$6, disposition_by=$7
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND fingerprint=$5 AND identity_key=$8
       RETURNING *`,
      [scope.provider, scope.authority, scope.owner, scope.repo, fingerprint, now, actor, identityKey],
      'accept a risk'
    );
    return findingFromRow(updated.rows[0] || null);
  }

  /*
   * Reads, and every one of them carries the identity boundary in the WHERE
   * clause rather than checking it afterwards. A scan id is a uuid somebody
   * could hold without owning, so "fetch then compare" is one forgotten
   * comparison away from being a cross-tenant read.
   */
  async getScan(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const identityKey = requireDigest(input.identityKey, 'Scan identity');
    const found = await this.#query(
      'SELECT * FROM nv_exposure_scans WHERE scan_id=$1 AND identity_key=$2',
      [scanId, identityKey],
      'read a scan'
    );
    return scanFromRow(found.rows[0] || null);
  }

  async listFindings(input = {}) {
    const scope = requireScope(input.scope);
    const identityKey = requireDigest(input.identityKey, 'Finding identity');
    const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
    const dispositions = Array.isArray(input.dispositions) && input.dispositions.length
      ? input.dispositions.map(value => requireMember(value, DISPOSITIONS, 'Disposition'))
      : DISPOSITIONS.slice();
    const found = await this.#query(
      `SELECT * FROM nv_exposure_findings
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND disposition = ANY($6::text[])
        ORDER BY first_observed_at, fingerprint
        LIMIT $7`,
      [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, dispositions, limit],
      'list findings'
    );
    return Object.freeze(found.rows.map(findingFromRow));
  }

  async listObservations(input = {}) {
    const scanId = requireText(input.scanId, 'Scan id', 64);
    const identityKey = requireDigest(input.identityKey, 'Scan identity');
    const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
    const found = await this.#query(
      `SELECT observation.* FROM nv_exposure_observations AS observation
         JOIN nv_exposure_scans AS scan ON scan.scan_id=observation.scan_id
        WHERE observation.scan_id=$1 AND scan.identity_key=$2
        ORDER BY observation.fingerprint
        LIMIT $3`,
      [scanId, identityKey, limit],
      'list observations'
    );
    return Object.freeze(found.rows.map(observationFromRow));
  }

  /*
   * Retention. A bounded slice at a time, and only scans past their own
   * retention date -- the findings survive, because a finding is the durable
   * record and an observation is the detail of one measurement. Deleting a
   * scan therefore ages out what was seen where without forgetting that a
   * credential was ever exposed.
   */
  async sweepExpiredScans(input = {}) {
    const now = instant(input.now == null ? Date.now() : input.now, 'Sweep time');
    const limit = boundedInteger(input.limit, this.sweepBatch, 1, MAX_SWEEP_BATCH);
    const deleted = await this.#query(
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
    return deleted.rows.length;
  }
}

module.exports = Object.freeze({
  COVERAGE,
  DEFAULT_PROBE_FRESHNESS_MS,
  DEFAULT_VERIFICATION_FRESHNESS_MS,
  DISPOSITIONS,
  EXPOSURE_CONFIG_VERSION,
  ExposureStore,
  ExposureStoreError,
  MAX_FINDINGS_PER_SCAN,
  MAX_OCCURRENCES,
  SCAN_STATES,
  SKIPPED_REASONS,
  TERMINAL_STATES
});
