/*
 * A tree entry's menu, opened by a long press on touch and by a right click
 * on a desk: open, rename or move, download, protect, and delete a file; move
 * or delete a folder.
 *
 * The menu acts on the entry it was opened for: its choice is heard by this
 * menu alone, and its listener goes when its dialog closes -- the dialog settles
 * every request it replaces, so no menu outlives its own. Every menu once left its listener on the page's one
 * dialog, so a later menu's Download or Protect also downloaded or protected
 * every file whose menu had been opened before it.
 *
 * Whatever it changes, it changes on the repository and branch the menu was
 * opened on: a choice made, a rename or deletion confirmed, or an answer that
 * arrives after another repository or branch is open is not carried out on
 * that one, and its commit is not recorded as that one's head.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';
import type { TreeEntry } from './file-tree.ts';

export interface MenuRow {
  addEventListener(type: string, listener: (event: MenuEvent) => void, options?: { passive: boolean }): void;
}
export interface MenuEvent {
  readonly target?: unknown;
  stopImmediatePropagation?(): void;
  preventDefault?(): void;
}
interface Anchor { href: string; download: string; click(): void; remove(): void }
export interface MenuDocument {
  createElement(tag: 'a'): Anchor;
  readonly body: { appendChild(node: unknown): unknown };
}
interface ModalBody {
  addEventListener(type: 'click', listener: (event: MenuEvent) => void): void;
  removeEventListener(type: 'click', listener: (event: MenuEvent) => void): void;
}

export interface ItemMenuDeps {
  readonly doc: MenuDocument;
  /* The page's one dialog's body, which every dialog reuses. */
  readonly body: () => ModalBody | null;
  /* The new path typed into the rename dialog. */
  readonly renameTo: () => string;
  readonly modal: (request: { title: string; bodyHTML: string; okText: string; danger?: boolean }) => Promise<unknown>;
  readonly closeModal: (confirmed: boolean) => void;
  /* What this account may do, applied to the menu's choices. */
  readonly capabilities: (body: unknown) => void;
  readonly isProtected: (path: unknown) => boolean;
  /* The open repository: a record whose identity is the repository, its branch changed in place. */
  readonly work: () => unknown;
  readonly api: (path: string, options: { method: string; body: unknown }) => Promise<unknown>;
  readonly guardedWrite: (extra: Record<string, unknown>) => unknown;
  readonly rememberHead: (commit: unknown) => void;
  readonly toast: (message: unknown, kind?: string) => void;
  readonly openFile: (path: unknown) => unknown;
  /* The file open in the editor, if any. */
  readonly fileOpen: () => unknown;
  readonly closeFile: () => void;
  /* The file tree read again from the top, its index let go of. */
  readonly reloadTree: () => void;
  readonly deleteFolder: (path: unknown) => unknown;
  readonly moveFolder: (path: unknown) => unknown;
  readonly toggleProtect: (path: unknown) => unknown;
  readonly haptic: (ms: number) => void;
  readonly timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface ItemMenu {
  /* The long press and the right click on a row; attached before the row's own press, so a long press is not also a press. */
  attach(row: MenuRow, entry: TreeEntry): void;
  open(entry: TreeEntry): void;
}

const LONG_PRESS_MS = 520;
export const UNREAD_ANSWER = 'The change was sent, but its answer could not be read. Refresh to see where it stands.';
const record = (value: unknown): boolean => typeof value === 'object' && value !== null;

export function createItemMenu(deps: ItemMenuDeps): ItemMenu {
  let pressTimer: unknown = null;
  let pressFired = false;

  function attach(row: MenuRow, entry: TreeEntry): void {
    row.addEventListener('click', event => {
      if (pressFired) { event.stopImmediatePropagation?.(); event.preventDefault?.(); pressFired = false; }
    });
    row.addEventListener('contextmenu', event => { event.preventDefault?.(); open(entry); });
    row.addEventListener('touchstart', () => {
      /* A second touch begun before the first ended starts over: the first's menu never opens behind it. */
      deps.timers.clear(pressTimer);
      pressFired = false;
      pressTimer = deps.timers.set(() => { pressFired = true; deps.haptic(14); open(entry); }, LONG_PRESS_MS);
    }, { passive: true });
    for (const type of ['touchend', 'touchmove', 'touchcancel']) row.addEventListener(type, () => { deps.timers.clear(pressTimer); }, { passive: true });
  }

  function open(entry: TreeEntry): void {
    const folder = entry.type === 'dir';
    const path = entry.path;
    const work = deps.work();
    const branch = field(work, 'branch');
    const owner = field(work, 'owner');
    const repo = field(work, 'repo');
    const here = (): boolean => deps.work() === work && field(work, 'branch') === branch;
    const choices = deps.modal({
      title: String(entry.name) + (folder ? '/' : ''), okText: 'Close',
      bodyHTML: `
      ${folder ? '' : `<button class="btn btn-ghost btn-block" data-mi="open" style="margin-top:0">Open in editor</button>
      <button class="btn btn-ghost btn-block" data-mi="rename" data-feature="file.rename">Rename / move</button>
      <button class="btn btn-ghost btn-block" data-mi="download">Download</button>`}
      ${folder ? '<button class="btn btn-ghost btn-block" data-mi="movedir" data-feature="folder.move">Rename / move folder\u2026</button>'
        : `<button class="btn btn-ghost btn-block" data-mi="protect">${deps.isProtected(path) ? 'Unprotect file' : 'Protect file'}</button>`}
      <button class="btn btn-ghost btn-block danger" data-mi="delete" ${folder ? 'style="margin-top:0"' : ''}>${folder ? 'Delete folder\u2026' : 'Delete file\u2026'}</button>`
    });
    const body = deps.body();
    deps.capabilities(body);
    if (!body) return;
    const choose = (event: MenuEvent): void => { void chosen(event); };
    body.addEventListener('click', choose);
    void Promise.resolve(choices).finally(() => body.removeEventListener('click', choose));

    async function chosen(event: MenuEvent): Promise<void> {
      const target = event.target as { closest?(selector: string): { dataset: Record<string, string | undefined> } | null } | null;
      const button = target && typeof target.closest === 'function' ? target.closest('[data-mi]') : null;
      if (!button) return;
      const act = button.dataset.mi;
      deps.closeModal(false);
      if (!here()) return;
      const address = `/api/repo/${String(owner)}/${String(repo)}`;
      if (act === 'open') deps.openFile(path);
      else if (act === 'download') {
        const anchor = deps.doc.createElement('a');
        anchor.href = `${address}/raw?ref=${encodeURIComponent(String(branch))}&path=${encodeURIComponent(String(path))}`;
        anchor.download = String(entry.name);
        deps.doc.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else if (act === 'rename') {
        const ok = await deps.modal({
          title: 'Rename / move',
          bodyHTML: `<label class="field-label" for="rnTo2">New path</label><input id="rnTo2" type="text" value="${escapeAttribute(path)}" autocapitalize="off" autocorrect="off" spellcheck="false">`,
          okText: 'Rename \u2726'
        });
        if (!ok || !here()) return;
        const to = deps.renameTo().trim().replace(/^\/+/, '');
        if (!to || to === path) return;
        try {
          const out = await deps.api(`${address}/rename`, { method: 'POST', body: deps.guardedWrite({ from: path, to, branch }) });
          if (!here()) return;
          if (!record(out)) { deps.toast(UNREAD_ANSWER, 'err'); return; }
          deps.rememberHead(field(out, 'commit'));
          deps.toast(`Renamed to ${to} \u2726`, 'ok');
          deps.reloadTree();
        } catch (error) { if (here()) deps.toast(field(error, 'message'), 'err'); }
      } else if (act === 'delete' && !folder) {
        const ok = await deps.modal({
          title: 'Delete file',
          bodyHTML: `<p style="font-size:.9rem;line-height:1.5">Delete <b class="mono">${escapeHtml(path)}</b> from <b>${escapeHtml(branch)}</b>?</p>`,
          okText: 'Delete', danger: true
        });
        if (!ok || !here()) return;
        try {
          const out = await deps.api(`${address}/file`, { method: 'DELETE', body: deps.guardedWrite({ path, branch, sha: entry.sha }) });
          if (!here()) return;
          if (!record(out)) { deps.toast(UNREAD_ANSWER, 'err'); return; }
          deps.rememberHead(field(out, 'commit'));
          deps.toast('File deleted', 'ok');
          const file = deps.fileOpen();
          if (file && field(file, 'path') === path) deps.closeFile();
          deps.reloadTree();
        } catch (error) { if (here()) deps.toast(field(error, 'message'), 'err'); }
      } else if (act === 'delete' && folder) void deps.deleteFolder(path);
      else if (act === 'movedir') void deps.moveFolder(path);
      else if (act === 'protect') void deps.toggleProtect(path);
    }
  }

  return { attach, open };
}
