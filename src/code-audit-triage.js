'use strict';

/*
 * What a team decided about its audit findings, and what an audit of a pull
 * request's head says about merging it.
 *
 * Triage is a decision about one finding of one repository, shared by its
 * collaborators: the finding is a false positive, or a risk the team accepts
 * until a date. The reason is chosen from a fixed list rather than written,
 * because a free-text note is where a line of the repository would end up
 * stored; who decided and when are recorded beside it, and every decision
 * and every reopening is kept as an event, so a reviewer can always read who
 * accepted what, for how long, and who took it back.
 *
 * A decision is laid over each audit (`applyTriage`): the finding leaves the
 * findings and joins the waived ones, listed with its decision, and the
 * grade, the fix-first list and the ledger counts are worked out again from
 * what is left -- the same functions the engine used, so a triaged audit
 * reads exactly as one that never reported the finding. An accepted risk
 * whose date has passed is open again, and says so.
 *
 * The merge gate (`evaluateMergeGate`) reads the latest audit the person
 * merging kept of the pull request's head branch and of its base: whether
 * it is of the commit being merged, and what is still open there after
 * triage. It answers with plain attributes -- a state, a grade, a list of
 * reasons -- that a governance policy rule on `pull.merge` can name in its
 * conditions. The gate decides nothing itself; the active policy does.
 */

const crypto = require('crypto');
const { score, priorities, LEDGER } = require('./code-audit');
const { TIERS } = require('./uranus-reach');
const { clockOf, DEFAULT_SLA } = require('./code-audit-policy');
const { evaluatePolicyDocument } = require('./governance-simulation');

const DISPOSITIONS = Object.freeze(['accepted-risk', 'false-positive']);
const FALSE_POSITIVE_REASONS = Object.freeze(['not-reachable', 'validated', 'test-code', 'not-sensitive', 'misread']);
const ACCEPTED_RISK_REASONS = Object.freeze(['compensating-control', 'low-impact', 'fix-scheduled', 'no-fix-available', 'third-party']);
const REASONS = Object.freeze({ 'false-positive': FALSE_POSITIVE_REASONS, 'accepted-risk': ACCEPTED_RISK_REASONS });
const EVENTS = Object.freeze(['decided', 'reopened']);

/* The words the page shows for each choice: this server's words, sent with the decisions so the page never keeps its own copy. */
const VOCABULARY = Object.freeze({
  dispositions: Object.freeze([
    Object.freeze({ id: 'false-positive', label: 'False positive', hint: 'The finding is wrong about this code.' }),
    Object.freeze({ id: 'accepted-risk', label: 'Accept the risk', hint: 'The finding is right, and the team accepts it until a date.' })
  ]),
  reasons: Object.freeze([
    Object.freeze({ id: 'not-reachable', disposition: 'false-positive', label: 'Request input never reaches it' }),
    Object.freeze({ id: 'validated', disposition: 'false-positive', label: 'The value is checked before it is used' }),
    Object.freeze({ id: 'test-code', disposition: 'false-positive', label: 'Test, example or fixture code' }),
    Object.freeze({ id: 'not-sensitive', disposition: 'false-positive', label: 'Not a secret or sensitive value' }),
    Object.freeze({ id: 'misread', disposition: 'false-positive', label: 'The engine misread the code' }),
    Object.freeze({ id: 'compensating-control', disposition: 'accepted-risk', label: 'A control elsewhere covers it' }),
    Object.freeze({ id: 'low-impact', disposition: 'accepted-risk', label: 'The impact is low here' }),
    Object.freeze({ id: 'fix-scheduled', disposition: 'accepted-risk', label: 'A fix is scheduled' }),
    Object.freeze({ id: 'no-fix-available', disposition: 'accepted-risk', label: 'No fix is available yet' }),
    Object.freeze({ id: 'third-party', disposition: 'accepted-risk', label: 'Vendored or upstream code' })
  ]),
  /* How long a risk may be accepted for: the page offers the choices; anything in the bounds is taken. */
  acceptDays: Object.freeze({ min: 7, max: 365, choices: Object.freeze([30, 90, 180]), default: 90 })
});

/* The reasons a merge gate can give; a policy names the ones it acts on. */
const GATE_REASONS = Object.freeze(['critical', 'serious', 'exploited', 'secret', 'overdue', 'introduced']);
const GATE_STATES = Object.freeze(['current', 'stale', 'missing', 'unavailable']);

const LIMITS = Object.freeze({
  maxDecisions: 5000,
  eventsPerFinding: 50,
  /* Events, and accepted risks that lapsed, are kept this long. */
  keepMs: 400 * 24 * 60 * 60 * 1000
});

const SHAPE = Object.freeze({
  findingId: /^[0-9a-f]{24}$/,
  rule: /^[A-Z]{2,4}-[0-9]{3}$/,
  actor: /^(alpha:[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,254})$/,
  identity: /^[0-9a-f]{64}$/
});

class CodeAuditTriageError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CodeAuditTriageError';
    this.code = code;
    this.status = status;
  }
}

const fits = (pattern, value) => typeof value === 'string' && pattern.test(value);
const iso = value => (value ? new Date(value).toISOString() : null);

function requireScope(scope) {
  const source = scope && typeof scope === 'object' ? scope : {};
  const text = (value, label) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length > 255) throw new CodeAuditTriageError(`${label} is required`, 'CODE_AUDIT_SCOPE_INVALID', 500);
    return trimmed;
  };
  return {
    provider: text(source.provider, 'Triage provider'),
    authority: text(source.authority, 'Triage authority'),
    owner: text(source.owner, 'Triage owner'),
    repo: text(source.repo, 'Triage repository')
  };
}

function requireFinding(findingId, rule) {
  if (!fits(SHAPE.findingId, findingId)) throw new CodeAuditTriageError('That is not a finding of an audit', 'CODE_AUDIT_FINDING_INVALID');
  if (!fits(SHAPE.rule, rule)) throw new CodeAuditTriageError('A decision names the rule of the finding it is about', 'CODE_AUDIT_RULE_INVALID');
}

function requireActor(actor, actorKey) {
  if (!fits(SHAPE.actor, actor) || !fits(SHAPE.identity, actorKey)) {
    throw new CodeAuditTriageError('The person deciding could not be identified', 'CODE_AUDIT_ACTOR_INVALID', 500);
  }
}

/*
 * A decision as asked for, checked against the vocabulary. The days are
 * asked only of an accepted risk; a false positive is not revisited.
 */
function normalizeDecision(input = {}) {
  const disposition = DISPOSITIONS.includes(input.disposition) ? input.disposition : null;
  if (!disposition) throw new CodeAuditTriageError('Choose false positive or accept the risk', 'CODE_AUDIT_DISPOSITION_INVALID');
  const reason = typeof input.reason === 'string' && REASONS[disposition].includes(input.reason) ? input.reason : null;
  if (!reason) throw new CodeAuditTriageError('Choose one of the listed reasons', 'CODE_AUDIT_REASON_INVALID');
  let days = null;
  if (disposition === 'accepted-risk') {
    /* A whole number, as the page sends it: "30" is a string somebody typed, not a choice from the list. */
    days = input.expiresInDays;
    const { min, max } = VOCABULARY.acceptDays;
    if (!Number.isInteger(days) || days < min || days > max) {
      throw new CodeAuditTriageError(`A risk is accepted for ${min} to ${max} days`, 'CODE_AUDIT_EXPIRY_INVALID');
    }
  }
  return { disposition, reason, days };
}

/* A decision still in force: a false positive always is; an accepted risk until its date. */
function inForce(decision, now = Date.now()) {
  if (!decision) return false;
  if (decision.disposition === 'false-positive') return true;
  const until = Date.parse(decision.expiresAt);
  return Number.isFinite(until) && until > now;
}

function decisionFromRow(row) {
  return Object.freeze({
    findingId: row.finding_id,
    rule: row.rule,
    disposition: row.disposition,
    reason: row.reason,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    expiresAt: iso(row.expires_at)
  });
}

function eventFromRow(row) {
  return Object.freeze({
    id: row.event_id,
    findingId: row.finding_id,
    rule: row.rule,
    event: row.event,
    disposition: row.disposition || null,
    reason: row.reason || null,
    expiresAt: iso(row.expires_at),
    actor: row.actor,
    at: iso(row.occurred_at)
  });
}

const DECISION_COLUMNS = 'finding_id, rule, disposition, reason, decided_by, decided_at, expires_at';
const EVENT_COLUMNS = 'event_id, finding_id, rule, event, disposition, reason, expires_at, actor, occurred_at';
const SCOPE_SQL = 'provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4';

class CodeAuditTriage {
  constructor(options) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('CodeAuditTriage requires a pg-compatible pool');
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

  /* Every decision of a repository, the lapsed ones included: the page says when an acceptance ran out. */
  async list({ scope }) {
    const where = requireScope(scope);
    const found = await this.pool.query(
      `SELECT ${DECISION_COLUMNS} FROM nv_code_audit_triage
        WHERE ${SCOPE_SQL}
        ORDER BY decided_at DESC, finding_id
        LIMIT $5`,
      [where.provider, where.authority, where.owner, where.repo, this.limits.maxDecisions]
    );
    return found.rows.map(decisionFromRow);
  }

  /* The decisions as a map, for laying over an audit. */
  async decisions({ scope }) {
    return new Map((await this.list({ scope })).map(decision => [decision.findingId, decision]));
  }

  /*
   * Records a decision, replacing any earlier one for the same finding, and
   * the event that says so. A decision about a finding of a different rule
   * under the same id cannot happen -- the id is derived from the rule -- and
   * is refused rather than trusted if it ever does.
   */
  async decide({ scope, findingId, rule, input, actor, actorKey, now = Date.now() }) {
    const where = requireScope(scope);
    requireFinding(findingId, rule);
    requireActor(actor, actorKey);
    const { disposition, reason, days } = normalizeDecision(input);
    const at = new Date(now);
    const expiresAt = days ? new Date(now + days * 24 * 60 * 60 * 1000) : null;
    const base = [where.provider, where.authority, where.owner, where.repo];
    return this.#transaction(async client => {
      const existing = (await client.query(
        `SELECT rule FROM nv_code_audit_triage WHERE ${SCOPE_SQL} AND finding_id=$5`,
        [...base, findingId]
      )).rows[0];
      if (existing && existing.rule !== rule) throw new CodeAuditTriageError('That finding belongs to a different rule', 'CODE_AUDIT_RULE_MISMATCH', 409);
      if (!existing) {
        const counted = await client.query(`SELECT count(*)::integer AS n FROM nv_code_audit_triage WHERE ${SCOPE_SQL}`, base);
        if (Number(counted.rows[0].n) >= this.limits.maxDecisions) {
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
      return decisionFromRow(saved.rows[0]);
    });
  }

  /* Takes a decision back. Returns the decision that was removed, or null when there was none. */
  async reopen({ scope, findingId, actor, actorKey, now = Date.now() }) {
    const where = requireScope(scope);
    if (!fits(SHAPE.findingId, findingId)) throw new CodeAuditTriageError('That is not a finding of an audit', 'CODE_AUDIT_FINDING_INVALID');
    requireActor(actor, actorKey);
    return this.#transaction(async client => {
      const removed = await client.query(
        `DELETE FROM nv_code_audit_triage WHERE ${SCOPE_SQL} AND finding_id=$5
         RETURNING ${DECISION_COLUMNS}`,
        [where.provider, where.authority, where.owner, where.repo, findingId]
      );
      const row = removed.rows[0];
      if (!row) return null;
      await this.#event(client, where, { findingId, rule: row.rule, event: 'reopened', actor, actorKey, at: new Date(now) });
      return decisionFromRow(row);
    });
  }

  async #event(client, where, { findingId, rule, event, disposition = null, reason = null, expiresAt = null, actor, actorKey, at }) {
    await client.query(
      `INSERT INTO nv_code_audit_triage_events
         (event_id, provider, authority, owner_login, repo_name, finding_id, rule, event, disposition, reason, expires_at, actor, actor_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [crypto.randomUUID(), where.provider, where.authority, where.owner, where.repo, findingId, rule, event, disposition, reason,
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
  async events({ scope, findingId, limit = this.limits.eventsPerFinding }) {
    const where = requireScope(scope);
    if (!fits(SHAPE.findingId, findingId)) return [];
    const found = await this.pool.query(
      `SELECT ${EVENT_COLUMNS} FROM nv_code_audit_triage_events
        WHERE ${SCOPE_SQL} AND finding_id=$5
        ORDER BY occurred_at DESC, event_id
        LIMIT $6`,
      [where.provider, where.authority, where.owner, where.repo, findingId, Math.max(1, Math.min(this.limits.eventsPerFinding, Number(limit) || this.limits.eventsPerFinding))]
    );
    return found.rows.map(eventFromRow);
  }
}

/* The decisions of a repository, counted: what the remediation card says about them. */
const EXPIRING_MS = 14 * 24 * 60 * 60 * 1000;
function summarizeDecisions(decisions, now = Date.now()) {
  const counts = { falsePositive: 0, acceptedRisk: 0, expiringSoon: 0, lapsed: 0 };
  for (const decision of decisions instanceof Map ? decisions.values() : []) {
    if (decision.disposition === 'false-positive') counts.falsePositive += 1;
    else if (inForce(decision, now)) {
      counts.acceptedRisk += 1;
      if (Date.parse(decision.expiresAt) <= now + EXPIRING_MS) counts.expiringSoon += 1;
    } else counts.lapsed += 1;
  }
  return counts;
}

/* ---- Laid over an audit ------------------------------------------------------ */

/* A reason's words, for a report read away from the page. */
const REASON_LABEL = new Map(VOCABULARY.reasons.map(reason => [reason.id, reason.label]));

/* The decision as an audit result carries it: no identity key, nothing but the words and the times. */
function publicDecision(decision) {
  return Object.freeze({
    disposition: decision.disposition,
    reason: decision.reason,
    reasonLabel: REASON_LABEL.get(decision.reason) || null,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    expiresAt: decision.expiresAt || null
  });
}

/* The ledger's counts of confirmed findings and leads, again, from the findings that are left. */
function recount(ledger, findings) {
  if (!Array.isArray(ledger)) return ledger;
  const rulesOf = new Map(LEDGER.map(entry => [entry.id, entry.rules]));
  return ledger.map(entry => {
    const rules = rulesOf.get(entry.id);
    if (!rules) return entry;
    const under = findings.filter(finding => rules.includes(finding.rule));
    return {
      ...entry,
      confirmed: under.filter(finding => finding.verdict !== 'needs-validation').length,
      toConfirm: under.filter(finding => finding.verdict === 'needs-validation').length
    };
  });
}

function applyTriage(result, decisions, { now = Date.now() } = {}) {
  if (!result || !Array.isArray(result.findings)) return result;
  const byId = decisions instanceof Map ? decisions : new Map();
  const open = [];
  const triaged = [];
  let lapsed = 0;
  for (const finding of result.findings) {
    const decision = byId.get(finding.id);
    /* A decision is about one rule at one place; the same id under another rule would be a different finding. */
    if (!decision || decision.rule !== finding.rule) { open.push(finding); continue; }
    if (inForce(decision, now)) triaged.push({ ...finding, suppression: Object.freeze({ triage: publicDecision(decision) }) });
    else {
      lapsed += 1;
      open.push({ ...finding, triage: Object.freeze({ ...publicDecision(decision), lapsed: true }) });
    }
  }
  const summary = Object.freeze({ triaged: triaged.length, lapsed, decisions: byId.size });
  if (!triaged.length) return { ...result, findings: open, triage: summary };
  return {
    ...result,
    findings: open,
    suppressed: [...(Array.isArray(result.suppressed) ? result.suppressed : []), ...triaged],
    ...score(open),
    priorities: priorities(open),
    ledger: recount(result.ledger, open),
    triage: summary
  };
}

/*
 * The grade and the fix-first list for a set of findings the page already
 * holds, worked out by the engine's own functions: after a decision the page
 * sends what is left and shows what comes back, rather than keeping a second
 * copy of the scoring in the browser. Only what the scoring reads is taken.
 */
const SCORE_LIMIT = 5000;
function rescore(input) {
  const list = Array.isArray(input) ? input.slice(0, SCORE_LIMIT) : [];
  const findings = [];
  for (const item of list) {
    if (!item || !fits(SHAPE.findingId, item.id) || !fits(SHAPE.rule, item.rule)) continue;
    if (!['critical', 'serious', 'warning'].includes(item.severity) || typeof item.category !== 'string' || !/^[a-z][a-z-]{1,31}$/.test(item.category)) continue;
    findings.push({
      id: item.id,
      rule: item.rule,
      category: item.category,
      severity: item.severity,
      verdict: item.verdict === 'needs-validation' ? 'needs-validation' : 'confirmed',
      reach: item.open === true ? { auth: 'open' } : null,
      detail: {
        intel: { exploited: item.exploited === true },
        usage: typeof item.tier === 'string' && Object.prototype.hasOwnProperty.call(TIERS, item.tier) ? { tier: item.tier } : null,
        risk: Number.isFinite(item.risk) ? { score: Math.max(0, Math.min(100, item.risk)) } : null,
        direct: item.direct === true
      }
    });
  }
  const scored = score(findings);
  const ledger = LEDGER.map(entry => {
    const under = findings.filter(finding => entry.rules.includes(finding.rule));
    return { id: entry.id, confirmed: under.filter(confirmed).length, toConfirm: under.length - under.filter(confirmed).length };
  });
  return { score: scored.score, grade: scored.grade, capped: scored.capped, capReason: scored.capReason, categories: scored.categories, priorities: priorities(findings), ledger };
}

/* ---- The merge gate ---------------------------------------------------------- */

const production = row => Boolean(row.reach && TIERS[row.reach] && TIERS[row.reach].production);
const confirmed = row => row.verdict !== 'needs-validation';

/*
 * What is open in a kept audit now: what it found open, and what it found
 * waived by a decision that has since been taken back or has lapsed -- but
 * not what the code itself waived, which is part of the commit -- less what
 * a decision in force covers today.
 */
function openRows(rows, decisions, now) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    if (row.waived && row.waived !== 'triage') return false;
    const decision = decisions instanceof Map ? decisions.get(row.id) : null;
    return !(decision && decision.rule === row.rule && inForce(decision, now));
  });
}

/*
 * `head` and `base` are kept audits with their finding rows, or null when
 * the person merging has none of that branch. The clock is the base's: a
 * pull request cannot lengthen its own deadline by changing the policy file
 * it is asking to merge.
 */
function evaluateMergeGate({ headSha, head, base, decisions, now = Date.now() } = {}) {
  if (!head || !head.audit) return gateResult('missing', { base: base && base.audit ? 'audited' : 'missing' });
  const audit = head.audit;
  if (!headSha || audit.commitSha !== headSha) {
    return gateResult('stale', { grade: audit.grade, auditedAt: audit.auditedAt, commitSha: audit.commitSha, base: base && base.audit ? 'audited' : 'missing' });
  }
  /* A matching commit proves freshness, not that the evidence needed to judge it was available. */
  if (audit.analysisComplete !== true
    || (audit.files && audit.files.complete !== true)
    || (audit.findings && audit.findings.total > audit.findings.stored)
    || (audit.watch && ['partial', 'unavailable'].includes(audit.watch.state))) {
    return gateResult('unavailable', {
      grade: audit.grade, auditedAt: audit.auditedAt, commitSha: audit.commitSha,
      base: base && base.audit ? 'audited' : 'missing', complete: audit.files ? audit.files.complete === true : null
    });
  }
  const sla = (base && base.audit && base.audit.sla) || DEFAULT_SLA;
  const open = openRows(head.findings, decisions, now);
  const counts = { critical: 0, serious: 0, warning: 0 };
  for (const row of open) if (counts[row.severity] !== undefined) counts[row.severity] += 1;
  const exploitedRows = open.filter(row => row.exploited && row.rule !== 'DEP-005' && production(row));
  const overdue = open.filter(row => {
    const clock = clockOf({ severity: row.severity, exploited: row.exploited && row.rule !== 'DEP-005' && production(row) }, { firstSeenAt: row.firstSeenAt, sla, now });
    return clock && clock.state === 'overdue';
  });
  let introduced = null;
  if (base && base.audit) {
    const before = new Set((base.findings || []).map(row => row.id));
    introduced = open.filter(row => confirmed(row) && (row.severity === 'critical' || row.severity === 'serious') && !before.has(row.id)).length;
  }
  const blocking = [];
  if (open.some(row => confirmed(row) && row.severity === 'critical')) blocking.push('critical');
  if (open.some(row => confirmed(row) && row.severity === 'serious')) blocking.push('serious');
  if (exploitedRows.length) blocking.push('exploited');
  if (open.some(row => confirmed(row) && row.category === 'secrets')) blocking.push('secret');
  if (overdue.length) blocking.push('overdue');
  if (introduced) blocking.push('introduced');
  return gateResult('current', {
    grade: audit.grade,
    auditedAt: audit.auditedAt,
    commitSha: audit.commitSha,
    blocking,
    open: counts,
    overdue: overdue.length,
    exploited: exploitedRows.length,
    introduced,
    base: base && base.audit ? 'audited' : 'missing',
    complete: audit.files ? audit.files.complete === true : null,
    sla: { ...sla, source: base && base.audit && base.audit.sla ? 'base' : 'default' }
  });
}

function gateResult(state, facts = {}) {
  return Object.freeze({
    state,
    grade: facts.grade || null,
    auditedAt: facts.auditedAt || null,
    commitSha: facts.commitSha || null,
    blocking: Object.freeze([...(facts.blocking || [])]),
    open: Object.freeze(facts.open || { critical: 0, serious: 0, warning: 0 }),
    overdue: facts.overdue || 0,
    exploited: facts.exploited || 0,
    introduced: facts.introduced === undefined ? null : facts.introduced,
    base: facts.base || 'missing',
    complete: facts.complete === undefined ? null : facts.complete,
    sla: facts.sla ? Object.freeze(facts.sla) : null
  });
}

/*
 * What the active policies would make of a merge with these attributes,
 * worked out the way the gateway works them out, for the page to show before
 * anybody presses Merge. Only the policies with a rule that matches are
 * listed, each with its mode, its effect and the rules that matched.
 */
function previewMergePolicies(activePolicies, attributes) {
  const out = [];
  for (const policy of Array.isArray(activePolicies) ? activePolicies : []) {
    const document = policy && policy.document;
    if (!document) continue;
    const evaluation = evaluatePolicyDocument(document, [{ id: 'merge-preview', action: 'pull.merge', attributes }]);
    const result = evaluation.results[0];
    if (!result || !result.matchedRuleIds.length) continue;
    const rules = (Array.isArray(document.rules) ? document.rules : []).filter(rule => result.matchedRuleIds.includes(rule.id));
    out.push({
      policyKey: policy.policyKey,
      mode: (document.enforcement && document.enforcement.mode) || 'observe',
      effect: result.effect,
      rules: rules.map(rule => ({
        id: rule.id,
        effect: rule.effect,
        description: typeof rule.description === 'string' ? rule.description.slice(0, 300) : null,
        audit: Boolean(rule.conditions && rule.conditions.audit)
      }))
    });
  }
  return out;
}

/* The facts a merge carries for its policy: the branches, and the gate's attributes. */
function mergeAttributes(pull, gate) {
  return { branch: pull.base, head: pull.head, audit: gateAttributes(gate) };
}

/* The gate when there is no history to read it from: no audit can be found, so none is claimed. */
function unavailableGate() {
  return gateResult('unavailable');
}

/* What a policy sees: the gate's attributes, without the times and the commit, which no rule should key on. */
function gateAttributes(gate) {
  return {
    state: gate.state,
    grade: gate.grade,
    blocking: [...gate.blocking],
    base: gate.base,
    open: { ...gate.open },
    overdue: gate.overdue,
    introduced: gate.introduced
  };
}

module.exports = Object.freeze({
  CodeAuditTriage,
  CodeAuditTriageError,
  DISPOSITIONS,
  REASONS,
  EVENTS,
  VOCABULARY,
  GATE_REASONS,
  GATE_STATES,
  LIMITS,
  SHAPE,
  normalizeDecision,
  inForce,
  applyTriage,
  rescore,
  openRows,
  evaluateMergeGate,
  unavailableGate,
  gateAttributes,
  mergeAttributes,
  previewMergePolicies,
  summarizeDecisions
});
