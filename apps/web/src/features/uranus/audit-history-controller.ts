/*
 * The kept audits of the branch open, and what is read with them: the team's
 * triage decisions, the clocks and the time to fix, the watch over the latest
 * audit, and each kept audit's findings as it kept them; and the history
 * cleared, armed like every other irreversible control.
 *
 * Every answer belongs to the repository, branch and session it was asked
 * in, and lands in the view drawn for them -- the one a finished audit run
 * replaced included, since it carries the history over. Each kind of read
 * has its own turn: a history read again lets go of the reads it started,
 * but checking the watch or reading the clocks again leaves the others to
 * finish, and a read let go of never leaves its part of the page waiting.
 */
import { field, items } from '../../platform/values.ts';
import type { AuditView } from './audit-controller.ts';

/* A watch older than this is checked against OSV when the history is read; a newer one is answered from what the server kept. */
export const WATCH_STALE_MS = 6 * 60 * 60 * 1000;
/* The second press that clears the history is offered this long. */
export const CLEAR_ARMED_MS = 5000;
/* A watch the server will let be checked again within this long redraws the page when it may. */
const RECHECK_WITHIN_MS = 30 * 60 * 1000;

export interface AuditHistoryDeps {
  readonly api: (path: string, options?: unknown) => Promise<unknown>;
  /* The open repository: owner, name and branch. */
  readonly work: () => unknown;
  readonly epoch: () => unknown;
  /* The repository and branch the audit's view is for: owner/name@branch. */
  readonly key: () => string;
  /* The audit's view as it is now. */
  readonly view: () => AuditView;
  readonly repaint: () => void;
  readonly toast: (message: string, kind?: string) => void;
  readonly later: (run: () => void, ms: number) => unknown;
  readonly cancel: (timer: unknown) => void;
  readonly now: () => number;
}

export interface AuditHistory {
  /* The kept audits read, then the decisions, the clocks and the watch. */
  load(): Promise<void>;
  /* The watch over the latest kept audit; forced, OSV is asked now. */
  watch(options?: { force?: boolean }): Promise<void>;
  /* The clocks read again, after a decision changed what counts. */
  metrics(): Promise<void>;
  /* One kept audit's findings, as it kept them. */
  detail(id: string): Promise<void>;
  /* The first press arms; the second clears every kept audit of the repository. */
  clear(): Promise<void>;
  /* Every read on its way let go of, and the second press no longer offered. */
  forget(): void;
  /* The redraw waiting for the watch to be checkable again let go of. */
  forgetWatch(): void;
}

const text = (value: unknown): string => (value == null ? '' : String(value));

export function createAuditHistory(deps: AuditHistoryDeps): AuditHistory {
  const turns = { history: 0, watch: 0, metrics: 0, triage: 0 };
  let armTimer: unknown = null;
  let watchTimer: unknown = null;
  /* Whether the watch check, or the decisions' read, still out is still wanted. */
  let watching: () => boolean = () => false;
  let triaging: () => boolean = () => false;

  /* A read's place: its own turn, if it takes one, the history's, and the repository, branch and session it was asked in. */
  function scope(kind?: keyof typeof turns) {
    const turn = kind ? ++turns[kind] : 0;
    const history = turns.history;
    const key = deps.key();
    const epoch = deps.epoch();
    const work = deps.work();
    return {
      current: (): boolean => (!kind || turn === turns[kind]) && history === turns.history && epoch === deps.epoch() && key === deps.key() && deps.view().key === key,
      base: `/api/repo/${text(field(work, 'owner'))}/${text(field(work, 'repo'))}/code-audit`,
      ref: encodeURIComponent(text(field(work, 'branch')))
    };
  }
  const audits = (): readonly unknown[] => {
    const history = deps.view().history;
    return field(history, 'status') === 'ready' ? items(field(history, 'audits')) : [];
  };

  async function load(): Promise<void> {
    if (!deps.work()) return;
    const own = scope('history');
    const view = deps.view();
    view.history = field(view.history, 'status') === 'ready' ? { ...view.history, refreshing: true } : { status: 'loading' };
    try {
      const listed = await deps.api(`${own.base}/history?ref=${own.ref}`);
      if (!own.current()) return;
      const shown = deps.view();
      if (!listed || field(listed, 'available') === false) {
        shown.history = { status: 'unavailable' };
        shown.watch = { status: 'unavailable' };
        deps.repaint();
        return;
      }
      /* A history without its list of audits is not an empty one. */
      if (!Array.isArray(field(listed, 'audits'))) throw new Error('');
      shown.history = { status: 'ready', audits: items(field(listed, 'audits')), branches: items(field(listed, 'branches')) };
      deps.repaint();
      /* The team's decisions and the clocks come with the history: both are read from what the server keeps. */
      const others = [triage()];
      if (audits().length) others.push(metrics());
      else shown.metrics = { status: 'idle' };
      if (audits().length) await watch({});
      else { shown.watch = { status: 'none' }; deps.repaint(); }
      await Promise.all(others);
    } catch (error) {
      if (!own.current()) return;
      deps.view().history = { status: 'error', error: text(field(error, 'message')) || 'The audit history could not be read.' };
      deps.repaint();
    }
  }

  async function watch({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (!deps.work()) return;
    const latest = audits()[0];
    if (!latest) return;
    const view = deps.view();
    /* A check still out is waited for; one let go of is not. */
    if (field(view.watch, 'status') === 'checking' && watching()) return;
    const own = scope('watch');
    watching = own.current;
    const last = Date.parse(text(field(field(latest, 'watch'), 'checkedAt')));
    /* Only a check that will reach OSV says so; one the server answers from what it kept is quiet. */
    const willAsk = force || !Number.isFinite(last) || deps.now() - last >= WATCH_STALE_MS;
    view.watch = { ...view.watch, status: willAsk ? 'checking' : field(view.watch, 'data') ? 'ready' : 'loading' };
    if (willAsk) deps.repaint();
    try {
      const answer = await deps.api(`${own.base}/watch?ref=${own.ref}${force ? '&refresh=1' : ''}`);
      if (!own.current()) return;
      const shown = deps.view();
      const audit = field(answer, 'audit');
      if (!answer || field(answer, 'available') === false || !audit) {
        shown.watch = { status: 'none' };
        deps.repaint();
        return;
      }
      shown.watch = { status: 'ready', data: answer };
      /* "Check now" is held for a few minutes after a check; the page redraws when it is offered again. */
      forgetWatch();
      const wait = Date.parse(text(field(answer, 'checkableAt'))) - deps.now();
      if (Number.isFinite(wait) && wait > 0 && wait < RECHECK_WITHIN_MS) watchTimer = deps.later(() => { if (own.current()) deps.repaint(); }, wait + 50);
      /* The history row carries the same check, so the two never disagree about when it was. */
      const row = audits().find(item => field(item, 'id') === field(audit, 'id'));
      if (row && field(audit, 'watch')) (row as Record<string, unknown>).watch = field(audit, 'watch');
      const alerts = field(answer, 'alerts');
      if (field(answer, 'fresh') && Array.isArray(alerts) && alerts.length) {
        deps.toast(`${alerts.length} new ${alerts.length === 1 ? 'item' : 'items'} for ${text(field(deps.work(), 'repo'))} since its last audit`, 'ok');
      }
    } catch (error) {
      if (!own.current()) return;
      const shown = deps.view();
      shown.watch = {
        ...shown.watch, status: 'error',
        error: field(error, 'status') === 429 ? 'Checked moments ago. Try again in a few minutes.' : 'The watch could not be checked. Nothing is marked new, and nothing is marked clear.'
      };
    }
    deps.repaint();
  }

  /*
   * The team's decisions about this repository's findings. A reader who is not
   * one of its collaborators -- anyone reading a public repository -- is told
   * nothing about them and offered no way to make one.
   */
  async function triage(): Promise<void> {
    const status = field(deps.view().triage, 'status');
    if (status === 'ready' || (status === 'loading' && triaging())) return;
    const own = scope('triage');
    triaging = own.current;
    deps.view().triage = { status: 'loading' };
    try {
      const answer = await deps.api(`${own.base}/triage`);
      if (!own.current()) return;
      deps.view().triage = answer && field(answer, 'available') !== false
        ? { status: 'ready', canDecide: field(answer, 'canDecide') === true, vocabulary: field(answer, 'vocabulary') || null, decisions: items(field(answer, 'decisions')) }
        : { status: 'unavailable' };
    } catch (error) {
      if (!own.current()) return;
      deps.view().triage = { status: field(error, 'code') === 'GOVERNANCE_COLLABORATORS_ONLY' || field(error, 'status') === 403 ? 'forbidden' : 'error' };
    }
    deps.repaint();
  }

  /* Where the branch stands against its clocks, and how long fixing has taken. */
  async function metrics(): Promise<void> {
    if (!deps.work()) return;
    const own = scope('metrics');
    const view = deps.view();
    view.metrics = { ...view.metrics, status: 'loading' };
    deps.repaint();
    try {
      const answer = await deps.api(`${own.base}/metrics?ref=${own.ref}`);
      if (!own.current()) return;
      deps.view().metrics = answer && field(answer, 'available') !== false ? { status: 'ready', data: answer } : { status: 'unavailable' };
    } catch {
      if (!own.current()) return;
      deps.view().metrics = { status: 'error', error: 'The clocks could not be read.' };
    }
    deps.repaint();
  }

  async function detail(id: string): Promise<void> {
    if (!deps.work()) return;
    const known = deps.view().historyDetail.get(id);
    if (field(known, 'status') === 'loading') return;
    if (field(known, 'status') === 'ready') { deps.repaint(); return; }
    const own = scope();
    deps.view().historyDetail.set(id, { status: 'loading' });
    deps.repaint();
    try {
      const found = await deps.api(`${own.base}/history/${encodeURIComponent(id)}`);
      if (!own.current()) return;
      /* A kept audit answered without its findings did not find none. */
      if (!Array.isArray(field(found, 'findings'))) throw new Error('');
      deps.view().historyDetail.set(id, { status: 'ready', findings: items(field(found, 'findings')) });
    } catch (error) {
      if (!own.current()) return;
      deps.view().historyDetail.set(id, { status: 'error', error: field(error, 'code') === 'CODE_AUDIT_NOT_FOUND' ? 'This audit is no longer kept.' : 'This audit could not be read.' });
    }
    deps.repaint();
  }

  async function clear(): Promise<void> {
    const work = deps.work();
    const view = deps.view();
    if (!work || field(view.history, 'status') !== 'ready') return;
    if (!view.historyArmed) {
      view.historyArmed = true;
      deps.cancel(armTimer);
      armTimer = deps.later(() => { deps.view().historyArmed = false; deps.repaint(); }, CLEAR_ARMED_MS);
      deps.repaint();
      return;
    }
    deps.cancel(armTimer);
    view.historyArmed = false;
    const own = scope();
    view.history = { ...view.history, clearing: true };
    deps.repaint();
    try {
      const body = await deps.api(`${own.base}/history/clear`, { method: 'POST', body: { confirm: 'clear-audit-history' } });
      if (!own.current()) return;
      turns.history += 1;
      const shown = deps.view();
      shown.history = { status: 'ready', audits: [], branches: [] };
      shown.watch = { status: 'none' };
      shown.historyOpen = new Set();
      shown.historyDetail = new Map();
      const cleared = Number(field(body, 'cleared')) || 0;
      deps.toast(`Cleared ${cleared} kept ${cleared === 1 ? 'audit' : 'audits'} of ${text(field(work, 'repo'))}`, 'ok');
    } catch (error) {
      if (!own.current()) return;
      const shown = deps.view();
      shown.history = { ...shown.history, clearing: false };
      deps.toast(text(field(error, 'message')) || 'The audit history could not be cleared.', 'err');
    }
    deps.repaint();
  }

  function forget(): void {
    for (const kind of Object.keys(turns) as (keyof typeof turns)[]) turns[kind] += 1;
    deps.cancel(armTimer);
  }

  function forgetWatch(): void {
    deps.cancel(watchTimer);
  }

  return { load, watch, metrics, detail, clear, forget, forgetWatch };
}
