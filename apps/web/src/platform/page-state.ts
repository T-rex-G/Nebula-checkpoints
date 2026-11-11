/*
 * What the page knows, in its one store (ADR-092).
 *
 * The workbench reads and writes `state` as it always did -- `state.work`,
 * `state.me = identity` -- and each slice is the store's: reading one reads
 * the store, assigning one replaces it in the store and tells every listener.
 * A slice that is changed in place (a repository's branch, a file's dirty
 * flag, the governance view's filters) is changed through
 * `pageStore.mutate`, which keeps it the same object -- the page compares
 * these records by identity to tell one repository, file or session from the
 * next -- and announces the change. A rule over the page's syntax tree
 * refuses any other in-place change (test/page-rules.test.js).
 *
 * The slices are typed by what is known of them here. A record the page only
 * passes along is `unknown` until the module that owns it is rebuilt and says
 * what it holds.
 */
import { createStore } from './store.ts';

export interface EditorSettings {
  fontSize: number;
  wrap: boolean;
  motion: boolean;
  editorTheme: string;
  editorFont: string;
  design: string;
}

/* Each limit in megabytes, or null until the deployment has said. */
export interface RuntimeLimits {
  uploadMaxMb: number | null;
  gitDataMaxMb: number | null;
  nativePushMaxMb: number | null;
  contentsMaxMb: number | null;
  githubApp: { enabled: boolean; webhookConfigured: boolean };
}

export interface PageState {
  /* Who is signed in, and what this deployment and this reader allow. */
  /* The signed-in identity, or null. Replaced, never changed, so a guard holding it notices a new one. */
  me: unknown;
  caps: unknown;
  safety: unknown;
  runtime: RuntimeLimits;
  settings: EditorSettings;
  /* Grows at every identity boundary; a reading started before it moved is discarded. */
  uiEpoch: number;

  /* Everything the reader has connected, and what was last read of it. */
  repos: unknown[];
  repoPage: number;
  repoSort: string;
  posture: unknown;
  securityPosture: unknown;
  scanner: unknown;

  /* The repository that is open: a record whose identity is the open repository. */
  work: unknown;
  /* The repository still opening, as the promise of its first answer. */
  opening: unknown;

  /* The open repository's files and lists, as the workbench's own tools hold them. */
  /* The open file: a record whose identity is the open file. */
  file: unknown;
  /* The editor itself, once made. */
  cm: unknown;
  fileIndex: unknown;
  staged: unknown[];
  commitsPage: number;
  prState: string;
  issueState: string;
  pendingPull: unknown;
  pendingFind: unknown;

  /* What each engine's view holds for the open repository. */
  governance: Record<string, unknown>;
  exposure: unknown;
}

function initialPageState(): PageState {
  return {
    me: null,
    posture: null,
    uiEpoch: 0,
    repos: [], repoPage: 1, repoSort: 'pushed',
    work: null, opening: null, file: null, cm: null,
    commitsPage: 1,
    staged: [],
    fileIndex: null,
    prState: 'open', issueState: 'open',
    settings: { fontSize: 14, wrap: true, motion: true, editorTheme: 'material-ocean', editorFont: 'DM Mono', design: 'nebula' },
    governance: {
      digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '',
      decisionPages: [], delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' }
    },
    /*
     * Limits start unknown, not at the self-hosted maxima. These three used to
     * hold 2048/64/64 -- the ceilings of a self-hosted deployment -- so until
     * /api/config answered, and forever if it never did, a hosted alpha
     * enforcing 25/16/16 told its reader the per-file limit was 2048 MB and
     * labelled a 30 MB file as a Git Data API push the server would refuse. A
     * number nobody sent us is not a smaller number; it is no number.
     */
    runtime: {
      uploadMaxMb: null, gitDataMaxMb: null, nativePushMaxMb: null, contentsMaxMb: null,
      githubApp: { enabled: false, webhookConfigured: false }
    },
    /* Set when the page first learns them. */
    safety: undefined,
    caps: undefined,
    exposure: undefined,
    securityPosture: undefined,
    pendingPull: undefined,
    pendingFind: undefined,
    scanner: undefined
  };
}

export const pageStore = createStore<PageState>(initialPageState());

/* Every slice's name: the properties `state` has, and the only ones. */
export const PAGE_SLICES: readonly (keyof PageState)[] = Object.freeze(Object.keys(initialPageState()) as (keyof PageState)[]);

/*
 * The page's state as the workbench reads and writes it. Each slice is a
 * property whose value is the store's and whose assignment goes through it.
 * Sealed: a slice the store does not have cannot be made by assigning it.
 */
export const state: PageState = (() => {
  const view = {} as PageState;
  for (const key of PAGE_SLICES) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => pageStore.get()[key],
      set: (value: PageState[typeof key]) => { pageStore.set(key, value); }
    });
  }
  return Object.seal(view);
})();
