/*
 * The findings inbox, decided before it is drawn: every open finding across
 * the workspace, in one list a person can work through.
 *
 * The server decides what each finding is (the posture module's inbox,
 * modules/posture/domain/findings-inbox.ts); this decides what is on screen. Filters live in the address, so a filtered view
 * can be reloaded, bookmarked and sent to someone. Owners come from each
 * repository's CODEOWNERS file, fetched only for the repositories on screen.
 * Decisions go through each repository's own triage route, one finding at a
 * time, with the same permissions as the audit screen -- the inbox adds a way
 * to reach them in bulk, not a second way to decide.
 *
 * Pure and platform-free, so the Node unit tests import it as it is.
 */
import { SEVERITIES } from '../../../../../packages/contracts/src/findings.ts';
import type {
  FindingState, FindingsInbox, InboxFinding, Severity, TriageVocabulary, UnavailableInbox
} from '../../../../../packages/contracts/src/findings.ts';

export { SEVERITIES };

export const SEVERITY_WORD: Readonly<Record<Severity, string>> = Object.freeze({ critical: 'Critical', serious: 'Serious', warning: 'Warning' });
export const STATE_WORD: Readonly<Record<FindingState, string>> = Object.freeze({
  regressed: 'Seen again', new: 'New', open: 'Open', 'accepted-risk': 'Risk accepted', 'false-positive': 'Not a problem'
});

export type ViewId = 'open' | 'regressed' | 'new' | 'decided' | 'all';
export interface ViewDefinition { readonly id: ViewId; readonly label: string; readonly match: (item: InboxFinding) => boolean }

/* The views a person picks between; "open work" is where the inbox opens. */
export const VIEWS: readonly ViewDefinition[] = Object.freeze([
  Object.freeze({ id: 'open', label: 'Open work', match: (item: InboxFinding) => !item.decision }),
  Object.freeze({ id: 'regressed', label: 'Seen again', match: (item: InboxFinding) => item.state === 'regressed' }),
  Object.freeze({ id: 'new', label: 'New this week', match: (item: InboxFinding) => item.state === 'new' }),
  Object.freeze({ id: 'decided', label: 'Decided', match: (item: InboxFinding) => Boolean(item.decision) }),
  Object.freeze({ id: 'all', label: 'Everything', match: () => true })
] as const);
const KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'supply-chain': 'Supply chain', code: 'Code security', access: 'Access control', secrets: 'Secrets in code',
  dependencies: 'Dependencies', infrastructure: 'Infrastructure', hygiene: 'Project hygiene', licences: 'Licences',
  ai: 'AI and model output', 'leaked-credentials': 'Leaked credentials'
});
export const PAGE = 50;

export interface Filters {
  readonly severities: readonly Severity[];
  readonly view: ViewId;
  readonly kind: string;
  readonly repo: string;
  readonly q: string;
  readonly pages: number;
}

/* A finding as drawn: its name settled, and its owners once their file has been read. */
export interface ShownFinding extends InboxFinding {
  readonly label: string;
  readonly owners?: readonly string[] | null;
}

export interface Facet { readonly id: string; readonly label?: string; readonly count: number }

/* The inbox with its list, or the list's absence explained. */
export interface ListView {
  readonly state: 'ready' | 'empty' | 'unmeasured';
  readonly filters: Filters;
  readonly total: number;
  readonly undecided: number;
  readonly views: readonly Facet[];
  readonly severities: readonly Facet[];
  readonly kinds: readonly Facet[];
  readonly repositories: readonly Facet[];
  readonly matching: number;
  readonly shown: readonly ShownFinding[];
  readonly more: number;
  readonly vocabulary: TriageVocabulary | null;
  readonly notes: readonly string[];
}

export type View =
  | { readonly state: 'loading' }
  | { readonly state: 'unavailable'; readonly reason: string }
  | ListView;

export interface ModelOptions {
  readonly labelOf?: (item: InboxFinding) => string;
  readonly ownersOf?: (item: InboxFinding) => readonly string[] | null;
}

export function kindLabel(kind: string | null | undefined): string {
  return KIND_LABEL[kind || ''] || String(kind || 'Other').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

const isSeverity = (value: string): value is Severity => (SEVERITIES as readonly string[]).includes(value);
const isView = (value: string | null): value is ViewId => VIEWS.some(entry => entry.id === value);

/* The address's query, into filters. Anything unrecognised is dropped, not kept. */
export function parseFilters(query: unknown): Filters {
  const params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
  const severities = String(params.get('severity') || '').split(',').filter(isSeverity);
  const asked = params.get('view');
  const view = isView(asked) ? asked : 'open';
  const kind = /^[a-z][a-z-]{1,40}$/.test(params.get('kind') || '') ? params.get('kind') || '' : '';
  const repo = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(params.get('repo') || '') ? params.get('repo') || '' : '';
  const q = String(params.get('q') || '').slice(0, 120);
  const pages = Math.min(40, Math.max(1, Number.parseInt(params.get('pages') || '1', 10) || 1));
  return { severities: [...new Set(severities)], view, kind, repo, q, pages };
}

export function serializeFilters(filters: Partial<Filters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== 'open') params.set('view', filters.view);
  const chosen = filters.severities || [];
  if (chosen.length) params.set('severity', SEVERITIES.filter(severity => chosen.includes(severity)).join(','));
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.repo) params.set('repo', filters.repo);
  if (filters.q) params.set('q', filters.q);
  if (filters.pages && filters.pages > 1) params.set('pages', String(filters.pages));
  const text = params.toString();
  return text ? `?${text}` : '';
}

function searchable(item: InboxFinding, label: string): string {
  return [label, item.rule, item.owner, item.repo, `${item.owner}/${item.repo}`, item.path, kindLabel(item.kind),
    item.package && item.package.name, ...(item.cves || [])].filter(Boolean).join(' ').toLowerCase();
}

/*
 * What is on screen. `labelOf` names an exposure rule the way the findings
 * screen does; `ownersOf` answers from the CODEOWNERS files fetched so far.
 */
export function model(inbox: FindingsInbox | UnavailableInbox | null | undefined, filters: Filters, options: ModelOptions = {}): View {
  if (!inbox) return { state: 'loading' };
  if (inbox.available === false) {
    const reasons: Readonly<Record<string, string>> = {
      'not-configured': 'Findings are kept in the server database, and this deployment has none.',
      'database-unavailable': 'The server database did not answer, so the findings could not be read. They are read again when you come back.',
      offline: 'You are offline, so the findings could not be read.'
    };
    return { state: 'unavailable', reason: reasons[inbox.reason || ''] || 'The findings could not be read just now.' };
  }
  const labelOf = typeof options.labelOf === 'function' ? options.labelOf : (item: InboxFinding) => item.title || item.rule;
  const ownersOf = typeof options.ownersOf === 'function' ? options.ownersOf : () => null;
  const all: ShownFinding[] = (Array.isArray(inbox.findings) ? inbox.findings : []).map(item => ({ ...item, label: item.title || labelOf(item) }));
  const view = VIEWS.find(entry => entry.id === filters.view) || VIEWS[0]!;
  const terms = String(filters.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const inView = all.filter(item => view.match(item));
  const matching = inView.filter(item =>
    (!filters.severities.length || filters.severities.includes(item.severity))
    && (!filters.kind || item.kind === filters.kind)
    && (!filters.repo || `${item.owner}/${item.repo}`.toLowerCase() === filters.repo.toLowerCase())
    && terms.every(term => searchable(item, item.label).includes(term)));
  const shown = matching.slice(0, PAGE * filters.pages).map(item => ({ ...item, owners: item.path ? ownersOf(item) : [] }));
  const facet = (pick: (item: ShownFinding) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const item of inView) counts.set(pick(item), (counts.get(pick(item)) || 0) + 1);
    return counts;
  };
  const sources = inbox.sources || {};
  const notes: string[] = [];
  if (sources.audit === 'unavailable') notes.push('Audits could not be read; their findings are not listed.');
  if (sources.exposure === 'unavailable') notes.push('Exposure scans could not be read; leaked credentials are not listed.');
  if (inbox.truncated) notes.push('There are more findings than one list holds. The most severe and oldest are shown; narrow the list to reach the rest.');
  return {
    state: all.length ? 'ready' : (sources.audit === 'unavailable' && sources.exposure === 'unavailable' ? 'unmeasured' : 'empty'),
    filters,
    total: all.length,
    undecided: all.filter(item => !item.decision).length,
    views: VIEWS.map(entry => ({ id: entry.id, label: entry.label, count: all.filter(entry.match).length })),
    severities: SEVERITIES.map(severity => ({ id: severity, label: SEVERITY_WORD[severity], count: facet(item => item.severity).get(severity) || 0 })),
    kinds: [...facet(item => item.kind).entries()].map(([id, count]) => ({ id, label: kindLabel(id), count })).sort((a, b) => b.count - a.count),
    repositories: [...facet(item => `${item.owner}/${item.repo}`).entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    matching: matching.length,
    shown,
    more: Math.max(0, matching.length - shown.length),
    vocabulary: inbox.vocabulary || null,
    notes
  };
}

/* ------------------------------------------------------------ words */

export function days(count: number | null | undefined): string {
  if (count === null || count === undefined) return '';
  if (count === 0) return 'today';
  return count === 1 ? '1 day ago' : `${count} days ago`;
}

export function date(iso: string | null | undefined): string {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function where(item: InboxFinding): string {
  if (!item.path) return `${item.owner}/${item.repo}`;
  return `${item.owner}/${item.repo} · ${item.path}${item.line ? `:${item.line}` : ''}`;
}

export interface TimelineEvent { readonly at: string | null; readonly text: string }

/* The record of one finding, oldest first, from what the inbox already holds. */
export function timelineEvents(item: InboxFinding): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  /* A finding that came back is first seen again after its fix: its clock restarted there. */
  if (item.regressedAfter) {
    events.push({ at: item.regressedAfter, text: item.timesFixed > 1 ? `Fixed ${item.timesFixed} times, most recently here` : 'Fixed' });
    if (item.firstSeenAt) events.push({ at: item.firstSeenAt, text: 'Seen again after the fix' });
  } else if (item.firstSeenAt) {
    events.push({ at: item.firstSeenAt, text: item.source === 'exposure' ? 'First found by an exposure scan' : `First seen by an audit of ${item.ref || 'the branch'}` });
  }
  if (item.decision) {
    const word = STATE_WORD[item.decision.disposition as FindingState] || 'Decided';
    events.push({
      at: item.decision.decidedAt || null,
      text: `${word}${item.decision.expiresAt ? ` until ${date(item.decision.expiresAt)}` : ''}${item.decision.reason ? ` — ${item.decision.reason.replace(/-/g, ' ')}` : ''}`
    });
  }
  return events.sort((a, b) => (Date.parse(a.at || '') || Infinity) - (Date.parse(b.at || '') || Infinity));
}
