/*
 * Where a team's triage decisions are kept.
 *
 * A decision is about one finding of one repository, shared by its
 * collaborators (domain/audit-triage.ts says what one may say). Who decided
 * and when are recorded beside it, and every decision and every reopening is
 * kept as an event, so a reviewer can always read who accepted what, for how
 * long, and who took it back. Events, and acceptances that lapsed, are kept
 * for the keeping window and no longer.
 */
import { randomUUID } from 'node:crypto';
import { fieldsOf } from '../../../platform/values/fields.ts';
import type { PoolClient, QueryOutcome, Queryable, TransactionalPool } from '../../../platform/persistence/queryable.ts';
import {
  CodeAuditTriageError, DISPOSITIONS, EVENTS, SHAPE, fits, normalizeDecision, type Decision, type Disposition, type TriageEvent
} from '../domain/audit-triage.ts';
import { iso, stored, text, textOrNull } from './audit-history-records.ts';

export const LIMITS = Object.freeze({
  maxDecisions: 5000,
  eventsPerFinding: 50,
  /* Events, and accepted risks that lapsed, are kept this long. */
  keepMs: 400 * 24 * 60 * 60 * 1000
});
export type TriageLimits = typeof LIMITS;

type Row = Readonly<Record<string, unknown>>;
const rowsOf = (outcome: QueryOutcome): readonly Row[] => outcome.rows ?? [];

/* A repository at a provider, as every decision is keyed. */
interface TriageScope {
  readonly provider: string;
  readonly authority: string;
  readonly owner: string;
  readonly repo: string;
}

function requireScope(scope: unknown): TriageScope {
  const source = fieldsOf(scope);
  const label = (value: unknown, name: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length > 255) throw new CodeAuditTriageError(`${name} is required`, 'CODE_AUDIT_SCOPE_INVALID', 500);
    return trimmed;
  };
  return {
    provider: label(source.provider, 'Triage provider'),
    authority: label(source.authority, 'Triage authority'),
    owner: label(source.owner, 'Triage owner'),
    repo: label(source.repo, 'Triage repository')
  };
}

function requireFinding(findingId: unknown, rule: unknown): asserts findingId is string {
  if (!fits(SHAPE.findingId, findingId)) throw new CodeAuditTriageError('That is not a finding of an audit', 'CODE_AUDIT_FINDING_INVALID');
  if (!fits(SHAPE.rule, rule)) throw new CodeAuditTriageError('A decision names the rule of the finding it is about', 'CODE_AUDIT_RULE_INVALID');
}

function requireActor(actor: unknown, actorKey: unknown): void {
  if (!fits(SHAPE.actor, actor) || !fits(SHAPE.identity, actorKey)) {
    throw new CodeAuditTriageError('The person deciding could not be identified', 'CODE_AUDIT_ACTOR_INVALID', 500);
  }
}

function decisionFromRow(row: Row): Decision {
  return Object.freeze({
    findingId: text(row.finding_id),
    rule: text(row.rule),
    disposition: stored<Disposition>(DISPOSITIONS, row.disposition, 'disposition'),
    reason: text(row.reason),
    decidedBy: text(row.decided_by),
    decidedAt: iso(row.decided_at),
    expiresAt: iso(row.expires_at)
  });
}

export interface DecisionEvent {
  readonly id: string;
  readonly findingId: string;
  readonly rule: string;
  readonly event: TriageEvent;
  readonly disposition: Disposition | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly actor: string;
  readonly at: string | null;
}

function eventFromRow(row: Row): DecisionEvent {
  return Object.freeze({
    id: text(row.event_id),
    findingId: text(row.finding_id),
    rule: text(row.rule),
    event: stored<TriageEvent>(EVENTS, row.event, 'event'),
    disposition: row.disposition ? stored<Disposition>(DISPOSITIONS, row.disposition, 'disposition') : null,
    reason: textOrNull(row.reason),
    expiresAt: iso(row.expires_at),
    actor: text(row.actor),
    at: iso(row.occurred_at)
  });
}

const DECISION_COLUMNS = 'finding_id, rule, disposition, reason, decided_by, decided_at, expires_at';
const EVENT_COLUMNS = 'event_id, finding_id, rule, event, disposition, reason, expires_at, actor, occurred_at';
const SCOPE_SQL = 'provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4';

interface EventInput {
  readonly findingId: string;
  readonly rule: unknown;
  readonly event: TriageEvent;
  readonly disposition?: Disposition | null;
  readonly reason?: string | null;
  readonly expiresAt?: Date | null;
  readonly actor: unknown;
  readonly actorKey: unknown;
  readonly at: Date;
}
interface Actor {
  readonly actor: unknown;
  readonly actorKey: unknown;
  readonly now?: number;
}

export class CodeAuditTriage {
  readonly pool: TransactionalPool;
  readonly limits: TriageLimits;

  constructor(options: { readonly pool?: TransactionalPool | null; readonly limits?: Partial<TriageLimits> | null }) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('CodeAuditTriage requires a pg-compatible pool');
    }
    this.pool = pool;
    this.limits = Object.freeze({ ...LIMITS, ...(options.limits || {}) });
  }

  async #transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

  /* Every decision of a repository, the lapsed ones included: the page says when an acceptance ran out. */
  async list({ scope }: { readonly scope: unknown }): Promise<Decision[]> {
    const where = requireScope(scope);
    const found = await this.pool.query(
      `SELECT ${DECISION_COLUMNS} FROM nv_code_audit_triage
        WHERE ${SCOPE_SQL}
        ORDER BY decided_at DESC, finding_id
        LIMIT $5`,
      [where.provider, where.authority, where.owner, where.repo, this.limits.maxDecisions]
    );
    return rowsOf(found).map(decisionFromRow);
  }

  /* The decisions as a map, for laying over an audit. */
  async decisions({ scope }: { readonly scope: unknown }): Promise<Map<string, Decision>> {
    return new Map((await this.list({ scope })).map(decision => [decision.findingId, decision]));
  }

  /*
   * Records a decision, replacing any earlier one for the same finding, and
   * the event that says so. A decision about a finding of a different rule
   * under the same id cannot happen -- the id is derived from the rule -- and
   * is refused rather than trusted if it ever does.
   */
  async decide({ scope, findingId, rule, input, actor, actorKey, now = Date.now() }: Actor & { readonly scope: unknown; readonly findingId: unknown; readonly rule: unknown; readonly input: unknown }): Promise<Decision> {
    const where = requireScope(scope);
    requireFinding(findingId, rule);
    requireActor(actor, actorKey);
    const { disposition, reason, days } = normalizeDecision(input);
    const at = new Date(now);
    const expiresAt = days ? new Date(now + days * 24 * 60 * 60 * 1000) : null;
    const base = [where.provider, where.authority, where.owner, where.repo];
    return this.#transaction(async client => {
      const existing = rowsOf(await client.query(
        `SELECT rule FROM nv_code_audit_triage WHERE ${SCOPE_SQL} AND finding_id=$5`,
        [...base, findingId]
      ))[0];
      if (existing && existing.rule !== rule) throw new CodeAuditTriageError('That finding belongs to a different rule', 'CODE_AUDIT_RULE_MISMATCH', 409);
      if (!existing) {
        const counted = rowsOf(await client.query(`SELECT count(*)::integer AS n FROM nv_code_audit_triage WHERE ${SCOPE_SQL}`, base))[0];
        if (Number(counted?.n) >= this.limits.maxDecisions) {
          throw new CodeAuditTriageError(`A repository keeps up to ${this.limits.maxDecisions} decisions; reopen some first`, 'CODE_AUDIT_TRIAGE_LIMIT', 409);
        }
      }
      const saved = await client.query(
        `INSERT INTO nv_code_audit_triage
           (provider, authority, owner_login, repo_name, finding_id, rule, disposition, reason, decided_by, decided_by_key, decided_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (provider, authority, owner_login, repo_name, finding_id) DO UPDATE SET
           disposition=EXCLUDED.disposition, reason=EXCLUDED.reason, decided_by=EXCLUDED.decided_by,
           decided_by_key=EXCLUDED.decided_by_key, decided_at=EXCLUDED.decided_at, expires_at=EXCLUDED.expires_at
         RETURNING ${DECISION_COLUMNS}`,
        [...base, findingId, rule, disposition, reason, actor, actorKey, at.toISOString(), expiresAt && expiresAt.toISOString()]
      );
      await this.#event(client, where, { findingId, rule, event: 'decided', disposition, reason, expiresAt, actor, actorKey, at });
      return decisionFromRow(rowsOf(saved)[0] ?? {});
    });
  }

  /* Takes a decision back. Returns the decision that was removed, or null when there was none. */
  async reopen({ scope, findingId, actor, actorKey, now = Date.now() }: Actor & { readonly scope: unknown; readonly findingId: unknown }): Promise<Decision | null> {
    const where = requireScope(scope);
    if (!fits(SHAPE.findingId, findingId)) throw new CodeAuditTriageError('That is not a finding of an audit', 'CODE_AUDIT_FINDING_INVALID');
    requireActor(actor, actorKey);
    return this.#transaction(async client => {
      const removed = await client.query(
        `DELETE FROM nv_code_audit_triage WHERE ${SCOPE_SQL} AND finding_id=$5
         RETURNING ${DECISION_COLUMNS}`,
        [where.provider, where.authority, where.owner, where.repo, findingId]
      );
      const row = rowsOf(removed)[0];
      if (!row) return null;
      await this.#event(client, where, { findingId, rule: row.rule, event: 'reopened', actor, actorKey, at: new Date(now) });
      return decisionFromRow(row);
    });
  }

  async #event(client: Queryable, where: TriageScope, { findingId, rule, event, disposition = null, reason = null, expiresAt = null, actor, actorKey, at }: EventInput): Promise<void> {
    await client.query(
      `INSERT INTO nv_code_audit_triage_events
         (event_id, provider, authority, owner_login, repo_name, finding_id, rule, event, disposition, reason, expires_at, actor, actor_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), where.provider, where.authority, where.owner, where.repo, findingId, rule, event, disposition, reason,
        expiresAt && expiresAt.toISOString(), actor, actorKey, at.toISOString()]
    );
    /* What is older than the keeping window goes: events, and acceptances that lapsed that long ago. */
    const cutoff = new Date(at.getTime() - this.limits.keepMs).toISOString();
    await client.query(
      `DELETE FROM nv_code_audit_triage_events WHERE ${SCOPE_SQL} AND occurred_at < $5`,
      [where.provider, where.authority, where.owner, where.repo, cutoff]
    );
    await client.query(
      `DELETE FROM nv_code_audit_triage WHERE ${SCOPE_SQL} AND expires_at < $5`,
      [where.provider, where.authority, where.owner, where.repo, cutoff]
    );
  }

  /* One finding's decisions and reopenings, newest first. */
  async events({ scope, findingId, limit = this.limits.eventsPerFinding }: { readonly scope: unknown; readonly findingId: unknown; readonly limit?: unknown }): Promise<DecisionEvent[]> {
    const where = requireScope(scope);
    if (!fits(SHAPE.findingId, findingId)) return [];
    const found = await this.pool.query(
      `SELECT ${EVENT_COLUMNS} FROM nv_code_audit_triage_events
        WHERE ${SCOPE_SQL} AND finding_id=$5
        ORDER BY occurred_at DESC, event_id
        LIMIT $6`,
      [where.provider, where.authority, where.owner, where.repo, findingId, Math.max(1, Math.min(this.limits.eventsPerFinding, Number(limit) || this.limits.eventsPerFinding))]
    );
    return rowsOf(found).map(eventFromRow);
  }
}
