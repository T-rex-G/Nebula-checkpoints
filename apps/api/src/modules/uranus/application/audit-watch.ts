/*
 * The watch: what has been published about a repository's dependencies since
 * it was last audited.
 *
 * An audit is a photograph. The day after it, a new advisory can be published
 * for a package version the repository still ships, or CISA can add a CVE the
 * audit already reported to its catalog of vulnerabilities exploited in the
 * wild -- and the grade on the screen says nothing about either until
 * somebody audits again. The watch asks the same two public sources the audit
 * asked, about the components the audit stored, and reports only the
 * difference:
 *
 *   - `advisory`: an OSV advisory for a stored package version whose id the
 *     audit did not receive, and which is not an alias of one it did.
 *   - `exploited`: a CVE the audit reported, which the catalog did not list
 *     then and lists now.
 *
 * It needs no repository access and no credential: names, versions and CVE
 * identifiers leave, anonymously, through the guarded transport's advisory and
 * threat-intel profiles, exactly as they do during an audit. A source that
 * cannot be reached leaves the watch partial or unavailable -- never "nothing
 * new", which is a claim that needs an answer behind it.
 *
 * And the watch as a service (`createAuditWatch`): when a branch's latest
 * audit is checked again, and that it is never checked twice at once.
 */

import { listOf, read } from '../../../platform/values/fields.ts';
import { LIMITS as AUDIT_LIMITS, type AuditLimits } from '../domain/audit-files.ts';
import { advisoryKey } from '../domain/dependencies.ts';
import { describeAdvisory, type AdvisedVersion } from '../domain/advisories.ts';
import type { Severity } from '../domain/audit-catalog.ts';
import { fetchAdvisoryRecords, queryAdvisoryIds, type AuditTransport } from '../client/advisory-lookup.ts';
import { lookupExploitIntel, type IntelAnswer, type IntelCache, type IntelStatus, type IntelTransport } from '../client/exploit-intel.ts';
import type { KeptAlert } from '../persistence/audit-history-records.ts';
import type { WatchedAudit } from '../persistence/audit-history-store.ts';

export type WatchLimits = AuditLimits & { readonly maxAlerts: number };
export const LIMITS: WatchLimits = Object.freeze({
  ...AUDIT_LIMITS,
  /* New advisories whose records are fetched. Past this they are reported by id, unrated. */
  maxAdvisoryDetails: 60,
  maxAlerts: 100
});

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ critical: 0, serious: 1, warning: 2 });
const idRank = (id: string): number => (id.startsWith('MAL-') ? 0 : id.startsWith('GHSA-') ? 1 : 2);

/* A component as the audit stored it: what it is, and what the audit knew about its version then. */
export interface WatchedComponent extends AdvisedVersion {
  readonly direct?: boolean;
  readonly dev?: boolean;
  readonly advisoryIds?: readonly string[];
  readonly cves?: readonly string[];
  readonly exploitedCves?: readonly string[];
}
interface ExploitFacts {
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly kevAdded: string | null;
  readonly kevDue: string | null;
  readonly epss: number | null;
}
interface AlertBase {
  readonly kind: 'advisory' | 'exploited';
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly id: string | null;
  readonly cve: string | null;
  readonly severity: Severity | null;
  readonly cvss: number | null;
  readonly fixed: string | null;
  readonly malicious: boolean;
}
/* One thing published since the audit: a new advisory for a stored version, or a reported CVE now known to be exploited. */
export type WatchAlert = AlertBase & ExploitFacts;
type SourceState = 'ok' | 'partial' | 'unavailable' | 'not-needed';
export interface WatchOutcome {
  readonly state: 'ok' | 'partial' | 'unavailable';
  readonly sources: { readonly advisories: SourceState; readonly exploited: SourceState };
  readonly checked: number;
  readonly total: number;
  readonly kev: IntelStatus['kev'];
  readonly kevVersion: string | null;
  readonly alerts: WatchAlert[];
  readonly truncated: number;
}
export interface WatchInput {
  readonly components: readonly WatchedComponent[] | null | undefined;
  readonly advisoryTransport: AuditTransport;
  readonly intelTransport?: IntelTransport | null;
  readonly intelCache?: IntelCache | null;
  readonly limits?: WatchLimits;
}

function exploitFacts(answer: IntelAnswer | null | undefined): ExploitFacts {
  if (!answer) return { exploited: false, ransomware: false, kevAdded: null, kevDue: null, epss: null };
  return {
    exploited: Boolean(answer.kev),
    ransomware: Boolean(answer.kev && answer.kev.ransomware),
    kevAdded: answer.kev ? answer.kev.added || null : null,
    kevDue: answer.kev ? answer.kev.due || null : null,
    epss: typeof answer.epss === 'number' && Number.isFinite(answer.epss) ? answer.epss : null
  };
}

const rankOf = (severity: Severity | null): number => (severity ? SEVERITY_RANK[severity] : 3);
function order(a: WatchAlert, b: WatchAlert): number {
  return Number(b.exploited) - Number(a.exploited)
    || Number(Boolean(b.malicious)) - Number(Boolean(a.malicious))
    || rankOf(a.severity) - rankOf(b.severity)
    || Number(b.direct) - Number(a.direct)
    || `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
    || String(a.id || a.cve).localeCompare(String(b.id || b.cve));
}

/*
 * `components` are what the audit stored: ecosystem, name, version, direct,
 * dev and the baseline -- the advisory ids, CVEs and catalog-listed CVEs the
 * audit knew about for that version.
 */
export async function watchComponents({ components, advisoryTransport, intelTransport, intelCache, limits = LIMITS }: WatchInput): Promise<WatchOutcome> {
  const stored: readonly (WatchedComponent | null | undefined)[] = Array.isArray(components) ? components : [];
  const entries = stored.filter((component): component is WatchedComponent => Boolean(component && component.name && component.version));
  const baseline = new Map(entries.map(component => [advisoryKey(component), component]));
  const known = (key: string, field: 'advisoryIds' | 'cves'): Set<string> => new Set((baseline.get(key)?.[field] || []).map(String));
  const queried = await queryAdvisoryIds(entries, advisoryTransport, limits);
  const answered = queried.asked.filter(entry => !queried.unknown.has(advisoryKey(entry)));

  /* Ids OSV holds now that the audit did not receive, per version. */
  const fresh: { readonly entry: WatchedComponent; readonly id: string }[] = [];
  /* A partly answered version still counts as unchecked, but the ids it did return can be news. */
  for (const entry of queried.asked.filter(item => queried.ids.has(advisoryKey(item)))) {
    const key = advisoryKey(entry);
    const before = known(key, 'advisoryIds');
    for (const id of queried.ids.get(key) || []) if (!before.has(id)) fresh.push({ entry, id });
  }
  const wanted = [...new Set(fresh.sort((a, b) => Number(b.entry.direct) - Number(a.entry.direct) || idRank(a.id) - idRank(b.id)).map(item => item.id))];
  const records = fresh.length ? await fetchAdvisoryRecords(wanted, advisoryTransport, limits) : new Map<string, unknown>();

  const advisoryAlerts: AlertBase[] = [];
  const covered = new Map<string, Set<string>>();
  for (const { entry, id } of fresh) {
    const key = advisoryKey(entry);
    const before = known(key, 'advisoryIds');
    const seen = covered.get(key) || new Set<string>();
    covered.set(key, seen);
    if (seen.has(id)) continue;
    const record = records.get(id);
    const aliases = listOf(read(record, 'aliases')).map(String);
    /* A new record for a vulnerability the audit already reported under another id is not news. */
    if (aliases.some(alias => before.has(alias))) continue;
    aliases.forEach(alias => seen.add(alias));
    seen.add(id);
    const advisory = describeAdvisory(id, record, entry);
    if (advisory.cve && known(key, 'cves').has(advisory.cve)) continue;
    advisoryAlerts.push({
      kind: 'advisory', ecosystem: entry.ecosystem, name: entry.name, version: entry.version,
      direct: Boolean(entry.direct), dev: Boolean(entry.dev),
      id, cve: advisory.cve, severity: advisory.severity, cvss: advisory.cvss, fixed: advisory.fixed, malicious: advisory.malicious
    });
  }

  /*
   * The catalog, asked about every CVE the audit reported that it did not
   * list then, and every CVE a new advisory carries.
   */
  const pending = new Map<string, { readonly entry: WatchedComponent; readonly cve: string }>();
  for (const entry of entries) {
    const listed = new Set((entry.exploitedCves || []).map(String));
    for (const cve of entry.cves || []) if (!listed.has(cve)) pending.set(`${advisoryKey(entry)}\0${cve}`, { entry, cve });
  }
  const askCves = [...new Set([...[...pending.values()].map(item => item.cve), ...advisoryAlerts.map(alert => alert.cve).filter((cve): cve is string => Boolean(cve))])];
  const intel: { readonly answers: ReadonlyMap<string, IntelAnswer>; readonly status: Pick<IntelStatus, 'kev' | 'kevVersion'> & { readonly kevStale?: boolean } } = intelTransport && askCves.length
    ? await lookupExploitIntel(askCves, intelTransport, intelCache ? { cache: intelCache } : {})
    : { answers: new Map(), status: { kev: askCves.length ? 'unavailable' : 'not-needed', kevVersion: null } };

  const alerts: WatchAlert[] = advisoryAlerts.map(alert => ({ ...alert, ...exploitFacts(alert.cve ? intel.answers.get(alert.cve) : null) }));
  for (const { entry, cve } of pending.values()) {
    const facts = exploitFacts(intel.answers.get(cve));
    if (!facts.exploited) continue;
    alerts.push({
      kind: 'exploited', ecosystem: entry.ecosystem, name: entry.name, version: entry.version,
      direct: Boolean(entry.direct), dev: Boolean(entry.dev),
      id: null, cve, severity: null, cvss: null, fixed: null, malicious: false, ...facts
    });
  }

  const total = entries.length;
  const checked = answered.length;
  const missingDetails = wanted.some(id => !records.has(id) || !records.get(id));
  const sources: WatchOutcome['sources'] = {
    advisories: !total ? 'ok' : !checked ? 'unavailable' : checked < total || missingDetails ? 'partial' : 'ok',
    exploited: intel.status.kev === 'unavailable' ? 'unavailable'
      : intel.status.kevStale || askCves.some(cve => !intel.answers.has(cve)) ? 'partial' : intel.status.kev
  };
  const truncated = Math.max(0, alerts.length - limits.maxAlerts);
  const incomplete = sources.advisories !== 'ok' || !['ok', 'not-needed'].includes(sources.exploited) || truncated > 0;
  const state = !incomplete ? 'ok' : !checked && !['ok', 'partial'].includes(sources.exploited) ? 'unavailable' : 'partial';
  return {
    state,
    sources,
    checked,
    total,
    kev: intel.status.kev,
    kevVersion: intel.status.kevVersion || null,
    alerts: alerts.sort(order).slice(0, limits.maxAlerts),
    truncated
  };
}

/* ---- The watch as a service ------------------------------------------------ */

/* The parts of the history the watch reads and writes. */
export interface WatchHistory {
  watched(input: { readonly scope: unknown; readonly identityKey: unknown; readonly ref: unknown }): Promise<WatchedAudit | null>;
  saveWatch(input: { readonly scope: unknown; readonly identityKey: unknown; readonly auditId: string; readonly outcome: WatchOutcome; readonly now: number }): Promise<KeptAlert[] | null>;
}
export interface AuditWatchOptions {
  readonly history: WatchHistory;
  readonly check: (input: { readonly components: WatchedAudit['components'] }) => Promise<WatchOutcome>;
  readonly staleMs?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/*
 * The watch as a service: checks a branch's latest audit when its last check
 * is older than `staleMs`, or when asked to and at least `minIntervalMs` has
 * passed, and never twice at once for the same audit. `check` is
 * `watchComponents` bound to its transports; this does not reach the network
 * itself.
 */
export function createAuditWatch({ history, check, staleMs = 6 * 60 * 60 * 1000, minIntervalMs = 10 * 60 * 1000, now: clock = () => Date.now() }: AuditWatchOptions) {
  const running = new Map<string, Promise<{ readonly outcome: WatchOutcome; readonly alerts: KeptAlert[] | null }>>();
  async function refresh({ scope, identityKey, ref, force = false }: { readonly scope: unknown; readonly identityKey: unknown; readonly ref: unknown; readonly force?: boolean }) {
    const watched = await history.watched({ scope, identityKey, ref });
    if (!watched) return { audit: null, alerts: [], components: 0, fresh: false, checkableAt: null };
    const { audit } = watched;
    const last = audit.watch ? Date.parse(String(audit.watch.checkedAt)) : 0;
    const age = clock() - last;
    const due = !audit.watch || age >= staleMs || (force && age >= minIntervalMs);
    if (!due || !watched.components.length) {
      return { audit, alerts: watched.alerts, components: watched.components.length, fresh: false, checkableAt: last ? new Date(last + minIntervalMs).toISOString() : null };
    }
    const key = audit.id;
    let pending = running.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const outcome = await check({ components: watched.components });
          const alerts = await history.saveWatch({ scope, identityKey, auditId: audit.id, outcome, now: clock() });
          return { outcome, alerts };
        } finally {
          running.delete(key);
        }
      })();
      running.set(key, pending);
    }
    const { outcome, alerts } = await pending;
    const checkedAt = new Date(clock()).toISOString();
    return {
      audit: { ...audit, watch: { checkedAt, state: outcome.state, checked: outcome.checked, total: outcome.total, kev: outcome.kev,
        sources: outcome.sources || null, truncated: count(outcome.truncated) } },
      alerts: alerts || [],
      components: watched.components.length,
      fresh: true,
      checkableAt: new Date(clock() + minIntervalMs).toISOString()
    };
  }
  return Object.freeze({ refresh });
}
