/*
 * The repository audit's page: its view, drawn for the branch open, and an
 * audit run, followed and kept.
 *
 * The view belongs to one repository and branch. Drawn for another, it starts
 * again from nothing, and every answer still in flight for the last one is
 * dropped when it arrives. Its controls narrow the findings shown -- by
 * category, OWASP class, severity, verdict, known exploitation and words --
 * reveal one the list is hiding, copy fix prompts, and export the audit with
 * the latest site check of the repository's address: a brief, SARIF, CSV and
 * two SBOMs, and a kept audit from its history on its own.
 *
 * An audit is a job on the server: the first request starts it and answers
 * with a run id, and the page asks after it, a little less often each time,
 * hearing the stage. A run the server no longer holds -- it restarted -- is
 * started once more; a poll lost to the network or the edge is asked again a
 * few times. The audit kept is compared with the last one the server kept of
 * the branch, or failing that with this browser's own fingerprints. An answer
 * that is not an audit is a failure, not a result.
 *
 * The view is held here. The history and the team's decisions read and write
 * it through view(), as it is now: a run that ends draws a new view carrying
 * their parts over.
 */
import { field, items } from '../../platform/values.ts';

export interface AuditView {
  key: string;
  status: 'idle' | 'running' | 'done' | 'error';
  result: unknown;
  diff: unknown;
  error: string;
  progress: unknown;
  filter: unknown;
  severity: unknown;
  verdict: unknown;
  exploit: unknown;
  owasp: unknown;
  query: string;
  limit: number;
  history: Record<string, unknown>;
  watch: Record<string, unknown>;
  historyOpen: Set<string>;
  historyDetail: Map<string, unknown>;
  historyArmed: boolean;
  triage: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export const AUDIT_POLL = Object.freeze({ firstMs: 1200, maxMs: 5000, growth: 1.35, transientTries: 6 });
export const UNREADABLE = 'The audit answered without its findings.';
const EDGE = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

export function blankAuditView(key = ''): AuditView {
  return {
    key, status: 'idle', result: null, diff: null, error: '', progress: null, filter: null, severity: null, verdict: null, exploit: null, owasp: null, query: '', limit: 0,
    history: { status: 'idle' }, watch: { status: 'idle' }, historyOpen: new Set(), historyDetail: new Map(), historyArmed: false,
    triage: { status: 'idle' }, metrics: { status: 'idle' }
  };
}

/* Whether a failed request is the network's or the edge's, to be asked again. */
export function transientAuditError(error: unknown, offline: (error: unknown) => boolean): boolean {
  if (!error) return false;
  const status = field(error, 'status');
  if (field(error, 'edge') && typeof status === 'number' && EDGE.has(status)) return true;
  return !status && offline(error);
}

export interface AuditReports {
  allPrompts(result: unknown): string;
  sarif(result: unknown, site: unknown, meta: unknown): string;
  csv(result: unknown, site: unknown, diff: unknown): string;
  brief(result: unknown, label: string, site: unknown): string;
  keptSarif(audit: unknown, findings: unknown, meta: unknown): string;
  keptCsv(audit: unknown, findings: unknown): string;
  keptBrief(audit: unknown, findings: unknown, label: string): string;
}

export interface AuditControllerDeps {
  readonly api: (path: string) => Promise<unknown>;
  /* The open repository: owner, name and branch. */
  readonly work: () => unknown;
  readonly epoch: () => unknown;
  /* The reader's provider, for the repository's address in SARIF. */
  readonly provider: () => string;
  /* The history's answers on their way let go of, and its timers. */
  readonly forgetHistory: () => void;
  readonly forgetWatch: () => void;
  readonly decision: (feature: string) => { readonly status: string; readonly reason?: string };
  readonly screen: { render(view: unknown, handlers: Record<string, unknown>): void; clear(): void; present(): boolean };
  /* Whether the audit is the tool showing. */
  readonly shown: () => boolean;
  readonly site: { link(): unknown; open(options: unknown): void };
  readonly history: {
    load(): void;
    watch(options: { force: boolean }): unknown;
    detail(id: string): void;
    clear(): unknown;
    reveal(id: string): void;
  };
  readonly triage: { decide(finding: unknown): unknown; reopen(finding: unknown): unknown; history(finding: unknown): unknown };
  readonly openFinding: (finding: unknown) => unknown;
  readonly copyPrompt: (text: unknown) => unknown;
  readonly copyText: (text: string) => Promise<void>;
  readonly toast: (message: string, kind?: string) => void;
  readonly download: (name: string, text: string, type: string) => void;
  readonly reports: AuditReports;
  readonly sbom: { cyclonedx(result: unknown, meta: unknown): string; spdx(result: unknown, meta: unknown): string };
  readonly memory: { readPrevious(key: string): unknown; remember(key: string, value: unknown): void; diff(result: unknown, previous: unknown): unknown };
  readonly offline: (error: unknown) => boolean;
  readonly pause: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface AuditController {
  /* The repository and branch the view is for: owner/name@branch. */
  key(): string;
  /* The view as it is now. */
  view(): AuditView;
  paint(): void;
  /* Drawn again, when the audit is the tool showing. */
  repaint(): void;
  run(): Promise<void>;
  /* Refresh: the history read again, or the view drawn afresh when it was another branch's. */
  reread(): void;
  /* Everything of the last repository let go of. */
  clear(): void;
}

const text = (value: unknown): string => (value == null ? '' : String(value));
const owaspOf = (finding: unknown): string => text(field(field(finding, 'standards'), 'owasp'));

export function createAuditController(deps: AuditControllerDeps): AuditController {
  let request = 0;
  let drawn: AuditView = blankAuditView();

  function key(): string {
    const work = deps.work();
    return work ? `${text(field(work, 'owner'))}/${text(field(work, 'repo'))}@${text(field(work, 'branch'))}` : '';
  }
  const repositoryUri = (): string => {
    const work = deps.work();
    return deps.provider() === 'github' ? `https://github.com/${text(field(work, 'owner'))}/${text(field(work, 'repo'))}` : '';
  };
  const supported = (): boolean => deps.decision('code-audit').status === 'Supported';

  /* The view replaced: for another branch, a run that starts or ends, or the page let go of. */
  function replaceView(next: AuditView): void {
    drawn = next;
  }

  function repaint(): void {
    if (deps.shown()) paint();
  }

  function handlers(): Record<string, unknown> {
    const view = (): AuditView => drawn;
    return {
      onSiteOpen: (options: unknown) => deps.site.open(options),
      onRun: () => run(),
      onWatchCheck: () => deps.history.watch({ force: true }),
      /* A redraw restores open rows, which fires toggle again: only a change the reader made is acted on. */
      onHistoryToggle: (id: string, open: boolean) => {
        const shown = view();
        if (open === shown.historyOpen.has(id)) return;
        if (open) shown.historyOpen.add(id); else shown.historyOpen.delete(id);
        if (open) deps.history.detail(id); else repaint();
      },
      onHistoryOpen: (id: string, options: { reveal?: boolean } = {}) => {
        view().historyOpen.add(id);
        deps.history.detail(id);
        if (options.reveal) deps.history.reveal(id);
      },
      onHistoryClear: () => deps.history.clear(),
      /* A kept audit exported on its own, from what it kept: the rule, place and package of each finding, never code. */
      onHistoryExport: (id: string, kind: string) => {
        const shown = view();
        const work = deps.work();
        const detail = shown.historyDetail.get(id);
        const audit = items(field(shown.history, 'audits')).find(item => field(item, 'id') === id);
        if (!work || !audit || !detail || field(detail, 'status') !== 'ready') return;
        const findings = items(field(detail, 'findings'));
        const base = `${text(field(work, 'repo'))}-audit-${text(field(audit, 'auditedAt')).slice(0, 10)}-${text(field(audit, 'commitSha')).slice(0, 7)}`;
        if (kind === 'sarif') return deps.download(`${base}.sarif`, deps.reports.keptSarif(audit, findings, { repositoryUri: repositoryUri() }), 'application/sarif+json');
        if (kind === 'csv') return deps.download(`${base}.csv`, deps.reports.keptCsv(audit, findings), 'text/csv');
        return deps.download(`${base}.md`, deps.reports.keptBrief(audit, findings, `${text(field(work, 'owner'))}/${text(field(work, 'repo'))} (${text(field(audit, 'ref'))})`), 'text/markdown');
      },
      onTriage: (finding: unknown) => deps.triage.decide(finding),
      onReopen: (finding: unknown) => deps.triage.reopen(finding),
      onTriageHistory: (finding: unknown) => deps.triage.history(finding),
      onFilter: (filter: unknown) => { Object.assign(view(), { filter, severity: null, verdict: null, exploit: null, owasp: null, limit: 0 }); paint(); },
      onOwasp: (owasp: unknown) => { Object.assign(view(), { owasp, severity: null, verdict: null, exploit: null, limit: 0 }); paint(); },
      onSeverity: (severity: unknown) => { Object.assign(view(), { severity, limit: 0 }); paint(); },
      onVerdict: (verdict: unknown) => { Object.assign(view(), { verdict, limit: 0 }); paint(); },
      onExploit: (exploit: unknown) => { Object.assign(view(), { exploit: exploit === 'kev' ? 'kev' : null, limit: 0 }); paint(); },
      /* A finding opened from Fix first or Dependency risk that the list is not showing: clear what hides it, and page to it. */
      onReveal: (id: unknown) => {
        const shown = view();
        const findings = items(field(shown.result, 'findings'));
        const at = findings.findIndex(finding => field(finding, 'id') === id);
        if (at < 0) return;
        const inScope = (finding: unknown): boolean => (!shown.filter || field(finding, 'category') === shown.filter)
          && (!shown.owasp || owaspOf(finding).startsWith(`${text(shown.owasp)}:`));
        if (!inScope(findings[at])) Object.assign(shown, { filter: null, owasp: null });
        Object.assign(shown, { severity: null, verdict: null, exploit: null, query: '' });
        shown.limit = Math.max(shown.limit || 0, findings.filter(inScope).findIndex(finding => field(finding, 'id') === id) + 1);
        paint();
      },
      onQuery: (query: unknown) => { Object.assign(view(), { query: String(query || '').slice(0, 120), limit: 0 }); paint(); },
      onMore: (limit: number) => { view().limit = limit; paint(); },
      onOpen: (finding: unknown) => deps.openFinding(finding),
      onCopy: (finding: unknown) => deps.copyPrompt(field(finding, 'prompt')),
      onCopyAll: async () => {
        try { await deps.copyText(deps.reports.allPrompts(view().result)); deps.toast('Every fix prompt copied', 'ok'); }
        catch { deps.toast('The clipboard is not available here', 'err'); }
      },
      onExport: (kind: string) => {
        const shown = view();
        const work = deps.work();
        const result = shown.result;
        const site = field(deps.site.link(), 'result');
        if (!work || (!result && !site)) return;
        const owner = text(field(work, 'owner'));
        const repo = text(field(work, 'repo'));
        const branch = text(field(work, 'branch'));
        const at = field(result, 'auditedAt') || field(site, 'checkedAt');
        const day = String(at || new Date(deps.now()).toISOString()).slice(0, 10);
        const base = `${repo}-audit-${day}`;
        if (kind === 'sarif') return deps.download(`${base}.sarif`, deps.reports.sarif(result, site, { ref: branch, repositoryUri: repositoryUri() }), 'application/sarif+json');
        if (kind === 'csv') return deps.download(`${base}.csv`, deps.reports.csv(result, site, shown.diff), 'text/csv');
        if ((kind === 'cyclonedx' || kind === 'spdx') && result) {
          const meta = { name: `${owner}/${repo}`, ref: branch, repositoryUri: repositoryUri() };
          return kind === 'cyclonedx'
            ? deps.download(`${repo}-sbom-${day}.cdx.json`, deps.sbom.cyclonedx(result, meta), 'application/vnd.cyclonedx+json')
            : deps.download(`${repo}-sbom-${day}.spdx.json`, deps.sbom.spdx(result, meta), 'application/spdx+json');
        }
        return deps.download(`${base}.md`, deps.reports.brief(result, `${owner}/${repo} (${branch})`, site), 'text/markdown');
      }
    };
  }

  function paint(): void {
    if (!deps.screen.present()) return;
    if (drawn.key !== key()) {
      deps.forgetHistory();
      replaceView(blankAuditView(key()));
    }
    const repository = deps.decision('code-audit');
    const view = drawn;
    if (repository.status === 'Supported' && field(view.history, 'status') === 'idle' && deps.work()) deps.history.load();
    deps.screen.render({
      ...drawn,
      unavailable: repository.status === 'Supported' ? null : repository.reason,
      site: deps.decision('site-check').status === 'Supported' ? deps.site.link() : null
    }, handlers());
  }

  /* The audit's own comparison: the server's, when it kept this one, else this browser's fingerprints. */
  function comparison(result: unknown, previous: unknown): unknown {
    const kept = field(field(result, 'history'), 'saved') === true ? field(result, 'history') : null;
    if (!kept) return deps.memory.diff(result, previous);
    const newIds = field(kept, 'newIds');
    const resolved = field(kept, 'resolved');
    return Array.isArray(newIds)
      ? { previousAt: field(kept, 'previousAt') || null, newIds: new Set(newIds), resolved: Number.isSafeInteger(resolved) ? resolved : null }
      : null;
  }

  async function run(): Promise<void> {
    const work = deps.work();
    if (!work || drawn.status === 'running') return;
    const mine = ++request;
    const runKey = key();
    const epoch = deps.epoch();
    const current = (): boolean => mine === request && epoch === deps.epoch() && runKey === key();
    const base = `/api/repo/${text(field(work, 'owner'))}/${text(field(work, 'repo'))}/code-audit?ref=${encodeURIComponent(text(field(work, 'branch')))}`;
    replaceView({ ...drawn, key: runKey, status: 'running', error: '', progress: null });
    paint();
    try {
      let answer = await deps.api(base);
      let wait: number = AUDIT_POLL.firstMs;
      let misses = 0;
      let restarted = false;
      while (field(answer, 'state') === 'running') {
        if (!current()) return;
        drawn.progress = answer;
        repaint();
        await deps.pause(wait);
        if (!current()) return;
        try {
          answer = await deps.api(`${base}&run=${encodeURIComponent(text(field(answer, 'run')))}`);
          misses = 0;
          wait = Math.min(AUDIT_POLL.maxMs, Math.round(wait * AUDIT_POLL.growth));
        } catch (error) {
          if (field(error, 'code') === 'AUDIT_RUN_GONE' && !restarted) {
            restarted = true;
            answer = await deps.api(base);
            continue;
          }
          misses += 1;
          if (!transientAuditError(error, deps.offline) || misses > AUDIT_POLL.transientTries) throw error;
          const after = field(error, 'retryAfter');
          const asked = typeof after === 'number' && Number.isFinite(after) ? after * 1000 : 0;
          wait = Math.min(AUDIT_POLL.maxMs * 2, Math.max(wait, asked, AUDIT_POLL.firstMs) * 1.5);
        }
      }
      if (!current()) return;
      if (!Array.isArray(field(answer, 'findings'))) throw new Error(UNREADABLE);
      const result = answer;
      const repoKey = `${text(field(work, 'owner'))}/${text(field(work, 'repo'))}`;
      const previous = deps.memory.readPrevious(repoKey);
      deps.memory.remember(repoKey, result);
      const diff = comparison(result, previous);
      const held = drawn;
      replaceView({
        ...blankAuditView(runKey), history: held.history, watch: held.watch, historyOpen: held.historyOpen, historyDetail: held.historyDetail,
        triage: held.triage, metrics: held.metrics, status: 'done', result, diff
      });
      /* The server kept this audit: its history is read again so the new one is listed. */
      if (field(field(result, 'history'), 'saved') === true) deps.history.load();
    } catch (error) {
      if (!current()) return;
      const unreachable = !field(error, 'status') && deps.offline(error);
      const said = field(error, 'message');
      replaceView({
        ...drawn, status: 'error', progress: null,
        error: unreachable ? 'The server could not be reached. Check the connection, then try again.' : (typeof said === 'string' && said) || 'The audit could not be completed.'
      });
    }
    repaint();
  }

  function reread(): void {
    if (drawn.key !== key()) { paint(); return; }
    if (deps.work() && supported()) deps.history.load();
  }

  function clear(): void {
    request += 1;
    deps.forgetHistory();
    deps.forgetWatch();
    replaceView(blankAuditView());
    deps.screen.clear();
  }

  return { key, view: () => drawn, paint, repaint, run, reread, clear };
}
