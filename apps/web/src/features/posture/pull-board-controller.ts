/*
 * The open pull requests across the workspace at work (pull-board.ts). Read
 * only once the card comes into view, from the repositories most recently
 * pushed to, a few at a time, through the same list route the workbench uses
 * -- so a card opened from here lands on a list already in the cache -- and
 * bound to the identity that asked, like the posture above it.
 */
import { model, pickRepositories, readAll } from './pull-board.ts';
import type { ReadResult } from './pull-board.ts';
import type { BoardActions } from './PullBoard.tsx';
import type { BoardView } from './pull-board.ts';

export const PULL_BOARD_TTL_MS = 5 * 60 * 1000;
/* The card is read a little before it scrolls into view. */
export const WATCH_MARGIN = '200px 0px';

export interface BoardState {
  readonly me: unknown;
  readonly uiEpoch: number;
  readonly repos: unknown;
  prState: string;
  pendingPull: unknown;
}

interface Watcher { observe(target: unknown): void }
export type Intersection = (seen: (entries: readonly { readonly isIntersecting: boolean }[]) => void, options: { rootMargin: string }) => Watcher;

export interface PullBoardDeps<Host> {
  readonly state: BoardState;
  readonly api: (path: string) => Promise<unknown>;
  /* The workbench's cache: an answer kept for a while, and one put there. */
  readonly cached: (path: string, ttl: number) => Promise<unknown>;
  readonly keep: (path: string, value: unknown) => void;
  readonly isOffline: (error: unknown) => boolean;
  readonly now: () => number;
  readonly capability: (name: string) => unknown;
  readonly section: () => { hidden: boolean } | null;
  readonly host: () => Host | null;
  readonly draw: (host: Host, view: BoardView, actions: BoardActions) => void;
  /* Whether the card is in view, where the browser can tell; null where it cannot, and the card counts as seen. */
  readonly intersection: Intersection | null;
  /* The pull requests' list chosen as the open one. */
  readonly chooseOpenList: () => void;
  readonly openTool: (owner: string, repo: string, tab: string) => Promise<unknown>;
  /* Whether the pull requests' list is drawn (not waiting on its reading), and reading it. */
  readonly listDrawn: () => boolean;
  readonly loadPulls: () => void;
}

export interface PullBoard {
  clear(): void;
  offered(): boolean;
  render(): void;
  /* Watch the card come into view; once. */
  watch(): void;
  load(force?: boolean): Promise<void>;
  visible(): boolean;
}

export function createPullBoard<Host>(deps: PullBoardDeps<Host>): PullBoard {
  const { state } = deps;
  let results: ReadResult[] | null = null;
  let at = 0;
  let request = 0;
  let inflight = false;
  let visible = false;
  let watching = false;

  function clear(): void {
    request += 1;
    results = null;
    at = 0;
    inflight = false;
  }

  const offered = (): boolean => deps.capability('pulls.read') === 'Supported';

  function open(owner: string, repo: string, number: number): void {
    state.pendingPull = { key: `${owner}/${repo}`.toLowerCase(), number: Number(number) };
    /* The board lists open pull requests, so the list it lands on is the open one. */
    if (state.prState !== 'open') {
      state.prState = 'open';
      deps.chooseOpenList();
    }
    void deps.openTool(owner, repo, 'pulls').then(() => {
      /* The list was already drawn, so the tab did not read it again: read it now to open the card's pull request. */
      if (state.pendingPull && deps.listDrawn()) deps.loadPulls();
    });
  }

  function render(): void {
    const section = deps.section();
    const host = deps.host();
    if (!section || !host) return;
    section.hidden = !offered();
    if (section.hidden) return;
    deps.draw(host, model({ results, repos: state.repos }), { open, refresh: () => { void load(true); } });
    /*
     * The inventory arrived after the card came into view: read it now. Only
     * when there is someone to read for and something readable to ask, so the
     * reading's own early returns, which draw the card, never ask again.
     */
    if (visible && !inflight && !results && state.me && pickRepositories(state.repos).length) void load();
  }

  function watch(): void {
    const section = deps.section();
    if (!section || watching) return;
    if (!deps.intersection) { visible = true; return; }
    watching = true;
    deps.intersection(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) void load();
    }, { rootMargin: WATCH_MARGIN }).observe(section);
  }

  async function load(force?: boolean): Promise<void> {
    if (!state.me || !offered()) { render(); return; }
    if (inflight && !force) return;
    if (!force && results && deps.now() - at < PULL_BOARD_TTL_MS) { render(); return; }
    const repositories = pickRepositories(state.repos);
    if (!repositories.length) { render(); return; }
    const asked = ++request;
    const epoch = state.uiEpoch;
    const identity = state.me;
    const stale = (): boolean => asked !== request || epoch !== state.uiEpoch || identity !== state.me;
    inflight = true;
    results = null;
    render();
    const read = await readAll(repositories, async (owner, repo) => {
      const path = `/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open`;
      try {
        if (!force) return await deps.cached(path, PULL_BOARD_TTL_MS);
        const fresh = await deps.api(path);
        deps.keep(path, fresh);
        return fresh;
      } catch (error) {
        if (error && typeof error === 'object') Object.assign(error, { offline: deps.isOffline(error) });
        throw error;
      }
    });
    if (stale()) {
      /*
       * Overtaken by a new identity or a new interface epoch rather than by a
       * newer reading: the answer is dropped, and so is the flag that held the
       * card at "reading", so the board reads again for whoever is now here.
       */
      if (asked === request) {
        inflight = false;
        render();
      }
      return;
    }
    inflight = false;
    results = read;
    at = deps.now();
    render();
  }

  return { clear, offered, render, watch, load, visible: () => visible };
}
