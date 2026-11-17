/*
 * What a team decided about its audit findings, laid over an audit.
 *
 * Triage is a decision about one finding of one repository, shared by its
 * collaborators: the finding is a false positive, or a risk the team accepts
 * until a date. The reason is chosen from a fixed list rather than written,
 * because a free-text note is where a line of the repository would end up
 * stored; who decided and when are recorded beside it, and every decision
 * and every reopening is kept as an event (persistence/audit-triage-store.ts).
 *
 * A decision is laid over each audit (`applyTriage`): the finding leaves the
 * findings and joins the waived ones, listed with its decision, and the
 * grade, the fix-first list and the ledger counts are worked out again from
 * what is left -- the same functions the engine used, so a triaged audit
 * reads exactly as one that never reported the finding. An accepted risk
 * whose date has passed is open again, and says so.
 */
import { fieldsOf, listOf, read } from '../../../platform/values/fields.ts';
import { IDENTITY_KEY } from '../../../../../../packages/contracts/src/ids.ts';
import type { Severity } from './audit-catalog.ts';
import { LEDGER } from './audit-ledger.ts';
import { priorities, score, type ScoredFinding } from './code-audit.ts';
import { TIERS } from './uranus-reach.ts';

export const DISPOSITIONS = Object.freeze(['accepted-risk', 'false-positive'] as const);
export type Disposition = (typeof DISPOSITIONS)[number];
const FALSE_POSITIVE_REASONS = Object.freeze(['not-reachable', 'validated', 'test-code', 'not-sensitive', 'misread'] as const);
const ACCEPTED_RISK_REASONS = Object.freeze(['compensating-control', 'low-impact', 'fix-scheduled', 'no-fix-available', 'third-party'] as const);
export const REASONS: Readonly<Record<Disposition, readonly string[]>> = Object.freeze({ 'false-positive': FALSE_POSITIVE_REASONS, 'accepted-risk': ACCEPTED_RISK_REASONS });
export const EVENTS = Object.freeze(['decided', 'reopened'] as const);
export type TriageEvent = (typeof EVENTS)[number];

/* The words the page shows for each choice: this server's words, sent with the decisions so the page never keeps its own copy. */
export const VOCABULARY = Object.freeze({
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

export const SHAPE = Object.freeze({
  findingId: /^[0-9a-f]{24}$/,
  rule: /^[A-Z]{2,4}-[0-9]{3}$/,
  actor: /^(alpha:[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,254})$/,
  /* The ids contract's identity key. */
  identity: IDENTITY_KEY
});

export class CodeAuditTriageError extends Error {
  override readonly name = 'CodeAuditTriageError';
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const fits = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);

/* One decision as it is kept: about one finding under one rule, by one person, until a date or for good. */
export interface Decision {
  readonly findingId: string;
  readonly rule: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly decidedBy: string;
  readonly decidedAt: string | null;
  readonly expiresAt: string | null;
}
export interface NormalizedDecision {
  readonly disposition: Disposition;
  readonly reason: string;
  readonly days: number | null;
}

/*
 * A decision as asked for, checked against the vocabulary. The days are
 * asked only of an accepted risk; a false positive is not revisited.
 */
export function normalizeDecision(input: unknown = {}): NormalizedDecision {
  const asked = read(input, 'disposition');
  const disposition = DISPOSITIONS.find(item => item === asked) ?? null;
  if (!disposition) throw new CodeAuditTriageError('Choose false positive or accept the risk', 'CODE_AUDIT_DISPOSITION_INVALID');
  const given = read(input, 'reason');
  const reason = typeof given === 'string' && REASONS[disposition].includes(given) ? given : null;
  if (!reason) throw new CodeAuditTriageError('Choose one of the listed reasons', 'CODE_AUDIT_REASON_INVALID');
  let days: number | null = null;
  if (disposition === 'accepted-risk') {
    /* A whole number, as the page sends it: "30" is a string somebody typed, not a choice from the list. */
    const expiresInDays = read(input, 'expiresInDays');
    const { min, max } = VOCABULARY.acceptDays;
    if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays) || expiresInDays < min || expiresInDays > max) {
      throw new CodeAuditTriageError(`A risk is accepted for ${min} to ${max} days`, 'CODE_AUDIT_EXPIRY_INVALID');
    }
    days = expiresInDays;
  }
  return { disposition, reason, days };
}

/* A decision still in force: a false positive always is; an accepted risk until its date. */
export function inForce(decision: Pick<Decision, 'disposition' | 'expiresAt'> | null | undefined, now: number = Date.now()): boolean {
  if (!decision) return false;
  if (decision.disposition === 'false-positive') return true;
  const until = Date.parse(String(decision.expiresAt));
  return Number.isFinite(until) && until > now;
}

/* The decisions as the server holds them, keyed by finding id; anything else holds none. */
function decisionsOf(decisions: unknown): ReadonlyMap<unknown, Decision> | null {
  return decisions instanceof Map ? decisions : null;
}

/* The decisions of a repository, counted: what the remediation card says about them. */
const EXPIRING_MS = 14 * 24 * 60 * 60 * 1000;
export function summarizeDecisions(decisions: unknown, now: number = Date.now()): { falsePositive: number; acceptedRisk: number; expiringSoon: number; lapsed: number } {
  const counts = { falsePositive: 0, acceptedRisk: 0, expiringSoon: 0, lapsed: 0 };
  for (const decision of decisionsOf(decisions)?.values() ?? []) {
    if (decision.disposition === 'false-positive') counts.falsePositive += 1;
    else if (inForce(decision, now)) {
      counts.acceptedRisk += 1;
      if (Date.parse(String(decision.expiresAt)) <= now + EXPIRING_MS) counts.expiringSoon += 1;
    } else counts.lapsed += 1;
  }
  return counts;
}

/* ---- Laid over an audit ------------------------------------------------------ */

/* A reason's words, for a report read away from the page. */
const REASON_LABEL = new Map<string, string>(VOCABULARY.reasons.map(reason => [reason.id, reason.label]));

export interface PublicDecision {
  readonly disposition: Disposition;
  readonly reason: string;
  readonly reasonLabel: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string | null;
  readonly expiresAt: string | null;
}

/* The decision as an audit result carries it: no identity key, nothing but the words and the times. */
function publicDecision(decision: Decision): PublicDecision {
  return Object.freeze({
    disposition: decision.disposition,
    reason: decision.reason,
    reasonLabel: REASON_LABEL.get(decision.reason) || null,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    expiresAt: decision.expiresAt || null
  });
}

/* Whether a finding is a confirmed one or a lead to confirm. */
export const confirmed = (finding: { readonly verdict?: unknown }): boolean => finding.verdict !== 'needs-validation';

/* The ledger's counts of confirmed findings and leads, again, from the findings that are left. */
function recount(ledger: unknown, findings: readonly ScoredFinding[]): unknown {
  if (!Array.isArray(ledger)) return ledger;
  const rulesOf = new Map<unknown, readonly string[]>(LEDGER.map(entry => [entry.id, entry.rules]));
  return listOf(ledger).map(entry => {
    const rules = rulesOf.get(read(entry, 'id'));
    if (!rules) return entry;
    const under = findings.filter(finding => rules.includes(finding.rule));
    return {
      ...fieldsOf(entry),
      confirmed: under.filter(finding => finding.verdict !== 'needs-validation').length,
      toConfirm: under.filter(finding => finding.verdict === 'needs-validation').length
    };
  });
}

/* An audit result as triage reads it: its findings, what was already waived, and its ledger. */
export interface Triageable {
  readonly findings: readonly ScoredFinding[];
  readonly suppressed?: unknown;
  readonly ledger?: unknown;
}

export function applyTriage<R extends Triageable>(result: R, decisions: unknown, { now = Date.now() }: { readonly now?: number } = {}) {
  if (!result || !Array.isArray(result.findings)) return result;
  const byId = decisionsOf(decisions) ?? new Map<unknown, Decision>();
  const open: R['findings'][number][] = [];
  const triaged: unknown[] = [];
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
    suppressed: [...listOf(result.suppressed), ...triaged],
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
const SCORED_SEVERITIES: readonly Severity[] = Object.freeze(['critical', 'serious', 'warning']);
export function rescore(input: unknown) {
  const list = Array.isArray(input) ? listOf(input).slice(0, SCORE_LIMIT) : [];
  const findings: ScoredFinding[] = [];
  for (const item of list) {
    const { id, rule, severity, category, tier, risk } = fieldsOf(item);
    if (!item || !fits(SHAPE.findingId, id) || !fits(SHAPE.rule, rule)) continue;
    const known = SCORED_SEVERITIES.find(level => level === severity);
    if (!known || typeof category !== 'string' || !/^[a-z][a-z-]{1,31}$/.test(category)) continue;
    findings.push({
      id,
      rule,
      category,
      severity: known,
      verdict: read(item, 'verdict') === 'needs-validation' ? 'needs-validation' : 'confirmed',
      reach: read(item, 'open') === true ? { auth: 'open' } : null,
      detail: {
        intel: { exploited: read(item, 'exploited') === true },
        usage: typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIERS, tier) ? { tier } : null,
        risk: typeof risk === 'number' && Number.isFinite(risk) ? { score: Math.max(0, Math.min(100, risk)) } : null,
        direct: read(item, 'direct') === true
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

/* ---- What is open now -------------------------------------------------------- */

/* A kept finding row, as triage and the merge gate read it. */
export interface KeptRow {
  readonly id: string;
  readonly rule: string;
  readonly category: string;
  readonly severity: string;
  readonly verdict: string;
  readonly reach: string | null;
  readonly exploited: boolean;
  readonly firstSeenAt: string | null;
  readonly waived: string | null;
}

/*
 * What is open in a kept audit now: what it found open, and what it found
 * waived by a decision that has since been taken back or has lapsed -- but
 * not what the code itself waived, which is part of the commit -- less what
 * a decision in force covers today.
 */
export function openRows<T extends KeptRow>(rows: readonly T[] | null | undefined, decisions: unknown, now: number): T[] {
  const kept = decisionsOf(decisions);
  const list: readonly T[] = Array.isArray(rows) ? rows : [];
  return list.filter(row => {
    if (row.waived && row.waived !== 'triage') return false;
    const decision = kept ? kept.get(row.id) : null;
    return !(decision && decision.rule === row.rule && inForce(decision, now));
  });
}
