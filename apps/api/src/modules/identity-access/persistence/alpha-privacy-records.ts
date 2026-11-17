import { createHash } from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { QueryOutcome, Row } from '../../../platform/persistence/queryable.ts';

/*
 * The alpha privacy store's checks and records.
 *
 * The checks on every value the store is given -- tester ids, hashes,
 * providers, authorities, resource types and reason codes -- and the records
 * it reads back: a cleanup's identity, a purge's report, and the shapes of
 * a hosted session and its readiness for deletion. The store in
 * alpha-privacy-store.ts and its operations stand on this.
 */

export const TESTER_ID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_RX = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const REASON_CODE_RX = /^(?:|[A-Z][A-Z0-9_]{1,79})$/;
export const RELEASE_VERSION_RX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
export const CORRELATION_ID_RX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const FEATURE_RX = /^[a-z][a-z0-9._-]{0,79}$/;
export const ERROR_CODE_RX = /^[A-Z][A-Z0-9_]{1,79}$/;
// Historical provider identifiers are retained solely for local cleanup and evidence.
const HISTORICAL_PROVIDERS = new Set(['github', 'gitlab', 'gitea']);
const RESOURCE_TYPES = new Set(['provider-webhook', 'temporary-branch', 'provider-session']);
export const CAPABILITY_STATUSES = new Set(['Supported', 'Experimental', 'Unavailable']);
export const RUNTIMES = new Set(['chrome', 'firefox', 'safari', 'edge', 'node', 'unknown']);
export const FEEDBACK_INPUT_FIELDS = new Set([
  'testerId', 'releaseVersion', 'correlationId', 'provider', 'feature',
  'capabilityStatus', 'errorCode', 'runtime', 'occurredAt'
]);
export const DAY_MS = 24 * 60 * 60 * 1000;

export class AlphaPrivacyStoreError extends Error {
  override readonly name = 'AlphaPrivacyStoreError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

type Fields = Readonly<Record<string, unknown>>;

export function requirePlainObject(value: unknown, label: string): Fields {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Fields;
}

export function requireTesterId(value: unknown): string {
  if (typeof value !== 'string' || !TESTER_ID_RX.test(value)) {
    throw new TypeError('testerId must be a UUID');
  }
  return value.toLowerCase();
}

export function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isSha256Hex(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

export function requireHashList(value: unknown, label: string, maximum = 1000): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded hash array`);
  }
  const hashes = (value as readonly unknown[]).map((item, index) => requireHash(item, `${label}[${index}]`));
  if (new Set(hashes).size !== hashes.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return hashes;
}

export function requireProvider(value: unknown): string {
  if (typeof value !== 'string' || !HISTORICAL_PROVIDERS.has(value)) {
    throw new TypeError('provider is unsupported');
  }
  return value;
}

export function requireActiveProvider(value: unknown): 'github' {
  if (value !== 'github') throw new TypeError('Only GitHub accounts can be connected');
  return value;
}

export function requireAuthority(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 255
    || !AUTHORITY_RX.test(value)
  ) {
    throw new TypeError('authority must be a normalized provider authority');
  }
  return value;
}

export function requireResourceType(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_TYPES.has(value)) {
    throw new TypeError('resourceType is unsupported');
  }
  return value;
}

export function requireReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !REASON_CODE_RX.test(value)) {
    throw new TypeError('reasonCode must be an allowlisted diagnostic code');
  }
  return value;
}

export function requirePattern(value: unknown, pattern: RegExp, label: string, maximum = 80): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function requireEnum(value: unknown, values: ReadonlySet<string>, label: string): string {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function toDate(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

export function toIso(value: unknown): string {
  return toDate(value, 'database timestamp').toISOString();
}

/* The rows a statement answered with. An answer without them is a failure, as it always was. */
export function rowsOf(result: QueryOutcome): readonly Row[] {
  const rows = result.rows;
  if (!rows) throw new TypeError('the database answered without rows');
  return rows;
}

/* The row a statement that always returns one returned (RETURNING, an aggregate). */
export function onlyRow(result: QueryOutcome): Row {
  const row = rowsOf(result)[0];
  if (!row) throw new TypeError('the database returned no row');
  return row;
}

export function cleanupTuple(row: Row): string {
  return [
    row.tester_id,
    row.identity_key,
    row.provider,
    row.resource_type,
    row.resource_key_hash
  ].join('\0');
}

export function testerPurgeHash(testerId: string): string {
  return createHash('sha256')
    .update(`nv-alpha-purge-v1\0${testerId}`, 'utf8')
    .digest('hex');
}

/* What a completed tester purge reports: counts and flags, never a removed value. */
export interface PurgeReport {
  readonly status: 'complete';
  readonly tokenBearingStateRemoved: boolean;
  readonly providerCleanupVerified: boolean;
  readonly retainedIntegrityMetadata: boolean;
  readonly removed: Readonly<{
    providerSessions: number;
    webhooks: number;
    events: number;
    snapshots: number;
    feedback: number;
  }>;
  readonly completedAt: string;
}

export function purgeReportFromRow(row: Row): PurgeReport {
  return Object.freeze({
    status: 'complete',
    tokenBearingStateRemoved: row.token_bearing_state_removed === true,
    providerCleanupVerified: row.provider_cleanup_verified === true,
    retainedIntegrityMetadata: row.retained_integrity_metadata === true,
    removed: Object.freeze({
      providerSessions: Number(row.provider_sessions_removed),
      webhooks: Number(row.webhooks_removed),
      events: Number(row.events_removed),
      snapshots: Number(row.snapshots_removed),
      feedback: Number(row.feedback_removed)
    }),
    completedAt: toIso(row.completed_at)
  });
}

/* Seals and opens the server's session rows; the store never reads a credential itself. */
export interface SessionCodec {
  encode(data: unknown): unknown;
  decode(value: unknown): unknown;
  identityKey(account: unknown): unknown;
}

export interface LifecycleOptions {
  readonly allowDeletion?: boolean;
  readonly allowRevoked?: boolean;
  readonly allowBlockedDeletion?: boolean;
}

export interface LifecycleContext {
  readonly tester: Row;
  readonly deletion: Row | null;
}

/* A hosted session as the codec opens it: its accounts, then whatever else the server keeps there. */
type Account = Record<string, unknown>;
export interface HostedSession {
  accounts: Account[];
  [key: string]: unknown;
}

/* Why deletion is blocked, by code, with the cleanup tasks that block it. */
export interface CleanupBlock {
  readonly code: string;
  readonly count: number;
  readonly cleanupIds: readonly unknown[];
}

export interface CleanupReadiness {
  readonly verified: boolean;
  readonly blockedCleanupIds: readonly unknown[];
  readonly cleanupBlocks: readonly CleanupBlock[];
}

export interface ReadinessScope {
  readonly identityKey: string;
  readonly provider: string;
}

export interface SessionLockOptions {
  readonly identityKey?: string;
  readonly provider?: string;
  readonly allowReleased?: boolean;
}
