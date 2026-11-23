/*
 * The repository header's controls at work: the repository read again
 * (Refresh, a branch that changed elsewhere, a merge) and laid over the one
 * open in place, so every reading that holds it still knows it as the same
 * repository; the branch chosen, and its shield; a branch created and
 * switched to; the star; the archive.
 *
 * An answer for a repository no longer open changes nothing on the one that
 * is: it used to be laid over it, the second repository taking the first's
 * branches, default branch and name.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';
import { branchList, branchProtected, compareSides, fillBranchSelect, repositoryChanges } from './repository-branches.ts';
import type { BranchDocument, BranchSelect } from './repository-branches.ts';

export interface HeaderState { readonly work: unknown }

interface Select extends BranchSelect { value: string }
interface Anchor { href: string; download: string; click(): void; remove(): void }
export interface HeaderDocument extends BranchDocument {
  createElement(tag: 'option'): { value: string; textContent: string | null; selected: boolean };
  createElement(tag: 'a'): Anchor;
  readonly body: { appendChild(node: unknown): unknown };
}

export interface HeaderDeps {
  readonly state: HeaderState;
  readonly api: (path: string, options?: { method: string; body?: unknown }) => Promise<unknown>;
  /* The open repository changed in place, through the page's store. */
  readonly mutateWork: (change: (work: Record<string, unknown>) => void) => void;
  readonly doc: HeaderDocument;
  readonly branchSelect: () => Select;
  readonly compareBase: () => Select;
  readonly compareHead: () => Select;
  readonly shield: () => { hidden: boolean } | null;
  readonly modal: (request: { title: string; bodyHTML: string; okText: string }) => Promise<unknown>;
  /* The name typed into the new-branch dialog. */
  readonly newBranchName: () => string;
  readonly toast: (message: unknown, kind?: string) => void;
  readonly presentError: (error: unknown) => void;
  readonly haptic: () => void;
  readonly closeDrawer: () => void;
  readonly closeFile: () => void;
  /* The file tree read again from the top, its index let go of. */
  readonly reloadTree: () => void;
  /* The tool open read again. */
  readonly reloadView: () => void;
  /* The commits from their first page, read again when they are shown. */
  readonly resetCommits: () => void;
  /* Another branch shown: the tool open drawn for it, when it belongs to a branch. */
  readonly branchChanged: () => void;
  readonly refreshRate: () => void;
  readonly saveRoute: () => void;
}

export interface RepositoryHeader {
  /* The repository read again and laid over the one open; null when there is none, or another was opened meanwhile. */
  refresh(): Promise<unknown>;
  /* Refresh pressed: the repository, its tree and the tool open read again. */
  sync(): Promise<void>;
  /* The shield shown while the branch open is protected. */
  refreshShield(): void;
  changeBranch(name: string): void;
  createBranch(): Promise<void>;
  toggleStar(): Promise<void>;
  downloadZip(): void;
}

const path = (work: unknown): string => `${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`;
const message = (error: unknown): unknown => field(error, 'message');

export function createRepositoryHeader(deps: HeaderDeps): RepositoryHeader {
  const { state, doc } = deps;

  function refreshShield(): void {
    const shield = deps.shield();
    if (shield) shield.hidden = !branchProtected(state.work, field(state.work, 'branch'));
  }

  async function refresh(): Promise<unknown> {
    const work = state.work;
    if (!work || !field(work, 'owner') || !field(work, 'repo')) return null;
    const info = await deps.api(`/api/repo/${path(work)}`);
    /* Another repository was opened while this one was read, or the account left: the answer is not the open one's. */
    if (state.work !== work) return null;
    const branches = branchList(info);
    if (!branches) throw new Error('The repository answered without its branches, so it was not read again.');
    const changes = repositoryChanges(work, info as Record<string, unknown>, branches);
    deps.mutateWork(open => {
      for (const [name, value] of Object.entries(changes)) Object.defineProperty(open, name, { value, enumerable: true, writable: true, configurable: true });
    });
    const names = branches.map(branch => field(branch, 'name'));
    const sides = compareSides(names, deps.compareBase().value, deps.compareHead().value, field(work, 'default_branch'));
    fillBranchSelect(doc, deps.branchSelect(), names, field(work, 'branch'));
    fillBranchSelect(doc, deps.compareBase(), names, sides.base);
    fillBranchSelect(doc, deps.compareHead(), names, sides.head);
    refreshShield();
    return info;
  }

  async function sync(): Promise<void> {
    const work = state.work;
    if (!field(work, 'repo')) return;
    deps.haptic();
    await refresh().catch(error => deps.toast(message(error), 'err'));
    /* Another repository was opened meanwhile: it was read for itself, and nothing here is its own. */
    if (state.work !== work) return;
    deps.reloadTree();
    deps.reloadView();
    deps.refreshRate();
    deps.toast('Refreshed \u2726', 'ok');
  }

  function changeBranch(name: string): void {
    deps.mutateWork(work => { work.branch = name; });
    refreshShield();
    deps.closeFile();
    deps.reloadTree();
    deps.resetCommits();
    deps.branchChanged();
    deps.saveRoute();
  }

  async function createBranch(): Promise<void> {
    const work = state.work;
    if (!work) return;
    const from = field(work, 'branch');
    const ok = await deps.modal({
      title: 'New branch',
      bodyHTML: `<label class="field-label" for="nbName">Branch name</label><input id="nbName" type="text" placeholder="feature/starlight" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="hint">Created from <b>${escapeHtml(from)}</b></p>`,
      okText: 'Create branch'
    });
    if (!ok) return;
    const name = deps.newBranchName().trim();
    if (!name) return;
    try {
      const created = await deps.api(`/api/repo/${path(work)}/branches`, { method: 'POST', body: { name, from } });
      /* Created on the repository it was asked for; one opened meanwhile is not switched to it. */
      if (state.work === work) {
        deps.mutateWork(open => { (open.branches as unknown[]).push({ name, sha: field(created, 'sha') || '' }); });
        for (const select of [deps.branchSelect(), deps.compareBase(), deps.compareHead()]) {
          const option = doc.createElement('option');
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        }
        deps.branchSelect().value = name;
        /*
         * Made from the branch the dialog named. When another was chosen while
         * it was open, what is on screen is that one's, not the new branch's:
         * it is read again, as for any branch chosen.
         */
        const moved = field(work, 'branch') !== from;
        deps.mutateWork(open => { open.branch = name; });
        refreshShield();
        if (moved) {
          deps.closeFile();
          deps.reloadTree();
          deps.resetCommits();
        }
        deps.branchChanged();
        deps.saveRoute();
      }
      deps.toast(`Branch ${name} created \u2726`, 'ok');
      deps.closeDrawer();
    } catch (error) { deps.toast(message(error), 'err'); }
  }

  async function toggleStar(): Promise<void> {
    const work = state.work;
    if (!work) return;
    try {
      const out = await deps.api(`/api/repo/${path(work)}/star`, { method: field(work, 'starred') ? 'DELETE' : 'PUT' });
      const starred = field(out, 'starred');
      if (typeof starred !== 'boolean') throw new Error('The star could not be confirmed.');
      /* The star belongs to the repository it was asked for; one opened meanwhile keeps its own. */
      if (state.work === work) deps.mutateWork(open => { open.starred = starred; });
      deps.toast(starred ? '\u2605 Starred' : 'Unstarred', 'ok');
    } catch (error) { deps.presentError(error); }
  }

  function downloadZip(): void {
    const work = state.work;
    if (!work) return;
    const link = doc.createElement('a');
    link.href = `/api/repo/${path(work)}/zip?ref=${encodeURIComponent(String(field(work, 'branch')))}`;
    link.download = '';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    deps.toast('Preparing archive\u2026');
  }

  return { refresh, sync, refreshShield, changeBranch, createBranch, toggleStar, downloadZip };
}
