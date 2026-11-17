/*
 * Where repository audits are kept.
 *
 * The rule is the one the exposure store follows: the server stores what
 * it learned about a repository and never any part of the repository itself.
 * An audit result in memory carries source-derived text -- a trace through
 * the code with a note at each step, a fix prompt that names the file, advisory
 * summaries, the reason written beside a waiver. `compactAudit` is the only way
 * into these tables, and it builds every row field by field from values that
 * are checked against the shape they must take: a rule id, a severity, a
 * bounded path and a line number, a package name and version, advisory and CVE
 * identifiers, counts and scores. Anything that does not fit is left out rather
 * than stored approximately (audit-history-rows.ts), and
 * `db/migrations/029_code_audit_history.sql` refuses it again at the database.
 *
 * Reads are the same in reverse: every row that leaves is built from named
 * columns, never by spreading a row, so a column added later is invisible until
 * somebody adds it to a serializer on purpose (audit-history-records.ts).
 * Every statement names the identity the rows belong to, directly or through
 * the audit that owns them. The reads across a whole workspace are in
 * audit-workspace-reads.ts; the watch that refreshes a branch's latest audit
 * is application/audit-watch.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { fieldsOf, isFields, listOf, read } from '../../../platform/values/fields.ts';
import type { QueryOutcome, Queryable, TransactionalPool } from '../../../platform/persistence/queryable.ts';
import { DEFAULT_SLA, clockOf, slaOf } from '../../kepler/index.ts';
import { assertAuditActive } from '../domain/audit-cancellation.ts';
import { productionTier } from '../domain/uranus-reach.ts';
import {
  ALERT_COLUMNS, ALERT_RECORD, AUDIT_COLUMNS, COMPONENT_COLUMNS, COMPONENT_RECORD, FINDING_COLUMNS, FINDING_RECORD, SCOPE_SQL, SEVERITY_ORDER_SQL
} from './audit-history-sql.ts';
import {
  ALERT_KINDS, CodeAuditHistoryError, LIMITS, SEVERITIES, SHAPE, WATCH_KEV, WATCH_STATES, compactAlert, count, evidenceFamily, fits, oneOf, reduceAudit,
  requireIdentity, requireRef, requireScope, type AlertKind, type AlertRow, type HistoryLimits, type HistorySeverity
} from './audit-history-rows.ts';
import {
  alertFromRow, auditFromRow, componentFromRow, findingFromRow, iso, ms, text, type KeptAlert, type KeptAudit, type KeptComponent, type KeptFinding
} from './audit-history-records.ts';
import { readWorkspace, readWorkspaceFindings, type WorkspaceFindingsInput, type WorkspaceInput } from './audit-workspace-reads.ts';

/* A row as the driver returns it: named columns, read one by one. */
type Row = Readonly<Record<string, unknown>>;
const rowsOf = (outcome: QueryOutcome): readonly Row[] => outcome.rows ?? [];

export interface CodeAuditHistoryOptions {
  readonly pool?: TransactionalPool | null;
  readonly limits?: Partial<HistoryLimits> | null;
}
/* What recording an audit changed, against the previous audit of the same branch. */
export interface RecordOutcome {
  readonly auditId: string;
  readonly previous: { readonly auditId: unknown; readonly auditedAt: string | null } | null;
  readonly newIds: string[] | null;
  readonly resolved: number | null;
  readonly firstSeen: Record<string, string>;
  readonly resolutions: number;
  readonly stored: { readonly findings: number; readonly waived: number; readonly components: number };
}
export interface KeptAuditRead {
  readonly audit: KeptAudit;
  readonly findings: KeptFinding[];
}
export interface WatchedAudit {
  readonly audit: KeptAudit;
  readonly components: KeptComponent[];
  readonly alerts: KeptAlert[];
}
interface ScopedRead {
  readonly scope: unknown;
  readonly identityKey: unknown;
}
interface TimeToFix {
  readonly count: number;
  readonly medianDays: number | null;
  readonly meanDays: number | null;
}
type Mttr = { windowDays: number; all: TimeToFix } & Record<HistorySeverity, TimeToFix>;
type OpenCounts = { open: number; overdue: number; dueSoon: number };

export class CodeAuditHistory {
  readonly pool: TransactionalPool;
  readonly limits: HistoryLimits;

  constructor(options: CodeAuditHistoryOptions) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('CodeAuditHistory requires a pg-compatible pool');
    }
    this.pool = pool;
    this.limits = Object.freeze({ ...LIMITS, ...(options.limits || {}) });
  }

  async #transaction<T>(run: (client: Queryable) => Promise<T>, { signal }: { readonly signal?: AbortSignal | null } = {}): Promise<T> {
    assertAuditActive(signal);
    const client = await this.pool.connect();
    try {
      assertAuditActive(signal);
      await client.query('BEGIN');
      const activeClient: Queryable = { query: async (sql, values) => {
        assertAuditActive(signal);
        const answer = await client.query(sql, values);
        assertAuditActive(signal);
        return answer;
      } };
      const value = await run(activeClient);
      assertAuditActive(signal);
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
   *
   * Each finding's clock is carried: it started when the previous audit of
   * this branch first saw it, or -- for a finding this branch has not shown
   * before -- when the latest audit of another branch did, so a feature branch
   * inherits the age of what it shares with main. A finding fixed and later
   * brought back starts again. And what the previous audit saw and this one
   * did not is a resolution, the evidence time to fix is measured from --
   * kept only when this audit read every eligible file with the same engine,
   * because a finding that went unread, or that a newer engine stopped
   * reporting, was not fixed.
   */
  async record({ scope, identityKey, result, now = Date.now(), signal }: ScopedRead & { readonly result: unknown; readonly now?: number; readonly signal?: AbortSignal | null }): Promise<RecordOutcome> {
    assertAuditActive(signal);
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const { compacted: compact, evidence } = reduceAudit(result);
    /* A finding that went away counts as fixed only where its own detectors were complete. */
    const provable = (row: Row): boolean => evidence[evidenceFamily(row.rule)] === true;
    const canResolve = Object.values(evidence).some(Boolean);
    const auditId = randomUUID();
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const { limits } = this;
    return this.#transaction(async client => {
      // Jobs are process-local. Serialize repository history across instances,
      // including cross-branch first-seen clocks and component retention.
      const lockKey = createHash('sha256').update(JSON.stringify(['code-audit-history-v1', ...base]))
        .digest().readBigInt64BE(0).toString();
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
      const latest = rowsOf(await client.query(
        `SELECT audit_id, audited_at, engine_version FROM nv_code_audits
          WHERE ${SCOPE_SQL} AND ref_name=$6
          ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC LIMIT 1`,
        [...base, compact.audit.ref_name]
      ))[0] || null;
      /*
       * A detector or identity upgrade starts a new comparison: what changed
       * across it is not evidence that every old finding was fixed and every
       * new one added. Clocks still carry across it -- a finding the upgrade
       * reports by the same identity is as old as it was -- so the branch's
       * latest audit is read either way, and compared only on the same engine.
       */
      // A delayed observation cannot prove that a finding seen later was fixed.
      const previous = latest && latest.engine_version === compact.audit.engine_version
        && ms(latest.audited_at) <= Date.parse(compact.audit.audited_at) ? latest : null;
      const audit = compact.audit;
      const rows = [...compact.findings, ...compact.waived];
      const ids = rows.map(row => row.finding_id);
      let diff: { readonly newIds: string[]; readonly resolved: number | null } | null = null;
      let before = new Map<string, Row>();
      if (latest) {
        before = new Map(rowsOf(await client.query(
          `SELECT f.finding_id, f.rule, f.severity, f.waived, COALESCE(f.first_seen_at, a.audited_at) AS first_seen
             FROM nv_code_audit_findings f
             JOIN nv_code_audits a ON a.audit_id=f.audit_id
            WHERE f.audit_id=$1 AND a.identity_key=$2`,
          [latest.audit_id, identity]
        )).map(row => [text(row.finding_id), row]));
      }
      if (previous) {
        const current = new Set(ids);
        const open = new Set(compact.findings.map(row => row.finding_id));
        diff = {
          newIds: [...open].filter(id => !before.has(id)),
          resolved: canResolve ? [...before.values()].filter(row => !row.waived && !current.has(text(row.finding_id)) && provable(row)).length : null
        };
      }
      /* The latest audit of every other branch, for what this branch has not shown before. */
      const elsewhere = ids.length ? new Map(rowsOf(await client.query(
        `WITH latest AS (
           SELECT DISTINCT ON (ref_name) audit_id, audited_at FROM nv_code_audits
            WHERE ${SCOPE_SQL} AND ref_name<>$6
            ORDER BY ref_name, audited_at DESC, recorded_at DESC, audit_id DESC)
         SELECT f.finding_id, min(COALESCE(f.first_seen_at, l.audited_at)) AS first_seen
           FROM latest l
           JOIN nv_code_audit_findings f ON f.audit_id=l.audit_id
          WHERE f.finding_id = ANY($7::text[])
          GROUP BY f.finding_id`,
        [...base, audit.ref_name, ids]
      )).map(row => [text(row.finding_id), ms(row.first_seen)])) : new Map<string, number>();
      const auditedAt = Date.parse(audit.audited_at);
      const firstSeen: Record<string, string> = {};
      for (const row of rows) {
        const candidates = [auditedAt];
        const known = before.get(row.finding_id);
        if (known) candidates.push(ms(known.first_seen));
        const shared = elsewhere.get(row.finding_id);
        if (shared !== undefined) candidates.push(shared);
        const earliest = Math.min(...candidates.filter(Number.isFinite));
        const at = new Date(earliest).toISOString();
        row.first_seen_at = at;
        firstSeen[row.finding_id] = at;
      }
      await client.query(
        `INSERT INTO nv_code_audits (
           audit_id, provider, authority, owner_login, repo_name, identity_key, ref_name, commit_sha, engine_version,
           audited_at, recorded_at, score, grade, cap_reason, category_ids, category_scores,
           critical_count, serious_count, warning_count, to_confirm_count, waived_count, exploited_count,
           risk_urgent, risk_high, risk_moderate, risk_low, files_read, files_eligible, coverage_complete,
           components_total, findings_total, findings_stored, new_count, resolved_count,
           watch_checked_at, watch_state, watch_checked, watch_total, watch_kev,
           sla_critical, sla_serious, sla_warning, policy_source, analysis_complete)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::smallint[],
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44)`,
        [auditId, where.provider, where.authority, where.owner, where.repo, identity, audit.ref_name, audit.commit_sha,
          audit.engine_version, audit.audited_at, new Date(now).toISOString(), audit.score, audit.grade, audit.cap_reason,
          audit.category_ids, audit.category_scores, audit.critical_count, audit.serious_count, audit.warning_count,
          audit.to_confirm_count, audit.waived_count, audit.exploited_count, audit.risk_urgent, audit.risk_high,
          audit.risk_moderate, audit.risk_low, audit.files_read, audit.files_eligible, audit.coverage_complete,
          audit.components_total, audit.findings_total, audit.findings_stored,
          diff && diff.resolved !== null ? diff.newIds.length : null, diff ? diff.resolved : null,
          audit.watch_checked_at, audit.watch_state, audit.watch_checked, audit.watch_total, audit.watch_kev,
          audit.sla_critical, audit.sla_serious, audit.sla_warning, audit.policy_source, audit.analysis_complete]
      );
      for (let start = 0; start < rows.length; start += limits.insertBatch) {
        await client.query(
          `INSERT INTO nv_code_audit_findings (audit_id, ${FINDING_COLUMNS})
           SELECT $1, ${FINDING_COLUMNS} FROM jsonb_to_recordset($2::jsonb) AS x(${FINDING_RECORD})
           ON CONFLICT (audit_id, finding_id) DO NOTHING`,
          [auditId, JSON.stringify(rows.slice(start, start + limits.insertBatch))]
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
      /* What went away, when it can be trusted to have been fixed. */
      let resolutions = 0;
      if (previous && previous.engine_version === audit.engine_version && canResolve) {
        const current = new Set(ids);
        const gone = [...before.values()].filter(row => !current.has(text(row.finding_id)) && oneOf(SEVERITIES, row.severity) !== null && provable(row))
          .slice(0, limits.maxResolutions)
          .map(row => ({
            finding_id: row.finding_id,
            rule: row.rule,
            severity: row.severity,
            first_seen_at: new Date(Math.min(ms(row.first_seen), auditedAt)).toISOString()
          }));
        if (gone.length) {
          const inserted = await client.query(
            `INSERT INTO nv_code_audit_resolutions
               (provider, authority, owner_login, repo_name, identity_key, ref_name, finding_id, rule, severity, first_seen_at, resolved_at)
             SELECT $1, $2, $3, $4, $5, $6, finding_id, rule, severity, first_seen_at, $7
               FROM jsonb_to_recordset($8::jsonb) AS x(finding_id text, rule text, severity text, first_seen_at timestamptz)
             ON CONFLICT DO NOTHING`,
            [...base, audit.ref_name, audit.audited_at, JSON.stringify(gone)]
          );
          resolutions = inserted.rowCount ?? 0;
        }
      }
      /* Only the latest audit of a branch is watched; the ones before it keep their history, not their components. */
      await client.query(
        `DELETE FROM nv_code_audit_components
          WHERE audit_id IN (
            SELECT audit_id FROM nv_code_audits WHERE ${SCOPE_SQL} AND ref_name=$6
             ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC OFFSET 1)`,
        [...base, audit.ref_name]
      );
      await client.query(
        `DELETE FROM nv_code_audits
          WHERE audit_id IN (
            SELECT audit_id FROM nv_code_audits WHERE ${SCOPE_SQL} AND ref_name=$6
             ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC OFFSET $7)`,
        [...base, audit.ref_name, limits.keepPerBranch]
      );
      await client.query(
        `DELETE FROM nv_code_audits WHERE ${SCOPE_SQL} AND audited_at < $6`,
        [...base, new Date(now - limits.maxAgeMs).toISOString()]
      );
      await client.query(
        `DELETE FROM nv_code_audit_resolutions WHERE ${SCOPE_SQL} AND resolved_at < $6`,
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
        firstSeen,
        resolutions,
        stored: { findings: compact.findings.length, waived: compact.waived.length, components: compact.components.length }
      };
    }, { signal });
  }

  /* One branch's audits, newest first, and the other branches this identity has audited. */
  async list({ scope, identityKey, ref, limit = this.limits.listLimit }: ScopedRead & { readonly ref: unknown; readonly limit?: unknown }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const [audits, branches] = await Promise.all([
      this.pool.query(
        `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits
          WHERE ${SCOPE_SQL} AND ref_name=$6
          ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC LIMIT $7`,
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
      audits: rowsOf(audits).map(auditFromRow),
      branches: rowsOf(branches).map(row => ({ ref: text(row.ref_name), audits: Number(row.audits), lastAt: iso(row.last_at) }))
    };
  }

  /* One audit and what it found. Null when it is not this identity's, or no longer kept. */
  async read({ scope, identityKey, auditId }: ScopedRead & { readonly auditId: unknown }): Promise<KeptAuditRead | null> {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    if (!fits(SHAPE.uuid, auditId)) return null;
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const audit = rowsOf(await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits WHERE ${SCOPE_SQL} AND audit_id=$6`,
      [...base, auditId]
    ))[0];
    if (!audit) return null;
    const findings = await this.pool.query(
      `SELECT ${FINDING_COLUMNS.split(',').map(column => `f.${column.trim()}`).join(', ')}
         FROM nv_code_audit_findings f
         JOIN nv_code_audits a ON a.audit_id=f.audit_id
        WHERE f.audit_id=$1 AND a.identity_key=$2
        ORDER BY ${SEVERITY_ORDER_SQL}, f.risk_score DESC NULLS LAST, f.file_path NULLS LAST, f.line_number NULLS LAST, f.finding_id`,
      [auditId, identity]
    );
    return { audit: auditFromRow(audit), findings: rowsOf(findings).map(findingFromRow) };
  }

  /* The latest audit of a branch, with the components the watch checks and the alerts it has found. */
  async watched({ scope, identityKey, ref }: ScopedRead & { readonly ref: unknown }): Promise<WatchedAudit | null> {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    const row = rowsOf(await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits
        WHERE ${SCOPE_SQL} AND ref_name=$6
        ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC LIMIT 1`,
      [...base, requireRef(ref)]
    ))[0];
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
    return { audit: auditFromRow(row), components: rowsOf(components).map(componentFromRow), alerts };
  }

  async #alerts(client: Queryable, auditId: unknown, identity: string): Promise<KeptAlert[]> {
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
    return rowsOf(found).map(alertFromRow);
  }

  /*
   * The watch's answer for an audit. Alerts are kept by what they are about,
   * so the date one was first seen survives later checks; a check that
   * answered completely for one source also drops that source's alerts it no
   * longer finds (an advisory withdrawn). Unanswered or truncated sources
   * retain their alerts: silence is not evidence that anything went away.
   */
  async saveWatch({ scope, identityKey, auditId, outcome, now = Date.now() }: ScopedRead & { readonly auditId: unknown; readonly outcome: unknown; readonly now?: number }): Promise<KeptAlert[] | null> {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    if (!fits(SHAPE.uuid, auditId)) return null;
    const state = oneOf(WATCH_STATES, read(outcome, 'state'));
    if (!state) throw new CodeAuditHistoryError('The watch outcome is invalid', 'CODE_AUDIT_WATCH_INVALID', 500);
    const answer = fieldsOf(outcome);
    const at = new Date(now).toISOString();
    const rows: AlertRow[] = [];
    const keys = new Set<string>();
    const sources = isFields(answer.sources) ? answer.sources : null;
    const kevComplete = answer.kev === 'ok' || answer.kev === 'not-needed';
    const truncated = count(answer.truncated) > 0;
    /* Legacy callers must prove a complete answer from both sources before pruning. */
    const legacyComplete = !sources && state === 'ok' && kevComplete && count(answer.checked) === count(answer.total);
    const completeKinds: AlertKind[] = truncated ? [] : sources
      ? [...(sources.advisories === 'ok' && count(answer.checked) === count(answer.total) ? ['advisory' as const] : []),
        ...(sources.exploited === 'ok' && answer.kev === 'ok' ? ['exploited' as const] : [])]
      : legacyComplete ? [...ALERT_KINDS] : [];
    const exploitationAnswered = answer.kev === 'ok' && (!sources || sources.exploited === 'ok');
    const advisoriesAnswered = sources ? sources.advisories === 'ok' : legacyComplete;
    const effectiveState = state === 'ok' && (truncated || !kevComplete || count(answer.checked) < count(answer.total)
      || (sources && (sources.advisories !== 'ok' || !['ok', 'not-needed'].includes(String(sources.exploited))))) ? 'partial' : state;
    for (const alert of listOf(answer.alerts)) {
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
          count(answer.checked), count(answer.total), oneOf(WATCH_KEV, answer.kev)]
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
  async clear({ scope, identityKey }: ScopedRead): Promise<number> {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const base = [where.provider, where.authority, where.owner, where.repo, identity];
    return this.#transaction(async client => {
      const removed = await client.query(`DELETE FROM nv_code_audits WHERE ${SCOPE_SQL}`, base);
      /* The time to fix was measured from those audits; it goes with them. */
      await client.query(`DELETE FROM nv_code_audit_resolutions WHERE ${SCOPE_SQL}`, base);
      return removed.rowCount ?? 0;
    });
  }

  /*
   * The latest audit of a branch and every row it kept -- open and waived --
   * with the date each was first seen. What the merge gate and the clocks
   * read. Null when this identity has kept no audit of the branch.
   */
  async latest({ scope, identityKey, ref }: ScopedRead & { readonly ref: unknown }): Promise<KeptAuditRead | null> {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const row = rowsOf(await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM nv_code_audits
        WHERE ${SCOPE_SQL} AND ref_name=$6
        ORDER BY audited_at DESC, recorded_at DESC, audit_id DESC LIMIT 1`,
      [where.provider, where.authority, where.owner, where.repo, identity, requireRef(ref)]
    ))[0];
    if (!row) return null;
    const findings = await this.pool.query(
      `SELECT ${FINDING_COLUMNS.split(',').map(column => `f.${column.trim()}`).join(', ')}
         FROM nv_code_audit_findings f
         JOIN nv_code_audits a ON a.audit_id=f.audit_id
        WHERE f.audit_id=$1 AND a.identity_key=$2
        ORDER BY ${SEVERITY_ORDER_SQL}, f.finding_id`,
      [row.audit_id, identity]
    );
    return { audit: auditFromRow(row), findings: rowsOf(findings).map(findingFromRow) };
  }

  /*
   * Where a branch stands against its clocks, and how long fixing has taken.
   * The open findings are the latest audit's, less what a decision in force
   * covers (`isTriaged`, from the team's decisions); time to fix is every
   * resolution of the branch in the window, by severity, as a median and a
   * mean in days.
   */
  async metrics({ scope, identityKey, ref, isTriaged = () => false, now = Date.now() }: ScopedRead & { readonly ref: unknown; readonly isTriaged?: (finding: KeptFinding) => boolean; readonly now?: number }) {
    const where = requireScope(scope);
    const identity = requireIdentity(identityKey);
    const branch = requireRef(ref);
    const latest = await this.latest({ scope: where, identityKey: identity, ref: branch });
    const windowDays = this.limits.mttrWindowDays;
    const since = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const resolved = await this.pool.query(
      `SELECT severity, count(*)::integer AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - first_seen_at)) AS median_s,
              avg(extract(epoch FROM resolved_at - first_seen_at)) AS mean_s
         FROM nv_code_audit_resolutions
        WHERE ${SCOPE_SQL} AND ref_name=$6 AND resolved_at >= $7
        GROUP BY ROLLUP (severity)`,
      [where.provider, where.authority, where.owner, where.repo, identity, branch, since]
    );
    const days = (seconds: unknown): number | null => (seconds === null || seconds === undefined ? null : Math.round((Number(seconds) / 86400) * 10) / 10);
    const none = (): TimeToFix => ({ count: 0, medianDays: null, meanDays: null });
    const mttr: Mttr = { windowDays, all: none(), critical: none(), serious: none(), warning: none() };
    for (const row of rowsOf(resolved)) {
      const entry = { count: Number(row.n), medianDays: days(row.median_s), meanDays: days(row.mean_s) };
      const severity = oneOf(SEVERITIES, row.severity);
      if (row.severity === null) mttr.all = entry;
      else if (severity) mttr[severity] = entry;
    }
    if (!latest) return { audit: null, sla: null, open: null, oldest: null, mttr };
    const sla = slaOf(latest.audit) || DEFAULT_SLA;
    const bySeverity: Record<HistorySeverity, OpenCounts> = {
      critical: { open: 0, overdue: 0, dueSoon: 0 }, serious: { open: 0, overdue: 0, dueSoon: 0 }, warning: { open: 0, overdue: 0, dueSoon: 0 }
    };
    const open = { total: 0, overdue: 0, dueSoon: 0, onTrack: 0, unclocked: 0, bySeverity };
    let oldest: { days: number; findingId: string; rule: string; severity: HistorySeverity } | null = null;
    for (const finding of latest.findings) {
      if (finding.waived && finding.waived !== 'triage') continue;
      if (isTriaged(finding)) continue;
      const clock = clockOf({ severity: finding.severity, exploited: finding.exploited && finding.rule !== 'DEP-005' && productionTier(finding.reach) },
        { firstSeenAt: finding.firstSeenAt, sla, now });
      open.total += 1;
      bySeverity[finding.severity].open += 1;
      if (!clock) { open.unclocked += 1; continue; }
      if (clock.state === 'overdue') { open.overdue += 1; bySeverity[finding.severity].overdue += 1; }
      else if (clock.state === 'due-soon') { open.dueSoon += 1; bySeverity[finding.severity].dueSoon += 1; }
      else open.onTrack += 1;
      const age = Math.floor((now - Date.parse(String(finding.firstSeenAt))) / (24 * 60 * 60 * 1000));
      if (!oldest || age > oldest.days) oldest = { days: age, findingId: finding.id, rule: finding.rule, severity: finding.severity };
    }
    return {
      audit: { id: latest.audit.id, auditedAt: latest.audit.auditedAt, commitSha: latest.audit.commitSha },
      sla: { ...sla, source: latest.audit.sla ? latest.audit.sla.source : 'default' },
      open,
      oldest,
      mttr
    };
  }

  /* Every repository this identity has audited, read together for the Overview (audit-workspace-reads.ts). */
  workspace(input: WorkspaceInput) {
    return readWorkspace(this.pool, this.limits, input);
  }

  /* The findings inbox over the same latest audits (audit-workspace-reads.ts). */
  workspaceFindings(input: WorkspaceFindingsInput) {
    return readWorkspaceFindings(this.pool, input);
  }
}
