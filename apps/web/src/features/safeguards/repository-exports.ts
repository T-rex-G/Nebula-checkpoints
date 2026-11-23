/*
 * A repository's recent activity and its evidence package, exported.
 *
 * The activity export collects the provider's last thirty days -- commits,
 * pull requests, issues and releases -- with the verified events this
 * deployment recorded, paged up to 2,500 and kept once each in the order they
 * happened, and offers them as Markdown, JSON and CSV from the dialog, its
 * buttons bound as the dialog opens. The evidence package is downloaded as
 * the server signed it, with how many events and snapshots it holds and
 * whether its chain verifies.
 *
 * Each export belongs to the repository it was asked for: every page of its
 * events is read from there, and its files are named for it, whatever is
 * open when they arrive; its dialog is not shown over another repository. A
 * list the answer does not carry is none, and a time that is not a time is
 * now, so the export says what it holds rather than stopping at a script's
 * error.
 */
import { field, items } from '../../platform/values.ts';

export interface ExportBody { querySelector(selector: string): { addEventListener(type: string, listener: () => unknown): void } | null }

export interface RepositoryExportsDeps {
  readonly api: (path: string) => Promise<unknown>;
  readonly work: () => unknown;
  readonly modal: (options: { title: string; bodyHTML: string; okText: string; onOpen?: (body: ExportBody) => void }) => Promise<unknown>;
  readonly toast: (message: unknown, kind?: string) => void;
  readonly present: (error: unknown) => void;
  readonly download: (name: string, text: string, type?: string) => void;
  /* The activity as CSV, its cells defused for a spreadsheet (features/workbench/export-safety.ts). */
  readonly csv: (activity: unknown) => string;
  readonly now: () => number;
}

export interface RepositoryExports {
  activity(): Promise<void>;
  evidence(): Promise<void>;
}

export interface IntelligenceEvents {
  readonly available: boolean;
  readonly truncatedBefore: boolean;
  readonly events: readonly unknown[];
  readonly error?: string;
}

const PAGES = 5;
export const EVENTS_UNREADABLE = 'The verified events could not be read.';
const text = (value: unknown): string => (value == null ? '' : String(value));

/* The day an answer was made, or today's when it does not say a time. */
export function dayOf(value: unknown, now: number): string {
  const at = value ? new Date(value as string | number).getTime() : NaN;
  return new Date(Number.isFinite(at) ? at : now).toISOString().slice(0, 10);
}

/* Every verified event a repository's address holds, up to five pages, once each, oldest first. */
export async function intelligenceEvents(api: (path: string) => Promise<unknown>, address: string): Promise<IntelligenceEvents> {
  const events = new Map<string, unknown>();
  let after = '';
  let available = true;
  let truncatedBefore = false;
  for (let page = 0; page < PAGES; page += 1) {
    const suffix = after ? `&after=${encodeURIComponent(after)}` : '';
    const answer = await api(`${address}/intelligence/events?limit=500${suffix}`);
    if (typeof answer !== 'object' || answer === null) throw new Error(EVENTS_UNREADABLE);
    available = field(answer, 'available') !== false;
    truncatedBefore = truncatedBefore || Boolean(field(answer, 'truncatedBefore'));
    for (const event of items(field(answer, 'events'))) {
      const id = field(event, 'id');
      if (id) events.set(String(id), event);
    }
    const next = text(field(answer, 'cursor'));
    if (!field(answer, 'hasMore') || !next) break;
    after = next;
  }
  const time = (event: unknown): number => new Date((field(event, 'createdAt') || 0) as string | number).getTime();
  return {
    available,
    truncatedBefore,
    events: [...events.values()].sort((a, b) => time(a) - time(b) || String(field(a, 'id')).localeCompare(String(field(b, 'id'))))
  };
}

/* The activity as Markdown: a heading per kind, a line per item, and the verified events or why there are none. */
export function activityMarkdown(a: Record<string, unknown>): string {
  const list = (name: string): readonly unknown[] => items(a[name]);
  const events = list('intelligenceEvents');
  return [`# ${text(a.owner)}/${text(a.repo)} \u2014 last ${text(a.days)} days`, '',
    `## Commits (${list('commits').length})`, ...list('commits').map(c => `- \`${text(field(c, 'sha')).slice(0, 8)}\` ${text(field(c, 'message'))} \u2014 ${text(field(c, 'author'))}`), '',
    `## Pull requests (${list('pulls').length})`, ...list('pulls').map(p => `- #${text(field(p, 'number'))} ${text(field(p, 'title'))} (${text(field(p, 'state'))})`), '',
    `## Issues (${list('issues').length})`, ...list('issues').map(i => `- #${text(field(i, 'number'))} ${text(field(i, 'title'))} (${text(field(i, 'state'))})`), '',
    `## Releases (${list('releases').length})`, ...list('releases').map(r => `- ${text(field(r, 'tag'))} ${text(field(r, 'name'))}`), '',
    `## Verified intelligence events (${events.length})`,
    ...(a.intelligenceAvailable
      ? events.map(event => `- ${text(field(event, 'createdAt'))} [${text(field(event, 'severity') || 'normal')} \u00b7 ${text(field(event, 'score') || 0)}] ${text(field(event, 'summary') || field(event, 'eventType') || 'event')} \u2014 ${text(field(event, 'actor') || 'unknown actor')}`)
      : [`- Unavailable${a.intelligenceError ? `: ${text(a.intelligenceError)}` : ' because Neon-backed live intelligence is not enabled.'}`])
  ].join('\n');
}

export function createRepositoryExports(deps: RepositoryExportsDeps): RepositoryExports {
  function place() {
    const work = deps.work();
    return {
      work,
      repo: String(field(work, 'repo')),
      address: `/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`,
      here: (): boolean => deps.work() === work
    };
  }

  async function activity(): Promise<void> {
    const { work, repo, address, here } = place();
    if (!work) return;
    try {
      deps.toast('Collecting activity and verified events\u2026', 'ok');
      const [activityResult, intelligenceResult] = await Promise.allSettled([
        deps.api(`${address}/activity?days=30`),
        intelligenceEvents(deps.api, address)
      ]);
      if (activityResult.status !== 'fulfilled') throw activityResult.reason;
      const base = activityResult.value;
      const intelligence: IntelligenceEvents = intelligenceResult.status === 'fulfilled'
        ? intelligenceResult.value
        : { available: false, truncatedBefore: false, events: [], error: text(field(intelligenceResult.reason, 'message')) };
      const a: Record<string, unknown> = {
        ...(typeof base === 'object' && base !== null ? base : {}),
        intelligenceAvailable: intelligence.available, intelligenceHistoryTruncated: intelligence.truncatedBefore,
        intelligenceEvents: intelligence.events, intelligenceError: intelligence.error || ''
      };
      if (!here()) return;
      const name = typeof a.repo === 'string' && a.repo ? a.repo : repo;
      const stamp = dayOf(a.generatedAt, deps.now());
      const md = activityMarkdown(a);
      const count = (key: string): number => items(a[key]).length;
      await deps.modal({
        title: 'Activity export ready', okText: 'Close',
        bodyHTML: `<p class="hint">${count('commits')} commits \u00b7 ${count('pulls')} PRs \u00b7 ${count('issues')} issues \u00b7 ${count('releases')} releases \u00b7 ${intelligence.events.length} verified event(s).</p>
        ${intelligence.truncatedBefore ? '<p class="hint">Verified-event export contains the latest 500 retained events; older retained history is not included in this browser export.</p>' : ''}${intelligence.available ? '' : '<p class="hint">Verified-event history is unavailable without Neon-backed live intelligence; the provider activity export is still complete for the selected period.</p>'}
        <div class="btn-row" style="margin-top:10px"><button class="btn btn-ghost small" id="actMd">Download Markdown</button><button class="btn btn-ghost small" id="actJson">Download JSON</button><button class="btn btn-ghost small" id="actCsv">Download CSV</button></div>`,
        /* Bound as the dialog opens: no button is on screen without its handler. */
        onOpen: body => {
          const bind = (id: string, run: () => void): void => { body.querySelector('#' + id)?.addEventListener('click', run); };
          bind('actMd', () => deps.download(`${name}-activity-${stamp}.md`, md, 'text/markdown'));
          bind('actJson', () => deps.download(`${name}-activity-${stamp}.json`, JSON.stringify(a, null, 2)));
          bind('actCsv', () => deps.download(`${name}-activity-${stamp}.csv`, deps.csv(a), 'text/csv'));
        }
      });
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
    }
  }

  async function evidence(): Promise<void> {
    const { work, repo, address, here } = place();
    if (!work) return;
    try {
      deps.toast('Building verifiable evidence package\u2026', 'ok');
      const pack = await deps.api(`${address}/evidence`);
      deps.download(`${repo}-evidence-${dayOf(field(pack, 'generatedAt'), deps.now())}.json`, JSON.stringify(pack, null, 2));
      if (!here()) return;
      const chain = field(pack, 'chain');
      await deps.modal({
        title: 'Evidence package exported', okText: 'Done',
        bodyHTML: `<p class="hint">${items(field(pack, 'events')).length} verified event(s), ${items(field(pack, 'snapshots')).length} signed snapshot(s). Evidence chain: <b>${field(chain, 'valid') ? 'valid' : field(chain, 'available') ? 'verification failed' : 'unavailable without Neon'}</b>.</p>`
      });
    } catch (error) {
      if (here()) deps.present(error);
    }
  }

  return { activity, evidence };
}

