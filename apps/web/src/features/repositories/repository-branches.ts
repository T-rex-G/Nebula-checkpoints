/*
 * A repository's branches as the header and the comparison hold them: a
 * select filled from the names with one chosen, whether a branch is
 * protected, the comparison's two sides kept where they still exist, and a
 * repository read again laid over the one open, its branch kept while that
 * branch still exists.
 */
import { field, hasFields, items } from '../../platform/values.ts';

export interface BranchOption { value: string; textContent: string | null; selected: boolean }
export interface BranchSelect { innerHTML: string; appendChild(node: unknown): unknown }
export interface BranchDocument { createElement(tag: 'option'): BranchOption }

/* A name as a control's text: what the page's own options would show for it. */
const text = (name: unknown): string => (name == null ? '' : String(name));

/* The select emptied and filled with the names, the selected one marked. */
export function fillBranchSelect(doc: BranchDocument, select: BranchSelect, names: readonly unknown[], selected: unknown): void {
  select.innerHTML = '';
  for (const name of names) {
    const option = doc.createElement('option');
    option.value = String(name);
    option.textContent = text(name);
    if (name === selected) option.selected = true;
    select.appendChild(option);
  }
}

/* Whether the repository open says this branch is protected. */
export function branchProtected(work: unknown, name: unknown): boolean {
  const branch = items(field(work, 'branches')).find(each => field(each, 'name') === name);
  return Boolean(branch && field(branch, 'protected'));
}

/* The branches an answer lists, or null when it lists none the page can hold. */
export function branchList(info: unknown): readonly unknown[] | null {
  const branches = field(info, 'branches');
  return hasFields(info) && Array.isArray(branches) && branches.every(branch => branch !== null && typeof branch === 'object') ? branches : null;
}

/* The comparison's two sides: each kept while its branch still exists, else the default and the first other branch. */
export function compareSides(names: readonly unknown[], base: string, head: string, defaultBranch: unknown): { base: unknown; head: unknown } {
  return {
    base: names.includes(base) ? base : defaultBranch,
    head: names.includes(head) ? head : (names.find(name => name !== defaultBranch) || defaultBranch)
  };
}

/* What a repository read again changes on the one open: every field it answered, and the branch kept while it exists. */
export function repositoryChanges(work: unknown, info: Readonly<Record<string, unknown>>, branches: readonly unknown[]): Record<string, unknown> {
  const previous = field(work, 'branch');
  const changes: Record<string, unknown> = {};
  /* An answer's own "__proto__" is a name like any other, not the record's prototype. */
  for (const [name, value] of Object.entries(info)) Object.defineProperty(changes, name, { value, enumerable: true, writable: true, configurable: true });
  changes.branch = branches.some(branch => field(branch, 'name') === previous) ? previous : info.default_branch;
  return changes;
}
