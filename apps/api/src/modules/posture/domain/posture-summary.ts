import { isFields, listOf, read } from '../../../platform/values/fields.ts';

/*
 * The workspace's security posture, as the Overview draws it.
 *
 * Three systems already measure a repository one at a time: the audit engine
 * counts findings and how long fixing them took, the exposure scanner counts
 * leaked credentials, and governance records every merge it was asked to
 * decide. This reads them together, for the repositories the signed-in
 * identity has audited or scanned, and nothing else -- no repository is
 * reached over the network to build it, and nothing a reader could not
 * already see one repository at a time is added by putting them side by side.
 *
 * Pure: the route hands in what the stores returned (and null for a store
 * that could not answer), and this decides what the figures are. A store that
 * could not answer leaves its part unmeasured rather than zero, because "no
 * findings" and "could not read the findings" are the opposite of each other.
 */

export const SEVERITIES = Object.freeze(['critical', 'serious', 'warning'] as const);
export type Severity = (typeof SEVERITIES)[number];
/* Exposure findings are their own category: a credential in the history is not a code finding. */
export const EXPOSURE_CATEGORY = 'leaked-credentials';
export const TOP_REPOSITORIES = 6;

function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.some(severity => severity === value);
}

function weeklySeries(weeks: number, entries: readonly unknown[]): number[] {
  const counts = new Array<number>(weeks).fill(0);
  for (const entry of entries) {
    const index = Number(read(entry, 'weeksAgo'));
    const count = Number(read(entry, 'count'));
    if (Number.isSafeInteger(index) && index >= 0 && index < weeks && Number.isFinite(count) && count > 0) counts[index] = (counts[index] ?? 0) + count;
  }
  return counts;
}

export interface OpenTally {
  critical: number;
  serious: number;
  warning: number;
  total: number;
}

function emptyOpen(): OpenTally {
  return { critical: 0, serious: 0, warning: 0, total: 0 };
}

function repositoryKey(owner: unknown, repo: unknown): string {
  return `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;
}

interface AuditMark { at: unknown; ref: unknown; grade: unknown; score: unknown; complete: boolean }
interface ExposureMark { at: unknown; partial: boolean }
interface RepositoryEntry {
  owner: unknown;
  repo: unknown;
  open: OpenTally;
  audit: AuditMark | null;
  exposure: ExposureMark | null;
}

export interface PostureInput {
  readonly weeks?: unknown;
  readonly now?: unknown;
  readonly audit?: unknown;
  readonly exposure?: unknown;
  readonly exposureTrend?: unknown;
  readonly merges?: unknown;
}

/* A series the stores answer as an array, or none. */
function seriesOf(source: unknown, key: string): readonly unknown[] {
  const value = read(source, key);
  return Array.isArray(value) ? value : [];
}

/*
 * `audit` is CodeAuditHistory#workspace, `exposure` is the posture reader's
 * exposure reading ({ available, repositories }), `exposureTrend` is
 * ExposureStore#workspaceTrend and `merges` is GovernanceStore#countMergeOutcomes
 * for the last seven days. Any of them may be null.
 */
export function summarizePosture(input: PostureInput = {}) {
  const weeks = typeof input.weeks === 'number' && Number.isSafeInteger(input.weeks) && input.weeks >= 1 && input.weeks <= 52 ? input.weeks : 12;
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const audit = isFields(input.audit) ? input.audit : null;
  const exposure = isFields(input.exposure) && input.exposure.available === true ? input.exposure : null;
  const exposureTrend = isFields(input.exposureTrend) ? input.exposureTrend : null;
  const merges = isFields(input.merges) ? input.merges : null;

  const repositories = new Map<string, RepositoryEntry>();
  function repository(owner: unknown, repo: unknown): RepositoryEntry {
    const key = repositoryKey(owner, repo);
    let entry = repositories.get(key);
    if (!entry) {
      entry = { owner, repo, open: emptyOpen(), audit: null, exposure: null };
      repositories.set(key, entry);
    }
    return entry;
  }

  const open = emptyOpen();
  const triaged = { acceptedRisk: 0, falsePositive: 0 };
  const categories = new Map<string, OpenTally>();
  const count = (category: string, severity: Severity, amount: number) => {
    let entry = categories.get(category);
    if (!entry) {
      entry = emptyOpen();
      categories.set(category, entry);
    }
    entry[severity] += amount;
    entry.total += amount;
  };

  if (audit) {
    for (const value of listOf(audit.audits)) {
      if (!isFields(value)) continue;
      const row = value;
      repository(row.owner, row.repo).audit = {
        at: row.auditedAt, ref: row.ref, grade: row.grade, score: row.score, complete: row.coverageComplete === true
      };
    }
    for (const value of listOf(audit.findings)) {
      if (!isFields(value)) continue;
      const row = value;
      const amount = Number(row.count) || 0;
      const severity = row.severity;
      if (!amount || !isSeverity(severity)) continue;
      if (row.state === 'accepted-risk') { triaged.acceptedRisk += amount; continue; }
      if (row.state === 'false-positive') { triaged.falsePositive += amount; continue; }
      if (row.state !== 'open') continue;
      const entry = repository(row.owner, row.repo);
      entry.open[severity] += amount;
      entry.open.total += amount;
      open[severity] += amount;
      open.total += amount;
      count(String(row.category || 'other'), severity, amount);
    }
  }

  if (exposure) {
    for (const value of listOf(exposure.repositories)) {
      if (!isFields(value)) continue;
      const row = value;
      const entry = repository(row.owner, row.repo);
      entry.exposure = { at: row.scannedAt || null, partial: row.partial === true };
      for (const severity of SEVERITIES) {
        const amount = Number(read(row.open, severity)) || 0;
        if (!amount) continue;
        entry.open[severity] += amount;
        entry.open.total += amount;
        open[severity] += amount;
        open.total += amount;
        count(EXPOSURE_CATEGORY, severity, amount);
      }
    }
  }
  if (exposureTrend) triaged.acceptedRisk += Number(exposureTrend.accepted) || 0;

  const opened = weeklySeries(weeks, [
    ...(audit ? seriesOf(audit, 'opened') : []),
    ...(exposureTrend ? seriesOf(exposureTrend, 'opened') : [])
  ]);
  const fixed = weeklySeries(weeks, [
    ...(audit ? seriesOf(audit, 'fixed') : []),
    ...(exposureTrend ? seriesOf(exposureTrend, 'fixed') : [])
  ]);
  const trend = opened.map((value, index) => ({ weeksAgo: index, opened: value, fixed: fixed[index] ?? 0 })).reverse();
  const openedTotal = opened.reduce((sum, value) => sum + value, 0);
  const fixedTotal = fixed.reduce((sum, value) => sum + value, 0);

  const ranked = [...repositories.values()]
    .map(entry => ({ ...entry, open: { ...entry.open } }))
    .sort((a, b) => b.open.critical - a.open.critical || b.open.serious - a.open.serious
      || b.open.total - a.open.total || repositoryKey(a.owner, a.repo).localeCompare(repositoryKey(b.owner, b.repo)));

  return {
    generatedAt: new Date(now).toISOString(),
    weeks,
    sources: {
      audit: audit ? 'measured' : 'unavailable',
      exposure: exposure && exposureTrend ? 'measured' : exposure ? 'partial' : 'unavailable',
      governance: merges ? 'measured' : 'unavailable'
    },
    open,
    triaged,
    week: {
      opened: opened[0],
      fixed: fixed[0],
      gated: merges ? (Number(merges.block) || 0) : null,
      warned: merges ? (Number(merges.warn) || 0) : null
    },
    window: { opened: openedTotal, fixed: fixedTotal },
    trend,
    timeToFix: audit && audit.timeToFix ? audit.timeToFix : null,
    categories: [...categories.entries()]
      .map(([category, counts]) => ({ category, ...counts }))
      .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    top: ranked.filter(entry => entry.open.total > 0).slice(0, TOP_REPOSITORIES),
    repositories: ranked.map(entry => ({
      owner: entry.owner,
      repo: entry.repo,
      open: entry.open,
      audit: entry.audit,
      exposure: entry.exposure
    }))
  };
}
