import { boundedMap } from '../../../platform/concurrency/bounded-map.ts';
import type { GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import * as ecosystems from '../domain/ecosystems.ts';
import { EXCLUDED_DIR, LIMITS, READ_LOCKS, baseName, isFixturePath, isRequirements, type AuditLimits, type SelectedEntry } from '../domain/audit-files.ts';
import { LOCK_PARSERS, advisoryKey, dependencyInventory, packageJsonFindings, requirementsPackages } from '../domain/dependencies.ts';
import { mergeScans, type AnalyseInput, type AuditFile, type Component, type Scan } from '../domain/code-audit.ts';
import { analyse, scanRules, selectFiles } from './audit-engine.ts';
import { lookupAdvisories, lookupPackages, type AdvisoryLookup, type AuditTransport } from '../client/advisory-lookup.ts';
import { lookupLicences } from '../client/licence-lookup.ts';
import { lookupExploitIntel, type IntelAnswer, type IntelCache } from '../client/exploit-intel.ts';

/*
 * Uranus against a provider: the repository read through the guarded reader
 * Exposure uses, the registries and the advisory database asked, and the
 * analysis run on what came back -- cancellable at every step.
 */

/* ---- Types ------------------------------------------------------------------------ */

/* A read the reader is asked for, through the session's transport. */
interface ReaderCall {
  readonly scope: unknown;
  readonly token: unknown;
  readonly transport: AuditTransport | undefined;
}
interface ReaderBlob {
  readonly text?: unknown;
}
type ReaderTexts = ReadonlyMap<string, ReaderBlob> & { readonly failed?: boolean };
interface ReaderTreeEntry {
  readonly path: string;
  readonly sha?: unknown;
  readonly size?: unknown;
}
/* The guarded repository reader, as the audit uses it: Exposure's reader, or a test's own. */
export interface AuditReader {
  resolveCommit(input: ReaderCall & { readonly ref: unknown }): Promise<{ readonly ref: string; readonly commitSha: string }>;
  readTree(input: ReaderCall & { readonly commitSha: string }): Promise<{ readonly entries: readonly ReaderTreeEntry[]; readonly skipped: readonly { readonly path?: string | null }[]; readonly truncated?: boolean }>;
  readBlob(input: ReaderCall & { readonly sha: unknown }): Promise<ReaderBlob>;
  readBlobTexts?(input: ReaderCall & { readonly commitSha: string; readonly paths: string[] }): Promise<ReaderTexts>;
  readonly MAX_TEXTS_PER_QUERY?: unknown;
}
/* Where an audit has got to: a stage and, while files are read, how many. Numbers and stage names only. */
export type AuditProgress = { readonly stage: string } & Readonly<Record<string, unknown>>;
type Analysis = ReturnType<typeof analyse>;
export interface AuditRepositoryInput {
  readonly reader: AuditReader;
  readonly scope: unknown;
  readonly ref: unknown;
  readonly token: unknown;
  readonly transport?: AuditTransport;
  readonly queryTransport?: AuditTransport;
  readonly registryTransport?: AuditTransport;
  readonly advisoryTransport?: AuditTransport;
  readonly licenceTransport?: AuditTransport;
  readonly intelTransport?: AuditTransport;
  readonly intelCache?: IntelCache;
  readonly limits?: AuditLimits;
  readonly analyser?: (input: AnalyseInput) => Analysis | Promise<Analysis>;
  readonly scanner?: (input: { readonly files: AuditFile[] }) => Scan | Promise<Scan>;
  readonly onProgress?: (progress: AuditProgress) => void;
  readonly signal?: AbortSignal | null;
}

/* Cancellation reasons can contain private context; only this fixed error leaves the audit. */
export function assertAuditActive(signal: AbortSignal | null | undefined): void {
  if (!signal || !signal.aborted) return;
  throw Object.assign(new Error('The audit was cancelled.'), {
    code: 'AUDIT_CANCELLED',
    status: 499,
    providerChanged: false,
    safeState: 'Nothing was changed. The audit only reads.'
  });
}

/*
 * The whole audit against a provider: resolve the ref once, list the tree at
 * that commit, read what fits the budget, ask the registries, analyse.
 *
 * `analyser` runs the analysis -- in-process by default, on a worker thread
 * where the caller has one -- and `onProgress` hears each stage as it
 * starts, with a count while files are read. Progress carries numbers and
 * stage names only, never a path or a line of the code.
 */
/*
 * What each component's advisories were at this audit: every id OSV answered
 * before aliases were folded together, the CVEs those advisories carry, and
 * which of them CISA listed as exploited. It is the baseline the watch
 * compares a later answer with (code-audit-watch.ts), so an advisory this
 * audit already reported is never announced again as new, and a CVE that was
 * already in the catalog is never announced as newly exploited.
 */
const MAX_BASELINE_IDS = 200;
function baselineComponents(components: Component[] | null | undefined, advisories: AdvisoryLookup, intel: { readonly answers: ReadonlyMap<string, IntelAnswer> } | null): void {
  if (!Array.isArray(components) || !advisories.ids) return;
  for (const component of components) {
    const key = advisoryKey(component);
    const ids = advisories.ids.get(key);
    if (!ids || !ids.length) continue;
    const answer = advisories.answers.get(key);
    const cves = answer && answer !== 'unknown' ? [...new Set(answer.advisories.map(advisory => advisory.cve).filter((cve): cve is string => Boolean(cve)))] : [];
    const listed = (cve: string): boolean => {
      const known = intel && intel.answers.get(cve);
      return Boolean(known && known.kev);
    };
    component.advisories = { ids: [...new Set(ids)].slice(0, MAX_BASELINE_IDS), cves: cves.slice(0, MAX_BASELINE_IDS), exploited: cves.filter(listed).slice(0, MAX_BASELINE_IDS) };
  }
}

/*
 * The files past the traced set: read a few megabytes at a time through the
 * provider's query API -- one request for up to a hundred files, where the
 * REST API needs one each -- and checked against every per-file rule in
 * batches, each batch's text dropped before the next is read. A reader
 * without a query API, or an audit without its transport, leaves them
 * unread, and coverage counts them as past the budget.
 */
interface BeyondInput {
  readonly reader: AuditReader;
  readonly scope: unknown;
  readonly commitSha: string;
  readonly token: unknown;
  readonly queryTransport: AuditTransport | undefined;
  readonly overflow: readonly SelectedEntry<ReaderTreeEntry>[];
  readonly limits: AuditLimits;
  readonly scanner: (input: { readonly files: AuditFile[] }) => Scan | Promise<Scan>;
  readonly progress: (stage: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly signal: AbortSignal | null | undefined;
}
interface Beyond {
  scan: Scan | null;
  read: number;
  unreadable: number;
  notRead: number;
}

async function readBeyond({ reader, scope, commitSha, token, queryTransport, overflow, limits, scanner, progress, signal }: BeyondInput): Promise<Beyond> {
  const out: Beyond = { scan: null, read: 0, unreadable: 0, notRead: 0 };
  const queue = Array.isArray(overflow) ? overflow : [];
  if (!queue.length) return out;
  const readBlobTexts = reader.readBlobTexts;
  if (typeof readBlobTexts !== 'function' || typeof queryTransport !== 'function') {
    out.notRead = queue.length;
    return out;
  }
  const perQuery = Math.max(1, Math.min(Number(reader.MAX_TEXTS_PER_QUERY) || 100, 100));
  const batches: SelectedEntry<ReaderTreeEntry>[][] = [];
  let batch: SelectedEntry<ReaderTreeEntry>[] = [];
  let bytes = 0;
  for (const entry of queue) {
    if (batch.length && (batch.length >= perQuery || bytes + entry.size > limits.queryBatchBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.size;
  }
  if (batch.length) batches.push(batch);

  let pending: { path: string; text: string }[] = [];
  let pendingBytes = 0;
  let done = 0;
  const flush = async (): Promise<void> => {
    assertAuditActive(signal);
    if (!pending.length) return;
    const files = pending;
    pending = [];
    pendingBytes = 0;
    try {
      out.scan = mergeScans(out.scan, await scanner({ files }));
      assertAuditActive(signal);
      out.read += files.length;
    } catch {
      assertAuditActive(signal);
      /* A batch the server could not check is unread, not clean. */
      out.unreadable += files.length;
    }
  };
  progress('rules', { done, total: queue.length });
  const concurrency = Math.max(1, limits.queryConcurrency || 1);
  /* A request that failed outright is asked again as two halves, twice over, before its files count as unread. */
  const readBatch = async (paths: readonly SelectedEntry<ReaderTreeEntry>[], depth = 0): Promise<ReaderTexts> => {
    assertAuditActive(signal);
    const texts = await readBlobTexts.call(reader, { scope, commitSha, paths: paths.map(entry => entry.path), token, transport: queryTransport });
    assertAuditActive(signal);
    if (!texts.failed || paths.length < 2 || depth >= 2) return texts;
    const middle = Math.ceil(paths.length / 2);
    const [first, second] = await Promise.all([readBatch(paths.slice(0, middle), depth + 1), readBatch(paths.slice(middle), depth + 1)]);
    return new Map([...first, ...second]);
  };
  for (let start = 0; start < batches.length; start += concurrency) {
    const answers = await Promise.all(batches.slice(start, start + concurrency).map(async paths => ({ paths, texts: await readBatch(paths) })));
    for (const { paths, texts } of answers) {
      for (const entry of paths) {
        const text = texts.get(entry.path)?.text;
        if (typeof text !== 'string') { out.unreadable += 1; continue; }
        pending.push({ path: entry.path, text });
        pendingBytes += text.length;
      }
      done += paths.length;
      progress('rules', { done, total: queue.length });
    }
    if (pendingBytes >= limits.scanBatchBytes) await flush();
  }
  await flush();
  return out;
}

export async function auditRepository(input: AuditRepositoryInput) {
  const { reader, scope, ref, token, intelCache, limits = LIMITS, analyser = (analysed: AnalyseInput) => analyse(analysed), scanner = (scanned: { readonly files: AuditFile[] }) => scanRules(scanned.files), onProgress = () => {}, signal } = input;
  assertAuditActive(signal);
  const cancellableTransport = (operation: AuditTransport | undefined): AuditTransport | undefined => typeof operation !== 'function' ? operation : async (call: GuardedFetchInput) => {
    assertAuditActive(signal);
    const answer = await operation(signal ? { ...call, signal } : call);
    assertAuditActive(signal);
    return answer;
  };
  const transport = cancellableTransport(input.transport);
  const queryTransport = cancellableTransport(input.queryTransport);
  const registryTransport = cancellableTransport(input.registryTransport);
  const advisoryTransport = cancellableTransport(input.advisoryTransport);
  const licenceTransport = cancellableTransport(input.licenceTransport);
  const intelTransport = cancellableTransport(input.intelTransport);
  const progress = (stage: string, detail: Readonly<Record<string, unknown>> = {}): void => { assertAuditActive(signal); try { onProgress({ stage, ...detail }); } catch {} };
  progress('resolving');
  const resolved = await reader.resolveCommit({ scope, ref, token, transport });
  assertAuditActive(signal);
  const tree = await reader.readTree({ scope, commitSha: resolved.commitSha, token, transport });
  assertAuditActive(signal);
  const paths = [...tree.entries.map(entry => entry.path), ...tree.skipped.flatMap(entry => (entry.path ? [entry.path] : []))];
  const selection = selectFiles(tree.entries, limits);
  let unreadable = 0;
  let done = 0;
  const total = selection.selected.length;
  progress('reading', { done, total });
  const files = (await boundedMap(selection.selected, limits.readConcurrency, async entry => {
    assertAuditActive(signal);
    const blob = await reader.readBlob({ scope, sha: entry.sha, token, transport });
    assertAuditActive(signal);
    done += 1;
    progress('reading', { done, total });
    if (typeof blob.text !== 'string') { unreadable += 1; return null; }
    return { path: entry.path, text: blob.text };
  })).filter((file): file is { path: string; text: string } => file !== null);

  const beyond = await readBeyond({ reader, scope, commitSha: resolved.commitSha, token, queryTransport, overflow: selection.overflow, limits, scanner, progress, signal });
  unreadable += beyond.unreadable;

  const packages = [];
  for (const file of files) {
    if (isFixturePath(file.path)) continue;
    if (baseName(file.path) === 'package.json') packages.push(...packageJsonFindings(file).packages);
    if (isRequirements(baseName(file.path))) packages.push(...requirementsPackages({ ...file, base: baseName(file.path) }));
  }
  const inventory = dependencyInventory(files);
  progress('advisories');
  /* The registries, the advisory database and deps.dev are asked at the same time: none needs another's answer. */
  const [registry, advisories, licenceLookup] = await Promise.all([
    registryTransport ? lookupPackages(packages, registryTransport, limits) : { answers: new Map(), asked: 0, total: 0 },
    advisoryTransport ? lookupAdvisories(inventory, advisoryTransport, limits) : { answers: new Map(), asked: 0, total: 0 },
    licenceTransport ? lookupLicences(inventory, licenceTransport) : null
  ]);
  /*
   * Exploit intelligence for the CVEs those advisories carry: only the CVE
   * identifiers leave, anonymously, and only when there is one to ask about.
   */
  const cves: string[] = [];
  for (const answer of advisories.answers.values()) {
    if (typeof answer === 'object' && Array.isArray(answer.advisories)) for (const advisory of answer.advisories) if (advisory.cve) cves.push(advisory.cve);
  }
  let intel = null;
  if (intelTransport) {
    if (cves.length) progress('intel');
    intel = await lookupExploitIntel(cves, intelTransport, intelCache ? { cache: intelCache } : {});
  }
  progress('analysing', { files: files.length });
  const result = await analyser({ files, paths, registry: registry.answers, advisories: advisories.answers, licences: licenceLookup ? licenceLookup.answers : null, intel: intel ? intel.answers : null, extra: beyond.scan });
  assertAuditActive(signal);
  baselineComponents(result.components, advisories, intel);
  const lockfiles = paths.filter(filePath => READ_LOCKS.has(baseName(filePath)) && !EXCLUDED_DIR.test(filePath) && !isFixturePath(filePath));
  const inventoried = new Set(files.map(file => file.path));
  const inventoryComplete = !tree.truncated && paths.filter(filePath => {
    if (EXCLUDED_DIR.test(filePath) || isFixturePath(filePath)) return false;
    const base = baseName(filePath);
    return base === 'package.json' || isRequirements(base) || ecosystems.manifestParserFor(filePath) || LOCK_PARSERS[base];
  }).every(filePath => inventoried.has(filePath));
  return {
    commitSha: resolved.commitSha,
    ref: resolved.ref,
    coverage: {
      treeTruncated: Boolean(tree.truncated),
      filesInTree: paths.length,
      eligible: selection.eligible,
      read: files.length + beyond.read,
      /* Of those, how many were checked against the rules alone, beyond the traced set. */
      rulesOnly: beyond.read,
      unreadable,
      skipped: { ...selection.skipped, budget: selection.skipped.budget + beyond.notRead },
      complete: !tree.truncated && selection.skipped.oversize + selection.skipped.budget + beyond.notRead === 0 && unreadable === 0,
      packages: { declared: registry.total, checked: result.dependencyStatus.checked, unknown: result.dependencyStatus.unknown, notChecked: Math.max(0, registry.total - registry.asked) },
      /*
       * Versions asked about, and where they came from. A lockfile too large
       * to read leaves declared ranges as the only evidence, and says so.
       */
      advisories: {
        inventoryComplete,
        versions: advisories.total,
        checked: result.advisoryStatus.checked,
        unknown: result.advisoryStatus.unknown,
        notChecked: Math.max(0, advisories.total - advisories.asked),
        vulnerable: result.advisoryStatus.vulnerable,
        malicious: result.advisoryStatus.malicious,
        lockfiles: lockfiles.length,
        lockfilesRead: files.filter(file => READ_LOCKS.has(baseName(file.path)) && !isFixturePath(file.path)).length,
        /* Manifests and lockfiles kept for the tests, which describe no install of the application. */
        setAside: result.manifestsSetAside || 0
      },
      /* Which exploit sources answered: a source that did not leaves its answers unknown, never negative. */
      exploit: intel ? intel.status : null,
      /* Licences: how many versions' licences came from lockfiles, how many deps.dev was asked about and answered. */
      licences: licenceLookup ? { versions: licenceLookup.total, fromLock: licenceLookup.fromLock, asked: licenceLookup.asked, answered: licenceLookup.answered } : null
    },
    ...result
  };
}
