/*
 * What an audit of a pull request's head says about merging it.
 *
 * The merge gate (`evaluateMergeGate`) reads the latest audit the person
 * merging kept of the pull request's head branch and of its base: whether
 * it is of the commit being merged, and what is still open there after
 * triage. It answers with plain attributes -- a state, a grade, a list of
 * reasons -- that a governance policy rule on `pull.merge` can name in its
 * conditions. The gate decides nothing itself; the active policy does.
 *
 * It stands on Kepler for the clocks and the policy evaluation, which is why
 * it is application and not domain: the domain names no other module.
 */
import { listOf, read } from '../../../platform/values/fields.ts';
import { DEFAULT_SLA, clockOf, evaluatePolicyDocument, type Sla } from '../../kepler/index.ts';
import { confirmed, openRows, type KeptRow } from '../domain/audit-triage.ts';
import { productionTier } from '../domain/uranus-reach.ts';

/* The reasons a merge gate can give; a policy names the ones it acts on. */
export const GATE_REASONS = Object.freeze(['critical', 'serious', 'exploited', 'secret', 'overdue', 'introduced'] as const);
export const GATE_STATES = Object.freeze(['current', 'stale', 'missing', 'unavailable'] as const);
export type GateReason = (typeof GATE_REASONS)[number];
export type GateState = (typeof GATE_STATES)[number];

const production = (row: KeptRow): boolean => productionTier(row.reach);

/* A kept audit as the gate reads it: the record and its finding rows. */
export interface GateAudit {
  readonly audit: {
    readonly commitSha: string;
    readonly grade: string | null;
    readonly auditedAt: string | null;
    readonly analysisComplete?: boolean | null;
    readonly files?: { readonly complete: boolean } | null;
    readonly findings?: { readonly total: number; readonly stored: number } | null;
    readonly watch?: { readonly state: string } | null;
    readonly sla?: Sla | null;
  };
  readonly findings: readonly KeptRow[];
}
type Counts = { critical: number; serious: number; warning: number };
type Evidence = 'incomplete' | 'unrecorded';
type GateSla = Sla & { readonly source: 'base' | 'default' };

interface GateFacts {
  readonly grade?: string | null;
  readonly auditedAt?: string | null;
  readonly commitSha?: string | null;
  readonly blocking?: readonly GateReason[];
  readonly open?: Counts;
  readonly overdue?: number;
  readonly exploited?: number;
  readonly introduced?: number | null;
  readonly base?: 'audited' | 'missing';
  readonly complete?: boolean | null;
  readonly evidence?: Evidence | null;
  readonly sla?: GateSla;
}
export interface Gate {
  readonly state: GateState;
  readonly grade: string | null;
  readonly auditedAt: string | null;
  readonly commitSha: string | null;
  readonly blocking: readonly GateReason[];
  readonly open: Readonly<Counts>;
  readonly overdue: number;
  readonly exploited: number;
  readonly introduced: number | null;
  readonly base: 'audited' | 'missing';
  readonly complete: boolean | null;
  readonly evidence: Evidence | null;
  readonly sla: GateSla | null;
}

/*
 * `head` and `base` are kept audits with their finding rows, or null when
 * the person merging has none of that branch. The clock is the base's: a
 * pull request cannot lengthen its own deadline by changing the policy file
 * it is asking to merge.
 */
/* Reasons a known finding refuses a merge even when the rest of the audit could not be completed. */
const DENY_ON_KNOWN: ReadonlySet<GateReason> = new Set(['critical', 'secret', 'exploited', 'overdue']);

export interface GateInput {
  readonly headSha?: string | null;
  readonly head?: GateAudit | null;
  readonly base?: GateAudit | null;
  readonly decisions?: unknown;
  readonly now?: number;
}

export function evaluateMergeGate({ headSha, head, base, decisions, now = Date.now() }: GateInput = {}): Gate {
  const baseState = base && base.audit ? 'audited' : 'missing';
  if (!head || !head.audit) return gateResult('missing', { base: baseState });
  const audit = head.audit;
  if (!headSha || audit.commitSha !== headSha) {
    return gateResult('stale', { grade: audit.grade, auditedAt: audit.auditedAt, commitSha: audit.commitSha, base: baseState });
  }
  /* A matching commit proves freshness, not that the evidence needed to judge it was available. */
  const evidenceComplete = audit.analysisComplete === true
    && !(audit.files && audit.files.complete !== true)
    && !(audit.findings && audit.findings.total > audit.findings.stored)
    && !(audit.watch && ['partial', 'unavailable'].includes(audit.watch.state));
  const sla = (base && base.audit && base.audit.sla) || DEFAULT_SLA;
  const open = openRows(head.findings, decisions, now);
  const counts: Counts = { critical: 0, serious: 0, warning: 0 };
  for (const row of open) if (row.severity === 'critical' || row.severity === 'serious' || row.severity === 'warning') counts[row.severity] += 1;
  const exploitedRows = open.filter(row => row.exploited && row.rule !== 'DEP-005' && production(row));
  const overdue = open.filter(row => {
    const clock = clockOf({ severity: row.severity, exploited: row.exploited && row.rule !== 'DEP-005' && production(row) }, { firstSeenAt: row.firstSeenAt, sla, now });
    return clock && clock.state === 'overdue';
  });
  let introduced: number | null = null;
  if (base && base.audit) {
    const before = new Set(listOf(base.findings).map(row => read(row, 'id')));
    introduced = open.filter(row => confirmed(row) && (row.severity === 'critical' || row.severity === 'serious') && !before.has(row.id)).length;
  }
  const blocking: GateReason[] = [];
  if (open.some(row => confirmed(row) && row.severity === 'critical')) blocking.push('critical');
  if (open.some(row => confirmed(row) && row.severity === 'serious')) blocking.push('serious');
  if (exploitedRows.length) blocking.push('exploited');
  if (open.some(row => confirmed(row) && row.category === 'secrets')) blocking.push('secret');
  if (overdue.length) blocking.push('overdue');
  if (introduced) blocking.push('introduced');
  /*
   * Incomplete evidence can only add findings. What it already shows that the
   * gate refuses (a confirmed critical, a credential, an exploited
   * vulnerability, an overdue finding) is judged as it stands; anything less
   * waits on an approval, as a head nobody could fully audit does.
   */
  /*
   * Which kind of incomplete: an audit kept before audits recorded their own
   * completeness ('unrecorded') is cured by auditing again; one that recorded
   * a gap ('incomplete') waits on an approval. A gate that could not read the
   * kept audits at all says neither.
   */
  const evidence: Evidence | null = evidenceComplete ? null
    : (audit.analysisComplete === true || audit.analysisComplete === false ? 'incomplete' : 'unrecorded');
  if (!evidenceComplete && !blocking.some(reason => DENY_ON_KNOWN.has(reason))) {
    return gateResult('unavailable', {
      grade: audit.grade, auditedAt: audit.auditedAt, commitSha: audit.commitSha, blocking, open: counts,
      overdue: overdue.length, exploited: exploitedRows.length, introduced,
      base: baseState, complete: false, evidence
    });
  }
  return gateResult('current', {
    grade: audit.grade,
    auditedAt: audit.auditedAt,
    commitSha: audit.commitSha,
    blocking,
    open: counts,
    overdue: overdue.length,
    exploited: exploitedRows.length,
    introduced,
    base: baseState,
    complete: evidenceComplete ? (audit.files ? audit.files.complete === true : null) : false,
    evidence,
    sla: { ...sla, source: base && base.audit && base.audit.sla ? 'base' : 'default' }
  });
}

function gateResult(state: GateState, facts: GateFacts = {}): Gate {
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
    evidence: facts.evidence || null,
    sla: facts.sla ? Object.freeze(facts.sla) : null
  });
}

/*
 * What the active policies would make of a merge with these attributes,
 * worked out the way the gateway works them out, for the page to show before
 * anybody presses Merge. Only the policies with a rule that matches are
 * listed, each with its mode, its effect and the rules that matched.
 */
export function previewMergePolicies(activePolicies: unknown, attributes: unknown) {
  const out = [];
  for (const policy of listOf(activePolicies)) {
    const document = read(policy, 'document');
    if (!document) continue;
    const evaluation = evaluatePolicyDocument(document, [{ id: 'merge-preview', action: 'pull.merge', attributes }]);
    const result = evaluation.results[0];
    if (!result || !result.matchedRuleIds.length) continue;
    const rules = listOf(read(document, 'rules')).filter(rule => result.matchedRuleIds.some(id => id === read(rule, 'id')));
    out.push({
      policyKey: read(policy, 'policyKey'),
      mode: read(read(document, 'enforcement'), 'mode') || 'observe',
      effect: result.effect,
      rules: rules.map(rule => {
        const description = read(rule, 'description');
        const conditions = read(rule, 'conditions');
        return {
          id: read(rule, 'id'),
          effect: read(rule, 'effect'),
          description: typeof description === 'string' ? description.slice(0, 300) : null,
          audit: Boolean(conditions && read(conditions, 'audit'))
        };
      })
    });
  }
  return out;
}

/* The facts a merge carries for its policy: the branches, and the gate's attributes. */
export function mergeAttributes(pull: { readonly base?: unknown; readonly head?: unknown }, gate: Gate) {
  return { branch: pull.base, head: pull.head, audit: gateAttributes(gate) };
}

/* The gate when there is no history to read it from: no audit can be found, so none is claimed. */
export function unavailableGate(): Gate {
  return gateResult('unavailable');
}

/* What a policy sees: the gate's attributes, without the times and the commit, which no rule should key on. */
export function gateAttributes(gate: Gate) {
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
