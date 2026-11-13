/*
 * The audit history's rows: an audit result reduced to what the tables take.
 *
 * `compactAudit` is the only way into the tables. It builds every row field
 * by field from values checked against the shape they must take -- a rule
 * id, a severity, a bounded path and a line number, a package name and
 * version, advisory and CVE identifiers, counts and scores -- and leaves out
 * anything that does not fit rather than storing it approximately.
 * `db/migrations/029_code_audit_history.sql` refuses it again at the
 * database.
 *
 * Reads are the same in reverse (audit-history-records.ts).
 */
import { createHash } from 'node:crypto';
import { fieldsOf, isFields, listOf, read } from '../../../platform/values/fields.ts';
import { SLA_DAYS } from '../../kepler/index.ts';
import { ENGINE } from '../domain/audit-catalog.ts';
import { AUDIT_WATCH_STATES, type AuditWatchState } from '../../../../../../packages/contracts/src/evidence.ts';
import { COMMIT_SHA, IDENTITY_KEY, MUTATION_ID } from '../../../../../../packages/contracts/src/ids.ts';

export const LIMITS = Object.freeze({
  maxFindings: 1500,
  /* Waived findings are kept beside the open ones, so a clock survives its waiver. */
  maxWaived: 500,
  maxComponents: 5000,
  /* Audits kept per branch, and how far back. */
  keepPerBranch: 30,
  maxAgeMs: 400 * 24 * 60 * 60 * 1000,
  /* The branches of one repository whose latest audit keeps its components for the watch. */
  watchedBranches: 5,
  listLimit: 30,
  branchLimit: 12,
  insertBatch: 500,
  /* Time to fix is measured over this window, ending now. */
  mttrWindowDays: 90,
  maxResolutions: 1500
});
export type HistoryLimits = typeof LIMITS;

export const ECOSYSTEMS = Object.freeze(['npm', 'pypi', 'go', 'maven', 'packagist', 'rubygems', 'cargo', 'nuget'] as const);
export const SEVERITIES = Object.freeze(['critical', 'serious', 'warning'] as const);
export const VERDICTS = Object.freeze(['confirmed', 'needs-validation'] as const);
export const RISK_BANDS = Object.freeze(['urgent', 'high', 'moderate', 'low'] as const);
export const REACH_TIERS = Object.freeze(['imported', 'named', 'bundled', 'transitive', 'installed', 'unknown', 'build', 'test', 'dev'] as const);
export const GRADES = Object.freeze(['A', 'B', 'C', 'D', 'F'] as const);
export const CAP_REASONS = Object.freeze(['critical', 'exploited'] as const);
export const WATCH_KEV = Object.freeze(['ok', 'unavailable', 'not-needed'] as const);
export const ALERT_KINDS = Object.freeze(['advisory', 'exploited'] as const);
export const WAIVED = Object.freeze(['code', 'policy', 'triage'] as const);
export const POLICY_SOURCES = Object.freeze(['default', 'repository', 'invalid'] as const);
/* The watch's states are the evidence contract's, so a page and a policy read the same three words. */
export const WATCH_STATES = AUDIT_WATCH_STATES;

export type HistorySeverity = (typeof SEVERITIES)[number];
export type Waived = (typeof WAIVED)[number];
export type WatchKev = (typeof WATCH_KEV)[number];
export type AlertKind = (typeof ALERT_KINDS)[number];
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/*
 * The same shapes the migration checks, so a value is refused here first and the database is the second wall, not the only one.
 * The identifiers are the ids contract's: an audit id is a v1-5 UUID, written as mutation ids are.
 */
export const SHAPE = Object.freeze({
  uuid: MUTATION_ID,
  identity: IDENTITY_KEY,
  commit: COMMIT_SHA,
  engine: /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/,
  findingId: /^[0-9a-f]{24}$/,
  rule: /^[A-Z]{2,4}-[0-9]{3}$/,
  category: /^[a-z][a-z-]{1,31}$/,
  packageName: /^[A-Za-z0-9@_.][A-Za-z0-9@/._:+~-]{0,213}$/,
  version: /^[A-Za-z0-9][A-Za-z0-9._+~:!-]{0,99}$/,
  advisory: /^[A-Za-z][A-Za-z0-9._-]{2,63}$/,
  cve: /^CVE-[0-9]{4}-[0-9]{4,7}$/,
  day: /^\d{4}-\d{2}-\d{2}$/
});

export class CodeAuditHistoryError extends Error {
  override readonly name = 'CodeAuditHistoryError';
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const fits = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
export function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return list.find(item => item === value) ?? null;
}
export const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const bounded = (value: unknown, min: number, max: number): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null);
const ids = (list: unknown, pattern: RegExp, max: number): string[] => [...new Set(listOf(list).filter((item): item is string => fits(pattern, item)))].slice(0, max);
const orNull = (list: string[]): string[] | null => (list.length ? list : null);

/* A repository at a provider, as every row here is keyed. */
export interface HistoryScope {
  readonly provider: string;
  readonly authority: string;
  readonly owner: string;
  readonly repo: string;
}

export function requireScope(scope: unknown): HistoryScope {
  const source = fieldsOf(scope);
  const text = (value: unknown, label: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length > 255) throw new CodeAuditHistoryError(`${label} is required`, 'CODE_AUDIT_SCOPE_INVALID', 500);
    return trimmed;
  };
  return {
    provider: text(source.provider, 'Audit provider'),
    authority: text(source.authority, 'Audit authority'),
    owner: text(source.owner, 'Audit owner'),
    repo: text(source.repo, 'Audit repository')
  };
}
export function requireIdentity(identityKey: unknown): string {
  if (!fits(SHAPE.identity, identityKey)) throw new CodeAuditHistoryError('Audit identity is invalid', 'CODE_AUDIT_IDENTITY_INVALID', 500);
  return identityKey;
}
export function requireRef(ref: unknown): string {
  const trimmed = String(ref || '').trim();
  if (!trimmed || trimmed.length > 255) throw new CodeAuditHistoryError('A branch is required', 'CODE_AUDIT_REF_REQUIRED');
  return trimmed;
}

/* ---- Into the tables ------------------------------------------------------ */

const SEVERITY_RANK: Readonly<Record<HistorySeverity, number>> = Object.freeze({ critical: 0, serious: 1, warning: 2 });

export interface FindingRow {
  readonly finding_id: string;
  readonly rule: string;
  readonly category: string;
  readonly severity: HistorySeverity;
  readonly verdict: (typeof VERDICTS)[number];
  readonly file_path: string | null;
  readonly line_number: number | null;
  readonly ecosystem: Ecosystem | null;
  readonly package_name: string | null;
  readonly package_version: string | null;
  readonly fixed_version: string | null;
  readonly advisory_ids: string[] | null;
  readonly cve_ids: string[] | null;
  readonly cvss: number | null;
  readonly risk_score: number | null;
  readonly risk_band: (typeof RISK_BANDS)[number] | null;
  readonly reach_tier: (typeof REACH_TIERS)[number] | null;
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly epss: number | null;
  readonly waived: Waived | null;
  /* Set when the audit is recorded: when this finding was first seen, by this branch or another. */
  first_seen_at?: string;
}
export interface ComponentRow {
  readonly ecosystem: Ecosystem;
  readonly package_name: string;
  readonly package_version: string;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly advisory_ids: string[];
  readonly cve_ids: string[];
  readonly exploited_cve_ids: string[];
}
export interface AuditRow {
  readonly ref_name: string;
  readonly commit_sha: string;
  readonly engine_version: string;
  readonly audited_at: string;
  readonly score: number;
  readonly grade: (typeof GRADES)[number];
  readonly cap_reason: (typeof CAP_REASONS)[number] | null;
  readonly category_ids: string[];
  readonly category_scores: number[];
  readonly critical_count: number;
  readonly serious_count: number;
  readonly warning_count: number;
  readonly to_confirm_count: number;
  readonly waived_count: number;
  readonly exploited_count: number;
  readonly risk_urgent: number;
  readonly risk_high: number;
  readonly risk_moderate: number;
  readonly risk_low: number;
  readonly files_read: number;
  readonly files_eligible: number;
  readonly coverage_complete: boolean;
  readonly components_total: number;
  readonly findings_total: number;
  readonly findings_stored: number;
  readonly watch_checked_at: string;
  readonly watch_state: AuditWatchState;
  readonly watch_checked: number;
  readonly watch_total: number;
  readonly watch_kev: WatchKev;
  readonly sla_critical: number | null;
  readonly sla_serious: number | null;
  readonly sla_warning: number | null;
  readonly policy_source: (typeof POLICY_SOURCES)[number] | null;
  readonly analysis_complete: boolean;
}
/* Which detectors could still observe what they observed before: what a missing finding proves. */
export interface ResolutionEvidence {
  readonly files: boolean;
  readonly code: boolean;
  readonly dependencies: boolean;
  readonly licences: boolean;
}
export interface CompactAudit {
  readonly audit: AuditRow;
  readonly findings: FindingRow[];
  readonly waived: FindingRow[];
  readonly components: ComponentRow[];
}

/* How a finding the audit did not count was waived: by a team decision, in the licence policy, or in the code beside it. */
function waivedBy(finding: unknown): Waived {
  const suppression = read(finding, 'suppression');
  if (!isFields(suppression)) return 'code';
  if (suppression.triage) return 'triage';
  if (suppression.policy) return 'policy';
  return 'code';
}

function compactFinding(finding: unknown, waived: Waived | null = null): FindingRow | null {
  if (!isFields(finding)) return null;
  const { id, rule } = finding;
  if (!fits(SHAPE.findingId, id) || !fits(SHAPE.rule, rule)) return null;
  const severity = oneOf(SEVERITIES, finding.severity);
  const category = finding.category;
  if (!severity || !fits(SHAPE.category, category)) return null;
  const detail = fieldsOf(finding.detail);
  const { package: detailPackage, version: detailVersion, fixed: detailFixed } = detail;
  const ecosystem = oneOf(ECOSYSTEMS, detail.ecosystem);
  const isPackage = ecosystem !== null && fits(SHAPE.packageName, detailPackage) && fits(SHAPE.version, detailVersion);
  const advisories = listOf(detail.advisories);
  const intel = fieldsOf(detail.intel);
  const risk = fieldsOf(detail.risk);
  const usage = fieldsOf(detail.usage);
  const exploited = intel.exploited === true;
  const cvss = bounded(detail.cvss, 0, 10);
  const epss = isFields(intel.epss) ? bounded(intel.epss.score, 0, 1) : null;
  const riskScore = bounded(risk.score, 0, 100);
  const path = finding.path;
  const line = finding.line;
  return {
    finding_id: id,
    rule,
    category,
    severity,
    verdict: oneOf(VERDICTS, finding.verdict) || 'confirmed',
    file_path: typeof path === 'string' && path.length >= 1 && path.length <= 1024 ? path : null,
    line_number: typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 && line <= 100000000 ? line : null,
    ecosystem: isPackage ? ecosystem : null,
    package_name: isPackage ? detailPackage : null,
    package_version: isPackage ? detailVersion : null,
    fixed_version: isPackage && fits(SHAPE.version, detailFixed) ? detailFixed : null,
    advisory_ids: isPackage ? orNull(ids(advisories.map(advisory => read(advisory, 'id')), SHAPE.advisory, 6)) : null,
    cve_ids: isPackage ? orNull(ids(advisories.map(advisory => read(advisory, 'cve')), SHAPE.cve, 6)) : null,
    cvss: cvss === null ? null : Math.round(cvss * 10) / 10,
    risk_score: riskScore === null ? null : Math.round(riskScore),
    risk_band: oneOf(RISK_BANDS, risk.band),
    reach_tier: oneOf(REACH_TIERS, usage.tier),
    exploited,
    ransomware: exploited && intel.ransomware === true,
    epss: epss === null ? null : Math.round(epss * 100000) / 100000,
    waived: oneOf(WAIVED, waived)
  };
}

function compactComponent(component: unknown): ComponentRow | null {
  if (!isFields(component)) return null;
  const ecosystem = oneOf(ECOSYSTEMS, component.ecosystem);
  const { name, version } = component;
  if (!ecosystem || !fits(SHAPE.packageName, name) || !fits(SHAPE.version, version)) return null;
  const known = fieldsOf(component.advisories);
  return {
    ecosystem,
    package_name: name,
    package_version: version,
    direct: component.direct === true,
    dev: component.dev === true,
    advisory_ids: ids(known.ids, SHAPE.advisory, 200),
    cve_ids: ids(known.cves, SHAPE.cve, 200),
    exploited_cve_ids: ids(known.exploited, SHAPE.cve, 200)
  };
}

/*
 * One audit result, reduced to the rows the tables take. Throws only when the
 * result cannot be an audit at all -- no commit, no score -- and otherwise
 * leaves out what does not fit.
 */
export function compactAudit(result: unknown): CompactAudit {
  return reduceAudit(result).compacted;
}

/* The rows, and beside them what each family's detectors could still see: kept in memory for resolutions, not stored. */
export function reduceAudit(result: unknown): { readonly compacted: CompactAudit; readonly evidence: ResolutionEvidence } {
  if (!isFields(result) || !fits(SHAPE.commit, result.commitSha)) {
    throw new CodeAuditHistoryError('An audit without a commit cannot be recorded', 'CODE_AUDIT_RESULT_INVALID');
  }
  const commitSha = result.commitSha;
  const score = bounded(result.score, 0, 100);
  const grade = oneOf(GRADES, result.grade);
  if (score === null || !grade) throw new CodeAuditHistoryError('An audit without a grade cannot be recorded', 'CODE_AUDIT_RESULT_INVALID');
  const findings = listOf(result.findings);
  const counts: Record<HistorySeverity, number> = { critical: 0, serious: 0, warning: 0 };
  let toConfirm = 0;
  for (const finding of findings) {
    const severity = oneOf(SEVERITIES, read(finding, 'severity'));
    if (severity) counts[severity] += 1;
    if (read(finding, 'verdict') === 'needs-validation') toConfirm += 1;
  }
  const ranked = (rows: (FindingRow | null)[]): FindingRow[] => rows
    .filter((row): row is FindingRow => Boolean(row))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.risk_score || 0) - (a.risk_score || 0));
  const storableFindings = ranked(findings.map(finding => compactFinding(finding)));
  const compact = storableFindings.slice(0, LIMITS.maxFindings);
  /* An id appears once: a finding is open or waived, never both. */
  const openIds = new Set(compact.map(row => row.finding_id));
  const suppressed = result.suppressed;
  const storableWaived = ranked(listOf(suppressed).map(finding => compactFinding(finding, waivedBy(finding))))
    .filter(row => !openIds.has(row.finding_id));
  const waivedRows = storableWaived.slice(0, LIMITS.maxWaived);
  const categories = listOf(result.categories).flatMap(category => {
    const id = read(category, 'id');
    const categoryScore = bounded(read(category, 'score'), 0, 100);
    return fits(SHAPE.category, id) && categoryScore !== null ? [{ id, score: categoryScore }] : [];
  }).slice(0, 16);
  const risk = fieldsOf(result.dependencyRisk);
  const bands = fieldsOf(risk.bands);
  const coverage = fieldsOf(result.coverage);
  const components: ComponentRow[] = [];
  const seen = new Set<string>();
  for (const component of listOf(result.components)) {
    const row = compactComponent(component);
    if (!row) continue;
    const key = `${row.ecosystem}\0${row.package_name}\0${row.package_version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push(row);
    if (components.length >= LIMITS.maxComponents) break;
  }
  const auditedAt = Date.parse(String(result.auditedAt));
  const engineVersion = read(result.engine, 'version');
  const engine = fits(SHAPE.engine, engineVersion) ? engineVersion : ENGINE.version;
  const at = new Date(Number.isFinite(auditedAt) ? auditedAt : Date.now()).toISOString();
  /*
   * The audit is the watch's first check: it asked OSV about these versions
   * and CISA about their CVEs a moment ago, so the watch starts from that
   * answer rather than asking the same questions again straight away.
   */
  const advisories = fieldsOf(coverage.advisories);
  const answered = Math.max(0, count(advisories.checked) - count(advisories.unknown));
  const exploit = fieldsOf(coverage.exploit);
  const advisoryState = advisories.inventoryComplete === false ? (answered ? 'partial' : 'unavailable')
    : !count(advisories.versions) ? 'ok'
      : answered === 0 ? 'unavailable'
        : count(advisories.unknown) || count(advisories.notChecked) ? 'partial' : 'ok';
  const needsKev = components.some(component => component.cve_ids.length) || count(exploit.cves) > 0;
  const kev = oneOf(WATCH_KEV, exploit.kev) || (needsKev ? 'unavailable' : 'not-needed');
  const watchState = advisoryState === 'ok' && kev !== 'unavailable' ? 'ok'
    : advisoryState === 'unavailable' && kev !== 'ok' ? 'unavailable' : 'partial';
  /* The clock the audited branch set, or the defaults; an audit without a policy at all predates clocks. */
  const policy = isFields(result.policy) ? result.policy : null;
  const days = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= SLA_DAYS.min && value <= SLA_DAYS.max ? value : null);
  const sla = fieldsOf(read(policy, 'sla'));
  const policySource = policy ? oneOf(POLICY_SOURCES, policy.source) : null;
  const critical = days(sla.critical);
  const serious = days(sla.serious);
  const warning = days(sla.warning);
  const slaKept = Boolean(policySource) && Boolean(critical) && Boolean(serious) && Boolean(warning);
  const audit = {
    ref_name: requireRef(result.ref),
    commit_sha: commitSha,
    engine_version: engine,
    audited_at: at,
    score: Math.round(score),
    grade,
    cap_reason: result.capped ? oneOf(CAP_REASONS, result.capReason) : null,
    category_ids: categories.map(category => category.id),
    category_scores: categories.map(category => Math.round(category.score)),
    critical_count: counts.critical,
    serious_count: counts.serious,
    warning_count: counts.warning,
    to_confirm_count: toConfirm,
    waived_count: Array.isArray(suppressed) ? suppressed.length : 0,
    exploited_count: count(risk.exploited),
    risk_urgent: count(bands.urgent),
    risk_high: count(bands.high),
    risk_moderate: count(bands.moderate),
    risk_low: count(bands.low),
    files_read: count(coverage.read),
    files_eligible: count(coverage.eligible),
    coverage_complete: coverage.complete === true,
    components_total: Math.max(count(result.componentsTruncated), components.length),
    findings_total: findings.length,
    findings_stored: compact.length,
    watch_checked_at: at,
    watch_state: watchState,
    watch_checked: Math.min(answered, components.length),
    watch_total: components.length,
    watch_kev: kev,
    sla_critical: slaKept ? critical : null,
    sla_serious: slaKept ? serious : null,
    sla_warning: slaKept ? warning : null,
    policy_source: slaKept ? policySource : null
  } as const;
  /* Rows the storage caps cut off, not rows that could never be stored or an id kept once. */
  const truncated = storableFindings.length > compact.length || storableWaived.length > waivedRows.length;
  const evidence = resolutionEvidence(result, audit, truncated);
  /* Only the all-detector verdict is stored. */
  const compacted: CompactAudit = {
    audit: { ...audit, analysis_complete: Object.values(evidence).every(Boolean) },
    findings: compact,
    waived: waivedRows,
    components
  };
  return { compacted, evidence: Object.freeze(evidence) };
}

/*
 * A missing observation proves a fix only when the detector that made it could
 * still observe it. Each family of findings has its own detectors: the file
 * rules, the tracer on top of them for code, the registry and advisory lookups
 * for dependencies, the licence answers for licences. The merge gate and the
 * stored `analysis_complete` still ask for every family at once.
 */
function resolutionEvidence(result: Readonly<Record<string, unknown>>, audit: Pick<AuditRow, 'coverage_complete' | 'files_read' | 'files_eligible'>, truncated: boolean): ResolutionEvidence {
  const coverage = fieldsOf(result.coverage);
  const files = Boolean(audit.coverage_complete) && audit.files_read >= audit.files_eligible && !truncated;
  const traced = fieldsOf(read(result.engine, 'traced'));
  const code = files && !traced.limit && !['cut', 'failed', 'deep', 'rulesOnly'].some(key => count(traced[key]) > 0) && !count(coverage.rulesOnly);
  const lookedUp = ['packages', 'advisories'].every(name => {
    const checked = coverage[name];
    const total = name === 'packages' ? 'declared' : 'versions';
    return !checked || !(read(checked, 'inventoryComplete') === false || count(read(checked, 'unknown')) || count(read(checked, 'notChecked')) || count(read(checked, 'checked')) < count(read(checked, total)));
  });
  const dependencies = files && lookedUp;
  const licences = coverage.licences;
  const licenceStatus = read(result.licences, 'status');
  const licencesAnswered = !(licences && count(read(licences, 'fromLock')) + count(read(licences, 'answered')) < count(read(licences, 'versions')))
    && !(licenceStatus && (count(read(licenceStatus, 'unknown')) || count(read(licenceStatus, 'notAsked'))));
  return { files, code, dependencies, licences: dependencies && licencesAnswered };
}

/* Which detectors a stored finding depends on, read from its rule. */
export function evidenceFamily(rule: unknown): keyof ResolutionEvidence {
  const prefix = String(rule || '').split('-')[0];
  return prefix === 'DEP' ? 'dependencies' : prefix === 'LIC' ? 'licences' : prefix === 'SEC' ? 'code' : 'files';
}

export interface AlertRow {
  readonly alert_key: string;
  readonly kind: AlertKind;
  readonly ecosystem: Ecosystem;
  readonly package_name: string;
  readonly package_version: string;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly advisory_id: string | null;
  readonly cve_id: string | null;
  readonly severity: HistorySeverity | null;
  readonly cvss: number | null;
  readonly fixed_version: string | null;
  readonly malicious: boolean;
  readonly exploited: boolean;
  readonly ransomware: boolean;
  readonly kev_added: string | null;
  readonly kev_due: string | null;
  readonly epss: number | null;
}

function alertKey(alert: { readonly kind: string; readonly ecosystem: string; readonly name: string; readonly version: string; readonly id: string | null; readonly cve: string | null }): string {
  return createHash('sha256')
    .update([alert.kind, alert.ecosystem, alert.name, alert.version, alert.id || '', alert.cve || ''].join('\0'))
    .digest('hex');
}

export function compactAlert(alert: unknown): AlertRow | null {
  if (!isFields(alert)) return null;
  const kind = oneOf(ALERT_KINDS, alert.kind);
  const ecosystem = oneOf(ECOSYSTEMS, alert.ecosystem);
  const { name, version } = alert;
  if (!kind || !ecosystem || !fits(SHAPE.packageName, name) || !fits(SHAPE.version, version)) return null;
  const advisory = fits(SHAPE.advisory, alert.id) ? alert.id : null;
  const cve = fits(SHAPE.cve, alert.cve) ? alert.cve : null;
  const exploited = alert.exploited === true;
  if (kind === 'advisory' && !advisory) return null;
  if (kind === 'exploited' && (!cve || !exploited)) return null;
  const cvss = bounded(alert.cvss, 0, 10);
  const epss = bounded(alert.epss, 0, 1);
  const { fixed, kevAdded, kevDue } = alert;
  return {
    alert_key: alertKey({ kind, ecosystem, name, version, id: advisory, cve }),
    kind,
    ecosystem,
    package_name: name,
    package_version: version,
    direct: alert.direct === true,
    dev: alert.dev === true,
    advisory_id: advisory,
    cve_id: cve,
    severity: oneOf(SEVERITIES, alert.severity),
    cvss: cvss === null ? null : Math.round(cvss * 10) / 10,
    fixed_version: fits(SHAPE.version, fixed) ? fixed : null,
    malicious: alert.malicious === true,
    exploited,
    ransomware: exploited && alert.ransomware === true,
    kev_added: fits(SHAPE.day, kevAdded) ? kevAdded : null,
    kev_due: fits(SHAPE.day, kevDue) ? kevDue : null,
    epss: epss === null ? null : Math.round(epss * 100000) / 100000
  };
}
