/*
 * The Policy Digital Twin, decided: who may act on it, and what each part of
 * the screen says about the twin the server sent. Every value is read from
 * the answer as it arrived -- a count is a whole number or none, a time is a
 * time or unknown -- and nothing here draws. GovernanceView.tsx draws it.
 */
import { field, hasFields, items } from '../../platform/values.ts';
import type { Fields } from '../../platform/values.ts';

export const CAPABILITIES = Object.freeze(['read', 'author', 'review', 'activate', 'administer'] as const);
export type Capability = (typeof CAPABILITIES)[number];

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';
export type EvidenceStatus = 'current' | 'unavailable' | 'stale';

const OK_WORDS: readonly string[] = Object.freeze(['approved', 'allow', 'current', 'valid', 'observe']);
const WARN_WORDS: readonly string[] = Object.freeze(['pending', 'warn', 'partial', 'require-approval']);
const DANGER_WORDS: readonly string[] = Object.freeze(['rejected', 'deny', 'block', 'invalid', 'stale', 'unavailable', 'revoked', 'expired', 'superseded']);

/* A field's value as text, or nothing. */
export const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/* A whole, non-negative count, or 0. */
export function count(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function hashShort(value: unknown): string {
  const hash = text(value);
  return /^[0-9a-f]{64}$/i.test(hash) ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : 'not recorded';
}

/* The moment a value names, or NaN: only a time sent as a date or a number is one. */
function instant(value: unknown): number {
  return (typeof value === 'string' && value !== '') || typeof value === 'number' ? new Date(value).getTime() : Number.NaN;
}

/*
 * A time a reader reads. A missing time used to be read as the epoch, and
 * the snapshot said it was taken on the first of January 1970; it is unknown.
 */
export function formatTime(value: unknown): string {
  const at = instant(value);
  if (!Number.isFinite(at)) return 'Unknown time';
  return new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/* How long ago, in the ledger's words. A missing time is unknown, not 56 years ago. */
export function ago(value: unknown, now: number = Date.now()): string {
  const at = instant(value);
  if (!Number.isFinite(at)) return 'unknown time';
  /* A time ahead of the clock is now, as is anything under a minute. */
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function human(value: unknown): string {
  return String(value || '').replace(/[-_.]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

export function tone(value: unknown): Tone {
  const word = String(value || '').toLowerCase();
  if (OK_WORDS.includes(word)) return 'ok';
  if (WARN_WORDS.includes(word)) return 'warn';
  if (DANGER_WORDS.includes(word)) return 'danger';
  return 'neutral';
}

export interface InterfaceAccess {
  readonly actor: { readonly login: string };
  readonly execution: { readonly kind: 'user' | 'installation'; readonly authMethod: string };
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly evidence: { readonly status: EvidenceStatus; readonly expiresAt: string };
}

/*
 * What the signed-in reader may do here. The server's word for each
 * capability, held only while the evidence behind it is current: evidence
 * that has expired, or never arrived, grants nothing.
 */
export function normalizeInterfaceAccess(value: unknown, now: number = Date.now()): InterfaceAccess {
  const raw = field(value, 'capabilities');
  const evidence = field(value, 'evidence');
  const expiresAt = field(evidence, 'expiresAt');
  const expiresAtMs = new Date(typeof expiresAt === 'string' || typeof expiresAt === 'number' ? expiresAt : 0).getTime();
  const nowMs = Number(now);
  const stated = field(evidence, 'status');
  const status: EvidenceStatus = stated === 'current' && Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs
    ? 'current'
    : stated === 'unavailable' ? 'unavailable' : 'stale';
  const granted = (name: Capability): boolean => status === 'current' && field(raw, name) === true;
  const kind = field(field(value, 'execution'), 'kind');
  return Object.freeze({
    actor: Object.freeze({ login: String(field(field(value, 'actor'), 'login') || '') }),
    execution: Object.freeze({
      kind: kind === 'installation' ? 'installation' : 'user',
      authMethod: String(field(field(value, 'execution'), 'authMethod') || '')
    }),
    capabilities: Object.freeze({
      read: granted('read'),
      author: granted('author'),
      review: granted('review'),
      activate: granted('activate'),
      administer: granted('administer')
    }),
    evidence: Object.freeze({ status, expiresAt: String(expiresAt || '') })
  });
}

/* A JSON object a reader typed, or the reason it is not one. */
export function parseJsonObject(source: unknown, label = 'Value'): Fields {
  const typed = text(source).trim();
  if (!typed) throw new Error(`${label} must be a JSON object`);
  if (typed.length > 64 * 1024) throw new Error(`${label} is too large`);
  let value: unknown;
  try { value = JSON.parse(typed); } catch { throw new Error(`${label} must contain valid JSON`); }
  if (!hasFields(value) || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

export interface SimulationScenario {
  readonly id: string;
  readonly action: string;
  readonly attributes: Fields;
}

export function defaultSimulationRequest(defaultBranch: unknown = 'main'): { schemaVersion: 1; scenarios: SimulationScenario[] } {
  const branch = String(defaultBranch || 'main').slice(0, 200) || 'main';
  return {
    schemaVersion: 1,
    scenarios: [
      { id: 'write-file', action: 'file.write', attributes: { branch, paths: ['README.md'] } },
      { id: 'reset-protected-branch', action: 'branch.reset', attributes: { branch, protected: true } },
      { id: 'merge-pull-request', action: 'pull.merge', attributes: { branch, audit: { state: 'current', blocking: [] } } },
      /* The audit gate's two answers, so a policy that acts on them is exercised before it can be activated. */
      { id: 'merge-failing-audit', action: 'pull.merge', attributes: { branch, audit: { state: 'current', blocking: ['critical', 'overdue'] } } },
      { id: 'merge-unaudited-head', action: 'pull.merge', attributes: { branch, audit: { state: 'missing', blocking: [] } } },
      { id: 'create-release', action: 'release.create', attributes: { branch } }
    ]
  };
}

export function reviewSummary(review: unknown): string {
  return `${count(field(review, 'approvalCount'))}/${count(field(review, 'requiredApprovals'))} approvals · ${count(field(review, 'assignedCount'))} assigned`;
}

/* A control's data, as the page's handler reads it: data-<name>="value". */
export type ActionData = Readonly<Record<string, string | number>>;

export interface Action {
  readonly action: string;
  readonly label: string;
  readonly data: ActionData;
  readonly kind: string;
  readonly disabled: boolean;
  readonly title: string;
}

export function act(action: string, label: string, data: ActionData = {}, kind = 'ghost', disabled = false, title = ''): Action {
  return { action, label, data, kind, disabled, title };
}

/* ---- The summary and the overview --------------------------------------------------- */

export interface Metric { readonly label: string; readonly value: number; readonly sub: string }

const moreDecisions = (history: unknown): boolean => {
  const before = field(history, 'nextBeforeDecisionSeq');
  const after = field(history, 'nextDecisionSeq');
  return (before ?? after) !== null && (before ?? after) !== undefined;
};

export function summary(twin: unknown): readonly Metric[] {
  const current = field(twin, 'current');
  const proposed = field(twin, 'proposed');
  const history = field(twin, 'history');
  return [
    { label: 'Active policies', value: count(field(current, 'activePolicyCount')), sub: `${count(field(current, 'policyCount'))} total` },
    { label: 'Proposed versions', value: count(field(proposed, 'versionCount')), sub: `${count(field(proposed, 'draftCount'))} drafts` },
    { label: 'Active exceptions', value: count(field(field(twin, 'effective'), 'activeExceptionCount')), sub: 'actor + target bound' },
    { label: 'Recent decisions', value: items(field(history, 'decisions')).length, sub: moreDecisions(history) ? 'more available' : 'latest page' }
  ];
}

export type StageId = 'draft' | 'review' | 'ready' | 'active';
export interface Stage { readonly id: StageId; readonly label: string; readonly n: number; readonly sub: string; readonly state: 'work' | 'held' | 'empty' }

/*
 * Where the work is, as a pipeline: drafts become immutable versions, a
 * version is reviewed, simulated, and only then activated. Each stage shows
 * how many items sit in it, and the first stage holding work is lit, so a
 * reader sees at a glance what is waiting and on whom.
 */
export function lifecycle(twin: unknown): readonly Stage[] {
  const proposed = field(twin, 'proposed');
  const versions = items(field(proposed, 'versions'));
  const pending = versions.filter(version => field(field(version, 'review'), 'status') === 'pending').length;
  const ready = versions.filter(version => field(field(version, 'activationReadiness'), 'eligible') === true
    || field(field(version, 'review'), 'status') === 'approved').length;
  const stages: readonly [StageId, string, number, string][] = [
    ['draft', 'Drafts', count(field(proposed, 'draftCount')), 'being written'],
    ['review', 'In review', pending, 'awaiting approval'],
    ['ready', 'Approved', ready, 'simulate, then activate'],
    ['active', 'Active', count(field(field(twin, 'current'), 'activePolicyCount')), 'enforcing now']
  ];
  const lit = stages.findIndex(([, , n], index) => n > 0 && index < 3);
  return stages.map(([id, label, n, sub], index) => ({ id, label, n, sub, state: index === lit ? 'work' : n ? 'held' : 'empty' }));
}

export interface BarPart { readonly tone: string; readonly word: string; readonly n: number }
export interface Bar { readonly label: string; readonly total: number; readonly said: string; readonly parts: readonly BarPart[] }

/* A proportion with its counts in words beside it. */
export function bar(label: string, parts: readonly BarPart[]): Bar {
  const total = parts.reduce((sum, part) => sum + part.n, 0);
  const words = parts.filter(part => part.n).map(part => `${part.n} ${part.word}`).join(', ');
  return { label, total, said: `${label}: ${total ? words : 'none'}`, parts };
}

/* How the running policies bite, and what they decided: the active policies by enforcement mode, and the recent runtime decisions by outcome. */
export function enforcement(twin: unknown): readonly [Bar, Bar] {
  const modes = { observe: 0, warn: 0, block: 0 };
  for (const policy of items(field(field(twin, 'current'), 'policies'))) {
    const active = field(policy, 'active');
    if (!field(active, 'versionId')) continue;
    const mode = String(field(active, 'enforcementMode') || 'observe');
    if (mode === 'enforce' || mode === 'block') modes.block += 1;
    else if (mode === 'warn') modes.warn += 1;
    else modes.observe += 1;
  }
  const outcomes = { allow: 0, warn: 0, block: 0 };
  for (const decision of items(field(field(twin, 'history'), 'decisions'))) {
    const outcome = String(field(decision, 'enforcementOutcome') || 'allow');
    if (outcome === 'warn') outcomes.warn += 1;
    else if (outcome === 'block') outcomes.block += 1;
    else outcomes.allow += 1;
  }
  return [
    bar('Active policies by mode', [{ tone: 'observe', word: 'observe', n: modes.observe }, { tone: 'warn', word: 'warn', n: modes.warn }, { tone: 'block', word: 'block', n: modes.block }]),
    bar('Recent decisions', [{ tone: 'allow', word: 'allowed', n: outcomes.allow }, { tone: 'warn', word: 'warned', n: outcomes.warn }, { tone: 'block', word: 'blocked', n: outcomes.block }])
  ];
}

/* ---- Policies, drafts, versions, exceptions ----------------------------------------- */

export interface PolicyCard {
  readonly key: string;
  readonly policyKey: string;
  readonly name: string;
  readonly description: string;
  /* The enforcement mode while it runs; otherwise how it stands. */
  readonly badge: { readonly value: string; readonly label: string };
  readonly facts: readonly [string, string][];
  readonly hash: string;
  readonly actions: readonly Action[];
  readonly lifecycle: readonly Action[];
}

export function policyCards(twin: unknown, access: InterfaceAccess): readonly PolicyCard[] {
  const can = access.capabilities;
  return items(field(field(twin, 'current'), 'policies')).map((policy, index) => {
    const active = field(policy, 'active');
    const latest = field(policy, 'latestVersion');
    const off = field(policy, 'switchedOff');
    const policyId = text(field(policy, 'policyId'));
    const policyKey = text(field(policy, 'policyKey'));
    const activeId = text(field(active, 'versionId'));
    const offId = text(field(off, 'versionId'));
    const ids = { 'policy-id': policyId, revision: count(field(policy, 'revision')) };
    const latestReview = field(latest, 'review');
    const mode = text(field(active, 'enforcementMode')) || 'observe';
    return {
      key: policyId || `policy-${index}`,
      policyKey,
      name: text(field(policy, 'name') || policyKey || 'Unnamed policy'),
      description: text(field(policy, 'description') || 'No description'),
      badge: activeId ? { value: mode, label: human(mode) } : offId ? { value: 'neutral', label: 'Switched off' } : { value: 'neutral', label: 'Not active' },
      facts: [
        ['Revision', String(count(field(policy, 'revision')))],
        ['Versions', String(count(field(policy, 'versionCount')))],
        ['Active', activeId ? `v${count(field(active, 'versionNumber'))}` : offId ? `Off · was v${count(field(off, 'versionNumber'))}` : 'None'],
        ['Latest review', latestReview ? human(field(latestReview, 'status')) : 'No version']
      ],
      hash: hashShort(field(active, 'documentHash')),
      actions: [
        act('select-policy', 'Inspect', { 'policy-id': policyId }),
        ...(can.author ? [act('new-draft', 'New draft', { 'policy-id': policyId })] : []),
        ...(activeId && can.author ? [act('request-exception', 'Request exception', { 'policy-id': policyId, 'version-id': activeId })] : [])
      ],
      lifecycle: [
        ...(activeId && can.activate ? [act('deactivate-policy', 'Switch off', { ...ids, 'version-number': count(field(active, 'versionNumber')) })] : []),
        ...(!activeId && offId && can.activate ? [act('reactivate-policy', `Turn v${count(field(off, 'versionNumber'))} back on`, { ...ids, 'version-id': offId }, 'primary')] : []),
        ...(can.administer ? [act('archive-policy', 'Archive', { ...ids, active: activeId ? 'true' : 'false' }, 'ghost')] : [])
      ]
    };
  });
}

/* The actions that start a policy, for whoever may author one. */
export function authorActions(access: InterfaceAccess): readonly Action[] {
  return access.capabilities.author ? [act('create-policy', 'Create policy', {}, 'primary'), act('generate-baseline', 'Generate baseline')] : [];
}

export interface DraftRow { readonly key: string; readonly revision: number; readonly policy: string; readonly author: string; readonly updated: string; readonly actions: readonly Action[] }

export function draftRows(twin: unknown, access: InterfaceAccess): readonly DraftRow[] {
  const can = access.capabilities;
  return items(field(field(twin, 'proposed'), 'drafts')).map((draft, index) => {
    const policyId = text(field(draft, 'policyId'));
    const draftId = text(field(draft, 'draftId'));
    const author = text(field(draft, 'authoredByLogin'));
    const ids = { 'policy-id': policyId, 'draft-id': draftId };
    /* The draft's revision as it was sent, for the server to compare against. */
    const revision = text(field(draft, 'revision'));
    return {
      key: draftId || `draft-${index}`,
      revision: count(field(draft, 'revision')),
      policy: policyId.slice(0, 8),
      author,
      updated: formatTime(field(draft, 'updatedAt')),
      actions: [
        ...(can.author ? [act('edit-draft', 'Edit', ids), act('validate-draft', 'Validate', ids), act('submit-draft', 'Submit', { ...ids, revision }, 'primary')] : []),
        ...(can.author && (author === access.actor.login || can.administer) ? [act('discard-draft', 'Discard', { ...ids, revision }, 'ghost')] : [])
      ]
    };
  });
}

export interface VersionRow {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly review: string;
  readonly stamp: string;
  /* The simulation shown for this version, when the last one run was of it. */
  readonly simulation: { readonly eligible: boolean; readonly hash: string } | null;
  readonly actions: readonly Action[];
}

export function versionRows(twin: unknown, access: InterfaceAccess, simulation: unknown): readonly VersionRow[] {
  const can = access.capabilities;
  const report = field(simulation, 'report');
  return items(field(field(twin, 'proposed'), 'versions')).map((version, index) => {
    const review = field(version, 'review');
    const policyId = text(field(version, 'policyId'));
    const versionId = text(field(version, 'versionId'));
    /* A version with no ids is nobody's simulation: an empty one used to match it. */
    const matches = Boolean(versionId) && field(simulation, 'policyId') === field(version, 'policyId') && field(simulation, 'versionId') === field(version, 'versionId');
    const eligible = matches && field(field(report, 'activationReadiness'), 'eligible') === true;
    const ids = { 'policy-id': policyId, 'version-id': versionId };
    const status = text(field(review, 'status')) || 'pending';
    return {
      key: versionId || `version-${index}`,
      title: `${text(field(version, 'policyKey'))} v${count(field(version, 'versionNumber'))}`,
      status,
      review: reviewSummary(review),
      stamp: `${formatTime(field(version, 'createdAt'))} · ${hashShort(field(version, 'documentHash'))}`,
      simulation: matches ? { eligible, hash: hashShort(field(report, 'simulationHash')) } : null,
      actions: [
        act('view-version', 'View JSON', ids),
        act('simulate', 'Simulate', ids, matches ? 'ghost' : 'primary'),
        ...(can.review && field(review, 'status') === 'pending' ? [act('claim-review', 'Claim review', ids), act('approve', 'Approve', ids), act('reject', 'Reject', ids, 'ghost')] : []),
        ...(can.activate ? [act('activate', 'Activate', ids, 'primary', !eligible, eligible ? '' : 'Run an eligible fresh simulation first')] : []),
        ...(can.author ? [act('withdraw-version', 'Withdraw', { ...ids, 'version-number': count(field(version, 'versionNumber')) }, 'ghost')] : [])
      ]
    };
  });
}

export interface ExceptionRow { readonly key: string; readonly title: string; readonly state: string; readonly expires: string; readonly requested: string; readonly actions: readonly Action[] }

export function exceptionRows(twin: unknown, access: InterfaceAccess): readonly ExceptionRow[] {
  const can = access.capabilities;
  return items(field(field(twin, 'history'), 'exceptions')).map((item, index) => {
    const exceptionId = text(field(item, 'exceptionId'));
    const ids = { 'exception-id': exceptionId, 'policy-id': text(field(item, 'policyId')), 'version-id': text(field(item, 'versionId')) };
    const state = field(item, 'state');
    return {
      key: exceptionId || `exception-${index}`,
      title: `${human(field(item, 'kind'))} · ${text(field(item, 'action'))}`,
      state: text(state),
      expires: `Expires ${formatTime(field(item, 'expiresAt'))}`,
      requested: `Requested ${formatTime(field(item, 'createdAt'))}`,
      actions: [
        act('view-exception', 'Inspect', ids),
        ...(can.administer && state === 'pending' ? [act('decide-exception', 'Decide', ids, 'primary')] : []),
        ...(can.administer && state === 'approved' ? [act('revoke-exception', 'Revoke', ids, 'ghost')] : [])
      ]
    };
  });
}

/* ---- The evidence ledger ------------------------------------------------------------ */

/*
 * The evidence ledger as a reader can work through it: one list at a time
 * (runtime decisions or activations), filtered by outcome, a page at a time,
 * newest first. "Clear from view" tidies the list for this reader only, up to
 * the newest entry shown; the ledger itself is immutable, so every entry stays
 * in exports and in chain verification and one press brings them back.
 */
export const LEDGER_PAGE = 8;
const OUTCOME = Object.freeze({ block: 'Blocked', warn: 'Warned', allow: 'Allowed' });
const ACTIVATION = Object.freeze({ activate: 'Activated', deactivate: 'Switched off', rollback: 'Rolled back' });
const ACTIVATION_TONE = Object.freeze({ activate: 'allow', deactivate: 'warn', rollback: 'info' });
type Outcome = keyof typeof OUTCOME;
type ActivationKind = keyof typeof ACTIVATION;

const outcomeOf = (value: unknown): Outcome => {
  const outcome = String(value || 'allow');
  return outcome === 'block' || outcome === 'warn' ? outcome : 'allow';
};
const activationOf = (value: unknown): ActivationKind => {
  const kind = String(value || 'activate');
  return kind === 'deactivate' || kind === 'rollback' ? kind : 'activate';
};

export interface LedgerTab { readonly id: 'decisions' | 'activations'; readonly label: string; readonly n: number; readonly more: boolean; readonly selected: boolean }
export interface LedgerChip { readonly id: string; readonly word: string; readonly n: number; readonly tone: string; readonly pressed: boolean; readonly disabled: boolean }

export type LedgerRow =
  | { readonly kind: 'decision'; readonly key: string; readonly tone: Outcome; readonly cleared: boolean; readonly action: string; readonly detail: string; readonly state: string; readonly at: string; readonly title: string; readonly when: string }
  | { readonly kind: 'activation'; readonly key: string; readonly tone: string; readonly cleared: boolean; readonly what: string; readonly policyKey: string; readonly detail: string; readonly at: string; readonly title: string; readonly when: string;
      /* The row's control: a way back to this version, a note that it is the one running, or nothing. */
      readonly restore: { readonly label: string; readonly data: ActionData } | 'current' | null };

export interface Ledger {
  readonly verify: { readonly label: string; readonly banner: { readonly valid: boolean; readonly words: string } | null };
  readonly tab: 'decisions' | 'activations';
  readonly tabs: readonly LedgerTab[];
  readonly chipsLabel: string;
  readonly chips: readonly LedgerChip[];
  readonly rows: readonly LedgerRow[];
  readonly empty: string;
  readonly shown: string;
  readonly foot: readonly Action[];
  readonly clearedNote: boolean;
}

export function ledger(twin: unknown, access: InterfaceAccess, verification: unknown, view: unknown, now: number = Date.now()): Ledger {
  const history = field(twin, 'history');
  const tab = field(view, 'tab') === 'activations' ? 'activations' : 'decisions';
  const decisions = items(field(history, 'decisions'));
  const activations = items(field(history, 'activations'));
  const all = tab === 'decisions' ? decisions : activations;
  const cleared = count(field(field(view, 'cleared'), tab));
  const showCleared = field(view, 'showCleared') === true;
  const seq = (item: unknown): number => count(field(item, 'seq'));
  const live = all.filter(item => seq(item) > cleared);
  const pool = showCleared ? all : live;
  const kindOf = (item: unknown): string => (tab === 'decisions' ? outcomeOf(field(item, 'enforcementOutcome')) : activationOf(field(item, 'action')));
  const words: Readonly<Record<string, string>> = tab === 'decisions' ? OUTCOME : ACTIVATION;
  const asked = field(view, 'filter');
  const filter = typeof asked === 'string' && Object.hasOwn(words, asked) ? asked : 'all';
  const filtered = filter === 'all' ? pool : pool.filter(item => kindOf(item) === filter);
  const limit = Math.max(LEDGER_PAGE, count(field(view, 'limit')) || LEDGER_PAGE);
  const shown = filtered.slice(0, limit);
  const policies = items(field(field(twin, 'current'), 'policies'));
  const policyOf = (id: unknown): unknown => policies.find(policy => field(policy, 'policyId') === id);
  const keyOf = (id: unknown): string => { const policy = policyOf(id); return policy ? text(field(policy, 'policyKey')) : text(id).slice(0, 8); };
  const activeOf = (id: unknown): unknown => { const policy = policyOf(id); return policy ? field(field(policy, 'active'), 'versionId') : null; };
  const verified = field(verification, 'valid');
  const complete = field(verification, 'complete') === true;
  const checked = field(verification, 'checked');
  const before = field(history, 'nextBeforeDecisionSeq');
  const after = field(history, 'nextDecisionSeq');
  const rows: LedgerRow[] = shown.map((item, index) => {
    const isCleared = seq(item) <= cleared;
    if (tab === 'decisions') {
      const outcome = outcomeOf(field(item, 'enforcementOutcome'));
      return {
        kind: 'decision', key: `decision-${seq(item)}-${index}`, tone: outcome, cleared: isCleared,
        action: text(field(item, 'action')),
        detail: `${human(field(item, 'effectiveEffect'))} · ${hashShort(field(item, 'decisionHash'))}`,
        state: OUTCOME[outcome],
        at: text(field(item, 'evaluatedAt')), title: formatTime(field(item, 'evaluatedAt')), when: ago(field(item, 'evaluatedAt'), now)
      };
    }
    const activation = activationOf(field(item, 'action'));
    const versionId = field(item, 'versionId');
    const current = activation !== 'deactivate' && activeOf(field(item, 'policyId')) === versionId;
    /* One small control per row, named in full for a screen reader and on hover: the list is for reading, the control is there when wanted. */
    const label = `${activation === 'deactivate' ? 'Turn back on' : 'Roll back to'} ${keyOf(field(item, 'policyId'))} version ${text(versionId).slice(0, 8)}`;
    return {
      kind: 'activation', key: `activation-${seq(item)}-${index}`, tone: ACTIVATION_TONE[activation], cleared: isCleared,
      what: ACTIVATION[activation],
      policyKey: keyOf(field(item, 'policyId')),
      detail: `${text(field(item, 'actorLogin'))} · version ${text(versionId).slice(0, 8)}`,
      at: text(field(item, 'createdAt')), title: formatTime(field(item, 'createdAt')), when: ago(field(item, 'createdAt'), now),
      restore: access.capabilities.activate && !current
        ? { label, data: { 'policy-id': text(field(item, 'policyId')), 'version-id': text(versionId) } }
        : current ? 'current' : null
    };
  });
  const hidden = all.length - live.length;
  return {
    verify: {
      label: verified === true && complete ? 'Chain verified' : 'Verify chain',
      banner: verified === null || verified === undefined ? null : {
        valid: Boolean(verified),
        words: `${verified ? (complete ? 'Decision chain verified' : 'Decision chain valid through the configured verification limit') : 'Decision chain verification failed'}${checked === null || checked === undefined ? '' : ` · ${count(checked)} records checked`}`
      }
    },
    tab,
    tabs: [
      { id: 'decisions', label: 'Runtime decisions', n: decisions.length, more: (before ?? after) !== null && (before ?? after) !== undefined, selected: tab === 'decisions' },
      { id: 'activations', label: 'Activations', n: activations.length, more: false, selected: tab === 'activations' }
    ],
    chipsLabel: `Filter ${tab === 'decisions' ? 'decisions by outcome' : 'activations by kind'}`,
    chips: [
      { id: 'all', word: 'All', n: pool.length, tone: 'neutral', pressed: filter === 'all', disabled: false },
      ...Object.entries(words).map(([id, word]) => {
        const n = pool.filter(item => kindOf(item) === id).length;
        return { id, word, n, tone: tab === 'decisions' ? id : ACTIVATION_TONE[activationOf(id)], pressed: id === filter, disabled: !n };
      })
    ],
    rows,
    empty: all.length
      ? (live.length || showCleared ? 'No entries match this filter.' : `All ${all.length} cleared from view. They are still in the ledger.`)
      : (tab === 'decisions' ? 'No runtime decisions yet.' : 'No activation history yet.'),
    shown: shown.length ? `Showing ${shown.length} of ${filtered.length}` : 'Nothing to show',
    foot: [
      ...(filtered.length > shown.length ? [act('ledger-more', `Show ${Math.min(LEDGER_PAGE, filtered.length - shown.length)} more`, { 'focus-key': 'ledger-more' })] : []),
      ...(tab === 'decisions' && (before ?? after) !== null && (before ?? after) !== undefined
        ? [act('load-more-decisions', 'Load older decisions', before !== null && before !== undefined ? { 'before-seq': text(before) } : { 'after-seq': text(after) })]
        : []),
      ...(live.length ? [act('ledger-clear', 'Clear from view', { through: Math.max(...live.map(seq)), 'focus-key': 'ledger-clear' })] : []),
      ...(hidden ? [act('ledger-show-cleared', showCleared ? 'Hide cleared' : `Show ${hidden} cleared`, { 'focus-key': 'ledger-show-cleared' })] : [])
    ],
    clearedNote: cleared > 0
  };
}

/* ---- Notifications, exports and webhooks -------------------------------------------- */

/*
 * Notifications are an inbox: what is unread, a few at a time, and a Clear
 * that marks them read on the server and puts them away. What was read is
 * one press away. Signed exports show the latest few; the rest unfold.
 */
export const INBOX_PAGE = 6;
export const EXPORTS_SHOWN = 4;

export interface InboxRow { readonly key: string; readonly read: boolean; readonly event: string; readonly detail: string; readonly at: string; readonly title: string; readonly when: string }
export interface ExportRow { readonly key: string; readonly what: string; readonly hash: string; readonly id: string; readonly at: string; readonly title: string; readonly when: string }
export interface WebhookRow { readonly key: string; readonly id: string; readonly name: string; readonly url: string; readonly detail: string }

export interface Delivery {
  readonly error: string;
  readonly unread: number;
  readonly enabled: boolean;
  readonly inbox: readonly InboxRow[];
  readonly inboxEmpty: string;
  readonly inboxFoot: readonly Action[];
  readonly exportsTotal: number;
  readonly exports: readonly ExportRow[];
  readonly exportsFoot: { readonly shown: string; readonly toggle: Action } | null;
  readonly webhooks: readonly WebhookRow[] | null;
}

export function delivery(input: unknown, access: InterfaceAccess, view: unknown, now: number = Date.now()): Delivery {
  const preferences = field(input, 'preferences');
  const notifications = items(field(field(input, 'notifications'), 'events'));
  const exportsList = items(field(input, 'exports'));
  const readThrough = count(field(preferences, 'lastReadSeq'));
  const seq = (item: unknown): number => count(field(item, 'seq'));
  const unreadItems = notifications.filter(item => seq(item) > readThrough);
  const unread = unreadItems.length;
  const showRead = field(view, 'showRead') === true;
  const inbox = showRead ? notifications : unreadItems;
  const inboxLimit = Math.max(INBOX_PAGE, count(field(view, 'inboxLimit')) || INBOX_PAGE);
  const inboxShown = inbox.slice(0, inboxLimit);
  const exportsAll = field(view, 'exportsAll') === true;
  const exportsShown = exportsAll ? exportsList : exportsList.slice(0, EXPORTS_SHOWN);
  const latestSeq = notifications.length ? Math.max(...notifications.map(seq)) : 0;
  const read = notifications.length - unread;
  return {
    error: text(field(input, 'error')),
    unread,
    enabled: field(preferences, 'enabled') !== false,
    inbox: inboxShown.map((item, index) => ({
      key: `event-${seq(item)}-${index}`,
      read: seq(item) <= readThrough,
      event: human(field(item, 'eventType')),
      detail: `Event ${seq(item)} · ${hashShort(field(item, 'eventHash'))}`,
      at: text(field(item, 'createdAt')), title: formatTime(field(item, 'createdAt')), when: ago(field(item, 'createdAt'), now)
    })),
    inboxEmpty: notifications.length ? 'All caught up. Nothing unread.' : 'No governance notifications.',
    inboxFoot: [
      ...(inbox.length > inboxShown.length ? [act('inbox-more', `Show ${Math.min(INBOX_PAGE, inbox.length - inboxShown.length)} more`, { 'focus-key': 'inbox-more' })] : []),
      ...(unread ? [act('mark-notifications-read', `Clear ${unread}`, { 'through-seq': latestSeq })] : []),
      ...(read ? [act('inbox-show-read', showRead ? 'Hide read' : `Show ${read} read`, { 'focus-key': 'inbox-show-read' })] : [])
    ],
    exportsTotal: exportsList.length,
    exports: exportsShown.map((item, index) => {
      const id = text(field(item, 'exportId'));
      return {
        key: id || `export-${index}`,
        id,
        what: `${String(field(item, 'format') || 'json').toUpperCase()} · ${count(field(item, 'eventCount'))} events`,
        hash: hashShort(field(item, 'envelopeHash') || field(item, 'exportHash')),
        at: text(field(item, 'createdAt')), title: formatTime(field(item, 'createdAt')), when: ago(field(item, 'createdAt'), now)
      };
    }),
    exportsFoot: exportsList.length > EXPORTS_SHOWN ? {
      shown: `Showing ${exportsShown.length} of ${exportsList.length}`,
      toggle: act('exports-all', exportsAll ? 'Show latest only' : `Show all ${exportsList.length}`, { 'focus-key': 'exports-all' })
    } : null,
    webhooks: access.capabilities.administer ? items(field(input, 'webhooks')).map((item, index) => {
      const id = text(field(item, 'webhookId'));
      return {
        key: id || `webhook-${index}`,
        id,
        name: text(field(item, 'name')),
        url: text(field(item, 'url')),
        detail: `${field(item, 'enabled') === false ? 'Disabled' : 'Enabled'} · ${items(field(item, 'eventTypes')).map(text).join(', ')}`
      };
    }) : null
  };
}

/* ---- Archived policies and the reset ------------------------------------------------ */

export interface ArchivedRow { readonly key: string; readonly name: string; readonly policyKey: string; readonly detail: string; readonly restore: Action | null }

/*
 * Archived policies: out of the way, not gone. Each keeps its versions and
 * history and can come back -- switched off, so returning to enforcement is
 * still a deliberate, simulated step.
 */
export function archivedRows(archived: unknown, access: InterfaceAccess): readonly ArchivedRow[] {
  return items(archived).map((item, index) => {
    const policyId = text(field(item, 'policyId'));
    const policyKey = text(field(item, 'policyKey'));
    const name = text(field(item, 'name') || policyKey);
    const versions = count(field(item, 'versionCount'));
    const inUse = field(item, 'keyInUse') === true;
    return {
      key: policyId || `archived-${index}`,
      name,
      policyKey,
      detail: `Archived ${formatTime(field(item, 'archivedAt'))} · ${versions} version${versions === 1 ? '' : 's'}${field(item, 'keyInUse') ? ' · a current policy uses this key' : ''}`,
      restore: access.capabilities.administer
        ? act('restore-policy', 'Restore', { 'policy-id': policyId, name }, 'ghost', inUse, inUse ? 'Archive or rename the current policy with this key first' : '')
        : null
    };
  });
}

/*
 * The reset, kept apart from everything else on the page and spelled out
 * before it is offered: what stops, what is kept, and that it can be undone
 * policy by policy.
 */
export function dangerZone(twin: unknown, access: InterfaceAccess): { readonly words: string; readonly reset: Action } | null {
  if (!access.capabilities.administer) return null;
  const current = field(twin, 'current');
  const total = count(field(current, 'policyCount'));
  if (!total) return null;
  const running = count(field(current, 'activePolicyCount'));
  return {
    words: `Switches off and archives all ${total} ${total === 1 ? 'policy' : 'policies'}${running ? ` (${running} running now)` : ''}. Enforcement stops at once. The evidence ledger, signed exports, webhooks and notification settings are kept, and every policy can be restored afterwards.`,
    reset: act('reset-governance', 'Reset governance…', { total, running }, 'ghost danger')
  };
}

/* ---- The screen --------------------------------------------------------------------- */

export interface GovernanceInput {
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly digitalTwin?: unknown;
  readonly access?: unknown;
  readonly simulation?: unknown;
  readonly verification?: unknown;
  readonly delivery?: unknown;
  readonly archived?: unknown;
  readonly view?: unknown;
  readonly now?: number;
}

export type Screen =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly twin: Fields; readonly access: InterfaceAccess; readonly now: number;
      readonly scope: string; readonly snapshot: string; readonly freshness: string; readonly incomplete: readonly string[];
      readonly noPolicies: boolean; readonly archivedCount: number; readonly executor: string; readonly readModelHash: string };

/* Which screen the twin makes: still loading, failed, or ready with what the hero and the banners say. */
export function screen(input: GovernanceInput): Screen {
  if (input.loading) return { kind: 'loading' };
  if (input.error) return { kind: 'error', message: text(input.error) };
  const twin = input.digitalTwin;
  if (!hasFields(twin) || !field(twin, 'schemaVersion')) return { kind: 'error', message: 'The Policy Digital Twin response is unavailable or invalid.' };
  const now = input.now === null || input.now === undefined ? Date.now() : input.now;
  const access = normalizeInterfaceAccess(input.access, now);
  const freshness = field(twin, 'freshness');
  const completeness = field(freshness, 'completeness');
  const incomplete = hasFields(completeness) && !Array.isArray(completeness)
    ? Object.entries(completeness).filter(([, complete]) => complete !== true).map(([name]) => human(name))
    : [];
  const scope = field(twin, 'scope');
  return {
    kind: 'ready',
    twin,
    access,
    now,
    scope: `${text(field(scope, 'owner'))}/${text(field(scope, 'repo'))}`,
    snapshot: formatTime(field(freshness, 'asOf')),
    freshness: text(field(freshness, 'status')) || 'partial',
    incomplete,
    noPolicies: count(field(field(twin, 'current'), 'policyCount')) === 0,
    archivedCount: items(input.archived).length,
    executor: access.execution.kind === 'installation' ? 'GitHub App execution · human governance actor' : human(access.execution.authMethod || 'user session'),
    readModelHash: hashShort(field(twin, 'readModelHash'))
  };
}
