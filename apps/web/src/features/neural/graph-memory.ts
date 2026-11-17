/*
 * What this browser remembers of the Neural map: where the reader has put
 * each panel, and which groups they have hidden.
 *
 * Arrangements are kept per repository, mode and shape of stage (a phone's
 * column and a desktop's two columns are different arrangements), for the
 * views arranged most recently. They name repositories, so they are the
 * account's data: when the account changes the page removes them from
 * storage with the rest of it. What storage holds is therefore what counts --
 * an arrangement held only in memory is dropped as soon as storage no longer
 * has it, rather than written back for the next account to find. Where
 * storage cannot be reached at all, what this page has arranged still stands
 * until it is closed.
 *
 * The groups hidden are this viewer's choice of what to see, and name no
 * repository; they stay in this browser across accounts.
 */
import { isNodeType, type NodeType } from './graph-model.ts';

export const PLACEMENT_KEY = 'nv_neural_layout';
export const HIDDEN_KEY = 'nv_neural_hidden_groups';
/* How many views' arrangements are kept: the most recently arranged. */
export const PLACEMENT_VIEWS = 40;

/* The part of the browser's storage the map uses. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/* Storage, or null where the browser has none; it may also throw when blocked. */
export type StorageSource = () => KeyValueStore | null | undefined;

type Entries = Record<string, unknown>;
const isEntries = (value: unknown): value is Entries => !!value && typeof value === 'object' && !Array.isArray(value);
/* The views, in an object that inherits nothing: a view of any name is only a name. */
const table = (from: Entries = {}): Entries => Object.assign(Object.create(null), from);

/* The view an arrangement belongs to: the repository, the mode, and the stage's layout. */
export function placementKey(work: { readonly owner: string; readonly repo: string } | null | undefined, mode: string, layoutMode: string | null): string {
  return work ? `${work.owner}/${work.repo}|${mode}|${layoutMode}` : '';
}

/* A panel being dragged, where it is now. */
export interface LivePlacement { readonly type: string; readonly x: number; readonly y: number }

export interface PlacementMemory {
  /* Where the reader has put each panel in this view, by type, with one being dragged where it is now. */
  arrangement(key: string, live?: LivePlacement | null): Readonly<Entries>;
  /* A panel put down: kept for this view, and the view becomes the most recently arranged. */
  remember(key: string, type: string, x: number, y: number): void;
  /* Whether the reader has moved anything in this view. */
  has(key: string): boolean;
  /* The view back to the layout's own arrangement. */
  forget(key: string): void;
}

export function placementMemory(storage: StorageSource): PlacementMemory {
  /* What storage held when last read or written, and the arrangements parsed from it. */
  let seen: string | null | undefined;
  let views: Entries = table();

  const read = (): Entries => {
    let raw: string | null;
    try {
      const store = storage();
      if (!store) return views;
      raw = store.getItem(PLACEMENT_KEY);
    } catch { return views; }
    if (raw !== seen) { seen = raw; views = parse(raw); }
    return views;
  };
  const write = (): void => {
    const keys = Object.keys(views);
    if (keys.length > PLACEMENT_VIEWS) for (const key of keys.slice(0, keys.length - PLACEMENT_VIEWS)) delete views[key];
    const text = JSON.stringify(views);
    try {
      const store = storage();
      if (store) { store.setItem(PLACEMENT_KEY, text); seen = text; }
    } catch { /* not remembered */ }
  };
  const entry = (key: string): Entries | null => {
    if (!key) return null;
    const saved = read()[key];
    return isEntries(saved) ? saved : null;
  };

  return {
    arrangement(key, live) {
      const saved = entry(key) || {};
      return live ? { ...saved, [live.type]: { x: live.x, y: live.y } } : saved;
    },
    remember(key, type, x, y) {
      if (!key) return;
      const kept = { ...(entry(key) || {}), [type]: { x: Math.round(x), y: Math.round(y) } };
      delete views[key];
      views[key] = kept;
      write();
    },
    has(key) {
      const saved = entry(key);
      return !!saved && Object.keys(saved).length > 0;
    },
    forget(key) {
      if (!key) return;
      delete read()[key];
      write();
    }
  };
}

function parse(raw: string | null): Entries {
  try {
    const saved: unknown = JSON.parse(raw || '{}');
    return table(isEntries(saved) ? saved : {});
  } catch { return table(); }
}

/*
 * The groups hidden in this browser, or null where nothing readable is kept
 * -- the map then keeps what it has. Only types the map knows are taken, and
 * never the repository, which is the hub and cannot be hidden.
 */
export function readHiddenGroups(storage: StorageSource): Set<NodeType> | null {
  try {
    const saved: unknown = JSON.parse(storage()?.getItem(HIDDEN_KEY) || '[]');
    if (!Array.isArray(saved)) return null;
    const hidden = new Set<NodeType>();
    for (const type of saved) if (typeof type === 'string' && isNodeType(type) && type !== 'repo') hidden.add(type);
    return hidden;
  } catch { return null; }
}

export function writeHiddenGroups(storage: StorageSource, hidden: ReadonlySet<string>): void {
  try { storage()?.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* not remembered */ }
}

export function forgetHiddenGroups(storage: StorageSource): void {
  try { storage()?.removeItem(HIDDEN_KEY); } catch { /* nothing kept */ }
}
