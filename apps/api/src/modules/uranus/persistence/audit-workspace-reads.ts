/*
 * The audit history read across a workspace: every repository an identity
 * has audited, for the Overview, and every finding its latest audits hold,
 * for the findings inbox. Both start from the same latest audit per
 * repository (WORKSPACE_SQL), so neither reaches a row another identity
 * recorded, and both apply decisions by the same rule.
 */
import { dateFrom } from '../../../platform/values/fields.ts';
import type { QueryOutcome, Queryable } from '../../../platform/persistence/queryable.ts';
import { DISPOSITIONS } from '../domain/audit-triage.ts';
import { FINDING_COLUMNS, SEVERITY_ORDER_SQL, WORKSPACE_SQL } from './audit-history-sql.ts';
import { GRADES, SEVERITIES, oneOf, requireIdentity, requireScope, type HistoryLimits, type HistorySeverity } from './audit-history-rows.ts';
import { findingFromRow, iso, stored, text, textOrNull } from './audit-history-records.ts';

type Row = Readonly<Record<string, unknown>>;
const rowsOf = (outcome: QueryOutcome): readonly Row[] => outcome.rows ?? [];
interface Median {
  readonly count: number;
  readonly medianDays: number | null;
}
/* The states a finding is counted in, by the decisions that apply to it. */
const FINDING_STATES = Object.freeze(['waived', 'false-positive', 'accepted-risk', 'open'] as const);

export interface WorkspaceInput {
  readonly provider: unknown;
  readonly authority: unknown;
  readonly identityKey: unknown;
  readonly now?: number;
  readonly weeks?: unknown;
  readonly repositoryLimit?: unknown;
}
export interface WorkspaceFindingsInput {
  readonly provider: unknown;
  readonly authority: unknown;
  readonly identityKey: unknown;
  readonly now?: number;
  readonly limit?: unknown;
  readonly repositoryLimit?: unknown;
}

/*
 * Every repository this identity has audited, read together for the
 * Overview. Each repository is represented by its latest audit, on whichever
 * branch that was, and everything else is measured on that same branch so a
 * repository is never counted twice.
 *
 * What the latest audit counted is what is open, with two corrections. A
 * finding the audit recorded as covered by a team decision is open again
 * when that decision has since been reopened or has expired. And a decision
 * this identity made itself applies at once. A teammate's decision made
 * after the audit is not applied -- this reads the decisions the auditor saw
 * or made, never ones they could not see -- so the next audit is what moves
 * it. Waivers in the code or in the licence policy are not findings.
 *
 * The weekly series are rolling seven-day windows ending now, `weeks` of
 * them, newest first: a finding opened when an audit first saw it, and was
 * fixed when an audit that read every file stopped seeing it.
 */
export async function readWorkspace(pool: Queryable, limits: HistoryLimits, { provider, authority, identityKey, now = Date.now(), weeks = 12, repositoryLimit = 200 }: WorkspaceInput) {
  const where = requireScope({ provider, authority, owner: 'workspace', repo: 'workspace' });
  const identity = requireIdentity(identityKey);
  const span = typeof weeks === 'number' && Number.isSafeInteger(weeks) && weeks >= 1 && weeks <= 52 ? weeks : 12;
  const limit = typeof repositoryLimit === 'number' && Number.isSafeInteger(repositoryLimit) && repositoryLimit >= 1 && repositoryLimit <= 500 ? repositoryLimit : 200;
  const at = new Date(now).toISOString();
  const mttrSince = new Date(now - limits.mttrWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const base = [where.provider, where.authority, identity, limit];
  const audits = await pool.query(
    `${WORKSPACE_SQL} SELECT owner_login, repo_name, ref_name, audited_at, score, grade, coverage_complete FROM picked
      ORDER BY audited_at DESC, owner_login, repo_name`,
    base
  );
  const findings = await pool.query(
    `${WORKSPACE_SQL}
     SELECT p.owner_login, p.repo_name, f.severity, f.category,
            CASE
              WHEN f.waived IN ('code', 'policy') THEN 'waived'
              WHEN (f.waived = 'triage' OR t.decided_by_key = $3) AND t.rule = f.rule AND t.disposition = 'false-positive' THEN 'false-positive'
              WHEN (f.waived = 'triage' OR t.decided_by_key = $3) AND t.rule = f.rule AND t.disposition = 'accepted-risk'
                   AND t.expires_at > $5::timestamptz THEN 'accepted-risk'
              ELSE 'open'
            END AS state,
            count(*)::integer AS n
       FROM picked p
       JOIN nv_code_audit_findings f ON f.audit_id = p.audit_id
       LEFT JOIN nv_code_audit_triage t
         ON t.provider=$1 AND t.authority=$2 AND t.owner_login=p.owner_login AND t.repo_name=p.repo_name AND t.finding_id=f.finding_id
      GROUP BY 1, 2, 3, 4, 5`,
    [...base, at]
  );
  const opened = await pool.query(
    `${WORKSPACE_SQL},
    seen AS (
      SELECT f.first_seen_at AS at
        FROM picked p JOIN nv_code_audit_findings f ON f.audit_id = p.audit_id
       WHERE f.first_seen_at IS NOT NULL AND (f.waived IS NULL OR f.waived = 'triage')
      UNION ALL
      SELECT r.first_seen_at
        FROM picked p JOIN nv_code_audit_resolutions r
          ON r.provider=$1 AND r.authority=$2 AND r.owner_login=p.owner_login AND r.repo_name=p.repo_name
         AND r.identity_key=$3 AND r.ref_name=p.ref_name)
     SELECT floor(extract(epoch FROM $5::timestamptz - at) / 604800)::integer AS weeks_ago, count(*)::integer AS n
       FROM seen
      WHERE at <= $5::timestamptz AND at > $5::timestamptz - make_interval(days => $6 * 7)
      GROUP BY 1`,
    [...base, at, span]
  );
  const fixed = await pool.query(
    `${WORKSPACE_SQL}
     SELECT floor(extract(epoch FROM $5::timestamptz - r.resolved_at) / 604800)::integer AS weeks_ago, count(*)::integer AS n
       FROM picked p JOIN nv_code_audit_resolutions r
         ON r.provider=$1 AND r.authority=$2 AND r.owner_login=p.owner_login AND r.repo_name=p.repo_name
        AND r.identity_key=$3 AND r.ref_name=p.ref_name
      WHERE r.resolved_at <= $5::timestamptz AND r.resolved_at > $5::timestamptz - make_interval(days => $6 * 7)
      GROUP BY 1`,
    [...base, at, span]
  );
  const timing = await pool.query(
    `${WORKSPACE_SQL}
     SELECT r.severity, count(*)::integer AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.resolved_at - r.first_seen_at)) AS median_s
       FROM picked p JOIN nv_code_audit_resolutions r
         ON r.provider=$1 AND r.authority=$2 AND r.owner_login=p.owner_login AND r.repo_name=p.repo_name
        AND r.identity_key=$3 AND r.ref_name=p.ref_name
      WHERE r.resolved_at <= $5::timestamptz AND r.resolved_at >= $6::timestamptz
      GROUP BY ROLLUP (r.severity)`,
    [...base, at, mttrSince]
  );
  const days = (seconds: unknown): number | null => (seconds === null || seconds === undefined ? null : Math.round((Number(seconds) / 86400) * 10) / 10);
  const none = (): Median => ({ count: 0, medianDays: null });
  const timeToFix: { windowDays: number; all: Median } & Record<HistorySeverity, Median> = { windowDays: limits.mttrWindowDays, all: none(), critical: none(), serious: none(), warning: none() };
  for (const row of rowsOf(timing)) {
    const entry = { count: Number(row.n), medianDays: days(row.median_s) };
    const severity = oneOf(SEVERITIES, row.severity);
    if (row.severity === null) timeToFix.all = entry;
    else if (severity) timeToFix[severity] = entry;
  }
  const weekly = (rows: QueryOutcome) => rowsOf(rows)
    .map(row => ({ weeksAgo: Number(row.weeks_ago), count: Number(row.n) }))
    .filter(row => Number.isSafeInteger(row.weeksAgo) && row.weeksAgo >= 0 && row.weeksAgo < span);
  return {
    weeks: span,
    audits: rowsOf(audits).map(row => ({
      owner: text(row.owner_login),
      repo: text(row.repo_name),
      ref: text(row.ref_name),
      auditedAt: dateFrom(row.audited_at).toISOString(),
      score: Number(row.score),
      grade: stored(GRADES, row.grade, 'grade'),
      coverageComplete: row.coverage_complete === true
    })),
    findings: rowsOf(findings).map(row => ({
      owner: text(row.owner_login),
      repo: text(row.repo_name),
      severity: stored(SEVERITIES, row.severity, 'severity'),
      category: text(row.category),
      state: stored(FINDING_STATES, row.state, 'finding state'),
      count: Number(row.n)
    })),
    opened: weekly(opened),
    fixed: weekly(fixed),
    timeToFix
  };
}

/*
 * The findings inbox: every finding the workspace's latest audits hold,
 * one row each, on the same terms as the workspace read above -- the same
 * latest audit per repository, and the same rule for which decisions apply.
 * Each row says when it was first seen, whether it was fixed once before
 * and came back (the last fix earlier than this sighting), and how many
 * times it has been fixed on that branch. Waivers in the code or in the
 * licence policy are not findings and are not listed.
 *
 * Bounded: `limit` rows, most severe and oldest first, and `truncated`
 * says when there were more.
 */
export async function readWorkspaceFindings(pool: Queryable, { provider, authority, identityKey, now = Date.now(), limit = 1000, repositoryLimit = 200 }: WorkspaceFindingsInput) {
  const where = requireScope({ provider, authority, owner: 'workspace', repo: 'workspace' });
  const identity = requireIdentity(identityKey);
  const bound = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 2000 ? limit : 1000;
  const repositories = typeof repositoryLimit === 'number' && Number.isSafeInteger(repositoryLimit) && repositoryLimit >= 1 && repositoryLimit <= 500 ? repositoryLimit : 200;
  const found = await pool.query(
    `${WORKSPACE_SQL}
     SELECT p.owner_login, p.repo_name, p.ref_name, p.audited_at,
            ${FINDING_COLUMNS.split(',').map(column => `f.${column.trim()}`).join(', ')},
            CASE
              WHEN (f.waived = 'triage' OR t.decided_by_key = $3) AND t.rule = f.rule
                   AND (t.disposition = 'false-positive' OR t.expires_at > $5::timestamptz) THEN t.disposition
              ELSE NULL
            END AS decision,
            CASE WHEN (f.waived = 'triage' OR t.decided_by_key = $3) AND t.rule = f.rule THEN t.reason END AS decision_reason,
            CASE WHEN (f.waived = 'triage' OR t.decided_by_key = $3) AND t.rule = f.rule THEN t.expires_at END AS decision_expires_at,
            fixes.times_fixed, fixes.last_fixed_at
       FROM picked p
       JOIN nv_code_audit_findings f ON f.audit_id = p.audit_id
       LEFT JOIN nv_code_audit_triage t
         ON t.provider=$1 AND t.authority=$2 AND t.owner_login=p.owner_login AND t.repo_name=p.repo_name AND t.finding_id=f.finding_id
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS times_fixed,
                max(r.resolved_at) FILTER (WHERE f.first_seen_at IS NOT NULL AND r.resolved_at <= f.first_seen_at) AS last_fixed_at
           FROM nv_code_audit_resolutions r
          WHERE r.provider=$1 AND r.authority=$2 AND r.owner_login=p.owner_login AND r.repo_name=p.repo_name
            AND r.identity_key=$3 AND r.ref_name=p.ref_name AND r.finding_id=f.finding_id
       ) fixes ON true
      WHERE f.waived IS NULL OR f.waived = 'triage'
      ORDER BY ${SEVERITY_ORDER_SQL}, f.first_seen_at ASC NULLS LAST, p.owner_login, p.repo_name, f.finding_id
      LIMIT $6`,
    [where.provider, where.authority, identity, repositories, new Date(now).toISOString(), bound + 1]
  );
  const all = rowsOf(found);
  const rows = all.slice(0, bound);
  return {
    truncated: all.length > bound,
    findings: rows.map(row => ({
      ...findingFromRow(row),
      owner: text(row.owner_login),
      repo: text(row.repo_name),
      ref: text(row.ref_name),
      auditedAt: iso(row.audited_at),
      decision: row.decision ? {
        disposition: stored(DISPOSITIONS, row.decision, 'decision'),
        reason: textOrNull(row.decision_reason),
        expiresAt: iso(row.decision_expires_at)
      } : null,
      timesFixed: Number(row.times_fixed) || 0,
      regressedAfter: iso(row.last_fixed_at)
    }))
  };
}
