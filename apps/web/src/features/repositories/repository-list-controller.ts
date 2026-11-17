/*
 * The repository list at work: listed, a page more, sorted, filtered, and a
 * repository it does not hold opened from its address.
 *
 * Each fresh listing overtakes the one before it: two in flight used to put
 * every repository in the list twice, and an answer that arrived after an
 * identity boundary drew the departed account's repositories into the page
 * that had just been purged of them. A further page belongs to the listing
 * it continues, and one is asked for at a time. A further page that cannot be
 * read leaves the list as it was, says why, and is asked for again by the
 * next press -- it used to empty the whole list. Whatever the filter box
 * holds applies to every card drawn, the next page's too.
 */
import { field, items } from '../../platform/values.ts';
import type { RequestOptions } from '../../platform/transport.ts';
import { EMPTY_LIST_HTML, LOADING_LIST_HTML, PAGE_SIZE, cardShown, filterQuery, openAnyView, repoCardHtml } from './repository-list.ts';

interface Card {
  className: string;
  tabIndex: number;
  innerHTML: string;
  readonly style: { display: string };
  readonly textContent: string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): { textContent: string | null; appendChild(node: unknown): unknown } | null;
  addEventListener(type: 'click' | 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}
interface Grid { innerHTML: string; appendChild(node: unknown): unknown }

/* What the page holds of the list: the page asked for, the order, the repositories, and its epoch. */
export interface ListState {
  repoPage: number;
  repoSort: string;
  repos: unknown[];
  readonly uiEpoch: number;
}

export interface RepositoryListDeps {
  readonly api: (path: string, options?: RequestOptions) => Promise<unknown>;
  readonly state: ListState;
  /* The list grows in the page's own store, never in place. */
  readonly appendRepos: (batch: readonly unknown[]) => void;
  readonly grid: () => Grid;
  readonly moreButton: () => { hidden: boolean };
  readonly cards: () => readonly Card[];
  readonly createCard: () => Card;
  readonly sigil: (fullName: string) => unknown;
  readonly timeAgo: (iso: unknown) => string;
  readonly open: (owner: string, name: string) => unknown;
  readonly filterText: () => string;
  readonly openAny: () => {
    readonly input: { value: string } | null;
    readonly card: { hidden: boolean } | null;
    readonly hint: { hidden: boolean; textContent: string | null } | null;
    readonly title: { textContent: string | null } | null;
    readonly sub: { textContent: string | null } | null;
    readonly button: { readonly dataset: { owner?: string; name?: string } } | null;
  };
  /* The pulses drawn from the list: the galaxy's, and the workspace's (which reads the list itself unless handed one). */
  readonly renderGalaxyPulse: (repos: readonly unknown[]) => void;
  readonly renderWorkspacePulse: (repos?: readonly unknown[]) => void;
  readonly toast: (message: string, kind?: string) => void;
}

export interface RepositoryList {
  /* A fresh listing (reset), or the next page of this one. */
  load(reset: boolean): Promise<void>;
  /* The next page: one at a time. */
  more(): Promise<void>;
  sort(order: string): Promise<void>;
  /* The filter box changed. */
  filter(text: string): void;
  /* Enter in the filter box: true when it opened a repository the list does not hold. */
  enter(): boolean;
  /* The card above the list pressed. */
  openAny(owner: string | undefined, name: string | undefined): Promise<void>;
  paintOpenAny(): void;
  /* A card for a repository. */
  card(repo: unknown): Card;
}

export function createRepositoryList(deps: RepositoryListDeps): RepositoryList {
  const { state } = deps;
  let listing = 0;
  let further: Promise<void> | null = null;

  function card(repo: unknown): Card {
    const fullName = String(field(repo, 'full_name'));
    const el = deps.createCard();
    el.className = 'card repo-card pressable';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Open repository ${fullName}`);
    el.innerHTML = repoCardHtml(repo, deps.timeAgo(field(repo, 'pushed_at')));
    const name = el.querySelector('h3 .repo-name');
    if (name) name.textContent = fullName;
    const desc = el.querySelector('.desc');
    if (desc) desc.textContent = String(field(repo, 'description') || 'No description');
    /*
     * A mark derived from the repository's own name, so the inventory is
     * something to recognise rather than only to read. Decoration beside the
     * name and never instead of it: a session that cannot draw it loses
     * nothing but the picture.
     */
    const sigil = deps.sigil(fullName);
    const slot = el.querySelector('.repo-sigil-slot');
    if (sigil && slot) slot.appendChild(sigil);
    const open = (): void => { void deps.open(String(field(repo, 'owner')), String(field(repo, 'name'))); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
    return el;
  }

  function narrow(cards: readonly Card[]): void {
    const query = filterQuery(deps.filterText());
    for (const each of cards) each.style.display = cardShown(each.textContent || '', query) ? '' : 'none';
  }

  function paintOpenAny(): void {
    const { input, card: offer, hint, title, sub, button } = deps.openAny();
    if (!input || !offer || !hint) return;
    const view = openAnyView(input.value, state.repos);
    offer.hidden = view.cardHidden;
    hint.hidden = view.hintHidden;
    hint.textContent = view.hint;
    if (view.cardHidden) return;
    if (title) title.textContent = view.title ?? '';
    if (sub) sub.textContent = view.sub ?? '';
    if (button) {
      button.dataset.owner = view.owner;
      button.dataset.name = view.name;
    }
  }

  async function load(reset: boolean): Promise<void> {
    const grid = deps.grid();
    if (reset) {
      listing += 1;
      further = null;
      state.repoPage = 1;
      state.repos = [];
      grid.innerHTML = LOADING_LIST_HTML;
    }
    const mine = listing;
    const epoch = state.uiEpoch;
    const overtaken = (): boolean => mine !== listing || epoch !== state.uiEpoch;
    try {
      const batch = items(await deps.api(`/api/repos?page=${state.repoPage}&sort=${state.repoSort}`));
      if (overtaken()) return;
      if (reset) grid.innerHTML = '';
      deps.appendRepos(batch);
      const drawn = batch.map(repo => card(repo));
      for (const each of drawn) grid.appendChild(each);
      narrow(drawn);
      deps.moreButton().hidden = batch.length < PAGE_SIZE;
      if (!state.repos.length) grid.innerHTML = EMPTY_LIST_HTML;
      deps.renderGalaxyPulse(state.repos);
      deps.renderWorkspacePulse();
      paintOpenAny();
    } catch (error) {
      if (overtaken()) return;
      deps.toast(error instanceof Error ? error.message : String(error), 'err');
      if (!reset) {
        /* The list as it was, and the same page asked for by the next press. */
        state.repoPage -= 1;
        return;
      }
      grid.innerHTML = '';
      deps.renderGalaxyPulse([]);
      deps.renderWorkspacePulse([]);
    }
  }

  function more(): Promise<void> {
    if (further) return further;
    state.repoPage += 1;
    const asked = load(false).finally(() => { if (further === asked) further = null; });
    further = asked;
    return asked;
  }

  function sort(order: string): Promise<void> {
    state.repoSort = order;
    return load(true);
  }

  function filter(_text: string): void {
    narrow(deps.cards());
    paintOpenAny();
  }

  function enter(): boolean {
    const { card: offer } = deps.openAny();
    return !!offer && !offer.hidden;
  }

  async function openAny(owner: string | undefined, name: string | undefined): Promise<void> {
    if (!owner || !name) return;
    const { input } = deps.openAny();
    if (input) input.value = '';
    for (const each of deps.cards()) each.style.display = '';
    paintOpenAny();
    await deps.open(owner, name);
  }

  return { load, more, sort, filter, enter, openAny, paintOpenAny, card };
}
