/*
 * Governance at work: the Policy Digital Twin read with its delivery
 * evidence and archive, and everything a person does to a policy's life --
 * create, draft, edit, validate, submit, simulate, review, activate, roll
 * back, switch off, archive, restore, withdraw, reset -- and to exceptions,
 * notifications, signed exports and webhooks. The screen itself is drawn by
 * GovernanceView.tsx; this is what its buttons do.
 *
 * Every write carries an idempotency key and every one that the ledger keeps
 * a reason for asks for it; each reloads the twin afterwards, so the page
 * shows the server's answer rather than a guess at it. An answer read for a
 * repository that is no longer open is dropped: its notifications, exports,
 * webhooks and archived policies are never shown on another's screen.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field, hasFields, items } from '../../platform/values.ts';
import { defaultSimulationRequest, parseJsonObject } from './governance.ts';
import type { GovernanceInput } from './governance.ts';
import {
  CREATE_POLICY_BODY, DELETE_WEBHOOK_BODY, DISCARD_BODY, EXCEPTION_DECISION_BODY, EXPORT_BODY, RESTORE_BODY, REVOKE_BODY, ROTATE_BODY,
  SECRET_WARNING, SUBMIT_BODY, WEBHOOK_BODY, WITHDRAW_BODY, activationBody, archiveBody, baselineBody, deactivateBody, draftBody,
  editDraftBody, exceptionBody, jsonBody, preferencesBody, resetBody, reviewBody, simulationBody, templatesBody
} from './governance-dialogs.ts';

type Fields = Record<string, unknown>;
type Request = { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: unknown };

/*
 * What the governance slice holds. The twin and its evidence are the
 * server's, read as sent; the page's state holds the slice as plain fields.
 */
export type GovernanceState = {
  [name: string]: unknown;
  digitalTwin?: unknown; access?: unknown; loading?: unknown; error?: unknown; simulation?: unknown; verification?: unknown;
  scopeKey?: unknown; decisionPages?: unknown; archived?: unknown; delivery?: unknown; view?: unknown;
};

export interface GovernanceDeps {
  readonly state: { governance: GovernanceState; readonly work: unknown };
  /* A change to the governance slice, made in place and announced. */
  readonly mutate: (change: (governance: GovernanceState) => void) => void;
  readonly api: (path: string, init?: Request) => Promise<unknown>;
  readonly modal: (request: Dialog) => Promise<unknown>;
  readonly toast: (message: string, kind?: string) => void;
  readonly stepUp: (action: string, scope: unknown, path: string, init: Request, label: string) => Promise<unknown>;
  readonly $: <T extends HTMLElement = HTMLElement>(selector: string) => T | null;
  readonly doc: Pick<Document, 'createElement'> & { readonly body: Pick<HTMLElement, 'appendChild'>; readonly activeElement: unknown };
  readonly storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  readonly draw: (root: HTMLElement | null, input: GovernanceInput) => void;
  readonly requestAnimationFrame: (run: () => void) => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly now: () => number;
  readonly randomId: () => string;
  readonly cssEscape: (value: string) => string;
}

export interface Governance {
  clear(): void;
  render(): void;
  load(force?: boolean): Promise<void>;
  scheduleAccessExpiry(): void;
  announce(message: unknown): void;
  /* The screen's buttons, wired once to `root`. */
  wire(root: HTMLElement | null): void;
  readonly handlers: Readonly<Record<string, (button: HTMLElement) => unknown>>;
}

/* What an action may ask, and the repository it was pressed on. */
type Dialog = { readonly title: string; readonly okText: string; readonly bodyHTML: string; readonly danger?: boolean };
interface Act {
  readonly base: string;
  ask(request: Dialog): Promise<unknown>;
  send(path: string, init?: Request): Promise<unknown>;
  stepUp(action: string, scope: unknown, path: string, init: Request, label: string): Promise<unknown>;
  json(title: string, shown: unknown): Promise<void>;
}
const MOVED = 'Another repository was opened, so nothing more was sent for the last one.';

const freshState = (): GovernanceState => ({
  digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '', decisionPages: [], archived: [],
  delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' }
});

/* A governance view's cleared-through sequence: a positive whole number, or none. */
const seq = (value: unknown): number => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0);
/* A deadline as the server sent it, read the way the Date constructor reads it: a number as milliseconds, anything else as text. */
const instant = (value: unknown): number => new Date(typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : String(value)).getTime();
/* What a thrown failure says, when it says anything. */
const said = (error: unknown): string => { const message = field(error, 'message'); return message ? String(message) : ''; };
/* A control the screen drew: an element that can be pressed, disabled and marked busy. */
const isControl = (value: unknown): value is HTMLButtonElement =>
  hasFields(value) && hasFields(value.dataset) && typeof value.setAttribute === 'function' && typeof value.removeAttribute === 'function';

export function createGovernance(deps: GovernanceDeps): Governance {
  const { state } = deps;
  let expiryTimer: unknown = null;
  const owner = (): unknown => field(state.work, 'owner');
  const repo = (): unknown => field(state.work, 'repo');
  const path = (): string => `${String(owner())}/${String(repo())}`;
  /* Every write is addressed to the repository open; with none open there is nowhere to send it. */
  const base = (): string => {
    if (!state.work) throw new Error('No repository is open.');
    return `/api/repo/${path()}/governance`;
  };
  const value = (selector: string): string => String(deps.$<HTMLInputElement>(selector)?.value ?? '');
  const key = (action: unknown): string => `governance-ui:${String(action || 'write')}:${deps.randomId()}`;
  const headers = (action: string): Record<string, string> => ({ 'Idempotency-Key': key(action) });
  const segment = (part: unknown): string => encodeURIComponent(String(part));
  /* The governance slice asked for is still the one held, for the same repository. */
  const still = (asked: GovernanceState, scope: string): boolean => state.governance === asked && !!state.work && path() === scope;

  function announce(message: unknown): void {
    const live = deps.$('#govLive');
    if (!live) return;
    live.textContent = '';
    deps.requestAnimationFrame(() => { live.textContent = String(message || ''); });
  }

  function clear(): void {
    if (expiryTimer) deps.clearTimeout(expiryTimer);
    expiryTimer = null;
    state.governance = freshState();
    deps.draw(deps.$('#govRoot'), { loading: true });
    const live = deps.$('#govLive');
    if (live) live.textContent = '';
  }

  /* Permission evidence has a deadline; past it, nothing is offered until governance is read again. */
  function scheduleAccessExpiry(): void {
    if (expiryTimer) deps.clearTimeout(expiryTimer);
    expiryTimer = null;
    const access = state.governance.access;
    const expiresAt = instant(field(field(access, 'evidence'), 'expiresAt') || 0);
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, Math.min(expiresAt - deps.now() + 25, 2_147_000_000));
    expiryTimer = deps.setTimeout(() => {
      if (!state.governance.access) return;
      deps.mutate(governance => {
        governance.access = Object.assign({}, governance.access, {
          capabilities: { read: false, author: false, review: false, activate: false, administer: false },
          evidence: Object.assign({}, field(governance.access, 'evidence'), { status: 'stale' })
        });
      });
      render();
      announce('Repository permission evidence expired. Refresh governance before taking action.');
    }, delay);
  }

  /*
   * How this reader is looking at the governance lists: which ledger tab and
   * filter, how far down, what they cleared from view. The view is not
   * evidence -- the ledger is immutable on the server -- and the one thing
   * kept between visits, the sequence each list was cleared through, is a
   * number per repository under a prefix the account purge removes.
   */
  const ledgerViewKey = (): string => `nv_view:ledger:${String(state.governance.scopeKey || '').toLowerCase()}`;
  function freshView(): Fields {
    let cleared: unknown = {};
    try { cleared = JSON.parse(deps.storage().getItem(ledgerViewKey()) || '{}') || {}; } catch { cleared = {}; }
    return { tab: 'decisions', filter: 'all', limit: 0, showCleared: false, showRead: false, inboxLimit: 0, exportsAll: false,
      cleared: { decisions: seq(field(cleared, 'decisions')), activations: seq(field(cleared, 'activations')) } };
  }
  function view(): Fields {
    if (!state.governance.view || field(state.governance.view, 'scope') !== state.governance.scopeKey) {
      deps.mutate(governance => { governance.view = { ...freshView(), scope: governance.scopeKey }; });
    }
    const held = state.governance.view;
    return hasFields(held) ? held : {};
  }
  function render(): void {
    const root = deps.$('#govRoot');
    if (!root) return;
    const governance = state.governance;
    deps.draw(root, {
      view: view(), digitalTwin: governance.digitalTwin, access: governance.access, loading: Boolean(governance.loading), error: governance.error,
      simulation: governance.simulation, verification: governance.verification, delivery: governance.delivery, archived: governance.archived
    });
  }
  function repaint(focusKey: string | undefined): void {
    render();
    const again = focusKey ? deps.$<HTMLButtonElement>(`#govRoot [data-focus-key="${deps.cssEscape(focusKey)}"]`) : null;
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }

  async function load(force = false): Promise<void> {
    if (!state.work || !owner() || !repo() || state.governance.loading) return;
    const expectedScope = path();
    const asked = state.governance;
    if (!force && state.governance.digitalTwin && state.governance.scopeKey === expectedScope) {
      render();
      return;
    }
    deps.mutate(governance => {
      governance.loading = true;
      governance.error = '';
    });
    render();
    try {
      const response = await deps.api(`/api/repo/${expectedScope}/governance/digital-twin?historyLimit=50`);
      if (!state.work || path() !== expectedScope) return;
      const previousHash = field(state.governance.digitalTwin, 'readModelHash');
      deps.mutate(governance => {
        governance.digitalTwin = field(response, 'digitalTwin') || null;
        governance.access = field(response, 'access') || null;
      });
      scheduleAccessExpiry();
      deps.mutate(governance => {
        governance.scopeKey = expectedScope;
        governance.error = '';
      });
      if (previousHash && previousHash !== field(field(response, 'digitalTwin'), 'readModelHash')) {
        deps.mutate(governance => {
          governance.simulation = null;
          governance.verification = null;
          governance.decisionPages = [];
        });
      }
      await Promise.all([loadDelivery(), loadArchive()]);
      if (still(asked, expectedScope)) announce('Policy Digital Twin and delivery evidence refreshed');
    } catch (error) {
      /* A failure is said on the screen of the repository it belongs to, and no other. */
      if (!still(asked, expectedScope)) return;
      deps.mutate(governance => { governance.error = said(error) || 'Policy Digital Twin could not be loaded'; });
      announce(state.governance.error);
    } finally {
      /* A slice let go of meanwhile is not this load's to finish: the next repository's own load may be on its way. */
      if (state.governance === asked) deps.mutate(governance => { governance.loading = false; });
      render();
    }
  }

  async function loadDelivery(): Promise<void> {
    const asked = state.governance;
    const scope = path();
    const requests = [
      deps.api(`${base()}/notifications?limit=50&afterSeq=0`),
      deps.api(`${base()}/notifications/preferences`),
      deps.api(`${base()}/exports?limit=50`)
    ];
    const canAdmin = field(field(state.governance.access, 'capabilities'), 'administer') === true;
    if (canAdmin) requests.push(deps.api(`${base()}/webhooks`));
    const settled = await Promise.allSettled(requests);
    if (!still(asked, scope)) return;
    const answer = (index: number): unknown => { const result = settled[index]; return result && result.status === 'fulfilled' ? result.value : undefined; };
    const errors = settled.filter(item => item.status === 'rejected').map(item => (item.status === 'rejected' && said(item.reason)) || 'Delivery data unavailable');
    deps.mutate(governance => {
      governance.delivery = {
        notifications: settled[0]?.status === 'fulfilled' ? answer(0) : { events: [] },
        preferences: settled[1]?.status === 'fulfilled' ? (field(answer(1), 'preferences') || {}) : {},
        exports: settled[2]?.status === 'fulfilled' ? (field(answer(2), 'exports') || []) : [],
        webhooks: canAdmin && settled[3]?.status === 'fulfilled' ? (field(answer(3), 'webhooks') || []) : [],
        error: errors.join(' · ')
      };
    });
    render();
  }

  /* Archived policies are a separate read: the twin is the governed present, and an archived policy is not part of it. */
  async function loadArchive(): Promise<void> {
    const asked = state.governance;
    const scope = path();
    let archived: unknown[] = [];
    try {
      const response = await deps.api(`${base()}/archive`);
      const policies = field(response, 'policies');
      archived = Array.isArray(policies) ? policies : [];
    } catch { archived = []; }
    if (!still(asked, scope)) return;
    deps.mutate(governance => { governance.archived = archived; });
  }

  async function verifyDecisionChain(): Promise<void> {
    const asked = state.governance;
    const scope = path();
    const response = await deps.api(`/api/repo/${scope}/governance/decisions/verify?limit=50000`);
    if (!still(asked, scope)) return;
    deps.mutate(governance => { governance.verification = field(response, 'verification') || response; });
    render();
    announce(field(state.governance.verification, 'valid') === true ? 'Decision chain verified' : 'Decision chain verification failed');
  }

  async function loadMoreDecisions(at: unknown, order = 'desc'): Promise<void> {
    const cursor = Number(at);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Decision cursor is invalid');
    const direction = order === 'desc' ? 'beforeSeq' : 'afterSeq';
    const scope = path();
    const asked = state.governance;
    const response = await deps.api(`/api/repo/${scope}/governance/decisions?limit=50&${direction}=${cursor}`);
    if (!still(asked, scope)) return;
    const page = field(response, 'decisions') ? response : (field(response, 'result') || response);
    const twin = state.governance.digitalTwin;
    const decisions = field(page, 'decisions');
    if (!twin || !page || !Array.isArray(decisions)) return;
    const history = field(twin, 'history');
    const existing = items(field(history, 'decisions'));
    const seen = new Set(existing.map(item => Number(field(item, 'seq'))));
    const merged = existing.concat(decisions.filter(item => !seen.has(Number(field(item, 'seq')))));
    deps.mutate(governance => {
      governance.digitalTwin = Object.assign({}, twin, {
        history: Object.assign({}, history, { decisions: merged }, order === 'desc'
          ? { nextBeforeDecisionSeq: field(page, 'complete') ? null : field(page, 'nextBeforeSeq') }
          : { nextDecisionSeq: field(page, 'complete') ? null : field(page, 'nextAfterSeq') })
      });
    });
    render();
    announce(`${decisions.length} more decisions loaded`);
  }

  function policyOf(policyId: unknown): unknown {
    const policies = field(field(state.governance.digitalTwin, 'current'), 'policies');
    return Array.isArray(policies) ? policies.find(item => field(item, 'policyId') === policyId) : null;
  }
  const defaultDocument = (): Fields => ({ schemaVersion: 1, description: 'Repository governance policy.', enforcement: { mode: 'observe' }, rules: [] });
  const defaultApproval = (): Fields => ({ requiredApprovals: 1, disallowAuthorApproval: true });
  /*
   * An action belongs to the repository it was pressed on. Every request it
   * sends, every dialog it asks and every answer it reads is checked against
   * that repository and its governance: once another repository is open, or
   * the account changed and governance was let go of, the action stops, and
   * nothing more is sent for the repository it was for. A confirmed dialog
   * used to be sent to whichever repository was open by then.
   */
  function begin(): Act {
    const work = state.work;
    const held = state.governance;
    const at = base();
    const check = (): void => { if (state.work !== work || state.governance !== held) throw new Error(MOVED); };
    const ask = async (request: Dialog): Promise<unknown> => {
      check();
      const answer = await deps.modal(request);
      if (answer) check();
      return answer;
    };
    return {
      base: at,
      ask,
      async send(path, init) { check(); const answer = await deps.api(path, init); check(); return answer; },
      async stepUp(action, scope, path, init, label) { check(); const answer = await deps.stepUp(action, scope, path, init, label); check(); return answer; },
      /* Evidence shown for reading. It is always shown straight after the send that read it, which checked; nothing follows it. */
      async json(title, shown) { await deps.modal({ title, okText: 'Close', bodyHTML: jsonBody(shown) }); }
    };
  }
  function readJson(selector: string, label: string): Fields {
    const element = deps.$<HTMLTextAreaElement>(selector);
    if (!element) throw new Error(`${label} input is unavailable`);
    return parseJsonObject(element.value, label);
  }

  async function createPolicy(): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Create governance policy', okText: 'Create policy', bodyHTML: CREATE_POLICY_BODY });
    if (!ok) return;
    const policyKey = value('#govPolicyKey').trim();
    const name = value('#govPolicyName').trim();
    if (!policyKey || !name) throw new Error('Policy key and name are required');
    await act.send(`${act.base}/policies`, { method: 'POST', headers: headers('policy-create'), body: { policyKey, name, description: value('#govPolicyDescription').trim() } });
    deps.toast('Governance policy created', 'ok');
    await load(true);
  }

  async function createDraft(policyId: unknown, seed?: unknown): Promise<void> {
    const act = begin();
    let document: unknown = field(seed, 'document') || defaultDocument();
    let approvalPolicy: unknown = field(seed, 'approvalPolicy') || defaultApproval();
    const ok = await act.ask({ title: 'Create policy draft', okText: 'Create draft', bodyHTML: draftBody(document, approvalPolicy) });
    if (!ok) return;
    document = readJson('#govDraftDocument', 'Policy document');
    approvalPolicy = readJson('#govDraftApproval', 'Approval policy');
    await act.send(`${act.base}/policies/${segment(policyId)}/drafts`, { method: 'POST', headers: headers('draft-create'), body: { document, approvalPolicy } });
    deps.toast('Draft created', 'ok');
    await load(true);
  }

  async function generateBaseline(): Promise<void> {
    const act = begin();
    const catalog = await act.send(`${act.base}/templates`);
    const listed = field(catalog, 'templates');
    const templates = Array.isArray(listed) ? listed : items(field(listed, 'templates'));
    if (!templates.length) throw new Error('No governance templates are available');
    const ok = await act.ask({ title: 'Generate repository baseline', okText: 'Generate', bodyHTML: templatesBody(templates) });
    if (!ok) return;
    const templateId = value('#govTemplateId');
    const selected = templates.find(item => field(item, 'templateId') === templateId) || {};
    const response = await act.send(`${act.base}/baselines/generate`, { method: 'POST', body: { templateId } });
    const baseline = field(response, 'baseline');
    const accept = await act.ask({ title: 'Baseline generated', okText: 'Create policy and draft', bodyHTML: baselineBody(baseline, selected) });
    if (!accept) return;
    const created = await act.send(`${act.base}/policies`, {
      method: 'POST', headers: headers('baseline-policy-create'),
      body: { policyKey: value('#govBaselineKey').trim(), name: value('#govBaselineName').trim(), description: `Generated from ${String(field(baseline, 'templateId'))}` }
    });
    await act.send(`${act.base}/policies/${segment(field(field(created, 'policy'), 'policyId'))}/drafts`, {
      method: 'POST', headers: headers('baseline-draft-create'),
      body: { document: field(baseline, 'document'), approvalPolicy: field(baseline, 'approvalPolicy') }
    });
    deps.toast('Baseline policy draft created', 'ok');
    await load(true);
  }

  async function inspectPolicy(policyId: unknown): Promise<void> {
    const act = begin();
    const [policy, versions] = await Promise.all([
      act.send(`${act.base}/policies/${segment(policyId)}`),
      act.send(`${act.base}/policies/${segment(policyId)}/versions?limit=100`)
    ]);
    await act.json('Policy state', { policy: field(policy, 'policy'), versions: field(versions, 'versions') });
  }

  async function editDraft(policyId: unknown, draftId: unknown): Promise<void> {
    const act = begin();
    const response = await act.send(`${act.base}/policies/${segment(policyId)}/drafts/${segment(draftId)}`);
    const draft = field(response, 'draft');
    const approvalPolicy = { requiredApprovals: field(draft, 'requiredApprovals'), disallowAuthorApproval: field(draft, 'disallowAuthorApproval') };
    const ok = await act.ask({ title: `Edit draft r${String(field(draft, 'revision'))}`, okText: 'Save draft', bodyHTML: editDraftBody(field(draft, 'document'), approvalPolicy) });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/drafts/${segment(draftId)}`, {
      method: 'PATCH', headers: headers('draft-update'),
      body: { expectedRevision: field(draft, 'revision'), document: readJson('#govEditDocument', 'Policy document'), approvalPolicy: readJson('#govEditApproval', 'Approval policy') }
    });
    deps.toast('Draft saved', 'ok');
    await load(true);
  }

  async function validateDraft(policyId: unknown, draftId: unknown): Promise<void> {
    const act = begin();
    const response = await act.send(`${act.base}/policies/${segment(policyId)}/drafts/${segment(draftId)}/validate`, { method: 'POST', body: {} });
    await act.json('Draft validation', field(response, 'validation'));
  }

  async function submitDraft(policyId: unknown, draftId: unknown, revision: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Submit immutable version?', danger: true, okText: 'Submit version', bodyHTML: SUBMIT_BODY });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/drafts/${segment(draftId)}/submit`, { method: 'POST', headers: headers('draft-submit'), body: { expectedRevision: Number(revision) } });
    deps.toast('Immutable policy version submitted', 'ok');
    await load(true);
  }

  async function viewVersion(policyId: unknown, versionId: unknown): Promise<void> {
    const act = begin();
    const response = await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}`);
    await act.json('Immutable policy version', field(response, 'version'));
  }

  async function simulate(policyId: unknown, versionId: unknown, act: Act = begin()): Promise<unknown> {
    const held = state.governance.simulation;
    const previous = held && field(held, 'policyId') === policyId && field(held, 'versionId') === versionId
      ? field(held, 'request')
      : defaultSimulationRequest(field(state.work, 'default_branch') || field(state.work, 'branch') || 'main');
    const ok = await act.ask({ title: 'Simulate policy version', okText: 'Run simulation', bodyHTML: simulationBody(previous) });
    if (!ok) return null;
    const request = readJson('#govSimulationRequest', 'Simulation request');
    const response = await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/simulate`, { method: 'POST', body: request });
    const report = field(response, 'simulation');
    deps.mutate(governance => { governance.simulation = { policyId, versionId, request, report }; });
    render();
    announce(field(field(report, 'activationReadiness'), 'eligible') ? 'Simulation is eligible for activation review' : 'Simulation contains activation blockers');
    await act.json('Simulation evidence', report);
    return state.governance.simulation;
  }

  async function claimReview(policyId: unknown, versionId: unknown): Promise<void> {
    const act = begin();
    await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/reviewers/me`, { method: 'POST', headers: headers('review-claim'), body: {} });
    deps.toast('Review assignment claimed', 'ok');
    await load(true);
  }

  async function decideReview(policyId: unknown, versionId: unknown, decision: 'approve' | 'reject'): Promise<void> {
    const act = begin();
    const rejecting = decision === 'reject';
    const ok = await act.ask({
      title: rejecting ? 'Reject policy version' : 'Approve policy version', danger: rejecting, okText: rejecting ? 'Reject' : 'Approve',
      bodyHTML: reviewBody(rejecting)
    });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/decisions`, {
      method: 'POST', headers: headers(`review-${decision}`), body: { decision, rationale: value('#govReviewRationale').trim() }
    });
    deps.toast(`Policy version ${decision === 'approve' ? 'approved' : 'rejected'}`, 'ok');
    await load(true);
  }

  async function activateOrRollback(policyId: unknown, versionId: unknown, operation: 'activate' | 'rollback', wording: { readonly title: string; readonly okText: string; readonly body: string } | null = null): Promise<void> {
    const act = begin();
    let simulation = state.governance.simulation;
    const eligible = (held: unknown): boolean => field(field(field(held, 'report'), 'activationReadiness'), 'eligible') === true;
    if (!simulation || field(simulation, 'policyId') !== policyId || field(simulation, 'versionId') !== versionId || !eligible(simulation)) {
      simulation = await simulate(policyId, versionId, act);
    }
    if (!simulation || !field(field(field(simulation, 'report'), 'activationReadiness'), 'eligible')) throw new Error('An eligible fresh simulation is required');
    const policy = policyOf(policyId) || field(await act.send(`${act.base}/policies/${segment(policyId)}`), 'policy');
    const ok = await act.ask({
      title: wording ? wording.title : operation === 'rollback' ? 'Rollback active policy?' : 'Activate policy version?', danger: true,
      okText: wording ? wording.okText : operation === 'rollback' ? 'Rollback' : 'Activate',
      bodyHTML: activationBody(wording ? wording.body : null)
    });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/${operation}`, {
      method: 'POST', headers: headers(`policy-${operation}`),
      body: { expectedRevision: Number(field(policy, 'revision')), reason: value('#govActivationReason').trim(), simulation: { simulationHash: field(field(simulation, 'report'), 'simulationHash'), request: field(simulation, 'request') } }
    });
    deps.mutate(governance => { governance.simulation = null; });
    deps.toast(operation === 'rollback' ? 'Policy rolled back' : 'Policy activated', 'ok');
    await load(true);
  }

  async function requestException(policyId: unknown, versionId: unknown): Promise<void> {
    const act = begin();
    const tomorrow = new Date(deps.now() + 24 * 60 * 60 * 1000);
    tomorrow.setSeconds(0, 0);
    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const ok = await act.ask({ title: 'Request exception or waiver', okText: 'Submit request', bodyHTML: exceptionBody(field(state.work, 'branch'), local) });
    if (!ok) return;
    /* An expiry left empty, or one the browser could not read, is asked for again in words, not as "Invalid time value". */
    const expires = new Date(value('#govExceptionExpires'));
    if (Number.isNaN(expires.getTime())) throw new Error('Choose when the exception expires.');
    const expiresAt = expires.toISOString();
    const ruleIds = value('#govExceptionRules').split(',').map(rule => rule.trim()).filter(Boolean);
    await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/exceptions`, {
      method: 'POST', headers: headers('exception-request'),
      body: { kind: value('#govExceptionKind'), action: value('#govExceptionAction').trim(), ruleIds, target: readJson('#govExceptionTarget', 'Mutation target'), reason: value('#govExceptionReason').trim(), expiresAt }
    });
    deps.toast('Exception request submitted', 'ok');
    await load(true);
  }

  async function viewException(exceptionId: unknown): Promise<void> {
    const act = begin();
    const response = await act.send(`${act.base}/exceptions/${segment(exceptionId)}`);
    await act.json('Exception evidence', field(response, 'exception'));
  }

  async function decideException(exceptionId: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Decide exception request', okText: 'Record decision', danger: true, bodyHTML: EXCEPTION_DECISION_BODY });
    if (!ok) return;
    await act.send(`${act.base}/exceptions/${segment(exceptionId)}/decision`, {
      method: 'POST', headers: headers('exception-decision'), body: { decision: value('#govExceptionDecision'), reason: value('#govExceptionDecisionReason').trim() }
    });
    deps.toast('Exception decision recorded', 'ok');
    await load(true);
  }

  async function revokeException(exceptionId: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Revoke exception?', danger: true, okText: 'Revoke', bodyHTML: REVOKE_BODY });
    if (!ok) return;
    await act.send(`${act.base}/exceptions/${segment(exceptionId)}/revoke`, { method: 'POST', headers: headers('exception-revoke'), body: { reason: value('#govExceptionRevokeReason').trim() } });
    deps.toast('Exception revoked', 'ok');
    await load(true);
  }

  async function editNotificationPreferences(): Promise<void> {
    const act = begin();
    const current = field(state.governance.delivery, 'preferences') || {};
    const enabled = field(current, 'enabled') !== false;
    const eventTypes = field(current, 'eventTypes');
    const types = Array.isArray(eventTypes) ? eventTypes.join('\n') : '';
    const ok = await act.ask({ title: 'Notification preferences', okText: 'Save preferences', bodyHTML: preferencesBody(enabled, types) });
    if (!ok) return;
    const chosen = value('#govNotificationTypes').split(/\r?\n/).map(type => type.trim()).filter(Boolean);
    await act.send(`${act.base}/notifications/preferences`, { method: 'PUT', headers: headers('notification-preferences'), body: { enabled: !!deps.$<HTMLInputElement>('#govNotificationEnabled')?.checked, eventTypes: chosen } });
    await loadDelivery();
  }

  async function markNotificationsRead(throughSeq: unknown): Promise<void> {
    const act = begin();
    await act.send(`${act.base}/notifications/read`, { method: 'POST', headers: headers('notification-read'), body: { throughSeq: Number(throughSeq) } });
    await loadDelivery();
  }

  async function createExport(): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Create signed evidence export', okText: 'Create export', bodyHTML: EXPORT_BODY });
    if (!ok) return;
    await act.send(`${act.base}/exports`, { method: 'POST', headers: headers('audit-export'), body: { format: value('#govExportFormat'), afterEventSeq: 0, limit: Number(value('#govExportLimit')) } });
    await loadDelivery();
  }

  function downloadExport(exportId: unknown): void {
    const act = begin();
    const link = deps.doc.createElement('a');
    link.href = `${act.base}/exports/${segment(exportId)}`;
    deps.doc.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function verifyExport(exportId: unknown): Promise<void> {
    const act = begin();
    const result = await act.send(`${act.base}/exports/${segment(exportId)}/verify`);
    await act.json('Evidence export verification', field(result, 'verification') || result);
  }

  async function createWebhook(): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Add governance webhook', okText: 'Create webhook', bodyHTML: WEBHOOK_BODY });
    if (!ok) return;
    const result = await act.send(`${act.base}/webhooks`, { method: 'POST', headers: headers('webhook-create'), body: { name: value('#govWebhookName').trim(), url: value('#govWebhookUrl').trim(), eventTypes: value('#govWebhookTypes').split(/\r?\n/).map(type => type.trim()).filter(Boolean), enabled: true } });
    await act.json('Webhook signing secret — save now', { signingSecret: field(result, 'signingSecret'), warning: SECRET_WARNING });
    await loadDelivery();
  }

  async function rotateWebhook(webhookId: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Rotate webhook secret?', danger: true, okText: 'Rotate secret', bodyHTML: ROTATE_BODY });
    if (!ok) return;
    const result = await act.send(`${act.base}/webhooks/${segment(webhookId)}/rotate-secret`, { method: 'POST', headers: headers('webhook-rotate'), body: {} });
    await act.json('Rotated webhook secret — save now', { signingSecret: field(result, 'signingSecret'), warning: SECRET_WARNING });
    await loadDelivery();
  }

  async function deleteWebhook(webhookId: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: 'Delete webhook?', danger: true, okText: 'Delete webhook', bodyHTML: DELETE_WEBHOOK_BODY });
    if (!ok) return;
    await act.send(`${act.base}/webhooks/${segment(webhookId)}`, { method: 'DELETE', headers: headers('webhook-delete'), body: {} });
    await loadDelivery();
  }

  /*
   * The rest of a policy's life. Each asks for a reason where the ledger will
   * keep one, says what happens and what is kept before it happens, and
   * reloads the twin afterwards.
   */
  function reason(selector: string): string {
    const typed = value(selector).trim();
    if (!typed) throw new Error('A reason is required; it is kept in the governance ledger.');
    return typed;
  }
  function policyName(policyId: unknown): string {
    const policy = policyOf(policyId);
    return policy ? String(field(policy, 'name') || field(policy, 'policyKey')) : 'this policy';
  }

  async function deactivatePolicy(policyId: unknown, revision: unknown, versionNumber: unknown): Promise<void> {
    const act = begin();
    const name = policyName(policyId);
    const ok = await act.ask({ title: `Switch off ${name}?`, danger: true, okText: 'Switch off', bodyHTML: deactivateBody(versionNumber) });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/deactivate`, { method: 'POST', headers: headers('policy-deactivate'), body: { expectedRevision: Number(revision), reason: reason('#govLifecycleReason') } });
    deps.toast(`${name} switched off`, 'ok');
    await load(true);
  }

  async function reactivatePolicy(policyId: unknown, versionId: unknown): Promise<void> {
    const act = begin();
    const name = policyName(policyId);
    await activateOrRollback(policyId, versionId, 'rollback', {
      title: `Turn ${name} back on?`, okText: 'Turn back on',
      body: 'The version that was running when it was switched off becomes active again, checked against a fresh simulation.'
    });
  }

  async function archivePolicy(policyId: unknown, revision: unknown, active: boolean): Promise<void> {
    const act = begin();
    const name = policyName(policyId);
    const ok = await act.ask({ title: `Archive ${name}?`, danger: true, okText: 'Archive', bodyHTML: archiveBody(active) });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/archive`, { method: 'POST', headers: headers('policy-archive'), body: { expectedRevision: Number(revision), reason: reason('#govLifecycleReason') } });
    deps.toast(`${name} archived`, 'ok');
    await load(true);
  }

  async function restorePolicy(policyId: unknown, name: string): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: `Restore ${name}?`, okText: 'Restore', bodyHTML: RESTORE_BODY });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/restore`, { method: 'POST', headers: headers('policy-restore'), body: { reason: reason('#govLifecycleReason') } });
    deps.toast(`${name} restored, switched off`, 'ok');
    await load(true);
  }

  async function discardDraft(policyId: unknown, draftId: unknown, revision: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: `Discard draft r${escapeHtml(revision)}?`, danger: true, okText: 'Discard draft', bodyHTML: DISCARD_BODY });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/drafts/${segment(draftId)}`, { method: 'DELETE', headers: headers('draft-discard'), body: { expectedRevision: Number(revision) } });
    deps.toast('Draft discarded', 'ok');
    await load(true);
  }

  async function withdrawVersion(policyId: unknown, versionId: unknown, versionNumber: unknown): Promise<void> {
    const act = begin();
    const ok = await act.ask({ title: `Withdraw v${escapeHtml(versionNumber)}?`, danger: true, okText: 'Withdraw version', bodyHTML: WITHDRAW_BODY });
    if (!ok) return;
    await act.send(`${act.base}/policies/${segment(policyId)}/versions/${segment(versionId)}/withdraw`, { method: 'POST', headers: headers('version-withdraw'), body: { reason: reason('#govLifecycleReason') } });
    deps.toast(`v${String(versionNumber)} withdrawn`, 'ok');
    await load(true);
  }

  async function reset(total: unknown, running: unknown): Promise<void> {
    const act = begin();
    const ownerName = owner();
    const repoName = repo();
    const name = `${String(ownerName)}/${String(repoName)}`;
    const ok = await act.ask({ title: `Reset governance for ${name}?`, danger: true, okText: 'Reset governance', bodyHTML: resetBody(name, total, running) });
    if (!ok) return;
    const why = reason('#govLifecycleReason');
    const confirm = value('#govResetConfirm').trim();
    if (confirm.toLowerCase() !== name.toLowerCase()) throw new Error(`Type ${name} exactly to reset its governance.`);
    const result = await act.stepUp('governance.reset', { owner: ownerName, repo: repoName }, `${act.base}/reset`, {
      method: 'POST', headers: headers('reset'), body: { reason: why, confirm }
    }, 'Reset repository governance');
    if (!result) return;
    const done = field(result, 'reset') || {};
    deps.toast(`Governance reset: ${Number(field(done, 'archivedCount') || 0)} archived, ${Number(field(done, 'deactivatedCount') || 0)} switched off`, 'ok');
    await load(true);
  }

  /* The ledger's view: a tab, a filter, how far down, and what was cleared from view (kept per repository). */
  function setView(change: (current: Fields) => void, focusKey: string | undefined): void {
    const current = view();
    deps.mutate(() => { change(current); });
    repaint(focusKey);
  }

  const data = (button: HTMLElement, name: string): string | undefined => button.dataset[name];
  const handlers: Readonly<Record<string, (button: HTMLElement) => unknown>> = Object.freeze({
    refresh: () => load(true),
    'create-policy': () => createPolicy(),
    'generate-baseline': () => generateBaseline(),
    'select-policy': button => inspectPolicy(data(button, 'policyId')),
    'new-draft': button => createDraft(data(button, 'policyId')),
    'edit-draft': button => editDraft(data(button, 'policyId'), data(button, 'draftId')),
    'validate-draft': button => validateDraft(data(button, 'policyId'), data(button, 'draftId')),
    'submit-draft': button => submitDraft(data(button, 'policyId'), data(button, 'draftId'), data(button, 'revision')),
    'view-version': button => viewVersion(data(button, 'policyId'), data(button, 'versionId')),
    simulate: button => simulate(data(button, 'policyId'), data(button, 'versionId')),
    'claim-review': button => claimReview(data(button, 'policyId'), data(button, 'versionId')),
    approve: button => decideReview(data(button, 'policyId'), data(button, 'versionId'), 'approve'),
    reject: button => decideReview(data(button, 'policyId'), data(button, 'versionId'), 'reject'),
    activate: button => activateOrRollback(data(button, 'policyId'), data(button, 'versionId'), 'activate'),
    rollback: button => activateOrRollback(data(button, 'policyId'), data(button, 'versionId'), 'rollback'),
    'request-exception': button => requestException(data(button, 'policyId'), data(button, 'versionId')),
    'view-exception': button => viewException(data(button, 'exceptionId')),
    'decide-exception': button => decideException(data(button, 'exceptionId')),
    'revoke-exception': button => revokeException(data(button, 'exceptionId')),
    'verify-chain': () => verifyDecisionChain(),
    'load-more-decisions': button => loadMoreDecisions(data(button, 'beforeSeq') || data(button, 'afterSeq'), data(button, 'beforeSeq') ? 'desc' : 'asc'),
    'delivery-refresh': () => loadDelivery(),
    'edit-notification-preferences': () => editNotificationPreferences(),
    'mark-notifications-read': button => markNotificationsRead(data(button, 'throughSeq')),
    'create-export': () => createExport(),
    'download-export': button => downloadExport(data(button, 'exportId')),
    'verify-export': button => verifyExport(data(button, 'exportId')),
    'create-webhook': () => createWebhook(),
    'rotate-webhook': button => rotateWebhook(data(button, 'webhookId')),
    'delete-webhook': button => deleteWebhook(data(button, 'webhookId')),
    'deactivate-policy': button => deactivatePolicy(data(button, 'policyId'), data(button, 'revision'), data(button, 'versionNumber')),
    'reactivate-policy': button => reactivatePolicy(data(button, 'policyId'), data(button, 'versionId')),
    'archive-policy': button => archivePolicy(data(button, 'policyId'), data(button, 'revision'), data(button, 'active') === 'true'),
    'restore-policy': button => restorePolicy(data(button, 'policyId'), data(button, 'name') || 'this policy'),
    'discard-draft': button => discardDraft(data(button, 'policyId'), data(button, 'draftId'), data(button, 'revision')),
    'withdraw-version': button => withdrawVersion(data(button, 'policyId'), data(button, 'versionId'), data(button, 'versionNumber')),
    'reset-governance': button => reset(data(button, 'total'), data(button, 'running')),
    'ledger-tab': button => {
      const current = view();
      if (current.tab !== data(button, 'tab')) deps.mutate(() => { Object.assign(current, { tab: data(button, 'tab') === 'activations' ? 'activations' : 'decisions', filter: 'all', limit: 0 }); });
      repaint(data(button, 'focusKey'));
    },
    'ledger-filter': button => {
      deps.mutate(() => { Object.assign(view(), { filter: data(button, 'filter'), limit: 0 }); });
      repaint(data(button, 'focusKey'));
    },
    'ledger-more': button => setView(current => { current.limit = (Number(current.limit) || 8) + 8; }, data(button, 'focusKey')),
    'ledger-clear': button => {
      const current = view();
      const tab = String(current.tab);
      deps.mutate(() => {
        const cleared = current.cleared;
        current.cleared = Object.assign({}, cleared, { [tab]: Math.max(Number(field(cleared, tab)) || 0, Number(data(button, 'through')) || 0) });
        Object.assign(current, { showCleared: false, limit: 0 });
      });
      try { deps.storage().setItem(ledgerViewKey(), JSON.stringify(current.cleared)); } catch { /* the view is this page's only */ }
      announce(`${tab === 'activations' ? 'Activations' : 'Runtime decisions'} cleared from view; the ledger keeps every entry`);
      repaint('ledger-show-cleared');
    },
    'ledger-show-cleared': button => setView(current => { current.showCleared = !current.showCleared; }, data(button, 'focusKey')),
    'inbox-more': button => setView(current => { current.inboxLimit = (Number(current.inboxLimit) || 6) + 6; }, data(button, 'focusKey')),
    'inbox-show-read': button => setView(current => { current.showRead = !current.showRead; }, data(button, 'focusKey')),
    'exports-all': button => setView(current => { current.exportsAll = !current.exportsAll; }, data(button, 'focusKey'))
  });

  /*
   * A control whose action is running is busy, not disabled. The screen is
   * drawn in place, so the control pressed is still there when its action
   * ends, and whether it may be pressed is the view's to say.
   */
  function wire(root: HTMLElement | null): void {
    if (!root) return;
    const busy = new WeakSet<object>();
    root.addEventListener('click', async event => {
      const find = field(event.target, 'closest');
      const button: unknown = typeof find === 'function' ? find.call(event.target, '[data-gov-action]') : null;
      if (!isControl(button) || button.disabled || busy.has(button)) return;
      const action = String(button.dataset.govAction);
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
      if (!handler) return;
      const previousFocus = deps.doc.activeElement;
      busy.add(button);
      button.setAttribute('aria-busy', 'true');
      try { await handler(button); } catch (error) {
        const message = said(error) || 'Governance action failed';
        deps.toast(message, 'err');
        announce(message);
      } finally {
        busy.delete(button);
        button.removeAttribute('aria-busy');
        const focus = field(previousFocus, 'focus');
        if (previousFocus && field(previousFocus, 'isConnected') && typeof focus === 'function') focus.call(previousFocus);
      }
    });
  }

  return { clear, render, load, scheduleAccessExpiry, announce, wire, handlers };
}
