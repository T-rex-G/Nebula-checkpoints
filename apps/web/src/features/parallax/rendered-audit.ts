/*
 * A rendered website audit, run: one anonymous page opened in an isolated
 * browser at two viewports, polled until it finishes, cancelled on request,
 * and reported as the server measured it. Decided here, without a page, so
 * the run's lifecycle can be checked on its own; drawn by RenderedAudit.tsx.
 */
import { field, items } from '../../platform/values.ts';

/* How the page reaches the server: the workbench's own request function, which throws with the answer's status and code. */
export type Api = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;

export interface AuditDeps {
  readonly api: Api;
  /* The wait between polls; a test hands in one that does not sleep. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface Viewport {
  readonly name: string;
  readonly width: string;
  readonly height: string;
  readonly finalUrl: string;
  readonly image: string;
  readonly metrics: readonly (readonly [string, string])[];
}

export interface Finding {
  readonly heading: string;
  readonly detail: string;
  readonly targets: string;
}

/* A finished report, read for the page: every value as text, every list as a list. */
export interface ResultView {
  readonly url: string;
  readonly filename: string;
  readonly scope: readonly string[];
  readonly viewports: readonly Viewport[];
  readonly findings: readonly Finding[];
}

export interface AuditState {
  readonly available: boolean;
  readonly busy: boolean;
  readonly status: string;
  readonly cancelDisabled: boolean;
  /* The server's report as it was sent, for the exports, and as the page reads it. */
  readonly report: unknown;
  readonly view: ResultView | null;
}

const POLL_MS = 1000;
const DEADLINE_MS = 115000;
const RETRIED_STATUSES: readonly number[] = Object.freeze([429, 502, 503, 504]);
const POLL_RETRIES = 3;

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/* A screenshot the page may show: a JPEG the server encoded, of a size a page can hold, and nothing else. */
export function imageUrl(shot: unknown): string {
  const data = field(shot, 'data');
  return field(shot, 'mimeType') === 'image/jpeg' && typeof data === 'string' && data.length < 2200000 && /^[A-Za-z0-9+/=]+$/.test(data)
    ? `data:image/jpeg;base64,${data}`
    : '';
}

function escape(value: unknown): string {
  return text(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/*
 * The report as a document of its own, for the reader to keep. Every value
 * the server or the audited page supplied is escaped, and the document's own
 * policy refuses scripts and any address but its embedded screenshots, so an
 * exported report is inert wherever it is opened.
 */
export function reportHtml(result: unknown): string {
  const url = field(result, 'url');
  const shots = items(field(result, 'viewports')).map(view => {
    const image = imageUrl(field(view, 'screenshot'));
    return `<figure><figcaption>${escape(field(view, 'name'))} · ${escape(field(view, 'width'))} × ${escape(field(view, 'height'))}</figcaption><p>Final page: ${escape(field(view, 'finalUrl') || url)}</p>${image ? `<img alt="${escape(field(view, 'name'))} viewport capture" src="${image}">` : '<p>Screenshot unavailable</p>'}<pre>${escape(JSON.stringify(field(view, 'facts'), null, 2))}</pre></figure>`;
  }).join('');
  const findings = items(field(result, 'findings')).map(item => `<li><strong>${escape(field(item, 'severity'))} · ${escape(field(item, 'viewport'))} · ${escape(field(item, 'title'))}</strong><p>${escape(field(item, 'detail'))}</p></li>`).join('');
  const coverage = field(result, 'coverage');
  const list = (values: unknown): string => items(values).map(reason => `<li>${escape(reason)}</li>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Nebulaverse rendered website audit</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172238;background:#f8fafc}img{max-width:100%;height:auto;border:1px solid #bac6d6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}li{margin:16px 0}figure{margin:28px 0}</style><h1>Rendered website audit</h1><p>${escape(url)} · ${escape(field(result, 'checkedAt'))}</p><p>Coverage: ${escape(field(coverage, 'state'))}</p><ul>${list(field(coverage, 'reasons'))}</ul><h2>Findings</h2><ul>${findings || '<li>No automated issues observed within this sample.</li>'}</ul><h2>Viewport evidence</h2>${shots}<h2>Scope and limitations</h2><ul>${list(field(result, 'limitations'))}</ul></html>`;
}

/* A finished report as the page shows it. */
export function resultView(result: unknown): ResultView {
  return {
    url: text(field(result, 'url')),
    filename: `website-rendered-${text(field(result, 'checkedAt')).slice(0, 10)}`,
    scope: [...items(field(field(result, 'coverage'), 'reasons')), ...items(field(result, 'limitations'))].map(text),
    viewports: items(field(result, 'viewports')).map(viewport => {
      const facts = field(viewport, 'facts');
      const metrics = field(facts, 'metrics');
      const lcp = field(metrics, 'lcpMs');
      const cls = field(metrics, 'cls');
      return {
        name: text(field(viewport, 'name')),
        width: text(field(viewport, 'width')),
        height: text(field(viewport, 'height')),
        finalUrl: text(field(viewport, 'finalUrl')),
        image: imageUrl(field(viewport, 'screenshot')),
        metrics: [
          ['LCP (lab)', lcp === null || lcp === undefined ? 'Unavailable' : `${text(lcp)} ms`],
          ['CLS (sample)', cls === null || cls === undefined ? 'Unavailable' : text(cls)],
          ['Horizontal overflow', `${text(field(facts, 'overflowPx'))} px`]
        ]
      };
    }),
    findings: items(field(result, 'findings')).map(finding => {
      const targets = field(finding, 'targets');
      return {
        heading: `${text(field(finding, 'severity'))} · ${text(field(finding, 'viewport'))} · ${text(field(finding, 'title'))}`,
        detail: text(field(finding, 'detail')),
        targets: targets ? items(targets).map(target => items(target).map(text).join(' → ')).join(', ') : ''
      };
    })
  };
}

/* A poll that failed is tried again only for an edge or network hiccup, and a few times: a coded answer is the run's own outcome, told once. */
export function pollAgain(error: unknown, failures: number): boolean {
  const status = field(error, 'status');
  return failures <= POLL_RETRIES && !field(error, 'code') && (!status || (typeof status === 'number' && RETRIED_STATUSES.includes(status)));
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

export interface Audit {
  state(): AuditState;
  subscribe(listener: () => void): () => void;
  readiness(): Promise<void>;
  start(url: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}

/* One panel's audit: what it shows, and the run behind it. */
export function createAudit({ api, wait = sleep, now = Date.now }: AuditDeps): Audit {
  let state: AuditState = Object.freeze({ available: false, busy: false, status: 'Checking browser availability…', cancelDisabled: false, report: null, view: null });
  const listeners = new Set<() => void>();
  /* The run in flight: its server id, which start it belongs to, and whether the reader asked to stop it. */
  let run = '';
  let version = 0;
  let cancelled = false;
  let disposed = false;

  const set = (change: Partial<AuditState>): void => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener();
  };
  const endpoint = (): string => `/api/site-rendered?${new URLSearchParams({ run })}`;

  async function readiness(): Promise<void> {
    try {
      const answer = await api('/api/site-rendered/status');
      const available = field(answer, 'available') === true;
      const message = field(answer, 'message');
      set({ available, status: typeof message === 'string' && message ? message : available ? 'Ready.' : 'Rendered audits are unavailable.' });
    } catch {
      set({ status: 'Browser availability could not be checked. Try again.' });
    }
  }

  async function cancel(): Promise<void> {
    cancelled = true;
    set({ status: 'Cancelling audit…', cancelDisabled: true });
    /* Until the start is answered there is no run to name; the answer is cancelled by its run when it lands. */
    if (!run) return;
    try {
      await api(endpoint(), { method: 'DELETE' });
    } catch (error) {
      if (field(error, 'status') !== 404) {
        set({ status: 'Cancellation could not be confirmed. Try cancelling again.', cancelDisabled: false });
        return;
      }
    }
    run = '';
    set({ status: 'Audit cancelled.', busy: false });
  }

  async function start(url: string): Promise<void> {
    if (state.busy || !state.available) return;
    const mine = ++version;
    const current = (): boolean => !disposed && mine === version;
    cancelled = false;
    run = '';
    set({ busy: true, cancelDisabled: false, report: null, view: null, status: 'Starting isolated browser…' });
    try {
      let answer = await api('/api/site-rendered', { method: 'POST', body: { url: url.trim() } });
      run = text(field(answer, 'run'));
      if (!current() || cancelled) { await cancel(); return; }
      const deadline = now() + DEADLINE_MS;
      let failures = 0;
      while (field(answer, 'state') === 'running') {
        /*
         * Past its deadline the run is released by its run, below, and said to
         * have taken too long. It is not the reader's cancel: that one marks
         * the run as theirs to stop, and the panel then said "Audit
         * cancelled." for a run the reader never touched.
         */
        if (now() > deadline) throw new Error('The audit took too long. Try again.');
        set({ status: `Checking ${text(field(answer, 'stage') || 'page').replace(/-/g, ' ')}…` });
        await wait(POLL_MS);
        if (!current() || cancelled) return;
        try {
          answer = await api(endpoint());
          failures = 0;
        } catch (error) {
          failures += 1;
          if (pollAgain(error, failures)) continue;
          throw error;
        }
        if (!current() || cancelled) return;
      }
      if (!field(answer, 'coverage') || !Array.isArray(field(answer, 'viewports'))) {
        throw new Error('The audit returned an incomplete report. Try again.');
      }
      const complete = Boolean(field(field(answer, 'coverage'), 'complete'));
      const observations = items(field(answer, 'findings')).length;
      set({
        report: answer,
        view: resultView(answer),
        status: `${complete ? 'Automated checks finished' : 'Partial report'} · ${observations} observations. Review coverage and evidence below.`
      });
    } catch (error) {
      /* The bounded worker still expires if connectivity was lost, so a failed release is not retried. */
      if (run) { try { await api(endpoint(), { method: 'DELETE' }); } catch { /* expires on its own */ } }
      const said = field(error, 'message');
      if (current() && !cancelled) set({ status: typeof said === 'string' && said ? said : 'The audit could not finish. Try again.' });
    } finally {
      if (current()) set({ busy: Boolean(cancelled && run) });
    }
  }

  /* The panel is gone: nothing it shows changes again, and a run it started is stopped. */
  function dispose(): void {
    const running = state.busy;
    disposed = true;
    listeners.clear();
    if (running) void cancel();
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readiness,
    start,
    cancel,
    dispose
  };
}
