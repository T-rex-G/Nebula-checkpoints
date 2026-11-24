/*
 * The deployed-site check: Parallax's page for any address, and the link to
 * it on a repository's audit.
 *
 * A check is a job on the server, as an audit is: the first request starts
 * it and answers with a run id, and the page asks after it -- quickly, a
 * check takes seconds -- hearing the stage each time, until the result is
 * there. A poll lost to the network or the edge is asked again, a few times.
 *
 * The address typed is remembered under the audit prefix the account purge
 * removes, and so are the last check's fingerprints; a check sent from a
 * repository's audit is remembered as that repository's address, so its
 * audit names it from then on. The audit shows the latest check of its
 * address, and is drawn again when one ends, whichever page the reader is
 * on -- it said "Checking" until something else drew it. A check belongs to
 * the session it was asked in: one ended after the account left is dropped.
 * An answer without an address is a failure, not a result left running.
 */
import { field } from '../../platform/values.ts';

export interface SiteView {
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly url: string;
  readonly suggested: boolean;
  readonly result: unknown;
  readonly diff: unknown;
  readonly error: string;
  readonly progress: unknown;
  /* The repository an audit sent the check from, by its key; null when it was not. */
  readonly from?: string | null;
}

export interface SiteLink {
  readonly link: true;
  readonly url: string;
  readonly suggested: boolean;
  readonly result: unknown;
  readonly status: 'idle' | 'running' | 'done';
}

export interface SiteHandlers {
  readonly onSiteBack: (() => void) | null;
  readonly onSiteInput: (value: string) => void;
  readonly onSiteCheck: (address: string) => void;
  readonly onSiteCopyAll: () => Promise<void>;
  readonly onCopy: (finding: unknown) => unknown;
  readonly onExport: (kind: string) => unknown;
}

export interface SiteCheckDeps {
  readonly api: (path: string) => Promise<unknown>;
  /* The open repository: a record with its owner, name and declared homepage; null when none is open. */
  readonly work: () => unknown;
  /* The session's epoch: it changes when the account leaves. */
  readonly epoch: () => unknown;
  readonly stored: (name: string) => string | null;
  readonly store: (name: string, value: string) => void;
  readonly memory: {
    readonly prefix: string;
    readPrevious(key: string): unknown;
    remember(key: string, value: unknown): void;
    diff(result: unknown, previous: unknown): unknown;
  };
  /* Whether this deployment checks sites, and why not when it does not. */
  readonly decision: () => { readonly status: string; readonly reason?: string };
  readonly screen: {
    render(view: SiteView & { from: string | null }, handlers: SiteHandlers): void;
    /* The page told why it cannot check. */
    refuse(reason: string): void;
    clear(): void;
  };
  readonly rendered: { mount(): void; dispose(): void };
  /* The page showing: 'site' for this one. */
  readonly page: () => string;
  readonly showPage: (name: string) => void;
  readonly showAudit: () => void;
  /* The audit drawn again, when it is the tool showing. */
  readonly repaintAudit: () => void;
  readonly copyPrompt: (text: unknown) => unknown;
  readonly copyText: (text: string) => Promise<void>;
  readonly prompts: (result: unknown) => string;
  readonly toast: (message: string, kind?: string) => void;
  readonly download: (name: string, text: string, type: string) => void;
  readonly reports: {
    sarif(result: unknown, site: unknown, meta: unknown): string;
    csv(result: unknown, site: unknown, diff: unknown): string;
    brief(result: unknown, label: string, site: unknown): string;
  };
  /* Whether a failed poll is the network's or the edge's, to be asked again. */
  readonly transient: (error: unknown) => boolean;
  readonly transientTries: () => number;
  readonly pause: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface SiteCheck {
  /* The repository's key the audit and the check share: owner/name. */
  key(): string;
  /* What the audit shows of its address: the address, whether it was suggested, the latest result and whether one is running. */
  link(): SiteLink;
  /* The page opened from the audit, for its address; with check, the address checked at once. */
  open(options?: { readonly check?: boolean }): void;
  /* The page opened from the rail: for any address, not the repository's. */
  openFromRail(): void;
  show(): void;
  paint(): void;
  run(address: string): Promise<void>;
  /* Everything the page holds let go of, and any check in flight dropped. */
  clear(): void;
}

export const UNREADABLE = 'The site check answered without the address it checked.';
const STANDALONE = 'site-url:standalone';

/* An address's origin, when it is one this check may ask: https only. */
export function siteOriginOf(address: unknown): string | null {
  try {
    const url = new URL(String(address ?? '').trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

/* A check's result, when it names the address it checked. */
const readable = (result: unknown): boolean => typeof field(result, 'origin') === 'string' && Boolean(field(result, 'origin'));
const message = (error: unknown): string => {
  const text = field(error, 'message');
  return typeof text === 'string' && text ? text : 'The site could not be checked.';
};
const retryAfter = (error: unknown): number => {
  const seconds = field(error, 'retryAfter');
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
};

export function createSiteCheck(deps: SiteCheckDeps): SiteCheck {
  let view: SiteView | null = null;
  let request = 0;

  const key = (): string => {
    const work = deps.work();
    return work ? `${String(field(work, 'owner'))}/${String(field(work, 'repo'))}` : '';
  };
  const urlKey = (): string => `${deps.memory.prefix}site-url:${key().toLowerCase()}`;

  function blank(): SiteView {
    return { status: 'idle', url: deps.stored(`${deps.memory.prefix}${STANDALONE}`) || '', suggested: false, result: null, diff: null, error: '', progress: null };
  }

  function link(): SiteLink {
    const remembered = deps.stored(urlKey()) || '';
    const homepage = field(deps.work(), 'homepage');
    const declared = typeof homepage === 'string' ? homepage : '';
    const url = remembered || declared;
    const origin = siteOriginOf(url);
    const result = origin && view && field(view.result, 'origin') === origin ? view.result : null;
    const running = Boolean(origin && view && view.status === 'running' && siteOriginOf(view.url) === origin);
    return { link: true, url, suggested: !remembered && Boolean(declared), result, status: running ? 'running' : result ? 'done' : 'idle' };
  }

  async function poll(path: string, current: () => boolean, onProgress: (progress: unknown) => void): Promise<unknown> {
    let answer = await deps.api(path);
    let misses = 0;
    let wait = 700;
    while (field(answer, 'state') === 'running') {
      if (!current()) return null;
      onProgress(answer);
      await deps.pause(wait);
      if (!current()) return null;
      try {
        answer = await deps.api(`${path}&run=${encodeURIComponent(String(field(answer, 'run')))}`);
        misses = 0;
        wait = Math.min(2000, Math.round(wait * 1.25));
      } catch (error) {
        misses += 1;
        if (!deps.transient(error) || misses > deps.transientTries()) throw error;
        wait = Math.min(4000, Math.max(wait, retryAfter(error) * 1000) * 1.5);
      }
    }
    return answer;
  }

  function paint(): void {
    if (!view) view = blank();
    const decision = deps.decision();
    if (decision.status !== 'Supported') {
      deps.rendered.dispose();
      deps.screen.refuse(String(decision.reason ?? ''));
      return;
    }
    deps.rendered.mount();
    const shown = view;
    const from = shown.from && shown.from === key() ? shown.from : null;
    deps.screen.render({ ...shown, from }, {
      onSiteBack: from ? () => deps.showAudit() : null,
      onSiteInput: value => { if (view) view = { ...view, url: value }; },
      onSiteCheck: address => { void run(address); },
      onSiteCopyAll: async () => {
        try { await deps.copyText(deps.prompts(view && view.result)); deps.toast('Every site fix prompt copied', 'ok'); } catch { deps.toast('The clipboard is not available here', 'err'); }
      },
      onCopy: finding => deps.copyPrompt(field(finding, 'prompt')),
      onExport: kind => {
        const site = view && view.result;
        if (!readable(site)) return;
        const host = String(field(site, 'origin')).replace(/^https:\/\//, '');
        const checkedAt = field(site, 'checkedAt');
        const day = (typeof checkedAt === 'string' && checkedAt ? checkedAt : new Date(deps.now()).toISOString()).slice(0, 10);
        const base = `${host}-site-check-${day}`;
        if (kind === 'sarif') return deps.download(`${base}.sarif`, deps.reports.sarif(null, site, {}), 'application/sarif+json');
        if (kind === 'csv') return deps.download(`${base}.csv`, deps.reports.csv(null, site, null), 'text/csv');
        return deps.download(`${base}.md`, deps.reports.brief(null, host, site), 'text/markdown');
      }
    });
  }

  function show(): void {
    deps.showPage('site');
    paint();
  }

  /* The page and the audit's link drawn again, each where it is showing. */
  function ended(): void {
    if (deps.page() === 'site') paint();
    deps.repaintAudit();
  }

  async function run(address: string): Promise<void> {
    if (!view || view.status === 'running') return;
    const mine = ++request;
    const epoch = deps.epoch();
    const current = (): boolean => mine === request && epoch === deps.epoch();
    view = { ...view, url: String(address ?? '').trim(), status: 'running', error: '', progress: null };
    paint();
    try {
      const result = await poll(`/api/site-check?url=${encodeURIComponent(view.url)}`, current, progress => {
        if (view) view = { ...view, progress };
        paint();
      });
      if (!current()) return;
      if (!readable(result)) throw new Error(UNREADABLE);
      const origin = String(field(result, 'origin'));
      const from = view.from || null;
      try {
        deps.store(`${deps.memory.prefix}${STANDALONE}`, origin);
        /* Checked for a repository: its audit names this address from now on. */
        if (from) deps.store(`${deps.memory.prefix}site-url:${from.toLowerCase()}`, origin);
      } catch {}
      const fingerprints = `site:${origin}`;
      const previous = deps.memory.readPrevious(fingerprints);
      deps.memory.remember(fingerprints, { ...(result as object), auditedAt: field(result, 'checkedAt') });
      view = { status: 'done', url: origin, suggested: false, result, diff: deps.memory.diff(result, previous), error: '', progress: null, from };
    } catch (error) {
      if (!current() || !view) return;
      view = { ...view, status: 'error', error: message(error), progress: null };
    }
    ended();
  }

  function open({ check = false }: { readonly check?: boolean } = {}): void {
    const shown = link();
    if (!view) view = blank();
    if (view.status !== 'running') {
      view = { ...view, url: shown.url || view.url, suggested: shown.suggested, error: '', from: key() };
    }
    show();
    if (check && shown.url && view.status !== 'running') void run(shown.url);
  }

  function openFromRail(): void {
    /* Reached from the rail, the page is for any address rather than the repository an audit sent it. */
    if (view && view.status !== 'running') view = { ...view, from: null };
    show();
  }

  function clear(): void {
    deps.rendered.dispose();
    request += 1;
    view = null;
    deps.screen.clear();
  }

  return { key, link, open, openFromRail, show, paint, run, clear };
}
