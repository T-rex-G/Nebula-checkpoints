import { isFields, listOf, read, type Fields } from '../../../platform/values/fields.ts';

/*
 * The findings inbox: every open finding across the workspace, from the audits
 * and the exposure scans, in one list a person can work through.
 *
 * Pure: the route hands in what the two stores returned (null for a store that
 * could not answer) and this decides each finding's state and the order they
 * are read in. Nothing here reads a repository. A path from an exposure scan
 * is shown through the same masking the findings screen uses, because a path
 * can itself carry the credential it leads to.
 *
 * States, in the order a person should meet them:
 *   regressed  fixed once on this branch and seen again since
 *   new        first seen in the last seven days
 *   open       everything else still open
 *   accepted-risk / false-positive   a team decision covers it
 * An exposure finding removed from the tree is still open -- its history
 * holds it -- and says so with `historyOnly`.
 */

const SEVERITY_RANK = Object.freeze({ critical: 0, serious: 1, warning: 2 });
/* A Map, so a state is looked up by its own name and never by one inherited from Object.prototype. */
const STATE_RANK: ReadonlyMap<string, number> = new Map([['regressed', 0], ['new', 1], ['open', 2], ['accepted-risk', 3], ['false-positive', 4]]);
export type InboxSeverity = keyof typeof SEVERITY_RANK;
export const STATES: readonly string[] = Object.freeze([...STATE_RANK.keys()]);
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPOSURE_KIND = 'leaked-credentials';

/* A severity the inbox ranks; any other value, a name inherited from Object.prototype included, is not one. */
function rankedSeverity(value: unknown): InboxSeverity | null {
  return value === 'critical' || value === 'serious' || value === 'warning' ? value : null;
}

/* A state's place in the reading order; NaN for a state the inbox does not know, as it always was. */
function stateRank(state: string): number {
  return STATE_RANK.get(state) ?? NaN;
}

function ageDays(at: unknown, now: number): number | null {
  const time = Date.parse(String(at || ''));
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / DAY_MS)) : null;
}

export interface InboxItem {
  readonly key: string;
  readonly source: 'audit' | 'exposure';
  readonly id: unknown;
  readonly owner: unknown;
  readonly repo: unknown;
  readonly ref: unknown;
  readonly rule: unknown;
  readonly title: unknown;
  readonly kind: unknown;
  readonly severity: InboxSeverity;
  readonly state: string;
  readonly path: unknown;
  readonly line: number | null;
  readonly package: {
    readonly ecosystem: unknown;
    readonly name: unknown;
    readonly version: unknown;
    readonly fixed: unknown;
  } | null;
  readonly cves: readonly unknown[];
  readonly exploited: boolean;
  readonly verdict: unknown;
  readonly firstSeenAt: unknown;
  readonly ageDays: number | null;
  readonly timesFixed: number;
  readonly regressedAfter: unknown;
  readonly decision: unknown;
  readonly historyOnly: boolean;
}

function auditItem(finding: Fields, now: number): InboxItem {
  const decided = read(finding.decision, 'disposition');
  const first = Date.parse(String(finding.firstSeenAt || ''));
  const state = decided ? String(decided) : (finding.regressedAfter ? 'regressed'
    : Number.isFinite(first) && now - first <= NEW_WINDOW_MS ? 'new' : 'open');
  const pkg = finding.package;
  const cves = read(pkg, 'cves');
  return {
    key: `audit:${String(finding.owner).toLowerCase()}/${String(finding.repo).toLowerCase()}:${String(finding.id)}`,
    source: 'audit',
    id: finding.id,
    owner: finding.owner,
    repo: finding.repo,
    ref: finding.ref || null,
    rule: finding.rule,
    title: finding.title || finding.rule,
    kind: finding.category || 'other',
    severity: rankedSeverity(finding.severity) ?? 'warning',
    state,
    path: finding.path || null,
    line: typeof finding.line === 'number' && Number.isInteger(finding.line) ? finding.line : null,
    package: pkg ? {
      ecosystem: read(pkg, 'ecosystem'), name: read(pkg, 'name'),
      version: read(pkg, 'version'), fixed: read(pkg, 'fixed') || null
    } : null,
    cves: pkg && Array.isArray(cves) ? cves.slice(0, 6) : [],
    exploited: finding.exploited === true,
    verdict: finding.verdict || null,
    firstSeenAt: finding.firstSeenAt || null,
    ageDays: ageDays(finding.firstSeenAt, now),
    timesFixed: Number(finding.timesFixed) || 0,
    regressedAfter: finding.regressedAfter || null,
    decision: finding.decision || null,
    historyOnly: false
  };
}

interface ExposurePorts {
  readonly severityOf: (rule: string) => unknown;
  readonly displayPath: (path: string) => unknown;
}

function exposureItem(finding: Fields, now: number, { severityOf, displayPath }: ExposurePorts): InboxItem {
  const scope = finding.scope || {};
  const accepted = finding.disposition === 'accepted-risk';
  const first = Date.parse(String(finding.firstObservedAt || ''));
  return {
    key: `exposure:${String(read(scope, 'owner')).toLowerCase()}/${String(read(scope, 'repo')).toLowerCase()}:${String(finding.fingerprint)}`,
    source: 'exposure',
    id: finding.fingerprint,
    owner: read(scope, 'owner'),
    repo: read(scope, 'repo'),
    ref: null,
    rule: finding.rule,
    title: null,
    kind: EXPOSURE_KIND,
    severity: rankedSeverity(severityOf(String(finding.rule))) ?? 'serious',
    state: accepted ? 'accepted-risk' : Number.isFinite(first) && now - first <= NEW_WINDOW_MS ? 'new' : 'open',
    path: finding.path ? displayPath(String(finding.path)) : null,
    line: null,
    package: null,
    cves: [],
    exploited: false,
    verdict: null,
    firstSeenAt: finding.firstObservedAt || null,
    ageDays: ageDays(finding.firstObservedAt, now),
    timesFixed: 0,
    regressedAfter: null,
    decision: accepted ? { disposition: 'accepted-risk', reason: null, expiresAt: null, decidedAt: finding.dispositionAt || null } : null,
    historyOnly: finding.disposition === 'removed-from-tree'
  };
}

function compare(a: InboxItem, b: InboxItem): number {
  const decidedA = a.decision ? 1 : 0;
  const decidedB = b.decision ? 1 : 0;
  return decidedA - decidedB
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || stateRank(a.state) - stateRank(b.state)
    /* Oldest first; an undated finding after every dated one; two undated ones tie. */
    || (a.ageDays === null && b.ageDays === null ? 0 : b.ageDays === null ? -1 : a.ageDays === null ? 1 : b.ageDays - a.ageDays)
    || a.key.localeCompare(b.key);
}

/* Counts by a key the data names. Each key is the data's own, so a key such as `__proto__` or `constructor` is counted like any other. */
function tally(items: readonly InboxItem[], pick: (item: InboxItem) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = pick(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries(counts);
}

export interface InboxInput {
  readonly now?: unknown;
  readonly severityOf?: ((rule: string) => unknown) | null;
  readonly displayPath?: ((path: string) => unknown) | null;
  readonly audit?: unknown;
  readonly exposure?: unknown;
}

/* The findings a store answered, if it answered a list of them. */
function findingsOf(source: unknown): readonly unknown[] | null {
  const findings = read(source, 'findings');
  return Array.isArray(findings) ? findings : null;
}

/*
 * `audit` is CodeAuditHistory#workspaceFindings, `exposure` is
 * ExposureStore#workspaceFindings; `severityOf` names an exposure rule's
 * severity and `displayPath` masks a credential-shaped path.
 */
export function buildInbox(input: InboxInput = {}) {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const severityOf = typeof input.severityOf === 'function' ? input.severityOf : () => 'serious';
  const displayPath = typeof input.displayPath === 'function' ? input.displayPath : (value: string) => value;
  const auditFindings = input.audit ? findingsOf(input.audit) : null;
  const exposureFindings = input.exposure ? findingsOf(input.exposure) : null;
  const items = [
    ...listOf(auditFindings).filter(isFields).map(finding => auditItem(finding, now)),
    ...listOf(exposureFindings).filter(isFields).map(finding => exposureItem(finding, now, { severityOf, displayPath }))
  ].sort(compare);
  const undecided = items.filter(item => !item.decision);
  return {
    generatedAt: new Date(now).toISOString(),
    sources: { audit: auditFindings ? 'measured' : 'unavailable', exposure: exposureFindings ? 'measured' : 'unavailable' },
    truncated: Boolean((auditFindings && read(input.audit, 'truncated')) || (exposureFindings && read(input.exposure, 'truncated'))),
    total: items.length,
    counts: {
      bySeverity: tally(undecided, item => item.severity),
      byState: tally(items, item => item.state),
      byKind: tally(undecided, item => String(item.kind)),
      byRepository: tally(undecided, item => `${String(item.owner)}/${String(item.repo)}`)
    },
    findings: items
  };
}
