/*
 * The team's decisions about an audit's findings, made from the audit: a
 * finding marked a false positive or its risk accepted for a while, a
 * decision taken back, and every decision about a finding read back with who
 * made it. After each, the page re-scores what it shows with the engine's own
 * scoring on the server, so the grade, the fix-first list and the ledger read
 * as the next audit will, and the clocks are read again. A finding is opened
 * in the editor at its line.
 *
 * Every answer belongs to the audit it was asked from: a decision or a
 * scoring that comes back after the reader opened another repository or
 * branch, or ran the audit again, changes nothing on the page.
 */
import { field, items } from '../../platform/values.ts';
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import type { AuditView } from './audit-controller.ts';

export const TRIAGE_EVENT_WORD: Readonly<Record<string, string>> = Object.freeze({ 'false-positive': 'Marked a false positive', 'accepted-risk': 'Accepted the risk' });
const DAY_MS = 24 * 60 * 60 * 1000;
const ID = /^[a-z-]{2,40}$/;

/* A day and a moment the way the audit says them everywhere: Jan 2, 2027 and Oct 4, 2026, 5:25 PM. */
export function auditDay(at: unknown): string {
  const date = new Date(at as string);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function auditMoment(at: unknown): string {
  const date = new Date(at as string);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* The reasons offered for a decision: the vocabulary's, for that decision. */
export function reasonOptions(vocabulary: unknown, disposition: string): string {
  return items(field(vocabulary, 'reasons'))
    .filter(reason => field(reason, 'disposition') === disposition && ID.test(String(field(reason, 'id'))))
    .map((reason, index) => `<option value="${String(field(reason, 'id'))}"${index === 0 ? ' selected' : ''}>${escapeHtml(field(reason, 'label'))}</option>`).join('');
}

interface ModalBody {
  querySelector(selector: string): { value?: string; innerHTML?: string; hidden?: boolean } | null;
  querySelectorAll(selector: string): Iterable<{ addEventListener(type: string, listener: () => void): void }>;
}

export interface AuditTriageDeps {
  readonly api: (path: string, options?: unknown) => Promise<unknown>;
  /* The open repository: owner, name and branch. */
  readonly work: () => unknown;
  /* The audit's view as it is now. */
  readonly view: () => AuditView;
  readonly modal: (request: Record<string, unknown>) => Promise<unknown>;
  /* What the decision's dialog holds once it closes. */
  readonly chosen: () => { readonly disposition: string; readonly reason: string; readonly days: string };
  readonly paint: () => void;
  /* The clocks read again. */
  readonly metrics: () => void;
  readonly toast: (message: string, kind?: string) => void;
  readonly now: () => number;
  readonly showEditor: () => void;
  readonly openFile: (path: string) => Promise<unknown>;
  readonly editor: () => { setCursor(at: unknown): void; scrollIntoView(at: unknown, margin: number): void; focus(): void } | null;
}

export interface AuditTriage {
  decide(finding: unknown): Promise<void>;
  reopen(finding: unknown): Promise<void>;
  history(finding: unknown): Promise<void>;
  open(finding: unknown): Promise<void>;
}

const text = (value: unknown): string => (value == null ? '' : String(value));

export function createAuditTriage(deps: AuditTriageDeps): AuditTriage {
  const base = (): string => `/api/repo/${text(field(deps.work(), 'owner'))}/${text(field(deps.work(), 'repo'))}/code-audit`;

  /*
   * After a decision the page re-scores what it shows with the engine's own
   * scoring on the server, without keeping a second copy of the rules here.
   * A scoring that fails, or answers without a score and a grade, leaves the
   * grade as it was and says so.
   */
  async function rescore(view: AuditView): Promise<void> {
    const result = view.result;
    const findings = items(field(result, 'findings')).map(finding => {
      const detail = field(finding, 'detail') || {};
      const risk = field(field(detail, 'risk'), 'score');
      return {
        id: field(finding, 'id'), rule: field(finding, 'rule'), category: field(finding, 'category'), severity: field(finding, 'severity'), verdict: field(finding, 'verdict'),
        open: field(field(finding, 'reach'), 'auth') === 'open',
        exploited: Boolean(field(field(detail, 'intel'), 'exploited')),
        tier: field(field(detail, 'usage'), 'tier') || null,
        risk: Number.isFinite(risk) ? risk : null,
        direct: field(detail, 'direct') === true
      };
    });
    try {
      const scored = await deps.api('/api/code-audit/score', { method: 'POST', body: { findings } });
      if (view !== deps.view() || !scored) return;
      if (!Number.isFinite(field(scored, 'score')) || typeof field(scored, 'grade') !== 'string') throw new Error('');
      const counts = new Map(items(field(scored, 'ledger')).map(entry => [field(entry, 'id'), entry]));
      const ledger = field(result, 'ledger');
      const categories = field(scored, 'categories');
      const priorities = field(scored, 'priorities');
      view.result = {
        ...(result as Record<string, unknown>),
        score: field(scored, 'score'), grade: field(scored, 'grade'), capped: field(scored, 'capped'), capReason: field(scored, 'capReason'),
        categories: Array.isArray(categories) ? categories : field(result, 'categories'),
        priorities: Array.isArray(priorities) ? priorities : field(result, 'priorities'),
        ledger: Array.isArray(ledger)
          ? ledger.map(entry => (counts.has(field(entry, 'id')) ? { ...entry, confirmed: field(counts.get(field(entry, 'id')), 'confirmed'), toConfirm: field(counts.get(field(entry, 'id')), 'toConfirm') } : entry))
          : ledger
      };
    } catch {
      if (view === deps.view()) deps.toast('The grade will reflect this decision on the next audit', 'ok');
    }
  }

  async function decide(finding: unknown): Promise<void> {
    const view = deps.view();
    const vocabulary = field(view.triage, 'vocabulary');
    if (!finding || !view.result || !Array.isArray(field(vocabulary, 'dispositions')) || !Array.isArray(field(vocabulary, 'reasons'))) return;
    const dispositions = items(field(vocabulary, 'dispositions')).filter(item => ID.test(String(field(item, 'id'))));
    const days = field(vocabulary, 'acceptDays') || { choices: [30, 90, 180], default: 90 };
    const path = field(finding, 'path');
    const line = field(finding, 'line');
    const where = path ? `${text(path)}${line ? `:${text(line)}` : ''}` : text(field(finding, 'where')) || 'whole repository';
    const first = dispositions[0] ? String(field(dispositions[0], 'id')) : '';
    const ok = await deps.modal({
      title: 'Triage this finding',
      okText: 'Record decision',
      bodyHTML: `
      <p class="triage-target"><b>${escapeHtml(field(finding, 'title'))}</b><span class="mono">${escapeHtml(where)} \u00b7 ${escapeHtml(field(finding, 'rule'))}</span></p>
      <fieldset class="triage-field">
        <legend class="field-label">Decision</legend>
        <div class="triage-options">${dispositions.map((item, index) => `
          <label class="triage-option"><input type="radio" name="triageDisposition" value="${String(field(item, 'id'))}"${index === 0 ? ' checked' : ''}>
            <span class="triage-option-text"><b>${escapeHtml(field(item, 'label'))}</b><small>${escapeHtml(field(item, 'hint') || '')}</small></span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field-label" for="triageReason">Reason</label>
      <select id="triageReason">${reasonOptions(vocabulary, first)}</select>
      <div id="triageDaysWrap" hidden>
        <label class="field-label" for="triageDays">Accept until</label>
        <select id="triageDays">${items(field(days, 'choices')).filter(Number.isInteger).map(choice => `<option value="${String(choice)}"${choice === field(days, 'default') ? ' selected' : ''}>${String(choice)} days, until ${escapeHtml(auditDay(deps.now() + (choice as number) * DAY_MS))}</option>`).join('')}</select>
      </div>
      <p class="hint triage-hint">Recorded with your name and shared with the repository\u2019s collaborators. It leaves the grade and the merge gate, stays listed with its reason, and anyone with reviewer access can reopen it.</p>`,
      onOpen: (body: ModalBody) => {
        const sync = (): void => {
          const chosen = body.querySelector('input[name="triageDisposition"]:checked');
          const disposition = chosen ? text(chosen.value) : '';
          const reason = body.querySelector('#triageReason');
          if (reason) reason.innerHTML = reasonOptions(vocabulary, disposition);
          const wrap = body.querySelector('#triageDaysWrap');
          if (wrap) wrap.hidden = disposition !== 'accepted-risk';
        };
        for (const input of body.querySelectorAll('input[name="triageDisposition"]')) input.addEventListener('change', sync);
      }
    });
    if (!ok || view !== deps.view()) return;
    const { disposition, reason, days: chosenDays } = deps.chosen();
    const expiresInDays = disposition === 'accepted-risk' ? Number(chosenDays) : undefined;
    try {
      const answer = await deps.api(`${base()}/findings/${encodeURIComponent(text(field(finding, 'id')))}/triage`, {
        method: 'POST', body: { rule: field(finding, 'rule'), disposition, reason, ...(expiresInDays ? { expiresInDays } : {}) }
      });
      if (view !== deps.view() || !view.result) return;
      const decision = field(answer, 'decision');
      /* Recorded, but not said back: the page cannot show what it was not told. */
      if (!decision || typeof field(decision, 'disposition') !== 'string') {
        deps.toast('The decision was recorded. Refresh to see it.', 'ok');
        return;
      }
      const result = view.result;
      const findings = items(field(result, 'findings'));
      const found = (findings.find(item => field(item, 'id') === field(finding, 'id')) || finding) as Record<string, unknown>;
      const { triage: lapsed, clock, ...rest } = found;
      void lapsed; void clock;
      view.result = {
        ...(result as Record<string, unknown>),
        findings: findings.filter(item => field(item, 'id') !== field(finding, 'id')),
        suppressed: [...items(field(result, 'suppressed')), {
          ...rest,
          suppression: { triage: { disposition: field(decision, 'disposition'), reason: field(decision, 'reason'), decidedBy: field(decision, 'decidedBy'), decidedAt: field(decision, 'decidedAt'), expiresAt: field(decision, 'expiresAt') } }
        }]
      };
      if (field(view.triage, 'status') === 'ready') {
        view.triage.decisions = [decision, ...items(field(view.triage, 'decisions')).filter(item => field(item, 'findingId') !== field(decision, 'findingId'))];
      }
      await rescore(view);
      deps.toast(field(decision, 'disposition') === 'false-positive' ? 'Recorded as a false positive' : `Risk accepted until ${auditDay(field(decision, 'expiresAt'))}`, 'ok');
      if (view === deps.view()) {
        deps.paint();
        deps.metrics();
      }
    } catch (error) {
      deps.toast(text(field(error, 'message')) || 'The decision could not be recorded.', 'err');
    }
  }

  async function reopen(finding: unknown): Promise<void> {
    const view = deps.view();
    if (!finding || !view.result) return;
    let said = 'Reopened: the finding counts again';
    try {
      await deps.api(`${base()}/findings/${encodeURIComponent(text(field(finding, 'id')))}/reopen`, { method: 'POST', body: {} });
    } catch (error) {
      if (field(error, 'code') !== 'CODE_AUDIT_TRIAGE_NOT_FOUND') {
        deps.toast(text(field(error, 'message')) || 'The finding could not be reopened.', 'err');
        return;
      }
      /* Someone took it back first: the finding counts again all the same. */
      said = 'That decision was already taken back';
    }
    if (view !== deps.view() || !view.result) return;
    const result = view.result;
    const suppressed = items(field(result, 'suppressed'));
    const found = (suppressed.find(item => field(item, 'id') === field(finding, 'id')) || finding) as Record<string, unknown>;
    const { suppression, ...open } = found;
    void suppression;
    view.result = {
      ...(result as Record<string, unknown>),
      suppressed: suppressed.filter(item => field(item, 'id') !== field(finding, 'id')),
      findings: [...items(field(result, 'findings')), open]
    };
    if (field(view.triage, 'status') === 'ready') view.triage.decisions = items(field(view.triage, 'decisions')).filter(item => field(item, 'findingId') !== field(finding, 'id'));
    await rescore(view);
    deps.toast(said, 'ok');
    if (view === deps.view()) {
      deps.paint();
      deps.metrics();
    }
  }

  async function history(finding: unknown): Promise<void> {
    if (!finding) return;
    const view = deps.view();
    try {
      const answer = await deps.api(`${base()}/findings/${encodeURIComponent(text(field(finding, 'id')))}/triage-events`);
      /* Read for an audit the reader has since left: not shown over another. */
      if (view !== deps.view()) return;
      const vocabulary = field(view.triage, 'vocabulary');
      const label = (id: unknown): string => {
        const found = items(field(vocabulary, 'reasons')).find(reason => field(reason, 'id') === id);
        return found ? text(field(found, 'label')) : text(id);
      };
      const events = items(field(answer, 'events'));
      await deps.modal({
        title: 'Decisions about this finding',
        okText: 'Done',
        cancel: false,
        bodyHTML: `<p class="triage-target"><b>${escapeHtml(field(finding, 'title'))}</b><span class="mono">${escapeHtml(field(finding, 'rule'))}</span></p>
        ${events.length ? `<ol class="triage-events">${events.map(event => `
          <li class="triage-event" data-event="${field(event, 'event') === 'reopened' ? 'reopened' : 'decided'}">
            <span class="triage-event-what">${field(event, 'event') === 'reopened' ? 'Reopened' : escapeHtml(TRIAGE_EVENT_WORD[text(field(event, 'disposition'))] || 'Decided')}${field(event, 'reason') ? ` \u2014 ${escapeHtml(label(field(event, 'reason')))}` : ''}${field(event, 'expiresAt') ? `, until ${escapeHtml(auditDay(field(event, 'expiresAt')))}` : ''}</span>
            <span class="triage-event-who">${escapeHtml(field(event, 'actor'))} \u00b7 <time datetime="${escapeAttribute(field(event, 'at'))}">${escapeHtml(auditMoment(field(event, 'at')))}</time></span>
          </li>`).join('')}</ol>` : '<p class="hint">No decisions recorded.</p>'}`
      });
    } catch (error) {
      deps.toast(text(field(error, 'message')) || 'The decisions could not be read.', 'err');
    }
  }

  async function open(finding: unknown): Promise<void> {
    const path = field(finding, 'path');
    if (!path) return;
    deps.showEditor();
    await deps.openFile(text(path));
    const line = field(finding, 'line');
    const editor = deps.editor();
    if (line && editor) {
      const at = { line: Math.max(0, Number(line) - 1), ch: 0 };
      editor.setCursor(at);
      editor.scrollIntoView(at, 120);
      editor.focus();
    }
  }

  return { decide, reopen, history, open };
}
