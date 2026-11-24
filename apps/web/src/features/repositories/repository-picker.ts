/*
 * The repository picker as what it shows. A security tool chosen before a
 * repository is asks which one rather than refusing: recent repositories
 * first, then the rest, filtered as the reader types; a pasted address, or an
 * owner/name the list does not hold, offers that repository itself; and a
 * picker for the reader's own repositories leaves out somebody else's and
 * offers nothing pasted.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, items } from '../../platform/values.ts';
import type { RecentRepository } from './recent-repositories.ts';
import type { RepositoryReference } from './repository-reference.ts';

export interface PickToolWords { readonly title: string; readonly lede: string }
export const PICK_TOOLS: Readonly<Record<string, PickToolWords>> = Object.freeze({
  neural: Object.freeze({ title: 'Neural', lede: 'The repository as a live graph of its files, people, access and risks.' }),
  governance: Object.freeze({ title: 'Governance', lede: 'Policies, simulations and reviews, rehearsed on a digital twin before they apply.' }),
  exposure: Object.freeze({ title: 'Exposure', lede: 'Credentials committed to a branch and its history, checked live on request.' }),
  audit: Object.freeze({ title: 'Audit', lede: 'Uranus maps every endpoint and follows what a caller sends to what uses it.' }),
  safeguards: Object.freeze({ title: 'Safeguards', lede: 'Read-only mode, locked paths, branch rules and recovery.' })
});
/* The tool a target names, looked up among the picker's own five only. */
export const pickTool = (target: string): PickToolWords | null => (Object.hasOwn(PICK_TOOLS, target) ? PICK_TOOLS[target] ?? null : null);

export const PICK_GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z"/></svg>';
export const PICK_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 10.8h11v9.2h-11zM8.8 10.8V8.2a3.2 3.2 0 0 1 6.4 0v2.6"/></svg>';
/* A full page of the listing; a shorter one is its last. */
export const PICK_PAGE = 30;

/* The dialog's body: the tool asking, with the rail's own mark, a search field and an empty list. */
export function pickBody(target: string, tool: PickToolWords, railMark: string, own: boolean): string {
  const placeholder = own ? 'Search your repositories' : 'Search, or paste any public repository';
  const label = own ? 'Search your repositories' : 'Search repositories, or paste any public repository address';
  return `<div class="rp-pick" data-tool="${escapeAttribute(target)}">
        <div class="rp-pick-tool"><span class="rp-pick-mark">${railMark}</span>
          <span class="rp-pick-tool-text"><span class="rp-pick-tool-name">${escapeHtml(tool.title)}</span><span class="rp-pick-tool-lede">${escapeHtml(tool.lede)}</span></span></div>
        <label class="rp-pick-search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3L20 20"/></svg>
          <input id="rpPickQuery" type="search" role="combobox" aria-expanded="true" aria-controls="rpPickList" aria-autocomplete="list" placeholder="${placeholder}" autocomplete="off" spellcheck="false" aria-label="${label}"></label>
        <div class="rp-pick-list" id="rpPickList" role="listbox" aria-label="Repositories"></div>
        <div class="rp-pick-foot" id="rpPickFoot"></div>
      </div>`;
}

/* One repository as the picker lists it. */
export interface PickRepo {
  readonly owner: unknown;
  readonly name: unknown;
  readonly description?: unknown;
  readonly private?: unknown;
  readonly pushed_at?: unknown;
  readonly visitor?: true;
  /* Not one the list holds: any repository the account can read, named by its address. */
  readonly any?: true;
}

export interface PickInput {
  readonly query: string;
  readonly repos: unknown;
  readonly recent: readonly RecentRepository[];
  readonly own: boolean;
  readonly reference: RepositoryReference | null;
  readonly loading: boolean;
  readonly failed: string;
  readonly more: boolean;
  readonly host: string;
}

export interface PickView {
  readonly groups: readonly { readonly label: string; readonly repos: readonly PickRepo[] }[];
  /* What the list says when it lists nothing; null when it lists something or is still being read. */
  readonly empty: string | null;
  /* Rows standing in while the first page is read. */
  readonly ghosts: number;
  readonly count: string;
  readonly more: boolean;
}

const key = (repo: PickRepo): string => `${String(repo.owner)}/${String(repo.name)}`;

export function pickView(input: PickInput): PickView {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const loaded: PickRepo[] = items(input.repos).map(repo => ({
    owner: field(repo, 'owner'), name: field(repo, 'name'), description: field(repo, 'description'), private: field(repo, 'private'), pushed_at: field(repo, 'pushed_at')
  }));
  const byName = new Map(loaded.map(repo => [key(repo), repo]));
  const matches = (repo: PickRepo): boolean => terms.every(term => `${key(repo)} ${String(repo.description || '')}`.toLowerCase().includes(term));
  const recent: PickRepo[] = input.recent.filter(item => !(input.own && item.visitor))
    .map(item => byName.get(`${item.owner}/${item.name}`) || item).filter(matches);
  const recentKeys = new Set(recent.map(key));
  const rest = loaded.filter(repo => !recentKeys.has(key(repo)) && matches(repo));
  /* A pasted address or owner/name that is not one of the listed repositories opens any repository the account can read. */
  const reference = input.own ? null : input.reference;
  const named = reference && !reference.wrongHost ? `${reference.owner}/${reference.name}`.toLowerCase() : null;
  const listed = named ? [...recent, ...rest, ...loaded].find(repo => key(repo).toLowerCase() === named) : undefined;
  const groups: { label: string; repos: PickRepo[] }[] = [];
  const group = (label: string, repos: PickRepo[]): void => { if (repos.length) groups.push({ label, repos }); };
  const anyRepository = (): PickRepo => ({ owner: reference?.owner, name: reference?.name, any: true });
  /* An address names one repository and is all that is listed; a typed owner/name is also a search, so the matches come first. */
  if (named && reference?.kind === 'address') group('Any repository', [listed || anyRepository()]);
  else {
    group(terms.length ? 'Matches' : 'Recent', recent);
    group(terms.length ? (recent.length ? 'More matches' : 'Matches') : 'All repositories', rest);
    if (named && !listed) group('Any repository', [anyRepository()]);
  }
  const listing = groups.some(entry => entry.repos.length);
  const ghosts = input.loading && !loaded.length ? 4 : 0;
  const empty = ghosts || listing ? null
    : input.failed || (reference && reference.wrongHost
      ? `That address is on ${reference.wrongHost}; this session reads repositories on ${input.host}.`
      : terms.length ? `No repository matches \u201c${input.query.trim()}\u201d${input.more ? ' in those loaded' : ''}.` : 'No repositories yet.');
  return {
    groups,
    empty,
    ghosts,
    count: loaded.length ? `${loaded.length} ${loaded.length === 1 ? 'repository' : 'repositories'} loaded` : '',
    more: input.more && !input.loading
  };
}

/* The line under a repository's name: where any repository lives, or what the list knows of it. */
export function pickMeta(repo: PickRepo, host: string, timeAgo: (iso: unknown) => string): string {
  if (repo.any) return `${host} \u00b7 read-only unless you can push to it`;
  return [repo.description, repo.pushed_at ? `updated ${timeAgo(repo.pushed_at)}` : ''].filter(Boolean).join(' \u00b7 ') || 'Recently opened';
}

/* Who can see a repository, said by a mark and a word; nothing is said when the list does not state it. */
export function pickVisibility(repo: PickRepo): { readonly state: 'private' | 'public' | 'unknown'; readonly mark: string; readonly word: string } {
  if (repo.private === true) return { state: 'private', mark: PICK_LOCK, word: 'Private' };
  if (repo.private === false) return { state: 'public', mark: PICK_GLOBE, word: 'Public' };
  return { state: 'unknown', mark: '', word: '' };
}
