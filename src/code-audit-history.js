'use strict';

/*
 * Where repository audits are kept, and the watch over what they found.
 *
 * The rule is the one `src/exposure-store.js` follows: the server stores what
 * it learned about a repository and never any part of the repository itself.
 * An audit result in memory carries source-derived text -- a trace through
 * the code with a note at each step, a fix prompt that names the file, advisory
 * summaries, the reason written beside a waiver. `compactAudit` is the only way
 * into these tables, and it builds every row field by field from values that
 * are checked against the shape they must take: a rule id, a severity, a
 * bounded path and a line number, a package name and version, advisory and CVE
 * identifiers, counts and scores. Anything that does not fit is left out rather
 * than stored approximately, and `db/migrations/029_code_audit_history.sql`
 * refuses it again at the database.
 *
 * Reads are the same in reverse: every row that leaves is built from named
 * columns, never by spreading a row, so a column added later is invisible until
 * somebody adds it to a serializer on purpose. Every statement names the
 * identity the rows belong to, directly or through the audit that owns them.
 */

const crypto = require('crypto');
const { RULES, ENGINE } = require('./code-audit');

const LIMITS = Object.freeze({
  maxFindings: 1500,
  maxComponents: 5000,
  /* Audits kept per branch, and how far back. */
  keepPerBranch: 30,
  maxAgeMs: 400 * 24 * 60 * 60 * 1000,
  /* The branches of one repository whose latest audit keeps its components for the watch. */
  watchedBranches: 5,
  listLimit: 30,
  branchLimit: 12,
  insertBatch: 500
});

const ECOSYSTEMS = Object.freeze(['npm', 'pypi', 'go', 'maven', 'packagist', 'rubygems', 'cargo', 'nuget']);
const SEVERITIES = Object.freeze(['critical', 'serious', 'warning']);
const VERDICTS = Object.freeze(['confirmed', 'needs-validation']);
const RISK_BANDS = Object.freeze(['urgent', 'high', 'moderate', 'low']);
const REACH_TIERS = Object.freeze(['imported', 'named', 'bundled', 'transitive', 'installed', 'unknown', 'build', 'test', 'dev']);
const GRADES = Object.freeze(['A', 'B', 'C', 'D', 'F']);
const CAP_REASONS = Object.freeze(['critical', 'exploited']);
const WATCH_STATES = Object.freeze(['ok', 'partial', 'unavailable']);
const WATCH_KEV = Object.freeze(['ok', 'unavailable', 'not-needed']);
const ALERT_KINDS = Object.freeze(['advisory', 'exploited']);

/* The same shapes the migration checks, so a value is refused here first and the database is the second wall, not the only one. */
const SHAPE = Object.freeze({
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  identity: /^[0-9a-f]{64}$/,
  commit: /^[0-9a-f]{40}$/,
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

class CodeAuditHistoryError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CodeAuditHistoryError';
    this.code = code;
    this.status = status;
  }
}

const fits = (pattern, value) => typeof value === 'string' && pattern.test(value);
const oneOf = (list, value) => (list.includes(value) ? value : null);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const bounded = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? value : null);
const ids = (list, pattern, max) => [...new Set((Array.isArray(list) ? list : []).filter(item => fits(pattern, item)))].slice(0, max);
const orNull = list => (list.length ? list : null);

function requireScope(scope) {
  const source = scope && typeof scope === 'object' ? scope : {};
  const text = (value, label) => {
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
function requireIdentity(identityKey) {
  if (!fits(SHAPE.identity, identityKey)) throw new CodeAuditHistoryError('Audit identity is invalid', 'CODE_AUDIT_IDENTITY_INVALID', 500);
  return identityKey;
}
function requireRef(ref) {
  const trimmed = String(ref || '').trim();
  if (!trimmed || trimmed.length > 255) throw new CodeAuditHistoryError('A branch is required', 'CODE_AUDIT_REF_REQUIRED');
  return trimmed;
}

/* ---- Into the tables ------------------------------------------------------ */

const SEVERITY_RANK = Object.freeze({ critical: 0, serious: 1, warning: 2 });

function compactFinding(finding) {
  if (!finding || !fits(SHAPE.findingId, finding.id) || !fits(SHAPE.rule, finding.rule)) return null;
  const severity = oneOf(SEVERITIES, finding.severity);
  if (!severity || !fits(SHAPE.category, finding.category)) return null;
  const detail = finding.detail && typeof finding.detail === 'object' ? finding.detail : {};
  const isPackage = oneOf(ECOSYSTEMS, detail.ecosystem) && fits(SHAPE.packageName, detail.package) && fits(SHAPE.version, detail.version);
  const advisories = Array.isArray(detail.advisories) ? detail.advisories : [];
  const intel = detail.intel && typeof detail.intel === 'object' ? detail.intel : {};
  const risk = detail.risk && typeof detail.risk === 'object' ? detail.risk : {};
  const usage = detail.usage && typeof detail.usage === 'object' ? detail.usage : {};
  const exploited = intel.exploited === true;
  const cvss = bounded(detail.cvss, 0, 10);
  const epss = intel.epss && typeof intel.epss === 'object' ? bounded(intel.epss.score, 0, 1) : null;
  const riskScore = bounded(risk.score, 0, 100);
  const path = typeof finding.path === 'string' && finding.path.length >= 1 && finding.path.length <= 1024 ? finding.path : null;
  return {
    finding_id: finding.id,
    rule: finding.rule,
    category: finding.category,
    severity,
    verdict: oneOf(VERDICTS, finding.verdict) || 'confirmed',
    file_path: path,
    line_number: Number.isSafeInteger(finding.line) && finding.line >= 1 && finding.line <= 100000000 ? finding.line : null,
    ecosystem: isPackage ? detail.ecosystem : null,
    package_name: isPackage ? detail.package : null,
    package_version: isPackage ? detail.version : null,
    fixed_version: isPackage && fits(SHAPE.version, detail.fixed) ? detail.fixed : null,
    advisory_ids: isPackage ? orNull(ids(advisories.map(advisory => advisory && advisory.id), SHAPE.advisory, 6)) : null,
    cve_ids: isPackage ? orNull(ids(advisories.map(advisory => advisory && advisory.cve), SHAPE.cve, 6)) : null,
    cvss: cvss === null ? null : Math.round(cvss * 10) / 10,
    risk_score: riskScore === null ? null : Math.round(riskScore),
    risk_band: oneOf(RISK_BANDS, risk.band),
    reach_tier: oneOf(REACH_TIERS, usage.tier),
    exploited,
    ransomware: exploited && intel.ransomware === true,
    epss: epss === null ? null : Math.round(epss * 100000) / 100000
  };
}

function compactComponent(component) {
  if (!component || !oneOf(ECOSYSTEMS, component.ecosystem) || !fits(SHAPE.packageName, component.name) || !fits(SHAPE.version, component.version)) return null;
  const known = component.advisories && typeof component.advisories === 'object' ? component.advisories : {};
  return {
    ecosystem: component.ecosystem,
    package_name: component.name,
    package_version: component.version,
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
function compactAudit(result) {
  if (!result || typeof result !== 'object' || !fits(SHAPE.commit, result.commitSha)) {
    throw new CodeAuditHistoryError('An audit without a commit cannot be recorded', 'CODE_AUDIT_RESULT_INVALID');
  }
  const score = bounded(result.score, 0, 100);
  const grade = oneOf(GRADES, result.grade);
  if (score === null || !grade) throw new CodeAuditHistoryError('An audit without a grade cannot be recorded', 'CODE_AUDIT_RESULT_INVALID');
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const counts = { critical: 0, serious: 0, warning: 0 };
  let toConfirm = 0;
  for (const finding of findings) {
    if (finding && SEVERITIES.includes(finding.severity)) counts[finding.severity] += 1;
    if (finding && finding.verdict === 'needs-validation') toConfirm += 1;
  }
  const compact = findings
    .map(finding => ({ finding, row: compactFinding(finding) }))
    .filter(item => item.row)
    .sort((a, b) => SEVERITY_RANK[a.row.severity] - SEVERITY_RANK[b.row.severity] || (b.row.risk_score || 0) - (a.row.risk_score || 0))
    .slice(0, LIMITS.maxFindings)
    .map(item => item.row);
  const categories = (Array.isArray(result.categories) ? result.categories : [])
    .filter(category => category && fits(SHAPE.category, category.id) && bounded(category.score, 0, 100) !== null)
    .slice(0, 16);
  const risk = result.dependencyRisk && typeof result.dependencyRisk === 'object' ? result.dependencyRisk : {};
  const bands = risk.bands && typeof risk.bands === 'object' ? risk.bands : {};
  const coverage = result.coverage && typeof result.coverage === 'object' ? result.coverage : {};
  const components = [];
  const seen = new Set();
  for (const component of Array.isArray(result.components) ? result.components : []) {
    const row = compactComponent(component);
    if (!row) continue;
    const key = `${row.ecosystem}\0${row.package_name}\0${row.package_version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push(row);
    if (components.length >= LIMITS.maxComponents) break;
  }
  const auditedAt = Date.parse(result.auditedAt);
  const engine = result.engine && fits(SHAPE.engine, result.engine.version) ? result.engine.version : ENGINE.version;
  const at = new Date(Number.isFinite(auditedAt) ? auditedAt : Date.now()).toISOString();
  /*
   * The audit is the watch's first check: it asked OSV about these versions
   * and CISA about their CVEs a moment ago, so the watch starts from that
   * answer rather than asking the same questions again straight away.
   */
  const advisories = coverage.advisories && typeof coverage.advisories === 'object' ? coverage.advisories : {};
  const answered = Math.max(0, count(advisories.checked) - count(advisories.unknown));
  const exploit = coverage.exploit && typeof coverage.exploit === 'object' ? coverage.exploit : {};
  const advisoryState = !count(advisories.versions) ? 'ok'
    : answered === 0 ? 'unavailable'
      : count(advisories.unknown) || count(advisories.notChecked) ? 'partial' : 'ok';
  const needsKev = components.some(component => component.cve_ids.length) || count(exploit.cves) > 0;
  const kev = oneOf(WATCH_KEV, exploit.kev) || (needsKev ? 'unavailable' : 'not-needed');
  const watchState = advisoryState === 'ok' && kev !== 'unavailable' ? 'ok'
    : advisoryState === 'unavailable' && kev !== 'ok' ? 'unavailable' : 'partial';
  return {
    audit: {
      ref_name: requireRef(result.ref),
      commit_sha: result.commitSha,
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
      waived_count: Array.isArray(result.suppressed) ? result.suppressed.length : 0,
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
      watch_kev: kev
    },
    findings: compact,
    components
  };
}

function alertKey(alert) {
  return crypto.createHash('sha256')
    .update([alert.kind, alert.ecosystem, alert.name, alert.version, alert.id || '', alert.cve || ''].join('\0'))
    .digest('hex');
}

function compactAlert(alert) {
  if (!alert || !oneOf(ALERT_KINDS, alert.kind) || !oneOf(ECOSYSTEMS, alert.ecosystem) || !fits(SHAPE.packageName, alert.name) || !fits(SHAPE.version, alert.version)) return null;
  const advisory = fits(SHAPE.advisory, alert.id) ? alert.id : null;
  const cve = fits(SHAPE.cve, alert.cve) ? alert.cve : null;
  const exploited = alert.exploited === true;
  if (alert.kind === 'advisory' && !advisory) return null;
  if (alert.kind === 'exploited' && (!cve || !exploited)) return null;
  const cvss = bounded(alert.cvss, 0, 10);
  const epss = bounded(alert.epss, 0, 1);
  return {
    alert_key: alertKey({ ...alert, id: advisory, cve }),
    kind: alert.kind,
    ecosystem: alert.ecosystem,
    package_name: alert.name,
    package_version: alert.version,
    direct: alert.direct === true,
    dev: alert.dev === true,
    advisory_id: advisory,
    cve_id: cve,
    severity: oneOf(SEVERITIES, alert.severity),
    cvss: cvss === null ? null : Math.round(cvss * 10) / 10,
    fixed_version: fits(SHAPE.version, alert.fixed) ? alert.fixed : null,
    malicious: alert.malicious === true,
    exploited,
    ransomware: exploited && alert.ransomware === true,
    kev_added: fits(SHAPE.day, alert.kevAdded) ? alert.kevAdded : null,
    kev_due: fits(SHAPE.day, alert.kevDue) ? alert.kevDue : null,
    epss: epss === null ? null : Math.round(epss * 100000) / 100000
  };
}

/* ---- Out of the tables ---------------------------------------------------- */

const iso = value => (value ? new Date(value).toISOString() : null);
const number = value => (value === null || value === undefined ? null : Number(value));
const day = value => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

function auditFromRow(row) {
  const categories = [];
  const categoryIds = Array.isArray(row.category_ids) ? row.category_ids : [];
  const categoryScores = Array.isArray(row.category_scores) ? row.category_scores : [];
  categoryIds.forEach((id, index) => categories.push({ id, score: Number(categoryScores[index]) }));
  return {
    id: row.audit_id,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    engine: row.engine_version,
    auditedAt: iso(row.audited_at),
    score: Number(row.score),
    grade: row.grade,
    capReason: row.cap_reason || null,
    categories,
    counts: { critical: Number(row.critical_count), serious: Number(row.serious_count), warning: Number(row.warning_count) },
    toConfirm: Number(row.to_confirm_count),
    waived: Number(row.waived_count),
    exploited: Number(row.exploited_count),
    risk: { urgent: Number(row.risk_urgent), high: Number(row.risk_high), moderate: Number(row.risk_moderate), low: Number(row.risk_low) },
    files: { read: Number(row.files_read), eligible: Number(row.files_eligible), complete: row.coverage_complete === true },
    components: Number(row.components_total),
    findings: { total: Number(row.findings_total), stored: Number(row.findings_stored) },
    diff: row.new_count === null || row.new_count === undefined ? null : { new: Number(row.new_count), resolved: Number(row.resolved_count) },
    watch: row.watch_checked_at ? {
      checkedAt: iso(row.watch_checked_at),
      state: row.watch_state,
      checked: number(row.watch_checked),
      total: number(row.watch_total),
      kev: row.watch_kev || null
    } : null
  };
}

function findingFromRow(row) {
  const definition = RULES[row.rule];
  return {
    id: row.finding_id,
    rule: row.rule,
    /* The rule's own title: text this server wrote, never text read from the repository. */
    title: definition ? definition.title : row.rule,
    category: row.category,
    severity: row.severity,
    verdict: row.verdict,
    path: row.file_path || null,
    line: row.line_number === null ? null : Number(row.line_number),
    package: row.package_name ? {
      ecosystem: row.ecosystem,
      name: row.package_name,
      version: row.package_version,
      fixed: row.fixed_version || null,
      advisories: Array.isArray(row.advisory_ids) ? [...row.advisory_ids] : [],
      cves: Array.isArray(row.cve_ids) ? [...row.cve_ids] : [],
      cvss: number(row.cvss)
    } : null,
    risk: row.risk_score === null ? null : { score: Number(row.risk_score), band: row.risk_band || null },
    reach: row.reach_tier || null,
    exploited: row.exploited === true,
    ransomware: row.ransomware === true,
    epss: number(row.epss)
  };
}

function componentFromRow(row) {
  return {
    ecosystem: row.ecosystem,
    name: row.package_name,
    version: row.package_version,
    direct: row.direct === true,
    dev: row.dev === true,
    advisoryIds: Array.isArray(row.advisory_ids) ? [...row.advisory_ids] : [],
    cves: Array.isArray(row.cve_ids) ? [...row.cve_ids] : [],
    exploitedCves: Array.isArray(row.exploited_cve_ids) ? [...row.exploited_cve_ids] : []
  };
}

function alertFromRow(row) {
  return {
    kind: row.kind,
    ecosystem: row.ecosystem,
    name: row.package_name,
    version: row.package_version,
    direct: row.direct === true,
    dev: row.dev === true,
    id: row.advisory_id || null,
    cve: row.cve_id || null,
    severity: row.severity || null,
    cvss: number(row.cvss),
    fixed: row.fixed_version || null,
    malicious: row.malicious === true,
    exploited: row.exploited === true,
    ransomware: row.ransomware === true,
    kevAdded: day(row.kev_added),
    kevDue: day(row.kev_due),
    epss: number(row.epss),
    firstSeenAt: iso(row.first_seen_at)
  };
}

const AUDIT_COLUMNS = `audit_id, ref_name, commit_sha, engine_version, audited_at, score, grade, cap_reason,
  category_ids, category_scores, critical_count, serious_count, warning_count, to_confirm_count, waived_count,
  exploited_count, risk_urgent, risk_high, risk_moderate, risk_low, files_read, files_eligible, coverage_complete,
  components_total, findings_total, findings_stored, new_count, resolved_count,
  watch_checked_at, watch_state, watch_checked, watch_total, watch_kev`;
const FINDING_COLUMNS = `finding_id, rule, category, severity, verdict, file_path, line_number, ecosystem, package_name,
  package_version, fixed_version, advisory_ids, cve_ids, cvss, risk_score, risk_band, reach_tier, exploited, ransomware, epss`;
const FINDING_RECORD = `finding_id text, rule text, category text, severity text, verdict text, file_path text, line_number integer,
  ecosystem text, package_name text, package_version text, fixed_version text, advisory_ids text[], cve_ids text[],
  cvss numeric, risk_score smallint, risk_band text, reach_tier text, exploited boolean, ransomware boolean, epss numeric`;
const COMPONENT_COLUMNS = 'ecosystem, package_name, package_version, direct, dev, advisory_ids, cve_ids, exploited_cve_ids';
const COMPONENT_RECORD = `ecosystem text, package_name text, package_version text, direct boolean, dev boolean,
  advisory_ids text[], cve_ids text[], exploited_cve_ids text[]`;
const ALERT_COLUMNS = `alert_key, kind, ecosystem, package_name, package_version, direct, dev, advisory_id, cve_id, severity,
  cvss, fixed_version, malicious, exploited, ransomware, kev_added, kev_due, epss`;
const ALERT_RECORD = `alert_key text, kind text, ecosystem text, package_name text, package_version text, direct boolean, dev boolean,
  advisory_id text, cve_id text, severity text, cvss numeric, fixed_version text, malicious boolean, exploited boolean,
  ransomware boolean, kev_added date, kev_due date, epss numeric`;
const SEVERITY_ORDER_SQL = `CASE f.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 ELSE 2 END`;
const SCOPE_SQL = 'provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4 AND identity_key=$5';

class CodeAuditHistory {
  constructor(options) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('CodeAuditHistory requires a pg-compatible pool');
    }
    this.pool = pool;
    this.limits = Object.freeze({ ...LIMITS, ...(options.limits || {}) });
  }

  async #transaction(run) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await run(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is going away anyway */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /*
   * Records one audit and returns what changed since the previous audit of the
   * same branch. In one transaction with it: the older audits of that branch
   * give up their components (only the latest is watched), audits past the
   * per-branch ceiling or the age limit are removed, and only the most recently
   * audited branches of the repository keep components at all.
   */
  async record({ scope, identityKey, result, now = Date.now() }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const compact = compactAudit(result);
    const auditId = crypto.randomUUID();
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const { limits } = this;
    return this.#transaction(async client => {
      let previous = (await client.query(
        `SELECT audit_id, audited_at, engine_version FROM nv_code_audits
          WHERE ${SCOPE_SQL} AND ref_name=$6
          ORDER BY audited_at DESC, recorded_at DESC LIMIT 1`,
        [...base, compact.audit.ref_name]
      )).rows[0] || null;
      // A detector/identity upgrade starts a new comparison baseline. It is
      // not evidence that every old finding was fixed and every new one added.
      if (previous && previous.engine_version !== compact.audit.engine_version) previous = null;
      let diff = null;
      if (previous) {
        const before = new Set((await client.query(
          `SELECT f.finding_id FROM nv_code_audit_findings f
             JOIN nv_code_audits a ON a.audit_id=f.audit_id
            WHERE f.audit_id=$1 AND a.identity_key=$2`,
          [previous.audit_id, identity]
        )).rows.map(row => row.finding_id));
        const current = new Set(compact.findings.map(row => row.finding_id));
        diff = { newIds: [...current].filter(id => !before.has(id)), resolved: [...before].filter(id => !current.has(id)).length };
      }
      const audit = compact.audit;
      await client.query(
        `INSERT INTO nv_code_audits (
           audit_id, provider, authority, owner_login, repo_name, identity_key, ref_name, commit_sha, engine_version,
           audited_at, recorded_at, score, grade, cap_reason, category_ids, category_scores,
           critical_count, serious_count, warning_count, to_confirm_count, waived_count, exploited_count,
           risk_urgent, risk_high, risk_moderate, risk_low, files_read, files_eligible, coverage_complete,
           components_total, findings_total, findings_stored, new_count, resolved_count,
           watch_checked_at, watch_state, watch_checked, watch_total, watch_kev)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::smallint[],
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)`,
        [auditId, where.provider, where.authority, where.owner, where.repo, identity, audit.ref_name, audit.commit_sha,
          audit.engine_version, audit.audited_at, new Date(now).toISOString(), audit.score, audit.grade, audit.cap_reason,
          audit.category_ids, audit.category_scores, audit.critical_count, audit.serious_count, audit.warning_count,
          audit.to_confirm_count, audit.waived_count, audit.exploited_count, audit.risk_urgent, audit.risk_high,
          audit.risk_moderate, audit.risk_low, audit.files_read, audit.files_eligible, audit.coverage_complete,
          audit.components_total, audit.findings_total, audit.findings_stored,
          diff ? diff.newIds.length : null, diff ? diff.resolved : null,
          audit.watch_checked_at, audit.watch_state, audit.watch_checked, audit.watch_total, audit.watch_kev]
      );
      for (let start = 0; start < compact.findings.length; start += limits.insertBatch) {
        await client.query(
          `INSERT INTO nv_code_audit_findings (audit_id, ${FINDING_COLUMNS})
           SELECT $1, ${FINDING_COLUMNS} FROM jsonb_to_recordset($2::jsonb) AS x(${FINDING_RECORD})
           ON CONFLICT (audit_id, finding_id) DO NOTHING`,
          [auditId, JSON.stringify(compact.findings.slice(start, start + limits.insertBatch))]
        );
      }
      for (let start = 0; start < compact.components.length; start += limits.insertBatch * 2) {
        await client.query(
          `INSERT INTO nv_code_audit_components (audit_id, ${COMPONENT_COLUMNS})
           SELECT $1, ${COMPONENT_COLUMNS} FROM jsonb_to_recordset($2::jsonb) AS x(${COMPONENT_RECORD})
           ON CONFLICT (audit_id, ecosystem, package_name, package_version) DO NOTHING`,
          [auditId, JSON.stringify(compact.components.slice(start, start + limits.insertBatch * 2))]
        );
      }
      /* Only the latest audit of a branch is watched; the ones before it keep their history, not their components. */
      await client.query(
        `DELETE FROM nv_code_audit_components
          WHERE audit_id IN (SELECT audit_id FROM nv_code_audits WHERE ${SCOPE_SQL} AND ref_name=$6 AND audit_id<>$7)`,
        [...base, audit.ref_name, auditId]
      );
      await client.query(
        `DELETE FROM nv_code_audits
          WHERE audit_id IN (
            SELECT audit_id FROM nv_code_audits WHERE ${SCOPE_SQL} AND ref_name=$6
             ORDER BY audited_at DESC, recorded_at DESC OFFSET $7)`,
        [...base, audit.ref_name, limits.keepPerBranch]
      );
      await client.query(
        `DELETE FROM nv_code_audits WHERE ${SCOPE_SQL} AND audited_at < $6`,
        [...base, new Date(now - limits.maxAgeMs).toISOString()]
      );
      await client.query(
        `DELETE FROM nv_code_audit_components
          WHERE audit_id IN (
            SELECT audit_id FROM nv_code_audits WHERE ${SCOPE_SQL}
               AND ref_name NOT IN (
                 SELECT ref_name FROM nv_code_audits WHERE ${SCOPE_SQL}
                  GROUP BY ref_name ORDER BY max(audited_at) DESC LIMIT $6))`,
        [...base, limits.watchedBranches]
      );
      return {
        auditId,
        previous: previous ? { auditId: previous.audit_id, auditedAt: iso(previous.audited_at) } : null,
        newIds: diff ? diff.newIds : null,
        resolved: diff ? diff.resolved : null,
        stored: { findings: compact.findings.length, components: compact.components.length }
      };
    });
  }

  /* One branch's audits, newest first, and the other branches this identity has audited. */
  async list({ scope, identityKey, ref, limit = this.limits.listLimit }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const [audits, branches] = await Promise.all([
      this.pool.query(
        `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits
          WHERE ${SCOPE_SQL} AND ref_name=$6
          ORDER BY audited_at DESC, recorded_at DESC LIMIT $7`,
        [...base, requireRef(ref), Math.max(1, Math.min(this.limits.listLimit, Number(limit) || this.limits.listLimit))]
      ),
      this.pool.query(
        `SELECT ref_name, count(*)::integer AS audits, max(audited_at) AS last_at FROM nv_code_audits
          WHERE ${SCOPE_SQL}
          GROUP BY ref_name ORDER BY max(audited_at) DESC LIMIT $6`,
        [...base, this.limits.branchLimit]
      )
    ]);
    return {
      audits: audits.rows.map(auditFromRow),
      branches: branches.rows.map(row => ({ ref: row.ref_name, audits: Number(row.audits), lastAt: iso(row.last_at) }))
    };
  }

  /* One audit and what it found. Null when it is not this identity's, or no longer kept. */
  async read({ scope, identityKey, auditId }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    if (!fits(SHAPE.uuid, auditId)) return null;
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const audit = (await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits WHERE ${SCOPE_SQL} AND audit_id=$6`,
      [...base, auditId]
    )).rows[0];
    if (!audit) return null;
    const findings = await this.pool.query(
      `SELECT ${FINDING_COLUMNS.split(',').map(column => `f.${column.trim()}`).join(', ')}
         FROM nv_code_audit_findings f
         JOIN nv_code_audits a ON a.audit_id=f.audit_id
        WHERE f.audit_id=$1 AND a.identity_key=$2
        ORDER BY ${SEVERITY_ORDER_SQL}, f.risk_score DESC NULLS LAST, f.file_path NULLS LAST, f.line_number NULLS LAST, f.finding_id`,
      [auditId, identity]
    );
    return { audit: auditFromRow(audit), findings: findings.rows.map(findingFromRow) };
  }

  /* The latest audit of a branch, with the components the watch checks and the alerts it has found. */
  async watched({ scope, identityKey, ref }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const row = (await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits
        WHERE ${SCOPE_SQL} AND ref_name=$6
        ORDER BY audited_at DESC, recorded_at DESC LIMIT 1`,
      [...base, requireRef(ref)]
    )).rows[0];
    if (!row) return null;
    const [components, alerts] = await Promise.all([
      this.pool.query(
        `SELECT c.ecosystem, c.package_name, c.package_version, c.direct, c.dev, c.advisory_ids, c.cve_ids, c.exploited_cve_ids
           FROM nv_code_audit_components c
           JOIN nv_code_audits a ON a.audit_id=c.audit_id
          WHERE c.audit_id=$1 AND a.identity_key=$2
          ORDER BY c.direct DESC, c.ecosystem, c.package_name, c.package_version`,
        [row.audit_id, identity]
      ),
      this.#alerts(this.pool, row.audit_id, identity)
    ]);
    return { audit: auditFromRow(row), components: components.rows.map(componentFromRow), alerts };
  }

  async #alerts(client, auditId, identity) {
    const found = await client.query(
      `SELECT l.kind, l.ecosystem, l.package_name, l.package_version, l.direct, l.dev, l.advisory_id, l.cve_id, l.severity,
              l.cvss, l.fixed_version, l.malicious, l.exploited, l.ransomware, l.kev_added, l.kev_due, l.epss, l.first_seen_at
         FROM nv_code_audit_alerts l
         JOIN nv_code_audits a ON a.audit_id=l.audit_id
        WHERE l.audit_id=$1 AND a.identity_key=$2
        ORDER BY l.exploited DESC, l.malicious DESC,
                 CASE l.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                 l.direct DESC, l.package_name, l.package_version, l.advisory_id NULLS LAST, l.cve_id`,
      [auditId, identity]
    );
    return found.rows.map(alertFromRow);
  }

  /*
   * The watch's answer for an audit. Alerts are kept by what they are about,
   * so the date one was first seen survives later checks; a check that
   * answered completely for one source also drops that source's alerts it no
   * longer finds (an advisory withdrawn). Unanswered or truncated sources
   * retain their alerts: silence is not evidence that anything went away.
   */
  async saveWatch({ scope, identityKey, auditId, outcome, now = Date.now() }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    if (!fits(SHAPE.uuid, auditId)) return null;
    const state = oneOf(WATCH_STATES, outcome && outcome.state);
    if (!state) throw new CodeAuditHistoryError('The watch outcome is invalid', 'CODE_AUDIT_WATCH_INVALID', 500);
    const at = new Date(now).toISOString();
    const rows = [];
    const keys = new Set();
    const sources = outcome.sources && typeof outcome.sources === 'object' ? outcome.sources : null;
    const kevComplete = outcome.kev === 'ok' || outcome.kev === 'not-needed';
    const truncated = count(outcome.truncated) > 0;
    /* Legacy callers must prove a complete answer from both sources before pruning. */
    const legacyComplete = !sources && state === 'ok' && kevComplete && count(outcome.checked) === count(outcome.total);
    const completeKinds = truncated ? [] : sources
      ? [...(sources.advisories === 'ok' && count(outcome.checked) === count(outcome.total) ? ['advisory'] : []),
        ...(sources.exploited === 'ok' && outcome.kev === 'ok' ? ['exploited'] : [])]
      : legacyComplete ? [...ALERT_KINDS] : [];
    const exploitationAnswered = outcome.kev === 'ok' && (!sources || sources.exploited === 'ok');
    const advisoriesAnswered = sources ? sources.advisories === 'ok' : legacyComplete;
    const effectiveState = state === 'ok' && (truncated || !kevComplete || count(outcome.checked) < count(outcome.total)
      || (sources && (sources.advisories !== 'ok' || !['ok', 'not-needed'].includes(sources.exploited)))) ? 'partial' : state;
    for (const alert of Array.isArray(outcome.alerts) ? outcome.alerts : []) {
      const row = compactAlert(alert);
      if (!row || keys.has(row.alert_key)) continue;
      keys.add(row.alert_key);
      rows.push(row);
    }
    return this.#transaction(async client => {
      const updated = await client.query(
        `UPDATE nv_code_audits
            SET watch_checked_at=$7, watch_state=$8, watch_checked=$9, watch_total=$10, watch_kev=$11
          WHERE ${SCOPE_SQL} AND audit_id=$6`,
        [where.provider, where.authority, where.owner, where.repo, identity, auditId, at, effectiveState,
          count(outcome.checked), count(outcome.total), oneOf(WATCH_KEV, outcome.kev)]
      );
      if (!updated.rowCount) return null;
      if (rows.length) {
        await client.query(
          `INSERT INTO nv_code_audit_alerts (audit_id, ${ALERT_COLUMNS}, first_seen_at, last_seen_at)
           SELECT $1, ${ALERT_COLUMNS}, $3, $3 FROM jsonb_to_recordset($2::jsonb) AS x(${ALERT_RECORD})
           ON CONFLICT (audit_id, alert_key) DO UPDATE SET
             cve_id=CASE WHEN $5 THEN EXCLUDED.cve_id ELSE COALESCE(EXCLUDED.cve_id, nv_code_audit_alerts.cve_id) END,
             severity=CASE WHEN $5 THEN EXCLUDED.severity ELSE COALESCE(EXCLUDED.severity, nv_code_audit_alerts.severity) END,
             cvss=CASE WHEN $5 THEN EXCLUDED.cvss ELSE COALESCE(EXCLUDED.cvss, nv_code_audit_alerts.cvss) END,
             fixed_version=CASE WHEN $5 THEN EXCLUDED.fixed_version ELSE COALESCE(EXCLUDED.fixed_version, nv_code_audit_alerts.fixed_version) END,
             exploited=CASE WHEN EXCLUDED.cve_id IS NOT NULL AND ($4 OR EXCLUDED.exploited) THEN EXCLUDED.exploited ELSE nv_code_audit_alerts.exploited END,
             ransomware=CASE WHEN EXCLUDED.cve_id IS NOT NULL AND ($4 OR EXCLUDED.exploited) THEN EXCLUDED.ransomware ELSE nv_code_audit_alerts.ransomware END,
             kev_added=CASE WHEN EXCLUDED.cve_id IS NOT NULL AND ($4 OR EXCLUDED.exploited) THEN EXCLUDED.kev_added ELSE nv_code_audit_alerts.kev_added END,
             kev_due=CASE WHEN EXCLUDED.cve_id IS NOT NULL AND ($4 OR EXCLUDED.exploited) THEN EXCLUDED.kev_due ELSE nv_code_audit_alerts.kev_due END,
             epss=COALESCE(EXCLUDED.epss, nv_code_audit_alerts.epss), last_seen_at=EXCLUDED.last_seen_at`,
          [auditId, JSON.stringify(rows), at, exploitationAnswered, advisoriesAnswered]
        );
      }
      if (completeKinds.length) {
        await client.query(
          `DELETE FROM nv_code_audit_alerts
            WHERE audit_id=$1 AND NOT (alert_key = ANY($3::text[])) AND kind = ANY($4::text[])
              AND audit_id IN (SELECT audit_id FROM nv_code_audits WHERE audit_id=$1 AND identity_key=$2)`,
          [auditId, identity, [...keys], completeKinds]
        );
      }
      return this.#alerts(client, auditId, identity);
    });
  }

  /* Every audit this identity kept of one repository, every branch. Returns how many. */
  async clear({ scope, identityKey }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const removed = await this.pool.query(
      `DELETE FROM nv_code_audits WHERE ${SCOPE_SQL}`,
      [where.provider, where.authority, where.owner, where.repo, identity]
    );
    return removed.rowCount;
  }
}

/*
 * The watch as a service: checks a branch's latest audit when its last check
 * is older than `staleMs`, or when asked to and at least `minIntervalMs` has
 * passed, and never twice at once for the same audit. `check` is
 * `watchComponents` bound to its transports; this does not reach the network
 * itself.
 */
function createAuditWatch({ history, check, staleMs = 6 * 60 * 60 * 1000, minIntervalMs = 10 * 60 * 1000, now: clock = () => Date.now() }) {
  const running = new Map();
  async function refresh({ scope, identityKey, ref, force = false }) {
    const watched = await history.watched({ scope, identityKey, ref });
    if (!watched) return { audit: null, alerts: [], components: 0, fresh: false, checkableAt: null };
    const { audit } = watched;
    const last = audit.watch ? Date.parse(audit.watch.checkedAt) : 0;
    const age = clock() - last;
    const due = !audit.watch || age >= staleMs || (force && age >= minIntervalMs);
    if (!due || !watched.components.length) {
      return { audit, alerts: watched.alerts, components: watched.components.length, fresh: false, checkableAt: last ? new Date(last + minIntervalMs).toISOString() : null };
    }
    const key = audit.id;
    if (!running.has(key)) {
      running.set(key, (async () => {
        try {
          const outcome = await check({ components: watched.components });
          const alerts = await history.saveWatch({ scope, identityKey, auditId: audit.id, outcome, now: clock() });
          return { outcome, alerts };
        } finally {
          running.delete(key);
        }
      })());
    }
    const { outcome, alerts } = await running.get(key);
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

module.exports = Object.freeze({
  CodeAuditHistory,
  /* The shapes the routes answer with, for fixtures that stand in for the database. */
  serialize: Object.freeze({ audit: auditFromRow, finding: findingFromRow, alert: alertFromRow }),
  CodeAuditHistoryError,
  createAuditWatch,
  compactAudit,
  compactAlert,
  LIMITS,
  SHAPE
});
