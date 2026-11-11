/*
 * The security posture on the Overview, decided.
 *
 * The cards above it say how the session stands -- its credential, its
 * recovery points, what the deployment offers. This says how the code stands:
 * what the audits and exposure scans have open across every repository this
 * identity has looked at, how that moved week by week, how long fixing has
 * taken, where the open findings are, and which repositories have never been
 * looked at at all.
 *
 * Every figure comes from GET /api/workspace/security-posture, which reads
 * what the stores already hold (the posture module's summary,
 * modules/posture/domain/posture-summary.ts, decides the numbers).
 * Nothing here computes a finding. What it adds is the one thing the server
 * cannot know: the repositories in the inventory that neither system has
 * read, because the inventory is the browser's.
 *
 * Drawn by SecurityPosture.tsx; tested on its own, like the pulse beside it.
 */
import { COMPLETENESS_OF, combineCompleteness, completenessOf } from '../../../../../packages/contracts/src/evidence.ts';
import { field, hasFields, items } from '../../platform/values.ts';
import { inventory, repoKey } from '../repositories/repo-inventory.ts';
import type { InventoryEntry } from '../repositories/repo-inventory.ts';

export const SEVERITIES = Object.freeze(['critical', 'serious', 'warning'] as const);
export type Severity = (typeof SEVERITIES)[number];

const CATEGORY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'supply-chain': 'Supply chain',
  code: 'Code security',
  access: 'Access control',
  secrets: 'Secrets in code',
  dependencies: 'Dependencies',
  infrastructure: 'Infrastructure',
  hygiene: 'Project hygiene',
  licences: 'Licences',
  ai: 'AI and model output',
  'leaked-credentials': 'Leaked credentials'
});

/* How many repositories the "not yet looked at" row names before it counts the rest. */
export const UNREAD_SHOWN = 6;
/* How many kinds of finding the card ranks. */
const CATEGORIES_SHOWN = 6;
/* The window the median is taken over, when the answer does not say. */
const FIX_WINDOW_DAYS = 90;

export interface OpenCounts {
  readonly critical: number;
  readonly serious: number;
  readonly warning: number;
  readonly total: number;
}

export interface TrendWeek {
  readonly weeksAgo: number;
  readonly opened: number;
  readonly fixed: number;
}

export interface CategoryCount extends OpenCounts {
  readonly category: string;
}

export interface RepositoryOpen {
  readonly owner: string;
  readonly repo: string;
  readonly open: OpenCounts;
}

export interface FixTime {
  readonly count: number;
  readonly medianDays: number | null;
}

export interface TimeToFix {
  readonly windowDays: number;
  readonly all: FixTime | null;
}

export interface Unread {
  readonly unread: readonly InventoryEntry[];
  readonly unreadMore: number;
  readonly inventory: number;
}

export interface ReadyView extends Unread {
  readonly state: 'ready';
  readonly weeks: number;
  readonly open: OpenCounts;
  readonly triaged: { readonly acceptedRisk: number; readonly falsePositive: number };
  readonly week: { readonly opened: number; readonly fixed: number; readonly gated: number | null };
  readonly window: { readonly opened: number; readonly fixed: number };
  readonly trend: readonly TrendWeek[];
  readonly timeToFix: TimeToFix | null;
  readonly categories: readonly CategoryCount[];
  readonly top: readonly RepositoryOpen[];
  readonly readCount: number;
  readonly covered: number;
  readonly notes: readonly string[];
}

export type PostureView =
  | { readonly state: 'loading' }
  | { readonly state: 'unavailable'; readonly reason: string }
  | (Unread & { readonly state: 'empty' | 'unmeasured' })
  | ReadyView;

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function categoryLabel(id: unknown): string {
  const known = typeof id === 'string' ? CATEGORY_LABEL[id] : undefined;
  return known || String(id || 'Other').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

export function days(value: unknown): string | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const number = Number(value);
  if (number < 1) return 'under a day';
  return `${number % 1 === 0 ? number : number.toFixed(1)} ${number === 1 ? 'day' : 'days'}`;
}

/* The words for how long ago a week of the trend was. */
export function weekName(weeksAgo: number): string {
  return weeksAgo === 0 ? 'This week' : weeksAgo === 1 ? 'Last week' : `${weeksAgo} weeks ago`;
}

const count = (value: unknown): number => Number(value) || 0;

function openOf(value: unknown): OpenCounts {
  return {
    critical: count(field(value, 'critical')),
    serious: count(field(value, 'serious')),
    warning: count(field(value, 'warning')),
    total: count(field(value, 'total'))
  };
}

function trendOf(value: unknown): TrendWeek {
  return { weeksAgo: count(field(value, 'weeksAgo')), opened: count(field(value, 'opened')), fixed: count(field(value, 'fixed')) };
}

function repositoryOf(value: unknown): RepositoryOpen {
  return { owner: String(field(value, 'owner') ?? ''), repo: String(field(value, 'repo') ?? ''), open: openOf(field(value, 'open')) };
}

function timeToFixOf(value: unknown): TimeToFix | null {
  if (!hasFields(value)) return null;
  const all = field(value, 'all');
  const median = field(all, 'medianDays');
  return {
    windowDays: count(field(value, 'windowDays')) || FIX_WINDOW_DAYS,
    all: hasFields(all) ? { count: count(field(all, 'count')), medianDays: median === null || median === undefined ? null : Number(median) } : null
  };
}

const UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  'not-configured': 'Security posture is kept in the server database, and this deployment has none.',
  'database-unavailable': 'The server database did not answer, so the posture could not be read. It is read again with the overview.',
  offline: 'You are offline, so the posture could not be read. It is read again when the connection returns.'
});

/*
 * The reading, decided. `summary` is the route's answer (or null while it is
 * on its way), `repos` the inventory the session holds.
 */
export function model(summary: unknown, repos: unknown): PostureView {
  if (!summary) return { state: 'loading' };
  if (field(summary, 'available') === false) {
    const reason = field(summary, 'reason');
    return {
      state: 'unavailable',
      reason: (typeof reason === 'string' ? UNAVAILABLE[reason] : undefined) || 'The posture could not be read just now. It is read again with the overview.'
    };
  }
  const listed = items(field(summary, 'repositories'));
  const read = new Set(listed.map(entry => repoKey(field(entry, 'owner'), field(entry, 'repo'))));
  const known = inventory(repos);
  const unread = known
    .filter(entry => !read.has(entry.key))
    .sort((a, b) => b.pushedAt - a.pushedAt || a.key.localeCompare(b.key));
  const covered = known.filter(entry => read.has(entry.key)).length;
  const sources = field(summary, 'sources');
  const audit = field(sources, 'audit');
  const exposure = field(sources, 'exposure');
  /* Anything the audits or the exposure scans read makes the posture measured. Governance alone counts no finding. */
  const reading = combineCompleteness([audit, exposure].map(word => completenessOf(COMPLETENESS_OF.source, word)));
  const measured = reading === 'complete' || reading === 'partial';
  const unreadPart: Unread = {
    unread: unread.slice(0, UNREAD_SHOWN),
    unreadMore: Math.max(0, unread.length - UNREAD_SHOWN),
    inventory: known.length
  };
  if (!listed.length) return { state: measured ? 'empty' : 'unmeasured', ...unreadPart };
  const week = field(summary, 'week');
  const gated = field(week, 'gated');
  const trend = items(field(summary, 'trend')).map(trendOf);
  const triaged = field(summary, 'triaged');
  const window = field(summary, 'window');
  const notes: string[] = [];
  if (audit !== 'measured') notes.push('Audits could not be read; their findings are not counted.');
  if (exposure === 'unavailable') notes.push('Exposure scans could not be read; leaked credentials are not counted.');
  else if (exposure === 'partial') notes.push('The exposure trend could not be read; credentials are counted, not charted.');
  if (field(sources, 'governance') !== 'measured') notes.push('Governance decisions could not be read; gated merges are not counted.');
  return {
    state: 'ready',
    weeks: count(field(summary, 'weeks')) || trend.length,
    open: openOf(field(summary, 'open')),
    triaged: { acceptedRisk: count(field(triaged, 'acceptedRisk')), falsePositive: count(field(triaged, 'falsePositive')) },
    week: {
      opened: count(field(week, 'opened')),
      fixed: count(field(week, 'fixed')),
      gated: gated === null || gated === undefined ? null : count(gated)
    },
    window: { opened: count(field(window, 'opened')), fixed: count(field(window, 'fixed')) },
    trend,
    timeToFix: timeToFixOf(field(summary, 'timeToFix')),
    categories: items(field(summary, 'categories'))
      .map(entry => ({ category: String(field(entry, 'category') ?? ''), ...openOf(entry) }))
      .filter(entry => entry.total > 0)
      .slice(0, CATEGORIES_SHOWN),
    top: items(field(summary, 'top')).map(repositoryOf),
    readCount: listed.length,
    covered,
    notes,
    ...unreadPart
  };
}

/* The headline sentence: what moved this week, in words a reader can repeat. */
export function weekSentence(view: Pick<ReadyView, 'week'>): string {
  const parts = [
    plural(view.week.opened, 'new finding', 'new findings'),
    `${view.week.fixed} fixed`
  ];
  if (view.week.gated !== null) parts.push(plural(view.week.gated, 'merge attempt gated', 'merge attempts gated'));
  return `This week: ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.`;
}

/* The open counts in words, so the colour of a bar is never the only way to read them. */
export function severityWords(open: OpenCounts): string {
  const words = SEVERITIES.filter(severity => open[severity]).map(severity => `${open[severity]} ${severity}`);
  return words.length ? words.join(' · ') : 'nothing open';
}

/*
 * The weekly chart's geometry at a given width: whole-number gridline steps
 * of 1, 2 or 5 times a power of ten, three or four of them, and two bars to a
 * week on one axis that starts at zero.
 */
export interface ChartBar { readonly kind: 'opened' | 'fixed'; readonly d: string }
export interface ChartWeek {
  readonly weeksAgo: number;
  readonly label: string;
  readonly hit: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly share: number;
  readonly bars: readonly ChartBar[];
}
export interface ChartPlan {
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly ticks: readonly { readonly value: number; readonly y: number }[];
  readonly left: number;
  readonly right: number;
  readonly weeks: readonly ChartWeek[];
}

export function chartPlan(view: Pick<ReadyView, 'trend' | 'window'>, measuredWidth: number): ChartPlan {
  const weeks = view.trend;
  const max = Math.max(1, ...weeks.map(entry => Math.max(entry.opened, entry.fixed)));
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, max / 3))));
  const fraction = Math.max(1, max / 3) / magnitude;
  const step = Math.max(1, Math.round((fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude));
  const top = step * Math.ceil(max / step);
  const width = Math.max(240, Math.round(measuredWidth || 480));
  const height = width < 420 ? 150 : 180;
  const pad = { left: 30, right: 6, top: 10, bottom: 22 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const column = plotW / Math.max(1, weeks.length);
  const barW = Math.max(3, Math.min(14, (column - 6) / 2));
  const y = (value: number): number => pad.top + plotH - (value / top) * plotH;
  const ticks: { value: number; y: number }[] = [];
  for (let value = 0; value <= top; value += step) ticks.push({ value, y: y(value) });
  const base = pad.top + plotH;
  /* Rounded where the data ends, square on the baseline. */
  const bar = (value: number, x: number, kind: ChartBar['kind']): ChartBar | null => {
    if (!value) return null;
    const h = Math.max(1, (value / top) * plotH);
    const r = Math.min(4, barW / 2, h);
    const yTop = base - h;
    return { kind, d: `M${x},${base}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${base}Z` };
  };
  return {
    width,
    height,
    label: `Findings opened and fixed per week over the last ${weeks.length} weeks: ${view.window.opened} opened and ${view.window.fixed} fixed in all.`,
    ticks,
    left: pad.left,
    right: width - pad.right,
    weeks: weeks.map((entry, index) => {
      const x0 = pad.left + index * column + (column - (barW * 2 + 2)) / 2;
      return {
        weeksAgo: entry.weeksAgo,
        label: `${weekName(entry.weeksAgo)}: ${entry.opened} opened, ${entry.fixed} fixed`,
        hit: { x: pad.left + index * column, y: pad.top, width: column, height: plotH },
        share: (index + 0.5) / weeks.length,
        bars: [bar(entry.opened, x0, 'opened'), bar(entry.fixed, x0 + barW + 2, 'fixed')].filter((entry): entry is ChartBar => entry !== null)
      };
    })
  };
}
