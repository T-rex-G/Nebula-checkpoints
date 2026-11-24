/*
 * The workspace: what is on screen for the repository open, let go of
 * together, and read again.
 *
 * Opening another repository clears every view that belonged to the last one
 * before anything is asked of the new one. Refresh reads the tool open again:
 * the commits from their first page, the lists, governance, Safeguards'
 * rules, Exposure's findings, the audit's history, the Neural map, and the
 * file open unless it holds an edit or cannot be shown as text -- a tool not
 * named here has nothing of its own to read. Choosing another branch draws
 * again the tools that belong to a branch -- Safeguards, the audit and the
 * Neural map -- so none is left showing the last branch's reading under the
 * new one's name.
 */
import { field } from '../../platform/values.ts';

export interface WorkspaceDeps {
  /* The tool open: a tab's name. */
  readonly tab: () => string;
  /* Every view that belongs to one repository, each cleared on its own. */
  readonly views: readonly (() => void)[];
  /* The file tree: its index of paths let go of, and the tree read from the top. */
  readonly tree: { forgetIndex(): void; load(): void };
  /* The commits: back to their first page, and read. */
  readonly commits: { reset(): void; load(): void };
  /* Each tool's reading, asked again by Refresh. */
  readonly reread: Readonly<Record<'pulls' | 'issues' | 'releases' | 'actions' | 'governance' | 'safeguards' | 'exposure' | 'audit' | 'neural', () => void>>;
  /* Each tool that belongs to a branch, drawn for the branch open now. */
  readonly redraw: Readonly<Record<'safeguards' | 'audit' | 'neural', () => void>>;
  /* The file open: a record with its path, and whether it is binary or holds an edit; null when none is. */
  readonly file: () => unknown;
  readonly openFile: (path: string) => void;
}

export interface Workspace {
  /* Every view of the last repository cleared, before the next is read. */
  resetViews(): void;
  reloadTree(): void;
  /* The commits from their first page, read again when they are shown. */
  resetCommits(): void;
  /* The tool open, read again by Refresh. */
  reloadView(): void;
  /* Another branch chosen: the tool open drawn for it, when it belongs to a branch. */
  branchChanged(): void;
}

const REREAD = new Set(['pulls', 'issues', 'releases', 'actions', 'governance', 'safeguards', 'exposure', 'audit', 'neural']);
const REDRAW = new Set(['safeguards', 'audit', 'neural']);

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  function resetViews(): void {
    for (const clear of deps.views) clear();
  }

  function reloadTree(): void {
    deps.tree.forgetIndex();
    deps.tree.load();
  }

  function resetCommits(): void {
    deps.commits.reset();
    if (deps.tab() === 'commits') deps.commits.load();
  }

  function reloadView(): void {
    const tab = deps.tab();
    if (tab === 'commits') { resetCommits(); return; }
    if (REREAD.has(tab)) { deps.reread[tab as keyof WorkspaceDeps['reread']](); return; }
    if (tab !== 'editor') return;
    /* An edit is the reader's own, and a binary file has no text to read again. */
    const file = deps.file();
    const path = field(file, 'path');
    if (typeof path === 'string' && path && !field(file, 'binary') && !field(file, 'dirty')) deps.openFile(path);
  }

  function branchChanged(): void {
    const tab = deps.tab();
    if (REDRAW.has(tab)) deps.redraw[tab as keyof WorkspaceDeps['redraw']]();
  }

  return { resetViews, reloadTree, resetCommits, reloadView, branchChanged };
}
