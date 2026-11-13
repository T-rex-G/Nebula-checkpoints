/*
 * The audit history's SQL fragments: the columns each table is read and
 * written by, and the scope every statement names. Shared by the store and
 * the workspace reads so the two can never read a table by different
 * columns.
 */
export const AUDIT_COLUMNS = `audit_id, ref_name, commit_sha, engine_version, audited_at, score, grade, cap_reason,
  category_ids, category_scores, critical_count, serious_count, warning_count, to_confirm_count, waived_count,
  exploited_count, risk_urgent, risk_high, risk_moderate, risk_low, files_read, files_eligible, coverage_complete,
  components_total, findings_total, findings_stored, new_count, resolved_count,
  watch_checked_at, watch_state, watch_checked, watch_total, watch_kev,
  sla_critical, sla_serious, sla_warning, policy_source, analysis_complete`;
export const FINDING_COLUMNS = `finding_id, rule, category, severity, verdict, file_path, line_number, ecosystem, package_name,
  package_version, fixed_version, advisory_ids, cve_ids, cvss, risk_score, risk_band, reach_tier, exploited, ransomware, epss,
  first_seen_at, waived`;
export const FINDING_RECORD = `finding_id text, rule text, category text, severity text, verdict text, file_path text, line_number integer,
  ecosystem text, package_name text, package_version text, fixed_version text, advisory_ids text[], cve_ids text[],
  cvss numeric, risk_score smallint, risk_band text, reach_tier text, exploited boolean, ransomware boolean, epss numeric,
  first_seen_at timestamptz, waived text`;
export const COMPONENT_COLUMNS = 'ecosystem, package_name, package_version, direct, dev, advisory_ids, cve_ids, exploited_cve_ids';
export const COMPONENT_RECORD = `ecosystem text, package_name text, package_version text, direct boolean, dev boolean,
  advisory_ids text[], cve_ids text[], exploited_cve_ids text[]`;
export const ALERT_COLUMNS = `alert_key, kind, ecosystem, package_name, package_version, direct, dev, advisory_id, cve_id, severity,
  cvss, fixed_version, malicious, exploited, ransomware, kev_added, kev_due, epss`;
export const ALERT_RECORD = `alert_key text, kind text, ecosystem text, package_name text, package_version text, direct boolean, dev boolean,
  advisory_id text, cve_id text, severity text, cvss numeric, fixed_version text, malicious boolean, exploited boolean,
  ransomware boolean, kev_added date, kev_due date, epss numeric`;
export const SEVERITY_ORDER_SQL = `CASE f.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 ELSE 2 END`;
export const SCOPE_SQL = 'provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4 AND identity_key=$5';
/*
 * Each repository's latest audit by one identity, across a workspace: $1 the
 * provider, $2 the authority, $3 the identity, $4 how many repositories. Every
 * workspace statement starts from it, so none reaches a row another identity
 * recorded.
 */
export const WORKSPACE_SQL = `WITH latest AS (
    SELECT DISTINCT ON (lower(owner_login), lower(repo_name))
           audit_id, owner_login, repo_name, ref_name, audited_at, score, grade, coverage_complete
      FROM nv_code_audits
     WHERE provider=$1 AND authority=$2 AND identity_key=$3
     ORDER BY lower(owner_login), lower(repo_name), audited_at DESC, recorded_at DESC, audit_id DESC),
  picked AS (SELECT audit_id, owner_login, repo_name, ref_name, audited_at, score, grade, coverage_complete
               FROM latest ORDER BY audited_at DESC, audit_id LIMIT $4)`;
