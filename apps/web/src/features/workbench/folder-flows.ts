/*
 * A folder moved or deleted from its menu in the tree.
 *
 * Both belong to the repository and branch the folder was shown in. Confirmed
 * after another was opened, nothing is sent; answered after, nothing is said
 * on the one open now. A deletion is sent in commits of a hundred files, each
 * on the head the last one made, and once confirmed it is carried through on
 * its own repository even if the reader opens another meanwhile -- a folder
 * half deleted is worse than one deleted. Whatever landed, the tree and the
 * file list are read again, so neither the palette nor Safeguards keeps a
 * path that has gone. A folder's name is written into the field escaped as an
 * attribute, so a quote in it is part of the name and nothing more.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, items } from '../../platform/values.ts';
import { UNREAD_ANSWER } from './item-menu.ts';

export interface FolderFlowsDeps {
  readonly api: (path: string, options?: { method: string; body: unknown }) => Promise<unknown>;
  /* The open repository: a record whose identity is the repository, its branch changed in place. */
  readonly work: () => unknown;
  readonly modal: (options: { title: string; bodyHTML: string; okText: string; danger?: boolean }) => Promise<unknown>;
  /* What was typed in a field of the dialog, or null when it is not there. */
  readonly value: (selector: string) => string | null;
  readonly toast: (message: unknown, kind?: string) => void;
  /* The head a commit made, kept for the branch while its repository is the one open. */
  readonly remember: (work: unknown, branch: string, commit: unknown) => void;
  /* The tree and the file list read again. */
  readonly reloadTree: () => void;
  readonly productName: string;
}

export interface FolderFlows {
  move(dirPath: unknown): Promise<void>;
  remove(dirPath: unknown): Promise<void>;
}

export const FILES_UNREADABLE = 'The repository\u2019s files could not be read.';
const BATCH = 100;
const SHA = /^[0-9a-f]{40}$/i;

const record = (value: unknown): boolean => typeof value === 'object' && value !== null;

/* The head the branch was last seen at, which a write must land on. */
export function headOf(work: unknown, branch: string): string {
  const found = items(field(work, 'branches')).find(item => field(item, 'name') === branch);
  const sha = field(found, 'sha');
  return typeof sha === 'string' && SHA.test(sha) ? sha : '';
}

const guarded = (body: Record<string, unknown>, head: string): Record<string, unknown> => (head ? { ...body, expectedHeadSha: head } : body);

export function createFolderFlows(deps: FolderFlowsDeps): FolderFlows {
  function place() {
    const work = deps.work();
    const branch = String(field(work, 'branch'));
    return {
      work,
      branch,
      address: `/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`,
      here: (): boolean => deps.work() === work && field(work, 'branch') === branch
    };
  }

  async function move(dirPath: unknown): Promise<void> {
    const path = String(dirPath);
    const { work, branch, address, here } = place();
    if (!work) return;
    const ok = await deps.modal({
      title: 'Rename / move folder',
      bodyHTML: `<p class="hint">Every file under <b class="mono">${escapeHtml(path)}/</b> moves in one atomic commit.</p>
      <label class="set-label" for="mvDirTo" style="margin-top:8px">New path</label>
      <input id="mvDirTo" type="text" value="${escapeAttribute(path)}" autocomplete="off" spellcheck="false" style="width:100%">
      <p class="hint" style="margin-top:6px">Rename in place (<span class="mono">docs</span> \u2192 <span class="mono">guides</span>) or move deeper (<span class="mono">assets/logos</span>).</p>`,
      okText: 'Move \u2726'
    });
    if (!ok || !here()) return;
    const to = (deps.value('#mvDirTo') ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!to || to === path) return;
    try {
      const out = await deps.api(`${address}/move-dir`, {
        method: 'POST',
        body: guarded({ from: path, to, branch, message: `Move ${path} -> ${to}` }, headOf(work, branch))
      });
      if (!here()) return;
      if (!record(out)) { deps.toast(UNREAD_ANSWER, 'err'); deps.reloadTree(); return; }
      deps.remember(work, branch, field(out, 'commit'));
      const moved = field(out, 'moved');
      deps.toast(typeof moved === 'number' && Number.isFinite(moved)
        ? `${moved} file${moved === 1 ? '' : 's'} moved to ${to}/ \u2726`
        : `Moved to ${to}/ \u2726`, 'ok');
      deps.reloadTree();
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
    }
  }

  async function remove(dirPath: unknown): Promise<void> {
    const path = String(dirPath);
    const { work, branch, address, here } = place();
    if (!work) return;
    let victims: string[];
    try {
      const out = await deps.api(`${address}/files?ref=${encodeURIComponent(branch)}`);
      if (!here()) return;
      const files = field(out, 'files');
      if (!Array.isArray(files)) { deps.toast(FILES_UNREADABLE, 'err'); return; }
      victims = files.filter((file): file is string => typeof file === 'string' && file.startsWith(path + '/'));
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
      return;
    }
    if (!victims.length) { deps.toast('That folder has no files', 'err'); return; }
    const leaf = path.split('/').pop() ?? '';
    const commits = Math.ceil(victims.length / BATCH);
    const ok = await deps.modal({
      title: 'Delete folder',
      bodyHTML: `<p style="font-size:.9rem;line-height:1.6">This deletes <b>${victims.length} file${victims.length > 1 ? 's' : ''}</b> under <b class="mono">${escapeHtml(path)}/</b> from <b>${escapeHtml(branch)}</b> in ${commits} commit${commits > 1 ? 's' : ''}.</p>
      <label class="field-label" for="delFolderName">Type <b class="mono">${escapeHtml(leaf)}</b> to confirm</label><input id="delFolderName" type="text" autocomplete="off" spellcheck="false">`,
      okText: 'Delete folder', danger: true
    });
    if (!ok || !here()) return;
    if ((deps.value('#delFolderName') ?? '').trim() !== leaf) { deps.toast('Name mismatch \u2014 aborted', 'err'); return; }
    let head = headOf(work, branch);
    let landed = false;
    try {
      for (let i = 0; i < victims.length; i += BATCH) {
        const out = await deps.api(`${address}/batch`, {
          method: 'POST',
          body: guarded({ branch, message: `Delete ${path}/ via ${deps.productName}`, ops: victims.slice(i, i + BATCH).map(file => ({ op: 'delete', path: file })) }, head)
        });
        landed = true;
        if (!record(out)) throw new Error(UNREAD_ANSWER);
        const commit = field(out, 'commit');
        if (typeof commit === 'string' && SHA.test(commit)) head = commit;
        deps.remember(work, branch, commit);
      }
      if (!here()) return;
      deps.toast(`Folder ${leaf}/ deleted \u2726`, 'ok');
      deps.reloadTree();
    } catch (error) {
      if (!here()) return;
      deps.toast(field(error, 'message'), 'err');
      if (landed) deps.reloadTree();
    }
  }

  return { move, remove };
}
