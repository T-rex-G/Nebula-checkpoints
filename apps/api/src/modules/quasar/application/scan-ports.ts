import { type Finding } from '../domain/exposure-findings.ts';
import type {
  ArchiveRead, BlobText, CommitChanges, ReaderTransport, TreeFile, listCommits, readArchive, readBlob,
  readCommitChanges, readTree
} from '../client/exposure-reader.ts';
import { MAX_FINDINGS_PER_SCAN, type ScanRecord } from '../persistence/exposure-store.ts';
import { isCommitSha, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { property } from '../../../platform/values/fields.ts';

/*
 * What a scan runs under and what it is handed.
 *
 * The ceilings one scan may not pass, and the versioned defaults a finding's
 * identity records; and the ports the runner in exposure-worker.ts is given:
 * the store it claims, writes and finishes a scan through, the provider
 * reads it makes, and the session that reads them. Each is checked when the
 * runner is built, so a missing one fails at once rather than mid-scan.
 */

/*
 * The measured caps a scan runs under. They are part of a finding's identity
 * through the scan's config version, because a finding produced under a
 * 200-file ceiling is not comparable with one produced under a 20,000-file
 * ceiling -- the second scan looked where the first never did, so comparing
 * them would report credentials that were always there as newly appeared.
 * Changing any number here moves EXPOSURE_BUDGET_VERSION and, with it, the
 * config version a scan records.
 */
/*
 * 2: binary formats are recognised by name and never fetched, and the byte
 * ceiling is charged at the size the tree declares when a read is started
 * rather than after it lands -- so which file the ceiling falls on no longer
 * depends on which reads happened to finish first.
 */
/*
 * 3: history is read under a commit ceiling and a ceiling on the blobs read
 * for changes the provider sent no patch for, archives are opened, and the
 * wall clock is twice as long to fit both.
 */
export const EXPOSURE_BUDGET_VERSION = 4;

/* The ceilings one scan runs under. */
export interface Budgets {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxWallClockMs: number;
  readonly maxCommits: number;
  readonly maxHistoryBlobReads: number;
  readonly flushEveryFindings: number;
  readonly renewEveryFiles: number;
  readonly accessCheckIntervalMs: number;
  readonly readConcurrency: number;
}

export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  /* Files read per scan. The tree may hold more; this is what gets opened. */
  maxFiles: 2_000,
  /* Total decoded bytes scanned, so a repository of large text files cannot
     cost more than one of many small ones. */
  maxBytes: 32 * 1024 * 1024,
  /* Wall clock, because this process also answers HTTP and a scan is the
     slowest thing it does. History doubled what a scan reads, so it doubled. */
  maxWallClockMs: 8 * 60 * 1000,
  /* Commits whose changes a history scan reads, newest back. Past it the
     scan is partial and says `commit-limit`. */
  maxCommits: 1_000,
  /* A change the provider sent without a patch -- too large, or binary -- is
     read from its blob instead. Bounded separately, because a history of
     large generated files would otherwise be a blob read per commit. */
  maxHistoryBlobReads: 200,
  /* Findings buffered before a write. Bounded by what the store will take in
     one call. */
  flushEveryFindings: 100,
  /* How often the lease is renewed, which is also how often a cancellation is
     noticed. Small enough that a cancel is acted on quickly, large enough that
     a scan is not mostly database round trips. */
  renewEveryFiles: 25,
  /*
   * And the same check on a clock, so a scan of large files still notices a
   * cancel or a revoked session within a few seconds rather than within
   * twenty-five files. The two together replace a check before and after every
   * single file -- a lease write and a full session resolution each time --
   * which was most of what a scan spent its time on.
   */
  accessCheckIntervalMs: 5_000,
  /*
   * Reads in flight at once. A blob is a few hundred bytes and a round trip is
   * most of its cost, so a handful in parallel is most of the speed; more than
   * that is impolite to the provider and buys little. Results are consumed in
   * tree order whatever order they arrive in, so a scan with the same inputs
   * makes the same decisions.
   */
  readConcurrency: 6
});

export const MAX_ARCHIVES_IN_FLIGHT = 2;
/* The reader's word for a file that is not text, spelled once here rather than
   requiring the reader -- the worker receives a reader, it does not pick one. */
export const SKIP_BINARY = 'binary';

type Fields = Readonly<Record<string, unknown>>;

/* A Git object id: SHA-1 or SHA-256, lower-case hex. */
export function isObjectId(value: string): boolean {
  return isCommitSha(value) || isSha256Hex(value);
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export function budgetsFrom(input: unknown): Budgets {
  const source: Fields = input && typeof input === 'object' ? input as Fields : {};
  return Object.freeze({
    maxFiles: boundedInteger(source.maxFiles, DEFAULT_BUDGETS.maxFiles, 1, 100_000),
    /*
     * The floors are 1, not a comfortable minimum. A caller asking for a tiny
     * budget gets a tiny budget and a scan that reports partial coverage --
     * which is visible. Silently raising a configured ceiling to something
     * this file preferred would produce a scan that read more than it was
     * told to, and nobody reading the configuration would know.
     */
    maxBytes: boundedInteger(source.maxBytes, DEFAULT_BUDGETS.maxBytes, 1, 512 * 1024 * 1024),
    maxWallClockMs: boundedInteger(source.maxWallClockMs, DEFAULT_BUDGETS.maxWallClockMs, 0, 30 * 60 * 1000),
    maxCommits: boundedInteger(source.maxCommits, DEFAULT_BUDGETS.maxCommits, 1, 100_000),
    maxHistoryBlobReads: boundedInteger(source.maxHistoryBlobReads, DEFAULT_BUDGETS.maxHistoryBlobReads, 0, 10_000),
    flushEveryFindings: boundedInteger(
      source.flushEveryFindings, DEFAULT_BUDGETS.flushEveryFindings, 1, MAX_FINDINGS_PER_SCAN
    ),
    renewEveryFiles: boundedInteger(source.renewEveryFiles, DEFAULT_BUDGETS.renewEveryFiles, 1, 1000),
    accessCheckIntervalMs: boundedInteger(
      source.accessCheckIntervalMs, DEFAULT_BUDGETS.accessCheckIntervalMs, 250, 60_000
    ),
    readConcurrency: boundedInteger(source.readConcurrency, DEFAULT_BUDGETS.readConcurrency, 1, 16)
  });
}

/*
 * Hand the event loop back between files. This process serves HTTP while it
 * scans, and a loop that reads two thousand blobs without yielding is a loop
 * that stops answering requests for as long as it runs. `setImmediate` runs
 * after I/O callbacks, so a pending response is written before the next file
 * is opened.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

export function errorCode(error: unknown): string {
  return String((error && property(error, 'code')) || '');
}

/* What the worker needs of the store: a claim, its renewal, the writes, and the end of a scan. */
export interface ScanStore {
  claimScan(input: { readonly now: number; readonly leaseMs: number }): Promise<{ readonly scan: ScanRecord; readonly claimOwner: string } | null>;
  renewClaim(input: { readonly scanId: unknown; readonly claimOwner: string; readonly leaseMs: number; readonly now: number }): Promise<boolean>;
  recordObservations(input: { readonly scanId: unknown; readonly claimOwner: string; readonly findings: readonly ObservedFinding[]; readonly now: number }): Promise<unknown>;
  finalizeScan(input: { readonly scanId: unknown; readonly claimOwner: string; readonly now: number } & ScanOutcome): Promise<unknown>;
}

/* The provider reads a scan makes. A reader without the optional ones scans the tree alone. */
export interface ScanReader {
  readonly readTree: typeof readTree;
  readonly readBlob: typeof readBlob;
  readonly readArchive?: typeof readArchive;
  readonly listCommits?: typeof listCommits;
  readonly readCommitChanges?: typeof readCommitChanges;
}

/* Who may read the repository right now: a live session's token, or nothing. */
export type SessionResolver = (input: { readonly scope: ScanRecord['scope']; readonly requestedBy: unknown; readonly scanId: ScanRecord['scanId'] }) =>
  Promise<{ readonly token?: unknown } | null | undefined>;

/* A connection pool for one scan, closed when the scan ends. */
export interface ScanConnections {
  readonly request?: ReaderTransport;
  close?(): void;
}

export interface ExposureRunnerOptions {
  readonly store?: ScanStore | null;
  readonly reader?: ScanReader | null;
  readonly sessionResolver?: SessionResolver | null;
  readonly fingerprintKey?: unknown;
  readonly budgets?: unknown;
  readonly now?: (() => number) | null;
  readonly createTransport?: (() => ScanConnections | null | undefined) | null;
  readonly leaseMs?: unknown;
}

export interface ExposureWorkerOptions extends ExposureRunnerOptions {
  readonly intervalMs?: unknown;
  readonly autoStart?: boolean;
}

/* Where a sighting was: in the tree, or in the commit that added it. */
export interface Provenance {
  readonly inTree: boolean;
  readonly introducedCommit?: string;
  readonly introducedAt?: string | null;
}

/* A finding as the store takes it: the sanitized finding and where it was seen. */
export type ObservedFinding = Readonly<Finding & Provenance>;

/* How a scan ended, as the store records it: a plain record of named fields, so the store's reader of fields takes it as it is. */
export type ScanOutcome = {
  readonly state: 'complete' | 'partial' | 'failed';
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly skippedReason: string | null;
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly filesTotal?: number;
  readonly filesSkippedBinary?: number;
  readonly filesSkippedOther?: number;
  readonly commitsTotal?: number | null;
  readonly commitsScanned?: number | null;
  readonly commitsSkipped?: number | null;
  readonly archivesScanned?: number;
  readonly archiveMembersScanned?: number;
};

/* A read started ahead of the scan, and how it settled. */
type Settled<T> = { readonly value: T } | { readonly error: unknown };

export interface TreeRead {
  readonly entry: TreeFile;
  readonly settled: Promise<Settled<BlobText | ArchiveRead>>;
}

export interface HistoryRead {
  readonly settled: Promise<Settled<CommitChanges>>;
}

/* A read's outcome held as a value, so a read nobody looks at again can never reject unobserved. */
export function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  return Promise.resolve(read).then(value => ({ value }), (error: unknown) => ({ error }));
}

export function requireStore(store: ScanStore | null | undefined): ScanStore {
  if (!store || typeof store.claimScan !== 'function') throw new TypeError('An exposure runner requires a store');
  return store;
}

export function requireReader(reader: ScanReader | null | undefined): ScanReader {
  if (!reader || typeof reader.readTree !== 'function' || typeof reader.readBlob !== 'function') {
    throw new TypeError('An exposure runner requires a provider reader');
  }
  return reader;
}

export function requireSessionResolver(sessionResolver: SessionResolver | null | undefined): SessionResolver {
  if (typeof sessionResolver !== 'function') {
    throw new TypeError('An exposure runner requires a session resolver');
  }
  return sessionResolver;
}
