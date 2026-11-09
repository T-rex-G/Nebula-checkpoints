import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { VERIFICATION_FRESHNESS_MS } from '../domain/verification-outcomes.ts';
import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { isCommitSha, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { PoolClient, QueryOutcome, Row } from '../../../platform/persistence/queryable.ts';
import { fieldsOf, listOf, property, trimmedText } from '../../../platform/values/fields.ts';

/*
 * The exposure store's vocabulary and its records.
 *
 * The states, modes and reasons a scan and a finding may hold, and the bounds
 * on each; the cursors a list is paged by, signed so a reader cannot forge
 * one; the checks on every value written; and the records each row is read
 * back as -- named columns only, since spreading a row would publish whatever
 * the schema grows next. The store in exposure-store.ts and its operations
 * stand on this, and on nothing else of each other.
 */

/*
 * The version of the scanning configuration -- the caps a scan runs under.
 * It is part of a finding's identity because a finding produced under a
 * 100-file ceiling is not comparable with one produced under a 10,000-file
 * ceiling: the second scan looked in places the first never saw, so a
 * comparison between them would read "appeared" for credentials that were
 * always there. Changing any cap moves this number.
 *
 * 2: binary formats are recognised by name and never fetched, and the byte
 * ceiling is charged at declared size when a read starts.
 *
 * 3: a scan can read history under a commit ceiling, archives are opened
 * under member and size ceilings, and the wall clock is longer to fit both.
 */
export const EXPOSURE_CONFIG_VERSION = 4;

/* A scan of the tree at one commit, or of that tree and every commit's
   changes reachable from it. */
export const SCAN_MODES = Object.freeze(['tree', 'history'] as const);
export const DECODINGS = Object.freeze(['base64'] as const);

export const SKIPPED_REASONS = Object.freeze([
  'file-count-limit', 'byte-limit', 'time-limit', 'tree-truncated',
  'unreadable-files', 'canceled', 'transport-refused',
  /*
   * The session that authorised the read is gone. Distinct from a transport
   * refusal because it is not a network problem and retrying will not help:
   * somebody disconnected the provider or revoked the grant, and the scan
   * stopped rather than keeping the credential to try again with.
   */
  'authorization-revoked', 'finding-limit', 'configuration-changed',
  /* History stopped at its commit ceiling, or the provider asked for fewer
     requests. Either way what was read is kept and coverage says partial. */
  'commit-limit', 'rate-limited'
] as const);
export const DISPOSITIONS = Object.freeze(['open', 'credential-rejected', 'accepted-risk', 'removed-from-tree'] as const);
export type Disposition = (typeof DISPOSITIONS)[number];

export const DEFAULT_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/*
 * How long a provider's answer stays current. It matches the verifier's own
 * window: an attempt that outlived its deadline is not a rejection, it is an
 * answer nobody should still be relying on.
 */
export const DEFAULT_VERIFICATION_FRESHNESS_MS = VERIFICATION_FRESHNESS_MS;
/*
 * Shorter than a verification's, and on purpose. Whether a token still works
 * changes when somebody revokes it; whether a table is readable changes when
 * somebody edits a policy, which is a far more ordinary thing to do in an
 * afternoon. A readability answer from yesterday is history, not news.
 */
export const DEFAULT_PROBE_FRESHNESS_MS = 60 * 60 * 1000;
export const MAX_OCCURRENCES = 20;
export const MAX_FINDINGS_PER_SCAN = 500;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_SWEEP_BATCH = 200;
export const MAX_SWEEP_BATCH = 2000;
export const DEFAULT_CURSOR_KEY = randomBytes(32);

export type Fields = Readonly<Record<string, unknown>>;

/* A repository at a provider, as every row here is keyed. */
export interface ExposureScope {
  readonly provider: string;
  readonly authority: string;
  readonly owner: string;
  readonly repo: string;
}

/* A row inside an aggregate the database built: an object, or nothing to read. */
export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object';
}

/* The rows a statement answered with. An answer without them is a failure, as it always was. */
export function rowsOf(result: QueryOutcome): readonly Row[] {
  const rows = result.rows;
  if (!rows) throw new TypeError('the database answered without rows');
  return rows;
}

/* The row a statement that always returns one returned (an aggregate with no FROM). */
export function onlyRow(result: QueryOutcome): Row {
  const row = rowsOf(result)[0];
  if (!row) throw new TypeError('the database returned no row');
  return row;
}

/* A rule's severity from the narration table. Only a rule the table lists: an inherited key is not a severity. */
export function severityOf(severities: Readonly<Record<string, Severity>>, rule: string): Severity {
  return (Object.hasOwn(severities, rule) && severities[rule]) || 'serious';
}

interface FindingsFilters {
  readonly dispositions: readonly Disposition[];
  readonly query: string;
  readonly severity: string;
  readonly where: string;
}

export function findingsFilters(input: Fields): FindingsFilters {
  try {
  const asked = listOf(input.dispositions);
  const dispositions = asked.length
    ? [...new Set(asked.map(value => requireMember(value, DISPOSITIONS, 'Disposition')))].sort()
    : DISPOSITIONS.slice().sort();
  const query = trimmedText(input.query).toLowerCase().replace(/\s+/g, ' ');
  if (query.length > 512) throw new TypeError('Finding query must be at most 512 characters');
  return {
    dispositions, query,
    severity: requireMember(input.severity || 'all', ['all', 'critical', 'serious', 'warning'], 'Severity'),
    where: requireMember(input.where || 'all', ['all', 'tree', 'history', 'archive', 'encoded'], 'Finding location')
  };
  } catch {
    fail('Choose a valid finding filter and a query of at most 512 characters', 'EXPOSURE_FILTER_INVALID', 400);
  }
}

export function cursorSignature(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/* A page's place in a findings view: signed, bound to the view, and to the evidence it was read from. */
interface FindingsCursor {
  readonly version: 1;
  readonly binding: string;
  readonly revision: string;
  readonly snapshot: string;
  readonly at: string;
  readonly fingerprint: string;
}

/* A page's place in one scan's report. */
type ReportCursor = Omit<FindingsCursor, 'at'>;

export function encodeFindingsCursor(value: Fields, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${cursorSignature(payload, key)}`;
}

/* A cursor's payload, once its signature is checked: what it says, still to be read field by field. */
function signedPayload(value: unknown, key: Buffer, invalid: string): unknown {
  if (typeof value !== 'string' || value.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(value)) {
    fail(invalid, 'EXPOSURE_CURSOR_INVALID', 400);
  }
  /* The shape above has exactly one dot, so both halves are there. */
  const [payload = '', signature = ''] = value.split('.');
  const expected = cursorSignature(payload, key);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    fail(invalid, 'EXPOSURE_CURSOR_INVALID', 400);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed;
  } catch {
    return fail(invalid, 'EXPOSURE_CURSOR_INVALID', 400);
  }
}

export function decodeFindingsCursor(value: unknown, key: Buffer, binding: string): FindingsCursor {
  const cursor = signedPayload(value, key, 'That findings cursor is not valid');
  const snapshot = property(cursor, 'snapshot');
  const at = property(cursor, 'at');
  const fingerprint = property(cursor, 'fingerprint');
  const revision = property(cursor, 'revision');
  if (!cursor || property(cursor, 'version') !== 1 || property(cursor, 'binding') !== binding
      || typeof snapshot !== 'string' || !Number.isFinite(Date.parse(snapshot))
      || typeof at !== 'string' || !Number.isFinite(Date.parse(at))
      || typeof fingerprint !== 'string' || !isSha256Hex(fingerprint)
      || typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) {
    return fail('That findings cursor does not match this view', 'EXPOSURE_CURSOR_INVALID', 400);
  }
  return { version: 1, binding, revision, snapshot, at, fingerprint };
}

export function decodeReportCursor(value: unknown, key: Buffer, binding: string): ReportCursor {
  const cursor = signedPayload(value, key, 'That report cursor is not valid');
  const snapshot = property(cursor, 'snapshot');
  const fingerprint = property(cursor, 'fingerprint');
  const revision = property(cursor, 'revision');
  if (!cursor || property(cursor, 'version') !== 1 || property(cursor, 'binding') !== binding
    || typeof snapshot !== 'string' || !Number.isFinite(Date.parse(snapshot))
    || typeof fingerprint !== 'string' || !isSha256Hex(fingerprint)
    || typeof revision !== 'string' || !/^[0-9a-f]{32}$/.test(revision)) {
    return fail('That report cursor does not match this scan', 'EXPOSURE_CURSOR_INVALID', 400);
  }
  if (Date.now() - Date.parse(snapshot) > 20 * 60 * 1000) {
    fail('This report view expired. Refresh the report.', 'EXPOSURE_CURSOR_STALE', 409);
  }
  return { version: 1, binding, revision, snapshot, fingerprint };
}

export class ExposureStoreError extends Error {
  override readonly name = 'ExposureStoreError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'EXPOSURE_STORE_UNAVAILABLE', status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function fail(message: string, code?: string, status?: number): never {
  throw new ExposureStoreError(message, code, status);
}

export function requireText(value: unknown, label: string, max: number): string {
  const out = trimmedText(value);
  if (!out || out.length > max) throw new TypeError(`${label} is required and must be at most ${max} characters`);
  return out;
}

function requirePath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 1024) {
    throw new TypeError('Finding path is required and must be at most 1024 characters');
  }
  return value;
}

export function requireScope(scope: unknown): ExposureScope {
  const source = fieldsOf(scope);
  return Object.freeze({
    provider: requireText(source.provider, 'Scan provider', 40),
    authority: requireText(source.authority, 'Scan authority', 255),
    owner: requireText(source.owner, 'Scan owner', 255),
    repo: requireText(source.repo, 'Scan repository', 255)
  });
}

export function requireDigest(value: unknown, label: string): string {
  const out = trimmedText(value).toLowerCase();
  if (!isSha256Hex(out)) throw new TypeError(`${label} must be a sha-256 digest`);
  return out;
}

export function requireCommit(value: unknown): string {
  const out = trimmedText(value).toLowerCase();
  if (!isCommitSha(out)) throw new TypeError('Scan commit must be a 40-character object id');
  return out;
}

export function requireVersion(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export function requireMember<Word extends string>(value: unknown, allowed: readonly Word[], label: string): Word {
  const out = trimmedText(value);
  const member = allowed.find(word => word === out);
  if (member === undefined) throw new TypeError(`${label} must be one of ${allowed.join(', ')}`);
  return member;
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/* Lock the repository/identity admission gap, including an empty scan set.
   The namespace separates this advisory key from unrelated store locks. */
export function historyScopeLockKey(scope: ExposureScope, identityKey: string): string {
  return createHash('sha256').update(JSON.stringify([
    'exposure-history-scope-v1', scope.provider, scope.authority, scope.owner, scope.repo, identityKey
  ])).digest().readBigInt64BE(0).toString();
}

export function instant(value: unknown, label: string): Date {
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
export function claimToken(): string {
  return randomBytes(16).toString('hex');
}

/* ---- Serializers ------------------------------------------------------- */

/*
 * Named columns only. Spreading a row would publish whatever the schema grows
 * next, and the whole privacy claim here is about what does not leave.
 */
function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : (value == null ? null : String(value));
}

/* The scope quadruple, text NOT NULL in every table that holds it, as is a scan's uuid key. */
const scopeOf = (row: Row): ExposureScope => Object.freeze({ provider: String(row.provider), authority: String(row.authority), owner: String(row.owner_login), repo: String(row.repo_name) });

export function scanOf(row: Row) {
  return Object.freeze({
    scanId: String(row.scan_id),
    scope: scopeOf(row),
    requestedBy: row.requested_by,
    refName: row.ref_name,
    commitSha: row.commit_sha,
    fingerprintKeyId: row.fingerprint_key_id || null,
    rulesVersion: row.rules_version,
    engineVersion: row.engine_version,
    fingerprintKeyVersion: row.fingerprint_key_version,
    configVersion: row.config_version,
    state: row.state,
    coverage: row.coverage,
    skippedReason: row.skipped_reason || null,
    filesScanned: row.files_scanned,
    bytesScanned: Number(row.bytes_scanned),
    /* Null on a scan that finished before these were recorded, rather than a
       zero that would claim nothing was skipped. */
    filesTotal: row.files_total == null ? null : Number(row.files_total),
    filesSkippedBinary: row.files_skipped_binary == null ? null : Number(row.files_skipped_binary),
    filesSkippedOther: row.files_skipped_other == null ? null : Number(row.files_skipped_other),
    scanMode: row.scan_mode || 'tree',
    historyBaseCommit: row.history_base_commit || null,
    commitsTotal: row.commits_total == null ? null : Number(row.commits_total),
    commitsScanned: row.commits_scanned == null ? null : Number(row.commits_scanned),
    commitsSkipped: row.commits_skipped == null ? null : Number(row.commits_skipped),
    archivesScanned: row.archives_scanned == null ? null : Number(row.archives_scanned),
    archiveMembersScanned: row.archive_members_scanned == null ? null : Number(row.archive_members_scanned),
    parentScanId: row.parent_scan_id || null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    retainUntil: iso(row.retain_until)
  });
}

export type ScanRecord = ReturnType<typeof scanOf>;

export function scanFromRow(row: Row | null | undefined): ScanRecord | null {
  return row ? scanOf(row) : null;
}

export function findingOf(row: Row) {
  return Object.freeze({
    fingerprint: row.fingerprint,
    scope: scopeOf(row),
    fingerprintKeyVersion: row.fingerprint_key_version,
    rulesVersion: row.rules_version,
    engineVersion: row.engine_version,
    rule: row.rule,
    path: row.file_path,
    commit: row.commit_sha || null,
    placeholder: row.placeholder,
    disposition: row.disposition,
    dispositionAt: iso(row.disposition_at),
    dispositionBy: row.disposition_by || null,
    firstObservedAt: iso(row.first_observed_at),
    lastObservedAt: iso(row.last_observed_at)
  });
}

export type FindingRecord = ReturnType<typeof findingOf>;

export function findingFromRow(row: Row | null | undefined): FindingRecord | null {
  return row ? findingOf(row) : null;
}

export function observationOf(row: Row) {
  const lines = listOf(row.occurrence_lines);
  const columns = listOf(row.occurrence_columns);
  return Object.freeze({
    scanId: row.scan_id,
    fingerprint: row.fingerprint,
    occurrenceCount: row.occurrence_count,
    occurrences: Object.freeze(lines.map((line, index) => Object.freeze({
      line: Number(line), column: Number(columns[index])
    }))),
    truncated: Boolean(row.truncated),
    /* Null on an observation from before history was read, which only ever
       read the tree. */
    inTree: row.in_tree === false ? false : true,
    introducedCommit: row.introduced_commit || null,
    introducedAt: iso(row.introduced_at),
    historyCommits: row.history_count_exact === false || row.history_commits == null ? null : Number(row.history_commits),
    decodedFrom: row.decoded_from || null,
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

export type ObservationRecord = ReturnType<typeof observationOf>;

export function observationFromRow(row: unknown): ObservationRecord | null {
  return isRow(row) ? observationOf(row) : null;
}

export function verificationOf(row: Row) {
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

export type VerificationRecord = ReturnType<typeof verificationOf>;

export function readabilityProbeOf(row: Row) {
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

export type ReadabilityProbeRecord = ReturnType<typeof readabilityProbeOf>;

export function verificationFromRow(row: Row | null | undefined): VerificationRecord | null {
  return row ? verificationOf(row) : null;
}

export function readabilityProbeFromRow(row: Row | null | undefined): ReadabilityProbeRecord | null {
  return row ? readabilityProbeOf(row) : null;
}

/* A stored time handed to Date as JavaScript would hand it; callers check what comes back. */
export function dateOf(value: unknown): Date {
  return new Date(value as string | number | Date);
}

/* ---- Input normalisation ----------------------------------------------- */

/*
 * The findings a scan writes are the sanitized objects `domain/exposure-findings.ts`
 * produces. Re-validated here anyway: this is the boundary where they stop
 * being a value in a process and start being a row, and a value that arrives
 * as a parameter has not been checked just because it arrived as a parameter.
 */
export function normalizeFinding(finding: unknown) {
  const source = fieldsOf(finding);
  const occurrences = listOf(source.occurrences);
  if (!occurrences.length) throw new TypeError('A finding must carry at least one location');
  if (occurrences.length > MAX_OCCURRENCES) throw new TypeError('A finding carries more locations than the schema admits');

  const lines: number[] = [];
  const columns: number[] = [];
  for (const occurrence of occurrences) {
    const line = occurrence && property(occurrence, 'line');
    const column = occurrence && property(occurrence, 'column');
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1
      || typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
      throw new TypeError('A location must be a positive line and column');
    }
    lines.push(line);
    columns.push(column);
  }

  const counted = source.occurrenceCount;
  const occurrenceCount = typeof counted === 'number' && Number.isInteger(counted) ? counted : lines.length;
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
    path: requirePath(source.path),
    placeholder,
    lines,
    columns,
    occurrenceCount,
    truncated: occurrenceCount > lines.length,
    verification: normalizeVerification(source.verification),
    ...normalizeProvenance(source)
  };
}

/*
 * Where a finding came from. A finding from the tree is in the tree; one from
 * history names the commit that introduced it, and one that is only in
 * history must -- a credential found nowhere is not a finding. `decodedFrom`
 * is a word from a closed set, never what was decoded.
 */
function normalizeProvenance(source: Fields) {
  const inTree = source.inTree !== false;
  const introducedCommit = source.introducedCommit == null || source.introducedCommit === ''
    ? null
    : requireCommit(source.introducedCommit);
  if (!inTree && !introducedCommit) {
    throw new TypeError('A finding that is not in the tree must name the commit that introduced it');
  }
  /* A commit date arrives from the provider as ISO text. */
  const introducedAt = introducedCommit && source.introducedAt != null
    ? instant(typeof source.introducedAt === 'string' ? Date.parse(source.introducedAt) : source.introducedAt, 'Introduction time')
    : null;
  const decodedFrom = source.decodedFrom == null ? null : requireMember(source.decodedFrom, DECODINGS, 'Decoding');
  return { inTree, introducedCommit, introducedAt, decodedFrom };
}

/*
 * A verification record from `client/credential-verification.ts`, reduced to the
 * bounded fields the schema admits. Notably absent: any response text, any
 * transport error message, any provider login. The subject arrives already
 * digested and is stored as the digest.
 */
export function normalizeVerification(verification: unknown) {
  if (verification == null) return null;
  const source = fieldsOf(verification);
  const state = requireMember(source.state, ['verified', 'rejected', 'unverifiable'], 'Verification state');
  const reason = trimmedText(source.reason);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(reason)) throw new TypeError('Verification reason must be a bounded reason code');
  const adapter = trimmedText(source.adapter);
  if (adapter && !/^[a-z][a-z0-9-]{2,63}$/.test(adapter)) throw new TypeError('Verification adapter must be a bounded identifier');
  const subjectDigest = trimmedText(source.subjectDigest);
  if (subjectDigest && !/^[0-9a-f]{32}$/.test(subjectDigest)) throw new TypeError('Verification subject must arrive already digested');
  return {
    state,
    reason,
    adapter: adapter || null,
    subjectDigest: subjectDigest || null,
    observedAt: instant(Date.parse(trimmedText(source.observedAt)) || source.observedAt, 'Verification time'),
    freshnessDeadline: source.freshnessDeadline
      ? instant(Date.parse(trimmedText(source.freshnessDeadline)) || source.freshnessDeadline, 'Verification deadline')
      : null,
    retryAfterMs: typeof source.retryAfterMs === 'number' && Number.isFinite(source.retryAfterMs)
      ? Math.min(Math.max(Math.round(source.retryAfterMs), 1000), 3_600_000)
      : null
  };
}

/*
 * An observation from `client/anonymous-readability-probe.ts`, reduced to the bounded
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
export function normalizeReadabilityProbe(observation: unknown) {
  if (observation == null) return null;
  const source = fieldsOf(observation);
  const state = requireMember(source.state, ['readable', 'denied', 'unverifiable'], 'Probe state');
  const reason = trimmedText(source.reason);
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(reason)) throw new TypeError('Probe reason must be a bounded reason code');
  const projectRef = trimmedText(source.projectRef);
  if (projectRef && !/^[a-z]{20}$/.test(projectRef)) throw new TypeError('Probe project reference must be twenty lowercase letters');
  const relation = trimmedText(source.relation);
  const relationStorable = /^[a-z_][a-z0-9_]{0,62}$/.test(relation);
  const projection = listOf(source.projection).map(column => trimmedText(column));
  const projectionStorable = projection.length > 0 && projection.length <= 8
    && projection.every(column => /^[a-z_][a-z0-9_]{0,62}$/.test(column));
  const testedRole = trimmedText(source.testedRole);
  if (testedRole && !['anon', 'publishable'].includes(testedRole)) {
    throw new TypeError('Probe tested role must be the anonymous role');
  }
  const rowCount = typeof source.rowCount === 'number' && Number.isInteger(source.rowCount) ? source.rowCount : 0;
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
    observedAt: instant(Date.parse(trimmedText(source.observedAt)) || source.observedAt, 'Probe time'),
    freshnessDeadline: source.freshnessDeadline
      ? instant(Date.parse(trimmedText(source.freshnessDeadline)) || source.freshnessDeadline, 'Probe deadline')
      : null
  };
}

/*
 * What the store's operations read of the store: its two ways to the
 * database -- one statement, or a transaction on one connection -- each
 * refusing in the store's own words, and the key and batch it was built with.
 */
export interface ExposureStoreContext {
  query(sql: string, params: readonly unknown[], label: string): Promise<QueryOutcome>;
  transaction<T>(work: (client: PoolClient) => Promise<T>, label: string): Promise<T>;
  readonly cursorKey: Buffer;
  readonly sweepBatch: number;
}
