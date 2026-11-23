/*
 * The findings inbox: every open finding across the workspace, read from the
 * server and kept for a few minutes, narrowed by filters that live in the
 * address, each row's owner read from its repository's CODEOWNERS -- once
 * per repository and only for those on screen -- a finding's record of
 * decisions read in place, and findings decided together, one at a time
 * through each repository's own triage route so the permissions are the
 * audit's own.
 *
 * An inbox read for another session is dropped when it arrives. A decision
 * made for several findings stops when the session changes, rather than
 * deciding the rest as whoever is signed in then. Owners read while the inbox
 * is read again are kept: they belong to the repository, not to the read.
 */
import { field, items } from '../../platform/values.ts';
import type { Filters, ShownFinding, View } from './findings-model.ts';
import type { Decision, InboxActions, InboxUiState } from './FindingsInbox.tsx';

export interface FindingsState extends InboxUiState {
  inbox: unknown;
  filters: Filters | null;
  readonly selected: Map<string, unknown>;
  readonly expanded: Set<string>;
  readonly owners: Map<string, unknown>;
  disposition: string;
  progress: string;
  request: number;
  at: number;
  deciding: boolean;
}

export interface FindingsDeps {
  readonly api: (path: string, options?: unknown) => Promise<unknown>;
  /* The signed-in identity, and the session it belongs to. */
  readonly identity: () => unknown;
  readonly epoch: () => unknown;
  readonly offered: () => boolean;
  readonly explain: () => string;
  readonly toast: (message: string, kind?: string) => void;
  readonly showPage: () => void;
  /* Whether the inbox is the page showing. */
  readonly showing: () => boolean;
  /* The filters written into the address, so they survive a reload. */
  readonly writeRoute: (filters: Filters) => void;
  readonly parseFilters: (query: unknown) => Filters;
  readonly model: (inbox: unknown, filters: Filters | null, options: { labelOf(item: ShownFinding): string; ownersOf(item: ShownFinding): unknown }) => View;
  /* Whether the inbox's place on the page is there to draw in. */
  readonly present: () => boolean;
  readonly render: (view: View, state: FindingsState, actions: InboxActions) => void;
  /* Where the inbox is drawn, and its search field's focus and caret, kept across a redraw. */
  readonly focus: { search(): { caret: number | null } | null; restore(caret: number | null): void };
  readonly codeowners: { ownersOf(rules: unknown, path: unknown): unknown[]; revive(rules: unknown): unknown };
  readonly exposureLabel: (rule: unknown) => string;
  readonly openTool: (owner: string, repo: string, tool: string) => unknown;
  readonly invalidatePosture: () => void;
  readonly offline: (error: unknown) => boolean;
  /* The audit's words for a day and for each kind of decision. */
  readonly day: (at: unknown) => string;
  readonly decisionWord: (disposition: unknown) => string | undefined;
  readonly now: () => number;
  /* How long an inbox read is kept before it is read again. */
  readonly keepMs: number;
}

export interface FindingsInboxController {
  readonly state: FindingsState;
  offered(): boolean;
  show(filters?: Filters | null): void;
  load(force?: boolean): Promise<void>;
  paint(options?: { keepFocus?: boolean }): void;
  clear(): void;
  /* Read again the next time it is shown: a decision elsewhere changed it. */
  invalidate(): void;
}

const text = (value: unknown): string => (value == null ? '' : String(value));
const repoKey = (item: unknown): string => `${text(field(item, 'owner'))}/${text(field(item, 'repo'))}`.toLowerCase();
const repoPath = (item: unknown): string => `/api/repo/${encodeURIComponent(text(field(item, 'owner')))}/${encodeURIComponent(text(field(item, 'repo')))}`;

export function createFindingsInbox(deps: FindingsDeps): FindingsInboxController {
  const state: FindingsState = {
    inbox: null, filters: null, selected: new Map(), expanded: new Set(), owners: new Map(),
    disposition: 'accepted-risk', progress: '', request: 0, at: 0, deciding: false
  };
  /* Bumped when the inbox is let go of: owners read before then are not kept. */
  let cleared = 0;

  const ownersOf = (item: ShownFinding): unknown => {
    const rules = state.owners.get(repoKey(item));
    return Array.isArray(rules) ? deps.codeowners.ownersOf(rules, field(item, 'path')) : [];
  };

  function loadOwners(shown: readonly unknown[]): void {
    const wanted = new Map<string, unknown>();
    for (const item of shown) {
      const key = repoKey(item);
      if (!state.owners.has(key) && !wanted.has(key)) wanted.set(key, item);
    }
    for (const [key, item] of wanted) {
      state.owners.set(key, 'pending');
      const mine = cleared;
      void deps.api(`${repoPath(item)}/codeowners`)
        .then(answer => deps.codeowners.revive(field(answer, 'rules')), () => [])
        .then(rules => {
          if (mine !== cleared) return;
          state.owners.set(key, rules);
          if (deps.showing()) paint();
        });
    }
  }

  function paint(options: { keepFocus?: boolean } = {}): void {
    if (!deps.present()) return;
    const search = options.keepFocus ? deps.focus.search() : null;
    const view = deps.model(state.inbox, state.filters, {
      labelOf: item => (field(item, 'source') === 'exposure' ? deps.exposureLabel(field(item, 'rule')) : text(field(item, 'rule'))),
      ownersOf
    });
    deps.render(view, state, {
      filter: (patch, opts = {}) => {
        state.filters = { ...(state.filters as Filters), ...patch };
        deps.writeRoute(state.filters);
        paint(opts);
      },
      select: (item, on) => {
        if (on) state.selected.set(item.key, item);
        else state.selected.delete(item.key);
        paint();
      },
      clearSelection: () => { state.selected.clear(); state.progress = ''; paint(); },
      expand: (item, open) => { if (open) state.expanded.add(item.key); else state.expanded.delete(item.key); },
      events: (item, host) => { void decisions(item, host); },
      open: item => { void deps.openTool(text(field(item, 'owner')), text(field(item, 'repo')), field(item, 'source') === 'exposure' ? 'exposure' : 'audit'); },
      decide: decision => { void decide(decision); }
    });
    if (search) deps.focus.restore(search.caret);
    if (field(view, 'state') === 'ready') loadOwners(items(field(view, 'shown')));
  }

  /* A finding's record of decisions, read once and drawn in place; a failure can be read again. */
  async function decisions(item: ShownFinding, host: HTMLElement): Promise<void> {
    if (!host || host.dataset.loaded === 'true') return;
    host.dataset.loaded = 'true';
    try {
      const answer = await deps.api(`${repoPath(item)}/code-audit/findings/${encodeURIComponent(text(field(item, 'id')))}/triage-events`);
      /* A record answered without its events is not one of nobody deciding. */
      if (!Array.isArray(field(answer, 'events'))) throw new Error('');
      const events = items(field(answer, 'events'));
      host.textContent = '';
      const make = (tag: string): HTMLElement => host.ownerDocument.createElement(tag);
      if (!events.length) {
        host.appendChild(Object.assign(make('p'), { textContent: 'Nobody has decided anything about this finding.' }));
        return;
      }
      const list = make('ol');
      list.className = 'fi-timeline';
      for (const event of events) {
        const entry = make('li');
        const when = make('time') as HTMLTimeElement;
        when.className = 'fi-when';
        when.dateTime = text(field(event, 'at'));
        when.textContent = deps.day(field(event, 'at'));
        const what = make('span');
        const reason = field(event, 'reason');
        what.textContent = `${field(event, 'event') === 'reopened' ? 'Reopened' : (deps.decisionWord(field(event, 'disposition')) || 'Decided')} by ${text(field(event, 'actor')) || 'someone'}${reason ? ` \u2014 ${text(reason).replace(/-/g, ' ')}` : ''}`;
        entry.append(when, what);
        list.appendChild(entry);
      }
      host.appendChild(list);
    } catch {
      host.dataset.loaded = '';
      host.textContent = '';
      host.appendChild(Object.assign(host.ownerDocument.createElement('p'), { textContent: 'The team\u2019s decisions about this finding could not be read here.' }));
    }
  }

  async function decide(decision: Decision): Promise<void> {
    if (state.deciding || !state.selected.size) return;
    state.deciding = true;
    const epoch = deps.epoch();
    const identity = deps.identity();
    const chosen = [...state.selected.values()];
    let done = 0;
    let stopped = false;
    const failed: string[] = [];
    for (const item of chosen) {
      /* The session changed: the rest are not decided as whoever is signed in now. */
      if (epoch !== deps.epoch() || identity !== deps.identity()) { stopped = true; break; }
      state.progress = `Deciding ${done + 1} of ${chosen.length}\u2026`;
      paint();
      try {
        await deps.api(`${repoPath(item)}/code-audit/findings/${encodeURIComponent(text(field(item, 'id')))}/triage`, {
          method: 'POST',
          body: { rule: field(item, 'rule'), disposition: decision.disposition, reason: decision.reason, ...(decision.expiresInDays ? { expiresInDays: decision.expiresInDays } : {}) }
        });
        done += 1;
        state.selected.delete(text(field(item, 'key')));
      } catch (error) {
        failed.push(`${text(field(item, 'owner'))}/${text(field(item, 'repo'))}: ${text(field(error, 'message')) || 'refused'}`);
      }
    }
    state.deciding = false;
    if (stopped) {
      state.progress = `${done} decided; the session changed, so the rest were not.`;
      return;
    }
    state.progress = failed.length
      ? `${done} decided; ${failed.length} could not be: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '\u2026' : ''}`
      : `${done} decided.`;
    if (done) {
      deps.toast(`${done} ${done === 1 ? 'finding' : 'findings'} decided`, 'ok');
      deps.invalidatePosture();
      await load(true);
    } else paint();
  }

  async function load(force = false): Promise<void> {
    if (!deps.identity() || !deps.offered()) return;
    if (!force && state.inbox && deps.now() - state.at < deps.keepMs) { paint(); return; }
    const request = ++state.request;
    const epoch = deps.epoch();
    const identity = deps.identity();
    const stale = (): boolean => request !== state.request || epoch !== deps.epoch() || identity !== deps.identity();
    state.at = deps.now();
    if (!state.inbox) paint();
    try {
      const inbox = await deps.api('/api/workspace/findings');
      if (stale()) return;
      /* An inbox whose findings are not a list cannot be read. */
      const listed = field(inbox, 'findings');
      if (listed != null && !Array.isArray(listed)) throw new Error('');
      state.inbox = inbox && typeof inbox === 'object' ? inbox : { available: false, reason: 'unreadable' };
      /* What was decided elsewhere, or is no longer listed, cannot stay selected. */
      const keys = new Set(items(field(state.inbox, 'findings')).filter(item => !field(item, 'decision')).map(item => field(item, 'key')));
      for (const key of [...state.selected.keys()]) if (!keys.has(key)) state.selected.delete(key);
    } catch (error) {
      if (stale()) return;
      state.at = 0;
      state.inbox = { available: false, reason: deps.offline(error) ? 'offline' : 'unreadable' };
    }
    paint();
  }

  function show(filters: Filters | null = null): void {
    if (!deps.offered()) { deps.toast(deps.explain(), 'err'); return; }
    state.filters = filters || state.filters || deps.parseFilters('');
    deps.showPage();
    deps.writeRoute(state.filters);
    paint();
    void load();
  }

  function clear(): void {
    state.request += 1;
    cleared += 1;
    state.inbox = null;
    state.selected.clear();
    state.expanded.clear();
    state.owners.clear();
    state.at = 0;
    state.progress = '';
  }

  return { state, offered: () => deps.offered(), show, load, paint, clear, invalidate: () => { state.at = 0; } };
}
