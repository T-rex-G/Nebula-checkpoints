/*
 * The recent-activity feed at work.
 *
 * Fetched rather than computed, and kept per identity: a reader returning to
 * the overview should not spend another handful of provider requests. Refresh
 * explicitly reads it again. A request from an old identity, or one the feed
 * was let go of under, never draws it.
 *
 * Every failure path ends in a drawn card. A feed that silently stays on
 * "Reading recent activity…" is worse than one that says it could not read
 * anything, because the reader cannot tell a slow network from a broken
 * surface. An empty answer is an answer with nothing in it: it used to be
 * drawn as the script's own error ("Cannot read properties of null").
 */
import { field, items } from '../../platform/values.ts';

/* What the feed holds: nothing yet, a reading under way, what it read, or why it could not. */
export type FeedState =
  | { readonly loading: true }
  | { readonly loading: false; readonly error: string }
  | {
    readonly loading: false;
    readonly now: number;
    readonly generatedAt: unknown;
    readonly days: unknown;
    readonly perRepositoryLimit: unknown;
    readonly kinds: unknown;
    readonly inventoryCount: unknown;
    readonly measured: boolean;
    readonly events: readonly unknown[];
    readonly truncated: boolean;
    readonly totalEvents: unknown;
    readonly undated: unknown;
    readonly repositories: readonly unknown[];
    readonly failed: readonly unknown[];
  };

export interface RefreshControl { disabled: boolean; textContent: string | null }

export interface ActivityFeedDeps<Root> {
  readonly state: { readonly me: unknown; readonly uiEpoch: number };
  readonly api: (path: string) => Promise<unknown>;
  /* The card's body, when the page has one. */
  readonly root: () => Root | null;
  readonly refresh: () => RefreshControl | null;
  readonly draw: (root: Root, current: FeedState | null) => void;
  /* The card taken off the page, as a purge or a change of identity needs. */
  readonly erase: (root: Root | null) => void;
  readonly now: () => number;
}

export interface ActivityFeed {
  /* Let go of what the feed holds; any reading under way is dropped when it lands. */
  clear(): void;
  paint(): void;
  /* Read the feed once, or again when forced; a reading under way is never doubled. */
  load(force?: boolean): Promise<void>;
  current(): FeedState | null;
}

const said = (error: unknown): string => {
  const message = field(error, 'message');
  return message ? String(message) : '';
};

/* What an answer says, read as sent; anything it leaves out is nothing. */
export function feedReading(payload: unknown, now: number): FeedState {
  const list = (name: string): readonly unknown[] => items(field(payload, name));
  return {
    loading: false,
    /*
     * The moment the answer arrived, not the moment each row is painted.
     * Reading the clock inside the renderer makes "3h ago" creep upward every
     * time anything else repaints the card, which is a clock the reader can
     * watch drift.
     */
    now,
    generatedAt: field(payload, 'generatedAt'),
    days: field(payload, 'days'),
    perRepositoryLimit: field(payload, 'perRepositoryLimit') || 20,
    kinds: field(payload, 'kinds') || [],
    inventoryCount: field(payload, 'inventoryCount') || 0,
    measured: !!field(payload, 'measured'),
    events: list('events'),
    truncated: !!field(payload, 'truncated'),
    totalEvents: field(payload, 'totalEvents') || 0,
    undated: field(payload, 'undated') || 0,
    repositories: list('repositories'),
    failed: list('failed')
  };
}

export function createActivityFeed<Root>(deps: ActivityFeedDeps<Root>): ActivityFeed {
  const { state } = deps;
  let current: FeedState | null = null;
  let request = 0;

  function clear(): void {
    request += 1;
    current = null;
    deps.erase(deps.root());
    const refresh = deps.refresh();
    if (refresh) refresh.disabled = true;
  }

  function paint(): void {
    const root = deps.root();
    if (!root) return;
    deps.draw(root, current);
    const refresh = deps.refresh();
    if (refresh) {
      /* Only ever drawn within a reading begun for a reader, so a reader is always there. */
      const reading = !!(current && current.loading);
      refresh.disabled = reading;
      refresh.textContent = reading ? 'Refreshing…' : 'Refresh';
    }
  }

  async function load(force?: boolean): Promise<void> {
    if (!deps.root() || !state.me) return;
    if (current && (current.loading || !force)) { paint(); return; }
    const asked = ++request;
    const epoch = state.uiEpoch;
    const identity = state.me;
    const still = (): boolean => asked === request && epoch === state.uiEpoch && identity === state.me;
    current = { loading: true };
    paint();
    try {
      const payload = await deps.api('/api/activity/recent');
      if (!still()) return;
      current = feedReading(payload, deps.now());
    } catch (error) {
      if (!still()) return;
      current = { loading: false, error: `Recent activity could not be read: ${said(error) || 'request failed'}` };
    }
    paint();
  }

  return { clear, paint, load, current: () => current };
}
