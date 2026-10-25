/*
 * The audit history's rows read back as what the routes answer with.
 *
 * Every record is built from named columns, never by spreading a row, so a
 * column added later is invisible until somebody adds it to a serializer on
 * purpose. A column the migration declares NOT NULL text is read as its
 * text; an enumerated column as one of its values, and a value outside them
 * -- which the database refuses to hold -- is refused here too rather than
 * passed on.
 */
import { dateFrom, listOf, ownEntry } from '../../../platform/values/fields.ts';
import { standardsFor, type Standards } from '../../posture/index.ts';
import { RULES } from '../domain/audit-catalog.ts';
import type { Tier } from '../domain/uranus-reach.ts';
import type { AuditWatchState } from '../../../../../../packages/contracts/src/evidence.ts';
import {
  ALERT_KINDS, CAP_REASONS, CodeAuditHistoryError, ECOSYSTEMS, GRADES, POLICY_SOURCES, REACH_TIERS, RISK_BANDS, SEVERITIES, VERDICTS, WAIVED, WATCH_KEV, WATCH_STATES, oneOf,
  type AlertKind, type Ecosystem, type HistorySeverity, type Waived, type WatchKev
} from './audit-history-rows.ts';

/* A row as the driver returns it: named columns, read one by one. */
type Row = Readonly<Record<string, unknown>>;

export const iso = (value: unknown): string | null => (value ? dateFrom(value).toISOString() : null);
/* An instant as the driver gives it -- a Date for timestamptz -- in milliseconds. */
export const ms = (value: unknown): number => (value instanceof Date ? value.getTime() : Date.parse(String(value)));
export const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const day = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
/* A NOT NULL text column, as its text. */
export const text = (value: unknown): string => String(value);
/* A nullable text column: its text, or null for no value. */
export const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
/* An enumerated column: one of its values. The database holds no other, and none is passed on. */
export function stored<T extends string>(list: readonly T[], value: unknown, column: string): T {
  const member = oneOf(list, value);
  if (member === null) throw new CodeAuditHistoryError(`A stored ${column} is outside its values`, 'CODE_AUDIT_ROW_INVALID', 500);
  return member;
}
export const storedOrNull = <T extends string>(list: readonly T[], value: unknown, column: string): T | null => (value ? stored(list, value, column) : null);

export interface KeptAudit {
  readonly id: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly engine: string;
  readonly auditedAt: string | null;
  readonly score: number;
  readonly grade: (typeof GRADES)[number];
  readonly capReason: (typeof CAP_REASONS)[number] | null;
  readonly categories: { readonly id: string; readonly score: number }[];
  readonly counts: Readonly<Record<HistorySeverity, number>>;
  readonly toConfirm: number;
  readonly waived: number;
  readonly exploited: number;
  readonly risk: { readonly urgent: number; readonly high: number; readonly moderate: number; readonly low: number };
  readonly files: { readonly read: number; readonly eligible: number; readonly complete: boolean };
  readonly analysisComplete: boolean | null;
  readonly components: number;
  readonly findings: { readonly total: number; readonly stored: number };
  readonly diff: { readonly new: number; readonly resolved: number | null } | null;
  readonly watch: {
    readonly checkedAt: string | null;
    readonly state: AuditWatchState;
    readonly checked: number | null;
    readonly total: number | null;
    readonly kev: WatchKev | null;
  } | null;
  readonly sla: { readonly critical: number; readonly serious: number; readonly warning: number; readonly source: (typeof POLICY_SOURCES)[number] } | null;
}

export function auditFromRow(row: Row): KeptAudit {
  const categories: { id: string; score: number }[] = [];
  const categoryIds = listOf(row.category_ids);
  const categoryScores = listOf(row.category_scores);
  categoryIds.forEach((id, index) => categories.push({ id: String(id), score: Number(categoryScores[index]) }));
  return {
    id: text(row.audit_id),
    ref: text(row.ref_name),
    commitSha: text(row.commit_sha),
    engine: text(row.engine_version),
    auditedAt: iso(row.audited_at),
    score: Number(row.score),
    grade: stored(GRADES, row.grade, 'grade'),
    capReason: storedOrNull(CAP_REASONS, row.cap_reason, 'cap reason'),
    categories,
    counts: { critical: Number(row.critical_count), serious: Number(row.serious_count), warning: Number(row.warning_count) },
    toConfirm: Number(row.to_confirm_count),
    waived: Number(row.waived_count),
    exploited: Number(row.exploited_count),
    risk: { urgent: Number(row.risk_urgent), high: Number(row.risk_high), moderate: Number(row.risk_moderate), low: Number(row.risk_low) },
    files: { read: Number(row.files_read), eligible: Number(row.files_eligible), complete: row.coverage_complete === true },
    analysisComplete: typeof row.analysis_complete === 'boolean' ? row.analysis_complete : null,
    components: Number(row.components_total),
    findings: { total: Number(row.findings_total), stored: Number(row.findings_stored) },
    diff: row.new_count === null || row.new_count === undefined ? null : { new: Number(row.new_count), resolved: row.resolved_count === null || row.resolved_count === undefined ? null : Number(row.resolved_count) },
    watch: row.watch_checked_at ? {
      checkedAt: iso(row.watch_checked_at),
      state: stored(WATCH_STATES, row.watch_state, 'watch state'),
      checked: number(row.watch_checked),
      total: number(row.watch_total),
      kev: storedOrNull(WATCH_KEV, row.watch_kev, 'watch catalog state')
    } : null,
    sla: row.policy_source ? {
      critical: Number(row.sla_critical),
      serious: Number(row.sla_serious),
      warning: Number(row.sla_warning),
      source: stored(POLICY_SOURCES, row.policy_source, 'policy source')
    } : null
  };
}

export interface KeptFinding {
  readonly id: string;
  readonly rule: string;
  readonly title: string;
  readonly category: string;
  readonly severity: HistorySeverity;
  readonly verdict: (typeof VERDICTS)[number];
  readonly path: string | null;
  readonly line: number | null;
  readonly package: {
    readonly ecosystem: Ecosystem;
    readonly name: string;
    readonly version: string | null;
    readonly fixed: string | null;
    readonly advisories: string[];
    readonly cves: string[];
    readonly cvss: number | null;
  } | null;
  readonly risk: { readonly score: number; readonly band: (typeof RISK_BANDS)[number] | null } | null;
  readonly reach: Tier | null;
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly epss: number | null;
  readonly firstSeenAt: string | null;
  readonly waived: Waived | null;
}

export function findingFromRow(row: Row): KeptFinding {
  const rule = text(row.rule);
  const definition = ownEntry(RULES, rule);
  return {
    id: text(row.finding_id),
    rule,
    /* The rule's own title: text this server wrote, never text read from the repository. */
    title: definition ? definition.title : rule,
    category: text(row.category),
    severity: stored(SEVERITIES, row.severity, 'severity'),
    verdict: stored(VERDICTS, row.verdict, 'verdict'),
    path: textOrNull(row.file_path),
    line: row.line_number === null ? null : Number(row.line_number),
    package: row.package_name ? {
      ecosystem: stored(ECOSYSTEMS, row.ecosystem, 'ecosystem'),
      name: text(row.package_name),
      version: textOrNull(row.package_version),
      fixed: textOrNull(row.fixed_version),
      advisories: strings(row.advisory_ids),
      cves: strings(row.cve_ids),
      cvss: number(row.cvss)
    } : null,
    risk: row.risk_score === null ? null : { score: Number(row.risk_score), band: storedOrNull(RISK_BANDS, row.risk_band, 'risk band') },
    reach: storedOrNull(REACH_TIERS, row.reach_tier, 'reach tier'),
    exploited: row.exploited === true,
    ransomware: row.ransomware === true,
    epss: number(row.epss),
    firstSeenAt: iso(row.first_seen_at),
    waived: storedOrNull(WAIVED, row.waived, 'waiver')
  };
}

export interface DescribedFinding extends KeptFinding {
  readonly why: string | null;
  readonly fix: string | null;
  readonly standards: Standards | null;
  readonly prompt: string | null;
}

/*
 * A kept finding with its rule's own words, for reading and exporting an
 * audit that is no longer on screen: why the rule matters, how to fix it,
 * the standards it maps to, and a prompt written from the rule, the place
 * and the package facts the record holds. All of it is text this server
 * wrote; none of it is read from the repository. It is the current engine's
 * wording of the rule, which the export says.
 */
export function describeKept(finding: KeptFinding): DescribedFinding {
  const definition = ownEntry(RULES, finding.rule);
  if (!definition) return { ...finding, why: null, fix: null, standards: null, prompt: null };
  const where = finding.path ? `${finding.path}${finding.line ? ` (line ${finding.line})` : ''}` : 'this repository';
  const pkg = finding.package;
  const facts = pkg ? `${pkg.name} ${pkg.version}${pkg.advisories.length ? ` -- ${pkg.advisories.join(', ')}` : ''}${pkg.fixed ? `; fixed in ${pkg.fixed}` : ''}` : '';
  return {
    ...finding,
    why: definition.why,
    fix: definition.fix,
    standards: standardsFor(finding.rule),
    prompt: `In ${where}: ${definition.title.toLowerCase()}${facts ? ` (${facts})` : ''}. ${definition.why} ${definition.fix} ` +
      'Make the smallest change that fixes it, keep the existing behaviour otherwise, and add or update a test that fails before the fix and passes after.'
  };
}

/* A kept audit as the history route answers it: the record, each finding described. */
export function describeKeptAudit<A extends { readonly findings: readonly KeptFinding[] }>(found: A): Omit<A, 'findings'> & { readonly findings: DescribedFinding[] } {
  return { ...found, findings: found.findings.map(describeKept) };
}

export interface KeptComponent {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly advisoryIds: string[];
  readonly cves: string[];
  readonly exploitedCves: string[];
}

export function componentFromRow(row: Row): KeptComponent {
  return {
    ecosystem: stored(ECOSYSTEMS, row.ecosystem, 'ecosystem'),
    name: text(row.package_name),
    version: text(row.package_version),
    direct: row.direct === true,
    dev: row.dev === true,
    advisoryIds: strings(row.advisory_ids),
    cves: strings(row.cve_ids),
    exploitedCves: strings(row.exploited_cve_ids)
  };
}

export interface KeptAlert {
  readonly kind: AlertKind;
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly id: string | null;
  readonly cve: string | null;
  readonly severity: HistorySeverity | null;
  readonly cvss: number | null;
  readonly fixed: string | null;
  readonly malicious: boolean;
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly kevAdded: string | null;
  readonly kevDue: string | null;
  readonly epss: number | null;
  readonly firstSeenAt: string | null;
}

export function alertFromRow(row: Row): KeptAlert {
  return {
    kind: stored(ALERT_KINDS, row.kind, 'alert kind'),
    ecosystem: stored(ECOSYSTEMS, row.ecosystem, 'ecosystem'),
    name: text(row.package_name),
    version: text(row.package_version),
    direct: row.direct === true,
    dev: row.dev === true,
    id: textOrNull(row.advisory_id),
    cve: textOrNull(row.cve_id),
    severity: storedOrNull(SEVERITIES, row.severity, 'severity'),
    cvss: number(row.cvss),
    fixed: textOrNull(row.fixed_version),
    malicious: row.malicious === true,
    exploited: row.exploited === true,
    ransomware: row.ransomware === true,
    kevAdded: day(row.kev_added),
    kevDue: day(row.kev_due),
    epss: number(row.epss),
    firstSeenAt: iso(row.first_seen_at)
  };
}
