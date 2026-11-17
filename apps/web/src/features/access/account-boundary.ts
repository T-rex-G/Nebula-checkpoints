/*
 * The account boundary: everything this browser holds for a reader, let go
 * of when the reader changes -- signing in, signing out, an account switched
 * or removed -- and the other tabs told to do the same.
 *
 * The order is the point. The page's epoch moves before the first await, so a
 * reading that was in flight for the reader who is leaving is discarded when
 * it lands; the repaints a press was holding go first of all, or one drawn
 * after the purge would bring the previous reader back; the open file is let
 * go before the editor is emptied, so the emptying is never saved as that
 * file's draft. Offline writes go on every boundary, not only a full sign-out:
 * a write queued for one account must never be replayed with another's
 * credentials. The page's memory of reads goes only on a full purge, since a
 * switch is followed at once by a start that reads everything again.
 *
 * Another tab is told on a channel and, where there is none, through storage;
 * it purges and starts again as whoever the server then answers for. A tab
 * never hears its own word, so it is never told twice.
 */

/* What this browser keeps in storage for a reader, by the start of its key. */
export const PRIVATE_STORAGE_PREFIXES: readonly string[] = Object.freeze([
  'nv_snap_', 'nv_incident_', 'nv_draft:', 'nv_recent:', 'nv_offline_repos:', 'nv_neural_layout', 'nv_audit:', 'nv_view:'
]);

/* Whether a key of this browser's storage holds something of a reader's. */
export function isPrivateStorageKey(key: string): boolean {
  return PRIVATE_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix));
}

/* The page's fields and lists that hold what a reader typed or was shown, emptied at the boundary. */
export const PURGED_FIELDS: readonly string[] = Object.freeze([
  '#repoGrid', '#tree', '#prList', '#issueList', '#releaseList', '#commitList',
  '#cmpResult', '#uploadQueue', '#actionsList', '#stageList', '#paletteList',
  '#filePath', '#fileSize', '#mdPreview', '#binaryPreview', '#editDiffBody',
  '#githubAppSettingsBody', '#tokenInput', '#codeSearch', '#findInput',
  '#replaceInput', '#uploadMsg', '#stageMsg', '#paletteInput'
]);

/* The cache the service worker keeps answers to the API in, by the start of its name. */
export const PRIVATE_CACHE_PREFIX = 'nv-api-';

export const IDENTITY_BOUNDARY_CHANNEL = 'nv-identity-boundary-v1';
export const IDENTITY_BOUNDARY_STORAGE_KEY = 'nv_identity_boundary_event';
export const IDENTITY_BOUNDARY_MESSAGE = 'NV_IDENTITY_BOUNDARY';
export const PURGE_MESSAGE = 'NV_PURGE_PRIVATE_DATA';

/* What the page holds for a reader: its own store's fields, replaced at the boundary, never changed in place. */
export interface ReaderState {
  uiEpoch: number;
  file: unknown;
  cm: unknown;
  staged: unknown[];
  work: unknown;
  repos: unknown[];
  me: unknown;
  caps: unknown;
  fileIndex: unknown;
}

interface Editor { setValue(value: string): void; clearHistory(): void }
interface Field { value?: string; textContent: string | null; replaceChildren?: () => void }
interface KeyedStorage { removeItem(key: string): void }
interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data?: unknown }) => void): void;
}
interface QueueTransaction {
  objectStore(name: string): { clear(): unknown };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export interface AccountBoundaryDeps {
  readonly state: ReaderState;
  /* The views that hold a reader's readings, each emptied; the held repaints first. */
  readonly discardHeldRepaints: () => void;
  readonly clearActivityFeed: () => void;
  readonly clearPosture: () => void;
  readonly paintUnread: (list: readonly unknown[]) => void;
  readonly clearCsrfToken: () => void;
  readonly clearGovernanceState: () => void;
  readonly clearExposureState: () => void;
  readonly clearAuditState: () => void;
  readonly clearSiteScanState: () => void;
  readonly forgetRepositoryWork: () => void;
  /* The browser's caches, its two storages, the service worker and the offline queue. */
  readonly cacheNames: () => Promise<readonly string[]>;
  readonly deleteCache: (name: string) => Promise<unknown>;
  readonly sessionStorage: () => { clear(): void };
  readonly localStorage: () => KeyedStorage & Record<string, unknown>;
  readonly serviceWorker: () => { postMessage(message: unknown): void } | null | undefined;
  readonly openQueue: () => Promise<{ transaction(store: string, mode: 'readwrite'): QueueTransaction }>;
  readonly find: (selector: string) => Field | null;
  /* The page's memory of reads (platform/transport.ts). */
  readonly forgetReads: () => void;
  /* The other tabs: a channel where the browser has one, and storage where it does not. */
  readonly channel: () => Channel | null;
  readonly writeStorage: (key: string, value: string) => void;
  readonly onStorage: (listener: (event: { key: string | null; newValue: string | null }) => void) => void;
  readonly marker: () => string;
  readonly reload: () => void;
}

export interface AccountBoundary {
  /* Let go of everything this browser holds for the reader; `full` also forgets the page's memory of reads. */
  purge(full: boolean): Promise<void>;
  /* The reader's private answers the browser cached, deleted: a purge does it, and so does taking a repository out of offline use. */
  purgePrivateCaches(): Promise<void>;
  /* Tell the other tabs a reader changed. */
  broadcast(): void;
  /* Told by another tab: purge, then start again as whoever the server answers for. Once. */
  receive(): Promise<void>;
  /* Hear the other tabs. */
  listen(): void;
}

export function createAccountBoundary(deps: AccountBoundaryDeps): AccountBoundary {
  const { state } = deps;
  let channel: Channel | null | undefined;
  const theChannel = (): Channel | null => {
    if (channel === undefined) {
      try { channel = deps.channel(); } catch { channel = null; }
    }
    return channel;
  };

  async function purgePrivateCaches(): Promise<void> {
    try {
      for (const name of await deps.cacheNames()) if (name.startsWith(PRIVATE_CACHE_PREFIX)) await deps.deleteCache(name);
    } catch { /* A cache the browser will not open holds nothing this page can reach. */ }
  }

  async function clearOfflineQueue(): Promise<void> {
    try {
      const db = await deps.openQueue();
      await new Promise<void>(resolve => {
        const tx = db.transaction('queue', 'readwrite');
        tx.objectStore('queue').clear();
        const done = (): void => resolve();
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      });
    } catch { /* No queue, nothing queued. */ }
  }

  async function purge(full: boolean): Promise<void> {
    /* Before the first await: a reading still in flight lands in a page that has moved on. */
    state.uiEpoch += 1;
    deps.discardHeldRepaints();
    deps.clearActivityFeed();
    deps.clearPosture();
    deps.paintUnread([]);
    deps.clearCsrfToken();
    deps.clearGovernanceState();
    deps.clearExposureState();
    deps.clearAuditState();
    deps.clearSiteScanState();
    await purgePrivateCaches();
    try { deps.sessionStorage().clear(); } catch { /* Blocked storage holds nothing. */ }
    try {
      const worker = deps.serviceWorker();
      if (worker) worker.postMessage({ type: PURGE_MESSAGE });
    } catch { /* No worker, no cache of its own. */ }
    try {
      const local = deps.localStorage();
      for (const key of Object.keys(local)) if (isPrivateStorageKey(key)) local.removeItem(key);
    } catch { /* Blocked storage holds nothing. */ }
    await clearOfflineQueue();
    /* The identity once kept here for every tab, before it was kept per tab. */
    try { deps.localStorage().removeItem('nv_me'); } catch { /* Blocked storage holds nothing. */ }
    state.file = null;
    const editor = state.cm as Editor | null;
    if (editor) {
      try { editor.setValue(''); } catch { /* An editor that will not empty is replaced on the next open. */ }
      try { editor.clearHistory(); } catch { /* As above. */ }
    }
    state.staged = [];
    deps.forgetRepositoryWork();
    state.work = null;
    state.repos = [];
    state.me = null;
    state.caps = null;
    state.fileIndex = null;
    /* The marker is neither a value nor a list of children, so the sweep below cannot reach it. */
    deps.paintUnread([]);
    for (const selector of PURGED_FIELDS) {
      const element = deps.find(selector);
      if (!element) continue;
      if ('value' in element) element.value = '';
      if (typeof element.replaceChildren === 'function') element.replaceChildren();
      else element.textContent = '';
    }
    if (full) deps.forgetReads();
  }

  function broadcast(): void {
    const marker = deps.marker();
    try {
      const told = theChannel();
      if (told) told.postMessage({ type: IDENTITY_BOUNDARY_MESSAGE, marker });
    } catch { /* A closed channel: storage still carries it. */ }
    try { deps.writeStorage(IDENTITY_BOUNDARY_STORAGE_KEY, marker); } catch { /* Blocked storage: the channel carried it, or nothing could. */ }
  }

  let receiving = false;
  async function receive(): Promise<void> {
    if (receiving) return;
    receiving = true;
    await purge(true);
    deps.reload();
  }

  function listen(): void {
    const heard = theChannel();
    if (heard) {
      heard.addEventListener('message', event => {
        const data = event.data as { type?: unknown } | null | undefined;
        if (data && data.type === IDENTITY_BOUNDARY_MESSAGE) receive().catch(() => {});
      });
    }
    deps.onStorage(event => {
      if (event.key === IDENTITY_BOUNDARY_STORAGE_KEY && event.newValue) receive().catch(() => {});
    });
  }

  return { purge, purgePrivateCaches, broadcast, receive, listen };
}
