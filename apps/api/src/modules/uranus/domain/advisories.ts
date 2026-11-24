import { listOf, read } from '../../../platform/values/fields.ts';
import * as ecosystems from './ecosystems.ts';
import { usageIndex, tierOf, riskOf, type Band, type Risk, type Role, type SourceFile, type Tier, type WantedPackage } from './uranus-reach.ts';
import { plain } from './audit-text.ts';
import { ECOSYSTEM_LANGUAGES, EXCLUDED_DIR, extensionOf, isTestPath } from './audit-files.ts';
import { SEVERITY_ORDER, type Severity } from './audit-catalog.ts';
import { advisoryKey, compareVersions, introducedThrough, nameKey, rangeCeiling, type Introduced, type InventoryEntry, type LockGraph } from './dependencies.ts';

/*
 * What the advisory records say about the versions in use: how severe each
 * is, which version fixes it, one finding per vulnerable package version, and
 * how close each is to the running code and to being exploited.
 */

/* ---- Types ------------------------------------------------------------------------ */

/* What one advisory says about one package version. An OSV record itself is read field by field. */
export interface Advisory {
  readonly id: string;
  readonly cve: string | null;
  readonly rated: boolean;
  readonly severity: Severity | null;
  readonly cvss: number | null;
  readonly summary: string;
  readonly fixed: string | null;
  readonly malicious: boolean;
}
/* The advisories for one version, or 'unknown' when the database could not say. */
export type AdvisoryAnswer = 'unknown' | { readonly advisories: readonly Advisory[]; readonly partial?: true };
export interface AdvisoryBrief {
  readonly id: string;
  readonly cve: string | null;
  readonly severity: Severity | null;
  readonly cvss: number | null;
  readonly summary: string;
  readonly epss?: number | null;
  readonly kev?: boolean;
}
export interface Usage {
  readonly tier: Tier;
  readonly files: string[] | undefined;
  readonly count: number | undefined;
  readonly through: string[];
  readonly throughCount: number;
  readonly chain: unknown;
  readonly seen: Role | null;
  readonly loader: 'bundler' | null;
  readonly reason: 'unread' | 'graph' | null;
}
/* What is known of one CVE's exploitation, as the exploit sources answered: an EPSS score, and whether CISA lists it. */
export interface ExploitAnswer {
  readonly epss: number | null;
  readonly percentile: number | null;
  readonly epssDate: string | null;
  readonly kev: { readonly added: string | null; readonly due: string | null; readonly ransomware: boolean } | null | undefined;
}
export interface ExploitIntel {
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly kev: { readonly cve: string; readonly added: string | null; readonly due: string | null; readonly ransomware: boolean } | null;
  readonly epss: { readonly cve: string; readonly score: number; readonly percentile: number | null; readonly date: string | null } | null;
  readonly catalog: 'listed' | 'unlisted' | 'unknown';
  readonly cves: number;
  readonly scored: number;
}
/* The facts a dependency finding carries: the package, its version, its advisories, and once weighed, its reach and risk. */
export interface AdvisoryDetail {
  readonly package: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly purl: string | null;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly source: InventoryEntry['source'];
  readonly range: string | null;
  readonly fixed: string | null;
  readonly unfixed: boolean;
  readonly cvss: number | null;
  advisories: AdvisoryBrief[];
  readonly more: number;
  usage?: Usage;
  intel?: ExploitIntel | null;
  risk?: Risk;
}
export interface AdvisoryFinding {
  readonly rule: 'DEP-003' | 'DEP-005' | 'DEP-006';
  readonly path: string;
  readonly line: number;
  readonly severity: Severity;
  readonly detail: AdvisoryDetail;
}
/* A finding with what its risk is weighed from: the entry, every advisory, and the worst severity among them. */
export interface Vulnerable {
  readonly finding: AdvisoryFinding;
  readonly entry: InventoryEntry;
  readonly all: readonly Advisory[];
  readonly impact: Severity;
}
export interface AdvisoryStatus {
  checked: number;
  vulnerable: number;
  malicious: number;
  unknown: number;
}
export interface DependencyRisk {
  exploited: number;
  ransomware: number;
  readonly bands: Record<Band, number>;
  readonly tiers: Partial<Record<Tier, number>>;
}

/* What each CVSS v3 metric's value weighs; a value the specification does not name weighs nothing and leaves no score. */
const ATTACK_VECTOR: ReadonlyMap<string, number> = new Map([['N', 0.85], ['A', 0.62], ['L', 0.55], ['P', 0.2]]);
const ATTACK_COMPLEXITY: ReadonlyMap<string, number> = new Map([['L', 0.77], ['H', 0.44]]);
const USER_INTERACTION: ReadonlyMap<string, number> = new Map([['N', 0.85], ['R', 0.62]]);
const IMPACT: ReadonlyMap<string, number> = new Map([['H', 0.56], ['L', 0.22], ['N', 0]]);

/* ---- Advisories ---------------------------------------------------------------- */

/* CVSS v3 base score from its vector, the one number most advisories carry. */
export function cvss3(vector: unknown): number | null {
  const metrics = new Map<string, string>();
  for (const part of String(vector || '').split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key, value);
  }
  if (!/^CVSS:3/.test(String(vector))) return null;
  const changed = metrics.get('S') === 'C';
  const weigh = (table: ReadonlyMap<string, number>, metric: string): number | undefined => table.get(metrics.get(metric) ?? '');
  const AV = weigh(ATTACK_VECTOR, 'AV');
  const AC = weigh(ATTACK_COMPLEXITY, 'AC');
  const PR = weigh(new Map([['N', 0.85], ['L', changed ? 0.68 : 0.62], ['H', changed ? 0.5 : 0.27]]), 'PR');
  const UI = weigh(USER_INTERACTION, 'UI');
  const [C, I, A] = [weigh(IMPACT, 'C'), weigh(IMPACT, 'I'), weigh(IMPACT, 'A')];
  if (AV === undefined || AC === undefined || PR === undefined || UI === undefined || C === undefined || I === undefined || A === undefined) return null;
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV * AC * PR * UI;
  const raw = changed ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10 - 1e-9) / 10;
}

/* The highest CVSS v3 base score a record publishes, or null. */
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

function topCvss(record: unknown): number | null {
  const scores = listOf(read(record, 'severity'))
    .filter(entry => read(entry, 'type') === 'CVSS_V3').map(entry => cvss3(read(entry, 'score'))).filter(finite);
  return scores.length ? Math.max(...scores) : null;
}

/*
 * One advisory's severity in the audit's three words. GitHub's reviewed
 * rating when the record carries it, else the CVSS v3 base score, else
 * serious -- an advisory with no rating is still an advisory.
 */
function advisorySeverity(record: unknown): Severity {
  if (String(read(record, 'id')).startsWith('MAL-')) return 'critical';
  const rated = String(read(read(record, 'database_specific'), 'severity') || '').toUpperCase();
  if (rated === 'CRITICAL') return 'critical';
  if (rated === 'HIGH') return 'serious';
  if (rated === 'MODERATE' || rated === 'MEDIUM' || rated === 'LOW') return 'warning';
  const top = topCvss(record);
  if (top !== null) return top >= 9 ? 'critical' : top >= 7 ? 'serious' : 'warning';
  return 'serious';
}

/* The version that fixes this advisory for this version of this package. */
/* The package version an advisory is asked about. */
export interface AdvisedVersion {
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
}

function fixedVersion(record: unknown, entry: AdvisedVersion): string | null {
  const key = nameKey(entry.ecosystem, entry.name);
  const fixes: string[] = [];
  let inRange: string | null = null;
  for (const affected of listOf(read(record, 'affected'))) {
    const pkg = read(affected, 'package');
    if (!pkg || nameKey(entry.ecosystem, read(pkg, 'name')) !== key) continue;
    for (const range of listOf(read(affected, 'ranges'))) {
      if (!range || read(range, 'type') === 'GIT') continue;
      let introduced = '0';
      for (const event of listOf(read(range, 'events'))) {
        const opened = read(event, 'introduced');
        const closed = read(event, 'fixed');
        if (opened !== undefined) introduced = String(opened);
        if (closed !== undefined) {
          const fixed = String(closed);
          fixes.push(fixed);
          if (!inRange && compareVersions(entry.version, introduced === '0' ? '0' : introduced) >= 0 && compareVersions(entry.version, fixed) < 0) inRange = fixed;
        }
      }
    }
  }
  if (inRange) return inRange;
  const later = fixes.filter(fix => compareVersions(fix, entry.version) > 0).sort(compareVersions);
  return later[0] || null;
}

/* What one advisory says about one package version, from its record when there is one. */
export function describeAdvisory(id: string, record: unknown, entry: AdvisedVersion): Advisory {
  const aliases = listOf(read(record, 'aliases')).map(String);
  return Object.freeze({
    id,
    cve: aliases.find(alias => /^CVE-\d{4}-\d+$/.test(alias)) || (/^CVE-\d{4}-\d+$/.test(id) ? id : null),
    /* Unrated when the record was not fetched: the id is still a fact, its severity is not. */
    rated: Boolean(record),
    severity: record ? advisorySeverity(record) : (id.startsWith('MAL-') ? 'critical' : null),
    cvss: record ? topCvss(record) : null,
    summary: record ? plain(read(record, 'summary') || '', 140) : '',
    fixed: record ? fixedVersion(record, entry) : null,
    malicious: id.startsWith('MAL-')
  });
}

const worst = (severities: readonly Severity[]): Severity => severities.reduce<Severity>((a, b) => (SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a), 'warning');
const softer = (severity: Severity): Severity => (severity === 'critical' ? 'serious' : 'warning');

/*
 * One finding per vulnerable package version, at the line a reader would
 * edit: the manifest for what they declared, the lockfile for what came
 * with it. Tooling only a developer installs is one step less severe, and a
 * range whose own floor is affected but which admits the fix is a warning
 * about the floor rather than a claim about what is installed.
 */
export function advisoryFindings(inventory: readonly InventoryEntry[], advisories: ReadonlyMap<string, AdvisoryAnswer>): { out: Vulnerable[]; status: AdvisoryStatus } {
  const out: Vulnerable[] = [];
  const status: AdvisoryStatus = { checked: 0, vulnerable: 0, malicious: 0, unknown: 0 };
  /* A version declared in two manifests is one version checked, as the coverage counts versions. */
  const counted = new Set<string>();
  for (const entry of inventory) {
    const key = advisoryKey(entry);
    const answer = advisories.get(key);
    if (!answer) continue;
    const first = !counted.has(key);
    counted.add(key);
    if (first) status.checked += 1;
    if (answer === 'unknown' || answer.partial) {
      if (first) status.unknown += 1;
      if (answer === 'unknown') continue;
    }
    if (!answer.advisories.length) continue;
    const malicious = answer.advisories.filter(advisory => advisory.malicious);
    const listed = (malicious.length ? malicious : answer.advisories).slice(0, 6);
    /* Severity and the fix come from the advisories that were rated; an unrated one never raises either. */
    const rated = answer.advisories.filter((advisory): advisory is Advisory & { severity: Severity } => advisory.rated !== false && Boolean(advisory.severity));
    const fixes = rated.map(advisory => advisory.fixed);
    const fixed = rated.length && fixes.every(Boolean) ? fixes.sort(compareVersions)[fixes.length - 1] ?? null : null;
    const scores = rated.map(advisory => advisory.cvss).filter(finite);
    const detail: AdvisoryDetail = {
      package: entry.name,
      version: entry.version,
      ecosystem: entry.ecosystem,
      purl: ecosystems.purl(entry.ecosystem, entry.name, entry.version),
      direct: entry.direct,
      dev: entry.dev,
      source: entry.source,
      range: entry.range || null,
      fixed,
      unfixed: rated.some(advisory => !advisory.fixed),
      cvss: scores.length ? Math.max(...scores) : null,
      advisories: listed.map(advisory => ({ id: advisory.id, cve: advisory.cve, severity: advisory.severity, cvss: finite(advisory.cvss) ? advisory.cvss : null, summary: advisory.summary })),
      more: Math.max(0, (malicious.length ? malicious : answer.advisories).length - listed.length)
    };
    /* The entry and every advisory travel beside the finding until its reach and its risk are known. */
    const all = answer.advisories;
    const vulnerable = (finding: AdvisoryFinding, impact: Severity): Vulnerable => ({ finding, entry, all, impact });
    if (malicious.length) {
      status.malicious += 1;
      out.push(vulnerable({ rule: 'DEP-006', path: entry.path, line: entry.line, severity: 'critical', detail }, 'critical'));
      continue;
    }
    status.vulnerable += 1;
    const impact = rated.length ? worst(rated.map(advisory => advisory.severity)) : 'serious';
    const severity = entry.dev ? softer(impact) : impact;
    if (entry.source === 'range') {
      const ceiling = rangeCeiling(entry.range, entry.ecosystem);
      const fixable = fixed && (!ceiling || compareVersions(fixed, ceiling) < 0);
      out.push(vulnerable(fixable ? { rule: 'DEP-005', path: entry.path, line: entry.line, severity: 'warning', detail } : { rule: 'DEP-003', path: entry.path, line: entry.line, severity, detail }, impact));
      continue;
    }
    out.push(vulnerable({ rule: 'DEP-003', path: entry.path, line: entry.line, severity, detail }, impact));
  }
  return { out, status };
}

/*
 * What is known about the exploitation of one package's advisories: the
 * catalog entry that matters most (a ransomware campaign first, then the
 * earliest listed) and the highest EPSS probability, each with the CVE it
 * belongs to. `catalog` separates "not listed" from "the catalog could not
 * be read", so an outage never reads as good news.
 */
function exploitIntelOf(advisories: readonly Advisory[], intel: ReadonlyMap<string, ExploitAnswer> | null): ExploitIntel | null {
  const cves = [...new Set(advisories.map(advisory => advisory.cve).filter((cve): cve is string => Boolean(cve)))];
  if (!intel || !cves.length) return null;
  let kev: ExploitIntel['kev'] = null;
  let epss: ExploitIntel['epss'] = null;
  let listedUnknown = false;
  let answered = 0;
  for (const cve of cves) {
    const answer = intel.get(cve);
    if (!answer) { listedUnknown = true; continue; }
    answered += 1;
    if (answer.kev === undefined) listedUnknown = true;
    if (answer.kev) {
      const better = !kev || (answer.kev.ransomware && !kev.ransomware) || (answer.kev.ransomware === kev.ransomware && String(answer.kev.added) < String(kev.added));
      if (better) kev = { cve, added: answer.kev.added, due: answer.kev.due, ransomware: Boolean(answer.kev.ransomware) };
    }
    const score = answer.epss;
    if (finite(score) && (!epss || score > epss.score)) epss = { cve, score, percentile: answer.percentile, date: answer.epssDate };
  }
  if (!answered) return { exploited: false, ransomware: false, kev: null, epss: null, catalog: 'unknown', cves: cves.length, scored: 0 };
  return {
    exploited: Boolean(kev),
    ransomware: Boolean(kev && kev.ransomware),
    kev,
    epss,
    catalog: kev ? 'listed' : listedUnknown ? 'unknown' : 'unlisted',
    cves: cves.length,
    scored: cves.filter(cve => finite(intel.get(cve)?.epss)).length
  };
}

/*
 * Reach, exploit intelligence and one risk number for every vulnerable
 * package. The import scan runs only when there is something to place, and
 * only looks for the vulnerable packages and the dependencies that
 * introduced them.
 */
export interface RiskContext {
  readonly files: readonly SourceFile[];
  readonly allPaths: readonly string[];
  readonly graphs: ReadonlyMap<string, LockGraph>;
  readonly intel: ReadonlyMap<string, ExploitAnswer> | null;
}

export function assessDependencyRisk(items: readonly Vulnerable[], { files, allPaths, graphs, intel }: RiskContext): DependencyRisk {
  const through = new Map<Vulnerable, Introduced | null>();
  const wanted = new Map<string, WantedPackage>();
  /* PHP names a package by the namespaces it autoloads, which only its lockfile records. */
  const namespacesOf = (ecosystem: string, key: string): string[] | undefined => {
    if (ecosystem !== 'packagist') return undefined;
    for (const graph of graphs.values()) {
      const namespaces = graph.namespaces && graph.namespaces.get(key);
      if (namespaces) return namespaces;
    }
    return [];
  };
  const want = (ecosystem: string, name: string): void => {
    const key = nameKey(ecosystem, name);
    wanted.set(`${ecosystem}:${key}`, { ecosystem, key, name, namespaces: namespacesOf(ecosystem, key) });
  };
  for (const item of items) {
    want(item.entry.ecosystem, item.entry.name);
    if (item.entry.direct) continue;
    const found = introducedThrough(item.entry.lock === undefined ? undefined : graphs.get(item.entry.lock), item.entry.name);
    through.set(item, found);
    for (const root of (found && found.roots) || []) want(item.entry.ecosystem, root.name);
  }
  const usage = usageIndex(files, [...wanted.values()], isTestPath);
  const read = new Set(files.map(file => file.path));
  const unseenOf = (languages: ReadonlySet<string>): boolean => allPaths.some(filePath => !read.has(filePath) && languages.has(extensionOf(filePath)) && !EXCLUDED_DIR.test(filePath) && !isTestPath(filePath));
  const unseen = new Map<string, boolean>();
  for (const [ecosystem, languages] of Object.entries(ECOSYSTEM_LANGUAGES)) unseen.set(ecosystem, unseenOf(languages));
  const summary: DependencyRisk = { exploited: 0, ransomware: 0, bands: { urgent: 0, high: 0, moderate: 0, low: 0 }, tiers: {} };
  for (const item of items) {
    const { entry, finding: { detail } } = item;
    const key = nameKey(entry.ecosystem, entry.name);
    const placed = tierOf({ entry, key, usage, through: through.has(item) ? through.get(item) : null, unseen: Boolean(unseen.get(entry.ecosystem)), keyOf: nameKey });
    detail.usage = {
      tier: placed.tier,
      files: placed.files,
      count: placed.count,
      through: placed.through || [],
      throughCount: placed.throughCount || 0,
      chain: placed.chain || [],
      seen: placed.seen || null,
      loader: placed.loader || null,
      reason: placed.reason || null
    };
    detail.intel = exploitIntelOf(item.all, intel);
    if (detail.intel && intel) {
      const byCve = new Map(item.all.flatMap((advisory): [string, ExploitAnswer | undefined][] => (advisory.cve ? [[advisory.cve, intel.get(advisory.cve)]] : [])));
      detail.advisories = detail.advisories.map(advisory => {
        const answer = advisory.cve ? byCve.get(advisory.cve) : null;
        return { ...advisory, epss: answer && finite(answer.epss) ? answer.epss : null, kev: Boolean(answer && answer.kev) };
      });
    }
    const risk = riskOf({
      severity: item.impact, cvss: detail.cvss, intel: detail.intel, tier: placed.tier,
      malicious: item.finding.rule === 'DEP-006', certainty: item.finding.rule === 'DEP-005' ? 0.4 : 1
    });
    detail.risk = risk;
    if (detail.intel && detail.intel.exploited && item.finding.rule !== 'DEP-005') {
      summary.exploited += 1;
      if (detail.intel.ransomware) summary.ransomware += 1;
    }
    summary.bands[risk.band] += 1;
    summary.tiers[placed.tier] = (summary.tiers[placed.tier] || 0) + 1;
  }
  return summary;
}
