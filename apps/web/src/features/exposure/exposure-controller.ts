/*
 * The Exposure screen at work: its findings read a page at a time and again
 * for a view, the history and each scan's report, a running scan followed
 * until it settles, a scan requested and canceled, the two-press checks --
 * verifying a credential with its issuer, accepting an exposure, asking a
 * project what the public can read -- the history cleared, and an export
 * collected whole or not at all.
 *
 * Everything asked for one repository is kept to it. An answer that arrives
 * after the reader has opened another repository, or let this one go, is
 * neither applied nor said: a refusal of a check on the first repository used
 * to be announced on the second one's screen. A scan canceled is canceled in
 * the history too; it used to stay "In progress" there while the proof card
 * said it was canceled.
 */
import { field, items } from '../../platform/values.ts';
import { PROBE_FALLBACK, VERIFICATION_FALLBACK, STATE_WORDS, answerFresh, exportRows, filtered, findingsUrl, wordFor } from './exposure-words.ts';
import type { ExposureView } from './exposure-words.ts';

type Rec = Record<string, unknown>;

export interface ExposureState extends Rec {
  scan: Rec | null;
  findings: Rec[];
  verifications: Record<string, unknown>;
  probes: Record<string, unknown>;
  probeDrafts: Record<string, { relation?: unknown; columns?: unknown }>;
  confirming: string;
  verifying: string;
  accepting: string;
  probing: string;
  clearing: boolean;
  loading: boolean;
  error: string;
  scopeKey: string;
  paged: boolean;
  total: number;
  counts: unknown;
  nextCursor: unknown;
  requestId: number;
  exporting: boolean;
  expanded: Set<unknown>;
  history: Rec[];
  historyLoading: boolean;
  historyDone: boolean;
  historyError: string;
  openScans: Set<unknown>;
  reports: Record<string, unknown>;
  view: { severity: unknown; status: unknown; where: unknown; query: unknown };
}

/*
 * One constructor for the screen's state, so a field added here is a field
 * every reset gets -- rather than three literals drifting apart and a
 * repository switch leaving the previous history on screen.
 */
export function freshExposureState(scopeKey = ''): ExposureState {
  return {
    scan: null, findings: [], verifications: {}, probes: {}, probeDrafts: {},
    confirming: '', verifying: '', accepting: '', probing: '', clearing: false,
    loading: false, error: '', scopeKey,
    paged: false, total: 0, counts: null, nextCursor: null, requestId: 0, exporting: false,
    expanded: new Set(),
    history: [], historyLoading: false, historyDone: false, historyError: '',
    openScans: new Set(), reports: {},
    view: { severity: null, status: 'all', where: 'all', query: '' }
  };
}

export interface ExposurePageState {
  readonly work: unknown;
  readonly me: unknown;
  exposure: unknown;
}

export interface ExposureDeps {
  readonly state: ExposurePageState;
  readonly api: (path: string, options?: { method: string; body?: unknown }) => Promise<unknown>;
  /* The screen's state changed in place, through the page's store. */
  readonly mutate: (change: (exposure: ExposureState) => void) => void;
  readonly render: () => void;
  readonly announce: (message: unknown) => void;
  readonly invalidatePosture: () => void;
  /* The open repository as the store keys it, and as its address names it. */
  readonly scopeKey: () => string;
  readonly path: () => string;
  /* Whether the Exposure tab is the one shown, and whether the page is. */
  readonly shown: () => boolean;
  readonly hidden: () => boolean;
  /* Whether the next scan reads history: the box on screen, or the kept preference when there is none. */
  readonly readsHistory: () => boolean;
  readonly timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
  readonly now: () => number;
  readonly download: (name: string, text: string, type: string) => void;
  readonly reports: { exposureSarif(rows: unknown, meta: Rec): string; exposureCsv(rows: unknown): string };
}

const running = (scan: unknown): boolean => field(scan, 'state') === 'queued' || field(scan, 'state') === 'running';
const codeOf = (error: unknown): unknown => field(error, 'code');
const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  EXPOSURE_AUTHORIZATION_MISSING: 'Reconnect GitHub, then try the scan again.',
  EXPOSURE_AUTHORIZATION_REVOKED: 'Your GitHub session expired. Reconnect GitHub, then try again.',
  EXPOSURE_REF_UNRESOLVED: 'This branch could not be found or accessed. Refresh your branches and check repository access.',
  EXPOSURE_PROVIDER_UNSUPPORTED: 'Repository exposure scanning currently supports GitHub only.',
  EXPOSURE_READ_FAILED: 'GitHub could not be reached or refused this read. Try again shortly; if it persists, check your GitHub connection.'
});

export interface ExposureController {
  current(): ExposureState;
  clear(): void;
  load(options?: { append?: boolean; filterOnly?: boolean }): Promise<void>;
  schedulePoll(current: ExposureState): void;
  /* The screen left: its scan is no longer followed. */
  stopPoll(): void;
  refreshScan(current?: ExposureState): Promise<void>;
  loadHistory(options?: { more?: boolean }): Promise<void>;
  loadReport(scanId: string): Promise<void>;
  clearHistory(): Promise<void>;
  arm(action: string, fingerprint: string, question: string): boolean;
  verify(fingerprint: string): Promise<void>;
  accept(fingerprint: string): Promise<void>;
  probe(fingerprint: string): Promise<void>;
  request(): Promise<void>;
  cancel(): Promise<void>;
  toggleAll(): void;
  filter(): void;
  exportFindings(kind: string): Promise<void>;
}

export function createExposure(deps: ExposureDeps): ExposureController {
  const { state } = deps;
  let pollTimer: unknown = null;

  function current(): ExposureState {
    if (!state.exposure) state.exposure = freshExposureState();
    return state.exposure as ExposureState;
  }
  /* Whether this screen state is still the open repository's. */
  const holds = (held: ExposureState, scopeKey: string): boolean => held === current() && scopeKey === deps.scopeKey();

  function clear(): void {
    deps.timers.clear(pollTimer);
    state.exposure = freshExposureState();
    deps.render();
  }

  async function load({ append = false, filterOnly = false }: { append?: boolean; filterOnly?: boolean } = {}): Promise<void> {
    if (!state.work) return;
    const scopeKey = deps.scopeKey();
    if (current().scopeKey !== scopeKey) state.exposure = freshExposureState(scopeKey);
    const now = current();
    if (append && (!now.nextCursor || now.loading)) return;
    deps.mutate(() => {
      now.requestId += 1;
      now.loading = true;
    });
    const requestId = now.requestId;
    deps.render();
    if (!filterOnly) void loadHistory();
    try {
      const page = await deps.api(findingsUrl(deps.path(), now.view as ExposureView, append ? now.nextCursor : null));
      if (!holds(now, scopeKey) || requestId !== now.requestId) return;
      if (!page || typeof page !== 'object') throw new Error('The findings answered with no page.');
      const found = Array.isArray(field(page, 'findings')) ? field(page, 'findings') as Rec[] : [];
      deps.mutate(() => {
        now.findings = append ? [...now.findings, ...found] : found;
        now.paged = Number.isInteger(field(page, 'total')) && Boolean(field(page, 'counts'));
        now.total = now.paged ? field(page, 'total') as number : found.length;
        now.counts = now.paged ? field(page, 'counts') : null;
        now.nextCursor = field(page, 'nextCursor') || null;
        now.verifications = { ...(append ? now.verifications : {}), ...(field(page, 'verifications') as Rec || {}) };
        now.probes = { ...(append ? now.probes : {}), ...(field(page, 'probes') as Rec || {}) };
      });
      if (now.error) deps.announce('Findings loaded.');
      deps.mutate(() => { now.error = ''; });
    } catch (error) {
      if (!holds(now, scopeKey) || requestId !== now.requestId) return;
      if (codeOf(error) === 'EXPOSURE_CURSOR_STALE') {
        deps.mutate(() => { now.loading = false; });
        deps.announce('Findings changed. Loading the current view.');
        return load({ filterOnly: true });
      }
      deps.mutate(() => {
        if (!append) {
          now.findings = [];
          now.verifications = {};
          now.probes = {};
          now.nextCursor = null;
        }
        now.error = 'Findings could not be loaded for this repository. Refresh to try again.';
      });
    } finally {
      if (requestId === now.requestId) deps.mutate(() => { now.loading = false; });
      if (holds(now, scopeKey)) {
        deps.render();
        schedulePoll(now);
      }
    }
  }

  /* A scan runs asynchronously: its status is read every two seconds while the screen shows it, and never after. */
  function schedulePoll(held: ExposureState): void {
    deps.timers.clear(pollTimer);
    if (held !== current() || held.scopeKey !== deps.scopeKey() || !deps.shown() || !running(held.scan)) return;
    pollTimer = deps.timers.set(() => { void refreshScan(held); }, 2000);
  }

  function stopPoll(): void { deps.timers.clear(pollTimer); }

  async function refreshScan(held: ExposureState = current()): Promise<void> {
    if (held !== current() || held.scopeKey !== deps.scopeKey() || !deps.shown() || !held.scan) return;
    if (deps.hidden()) { schedulePoll(held); return; }
    const scanId = held.scan.scanId;
    const ours = (): boolean => held === current() && field(held.scan, 'scanId') === scanId && held.scopeKey === deps.scopeKey();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/scans/${encodeURIComponent(String(scanId))}`);
      if (!ours()) return;
      const scan = field(body, 'scan') as Rec | undefined;
      if (!scan) throw new Error('Missing scan status');
      /* A status read begun before cancellation cannot resurrect the scan. */
      if (field(held.scan, 'state') === 'canceled') return;
      deps.mutate(() => {
        held.scan = scan;
        held.error = '';
        held.history = held.history.map(item => (item.scanId === scan.scanId ? { ...item, ...scan } : item));
      });
      deps.render();
      if (running(held.scan)) schedulePoll(held);
      else {
        deps.announce(`Scan ${wordFor(STATE_WORDS, field(held.scan, 'state')) || 'finished'}. Updating findings.`);
        deps.invalidatePosture();
        await load();
      }
    } catch {
      if (!ours() || field(held.scan, 'state') === 'canceled') return;
      deps.mutate(() => { held.error = 'The status check failed. Your scan may still be running. Retry the status check.'; });
      deps.render();
      deps.announce(held.error);
    }
  }

  async function loadHistory({ more = false }: { more?: boolean } = {}): Promise<void> {
    if (!state.work) return;
    const held = current();
    const scopeKey = deps.scopeKey();
    if (held.historyLoading) return;
    deps.mutate(() => { held.historyLoading = true; });
    deps.render();
    try {
      const last = more ? held.history[held.history.length - 1] : null;
      const query = new URLSearchParams({ limit: '20' });
      if (last) {
        query.set('beforeAt', String(last.createdAt));
        query.set('beforeId', String(last.scanId));
      }
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/scans?${query}`);
      if (!holds(held, scopeKey)) return;
      const page = items(field(body, 'scans')) as Rec[];
      deps.mutate(() => {
        held.history = more ? [...held.history, ...page] : page;
        held.historyDone = page.length < 20;
        held.historyError = '';
      });
      /*
       * The proof card shows the newest scan when this session has not started
       * one -- a reader coming back should see what the last scan proved, not
       * an invitation to start one as though none had ever run.
       */
      const newest = page[0];
      if (!more && newest && (!held.scan || held.scan.scanId === newest.scanId)) deps.mutate(() => { held.scan = newest; });
    } catch {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => { held.historyError = 'Scan history could not be loaded.'; });
    } finally {
      if (held === current()) {
        deps.mutate(() => { held.historyLoading = false; });
        deps.render();
        schedulePoll(held);
      }
    }
  }

  /* A scan's report, read whole: at most five pages of a hundred, and a continuation that repeats itself ends it. */
  async function loadReport(scanId: string): Promise<void> {
    const held = current();
    const scopeKey = deps.scopeKey();
    const existing = Object.hasOwn(held.reports, scanId) ? held.reports[scanId] : undefined;
    if (existing && (field(existing, 'loading') || field(existing, 'entries'))) return;
    deps.mutate(() => { held.reports[scanId] = { loading: true, entries: null, error: '' }; });
    deps.render();
    try {
      const observations: unknown[] = [];
      const cursors = new Set<unknown>();
      const base = `/api/repo/${deps.path()}/exposure/scans/${encodeURIComponent(scanId)}/observations`;
      let cursor: unknown = null;
      let complete = false;
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', String(cursor));
        const body = await deps.api(`${base}?${query}`);
        if (!holds(held, scopeKey)) return;
        const listed = field(body, 'observations');
        if (!body || !Array.isArray(listed)) throw new Error('Invalid scan report');
        observations.push(...listed.slice(0, 100));
        complete = field(body, 'complete') === true && listed.length <= 100;
        const next = field(body, 'nextCursor');
        if (complete || !next || cursors.has(next)) break;
        cursor = next;
        cursors.add(cursor);
      }
      deps.mutate(() => {
        held.reports[scanId] = {
          loading: false, error: '', complete,
          entries: observations.filter(item => item && field(item, 'finding')).map(item => ({
            ...(field(item, 'finding') as Rec), occurrences: field(item, 'occurrences'), occurrenceCount: field(item, 'occurrenceCount')
          }))
        };
      });
    } catch {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => { held.reports[scanId] = { loading: false, entries: null, error: 'This scan\u2019s report could not be loaded.' }; });
    } finally {
      if (held === current()) deps.render();
    }
  }

  /*
   * Two presses, and the second one is the one that acts. The armed control
   * is named by action and fingerprint together, so arming one disarms every
   * other.
   */
  function arm(action: string, fingerprint: string, question: string): boolean {
    const held = current();
    const key = `${action}:${fingerprint}`;
    if (held.confirming === key) return false;
    deps.mutate(() => { held.confirming = key; });
    deps.render();
    deps.announce(question);
    return true;
  }

  /*
   * Clearing, armed like every other irreversible control. On success the
   * screen is emptied rather than reloaded: there is nothing left to load, and
   * a reload racing the delete could briefly show what was just removed.
   */
  async function clearHistory(): Promise<void> {
    if (!state.work) return;
    const held = current();
    if (arm('clear', 'history', 'Press again to delete every scan, finding and check result for this repository.')) return;
    deps.mutate(() => {
      held.confirming = '';
      held.clearing = true;
    });
    deps.render();
    const scopeKey = deps.scopeKey();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/clear`, { method: 'POST', body: { confirm: 'clear-exposure-history' } });
      if (!holds(held, scopeKey)) return;
      const cleared = field(body, 'cleared') || {};
      deps.timers.clear(pollTimer);
      state.exposure = freshExposureState(scopeKey);
      deps.mutate(exposure => { exposure.historyDone = true; });
      deps.render();
      deps.announce(`Cleared ${Number(field(cleared, 'scans')) || 0} scans and ${Number(field(cleared, 'findings')) || 0} findings.`);
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => {
        held.clearing = false;
        held.error = codeOf(error) === 'EXPOSURE_SCAN_ACTIVE'
          ? 'A scan is still running. Cancel it before clearing the history.'
          : 'The history could not be cleared.';
      });
      deps.render();
      deps.announce(held.error);
    }
  }

  /* A finding changed by the server's answer, in the list as it now stands. */
  const merge = (held: ExposureState, fingerprint: string, finding: unknown): void => {
    if (!finding) return;
    deps.mutate(() => {
      held.findings = held.findings.map(item => (item.fingerprint === fingerprint ? { ...item, ...(finding as Rec) } : item));
    });
  };

  /* The verification of a credential with the service that issued it: it contacts a third party, so it takes two presses. */
  async function verify(fingerprint: string): Promise<void> {
    if (!state.work) return;
    const held = current();
    const scopeKey = deps.scopeKey();
    if (arm('verify', fingerprint, 'Press again to send this credential to the service that issued it.')) return;
    deps.mutate(() => {
      held.confirming = '';
      held.verifying = fingerprint;
    });
    deps.render();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/findings/${fingerprint}/verify`, {
        method: 'POST',
        body: { confirm: 'use-this-credential', authorized: true }
      });
      /* Checked on the credential's own repository either way, so its posture is read again. */
      if (!holds(held, scopeKey)) { deps.invalidatePosture(); return; }
      const narration = field(body, 'narration');
      const answered = field(body, 'verification');
      const verification = answered ? { ...(answered as Rec), narration } : null;
      if (verification) deps.mutate(() => { held.verifications[fingerprint] = verification; });
      deps.invalidatePosture();
      merge(held, fingerprint, field(body, 'finding'));
      deps.announce(verification && (narration || (answerFresh(verification, deps.now())
        ? wordFor(VERIFICATION_FALLBACK, field(verification, 'state'))
        : 'Previous verification expired or has no check time. Check again for current evidence.')) || 'The check finished.');
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => {
        held.error = codeOf(error) === 'GOVERNANCE_ROLE_REQUIRED'
          ? 'A governance administrator with permission from the credential owner must run this check.'
          : 'That credential could not be checked.';
      });
      deps.announce(held.error);
    } finally {
      deps.mutate(() => { held.verifying = ''; });
      deps.render();
    }
  }

  /*
   * Accepting the risk: not a dismissal. The finding stays, the sentence under
   * it says a person accepted the exposure and that the credential is still in
   * the repository, and the server records the name.
   */
  async function accept(fingerprint: string): Promise<void> {
    if (!state.work) return;
    const held = current();
    const scopeKey = deps.scopeKey();
    if (arm('accept', fingerprint, 'Press again to record you as accepting this exposure. Nothing here undoes it.')) return;
    deps.mutate(() => {
      held.confirming = '';
      held.accepting = fingerprint;
    });
    deps.render();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/findings/${fingerprint}/accept-risk`, { method: 'POST' });
      /* Recorded on the finding's own repository either way, so its posture is read again. */
      if (!holds(held, scopeKey)) { deps.invalidatePosture(); return; }
      merge(held, fingerprint, field(body, 'finding'));
      deps.mutate(() => { held.error = ''; });
      deps.invalidatePosture();
      deps.announce('Recorded. The credential is still in the repository.');
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      /* Who may accept is the server's decision and it is a role: saying so beats "that did not work". */
      deps.mutate(() => {
        held.error = codeOf(error) === 'GOVERNANCE_ROLE_REQUIRED'
          ? 'Accepting an exposure needs a governance administrator. Yours is recorded as a lower role.'
          : 'That finding could not be accepted.';
      });
      deps.announce(held.error);
    } finally {
      deps.mutate(() => { held.accepting = ''; });
      deps.render();
    }
  }

  /*
   * Asking the project what the anonymous role can read: a table and the
   * columns typed, refused here only when nothing is typed, and two presses.
   */
  async function probe(fingerprint: string): Promise<void> {
    if (!state.work) return;
    const held = current();
    const scopeKey = deps.scopeKey();
    const draft = held.probeDrafts[fingerprint] || { relation: '', columns: '' };
    const relation = String(field(draft, 'relation') || '').trim();
    const projection = String(field(draft, 'columns') || '').split(',').map(column => column.trim()).filter(Boolean);
    if (!relation || !projection.length) {
      deps.announce('Name a table and at least one column before asking.');
      return;
    }
    if (arm('probe', fingerprint, 'Press again to send one request to that project.')) return;
    deps.mutate(() => {
      held.confirming = '';
      held.probing = fingerprint;
    });
    deps.render();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/findings/${fingerprint}/probe-readability`, {
        method: 'POST',
        body: { confirm: 'contact-this-project', authorized: true, relation, projection }
      });
      if (!holds(held, scopeKey)) return;
      const narration = field(body, 'narration');
      const answered = field(body, 'probe');
      const result = answered ? { ...(answered as Rec), narration } : null;
      deps.mutate(() => {
        if (result) held.probes[fingerprint] = result;
        held.error = '';
      });
      deps.announce((result && (narration || (answerFresh(result, deps.now())
        ? wordFor(PROBE_FALLBACK, field(result, 'state'))
        : 'Previous readability result expired or has no check time. Check again for current evidence.'))) || 'The question finished.');
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      const code = codeOf(error);
      deps.mutate(() => {
        held.error = code === 'GOVERNANCE_ROLE_REQUIRED'
          ? 'A governance administrator with permission from the project owner must run this probe.'
          : code === 'EXPOSURE_PROBE_NOT_ANONYMOUS'
            ? 'Only an anonymous key can be used to ask what the public can read.'
            : code === 'EXPOSURE_PROBE_NO_PROJECT'
              ? 'No project reference was found beside that key, so there is nothing to ask.'
              : 'That project could not be asked.';
      });
      deps.announce(held.error);
    } finally {
      deps.mutate(() => { held.probing = ''; });
      deps.render();
    }
  }

  async function request(): Promise<void> {
    if (!state.work) return;
    const held = current();
    if (held.loading || running(held.scan)) return;
    const scopeKey = deps.scopeKey();
    deps.mutate(() => { held.loading = true; });
    deps.render();
    try {
      const history = deps.readsHistory();
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/scans`, {
        method: 'POST',
        body: { ref: field(state.work, 'branch') || 'HEAD', history }
      });
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => {
        held.scan = (field(body, 'scan') as Rec | undefined) || null;
        held.error = '';
      });
      const scan = held.scan;
      if (scan && !held.history.some(item => item.scanId === scan.scanId)) {
        deps.mutate(() => {
          held.history = [{ ...scan, findingCount: 0, severityCounts: { critical: 0, serious: 0, warning: 0 } }, ...held.history];
        });
      }
      deps.announce('Scan requested. Nothing is proven until it finishes.');
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => { held.error = wordFor(MESSAGES, codeOf(error)) || 'The scan could not be started for this repository. Try again or check your repository access.'; });
      deps.announce(held.error);
    } finally {
      deps.mutate(() => { held.loading = false; });
      if (holds(held, scopeKey)) {
        deps.render();
        schedulePoll(held);
      }
    }
  }

  async function cancel(): Promise<void> {
    if (!state.work) return;
    const held = current();
    if (!held.scan) return;
    /* Still this screen's, and the screen still the open repository's. */
    const ours = (): boolean => held === current() && held.scopeKey === deps.scopeKey();
    try {
      const body = await deps.api(`/api/repo/${deps.path()}/exposure/scans/${encodeURIComponent(String(held.scan.scanId))}/cancel`, { method: 'POST' });
      if (!ours()) return;
      const scan = field(body, 'scan') as Rec | undefined;
      deps.mutate(() => {
        if (scan) {
          held.scan = scan;
          /* The history says what the proof card says: the scan is canceled there too. */
          held.history = held.history.map(item => (item.scanId === scan.scanId ? { ...item, ...scan } : item));
        }
        held.error = '';
      });
      deps.timers.clear(pollTimer);
      deps.announce('Scan canceled. Its coverage is partial.');
    } catch {
      if (!ours()) return;
      deps.mutate(() => { held.error = 'The scan could not be canceled.'; });
      deps.announce(held.error);
    } finally {
      deps.render();
    }
  }

  function toggleAll(): void {
    const held = current();
    const allOpen = held.findings.length > 0 && held.findings.every(finding => held.expanded.has(finding.fingerprint));
    deps.mutate(() => { held.expanded = allOpen ? new Set() : new Set(held.findings.map(finding => finding.fingerprint)); });
    deps.render();
    deps.announce(allOpen ? 'All findings collapsed.' : 'All findings expanded.');
  }

  function filter(): void {
    if (current().paged) {
      deps.mutate(exposure => {
        exposure.findings = [];
        exposure.nextCursor = null;
      });
      void load({ filterOnly: true });
    } else deps.render();
  }

  /* An export is collected whole, or not at all: a paged list is read to its end, bounded, and checked against its total. */
  async function exportFindings(kind: string): Promise<void> {
    const held = current();
    if (held.exporting) return;
    let shown = filtered(held as never) as Rec[];
    const scopeKey = deps.scopeKey();
    const selected = { view: { ...held.view } as ExposureView };
    deps.mutate(() => { held.exporting = true; });
    deps.render();
    try {
      if (held.paged) {
        const collected: Rec[] = [];
        let cursor: unknown = null;
        do {
          const page = await deps.api(findingsUrl(deps.path(), selected.view, cursor, 200));
          if (!holds(held, scopeKey)) return;
          const listed = field(page, 'findings');
          if (!page || !Array.isArray(listed) || !Number.isInteger(field(page, 'total'))) throw new Error('Incomplete export response');
          collected.push(...listed);
          deps.mutate(() => { Object.assign(held.verifications, field(page, 'verifications') || {}); });
          cursor = field(page, 'nextCursor');
          if (collected.length > 10000 || (cursor && !listed.length)) throw new Error('Export limit reached');
          if (!cursor && collected.length !== field(page, 'total')) throw new Error('Incomplete export');
        } while (cursor);
        shown = collected;
      }
      if (!shown.length) return;
      const rows = exportRows(shown, held.verifications, deps.now());
      const day = new Date(deps.now()).toISOString().slice(0, 10);
      const work = state.work;
      const base = `${String(field(work, 'repo'))}-exposure-${day}`;
      if (kind === 'sarif') {
        const provider = field(state.me, 'provider') || 'github';
        const scan = held.scan || {};
        deps.download(`${base}.sarif`, deps.reports.exposureSarif(rows, {
          ref: field(work, 'branch'), commitSha: field(scan, 'commitSha'),
          repositoryUri: provider === 'github' ? `https://github.com/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}` : ''
        }), 'application/sarif+json');
      } else {
        deps.download(`${base}.csv`, deps.reports.exposureCsv(rows), 'text/csv');
      }
      deps.announce(`${rows.length} ${rows.length === 1 ? 'finding' : 'findings'} exported.`);
    } catch (error) {
      if (!holds(held, scopeKey)) return;
      deps.mutate(() => {
        held.error = codeOf(error) === 'EXPOSURE_CURSOR_STALE'
          ? 'Findings changed during export. Refresh and export again.'
          : 'A complete export could not be collected. Narrow the filters or try again.';
      });
      deps.announce(held.error);
    } finally {
      deps.mutate(() => { held.exporting = false; });
      if (held === current()) deps.render();
    }
  }

  return { current, clear, load, schedulePoll, stopPoll, refreshScan, loadHistory, loadReport, clearHistory, arm, verify, accept, probe, request, cancel, toggleAll, filter, exportFindings };
}
