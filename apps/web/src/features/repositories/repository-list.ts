/*
 * The repository list as what it shows: a card for each repository, the
 * empty list, what the filter box narrows the list to, and the card that
 * offers a repository the list does not hold.
 *
 * Who can see a repository is a sigil in the card's corner -- a keyhole
 * shield for private, an open orbit for public -- drawn in the preset's own
 * tones; the word travels for a screen reader and in the tooltip. The filter
 * box filters: an address names one repository, so the list narrows to it,
 * and the card above the list opens it when the list does not hold it.
 */
import { EMPTY_ICON, META_ICON } from '../../components/icons.ts';
import { escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';
import { repositoryReference, sessionHost } from './repository-reference.ts';

/* How many repositories one listing answers with: a full page means there may be more. */
export const PAGE_SIZE = 30;

export const REPO_VIS_PRIVATE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.2l7 2.9v5.3c0 4.3-2.9 7.9-7 9.4-4.1-1.5-7-5.1-7-9.4V6.1z"/><circle cx="12" cy="10.6" r="1.9"/><path d="M12 12.5v3.2"/></svg>';
export const REPO_VIS_PUBLIC = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3.1"/><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-28 12 12)"/><circle cx="19.2" cy="8.3" r="1.1" class="repo-vis-moon"/></svg>';

export const EMPTY_LIST_HTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.repos}</div><p>No repositories yet.<br>Create one with “＋ New repo”.</p></div>`;
export const LOADING_LIST_HTML = '<div class="skeleton"></div>'.repeat(6);

/* A card's markup around its name and description, which are set as text. `ago` is when it was last pushed, in words. */
export function repoCardHtml(repo: unknown, ago: string): string {
  const isPrivate = !!field(repo, 'private');
  const language = field(repo, 'language');
  return `
    <div class="repo-head">
      <span class="repo-sigil-slot"></span>
      <h3><span class="repo-name"></span></h3>
      <span class="repo-vis" data-visibility="${isPrivate ? 'private' : 'public'}" title="${isPrivate ? 'Private repository' : 'Public repository'}">${isPrivate ? REPO_VIS_PRIVATE : REPO_VIS_PUBLIC}<span class="sr-only">${isPrivate ? 'Private' : 'Public'}</span></span>
    </div>
    <p class="desc"></p>
    <div class="repo-meta">
      ${language ? `<span><span class="lang-dot"></span>${escapeHtml(language)}</span>` : ''}
      <span>${META_ICON.star} ${String(field(repo, 'stars'))}</span><span>${META_ICON.fork} ${String(field(repo, 'forks'))}</span><span>${ago}</span>
    </div>
    <span class="repo-open">Open workspace</span>`;
}

/* What the filter box narrows the list to: an address's owner/name, or what was typed, matched without case. */
export function filterQuery(text: string): string {
  const reference = repositoryReference(text);
  return reference && reference.kind === 'address' ? `${reference.owner}/${reference.name}`.toLowerCase() : text.toLowerCase();
}

/* Whether a card whose words are `cardText` stays in a list narrowed to `query`. */
export function cardShown(cardText: string, query: string): boolean {
  return cardText.toLowerCase().includes(query);
}

/* The card above the list: hidden, or naming a repository the list does not hold; and the hint for an address on another host. */
export interface OpenAnyView {
  readonly cardHidden: boolean;
  readonly hintHidden: boolean;
  readonly hint: string;
  readonly owner?: string;
  readonly name?: string;
  readonly title?: string;
  readonly sub?: string;
}

export function openAnyView(text: string, repos: readonly unknown[]): OpenAnyView {
  const reference = repositoryReference(text);
  if (reference && reference.wrongHost !== undefined) {
    return { cardHidden: true, hintHidden: false, hint: `That address is on ${reference.wrongHost}; this session reads repositories on ${sessionHost()}.` };
  }
  if (!reference) return { cardHidden: true, hintHidden: true, hint: '' };
  const wanted = `${reference.owner}/${reference.name}`.toLowerCase();
  const listed = repos.some(repo => `${String(field(repo, 'owner'))}/${String(field(repo, 'name'))}`.toLowerCase() === wanted);
  if (listed) return { cardHidden: true, hintHidden: true, hint: '' };
  return {
    cardHidden: false, hintHidden: true, hint: '',
    owner: reference.owner, name: reference.name,
    title: `${reference.owner}/${reference.name}`,
    sub: `Open from ${sessionHost()} — read-only unless you can push to it`
  };
}
