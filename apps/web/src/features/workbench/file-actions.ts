/*
 * The open file's own actions in the editor: committed with a message --
 * after a warning on a protected branch, and a question when the file changed
 * on the provider since it was opened -- or, refused, routed for approval or
 * kept in the offline queue; staged; deleted or its deletion staged; renamed
 * or moved; its history read; and a new, empty file staged for review.
 *
 * Each action belongs to the file it was asked for. What a commit sends is
 * what the editor held when it was confirmed, and only that is marked
 * committed: an edit made while the commit is out stays an edit, offered to
 * be committed and kept as a draft. An answer that comes back after another
 * file was opened changes that other file in nothing, and a commit refused
 * and queued queues the file it was for.
 */
import { field, items } from '../../platform/values.ts';
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import type { OpenFile } from './file-opener.ts';

export interface FileActionsDeps {
  readonly api: (path: string, options?: unknown) => Promise<unknown>;
  /* The open repository: owner, name and branch. */
  readonly work: () => unknown;
  readonly epoch: () => unknown;
  /* The open file's record, as it is now, a change made to it, and the editor's text. */
  readonly file: () => OpenFile | null;
  readonly mutateFile: (change: (file: OpenFile) => void) => void;
  readonly text: () => string;
  readonly modal: (request: Record<string, unknown>) => Promise<unknown>;
  /* Whether the dialog opened last is still the one on the page, and its body redrawn. */
  readonly modalOwner: () => () => boolean;
  readonly modalBody: (html: string) => void;
  /* A field or a box in the dialog on the page. */
  readonly value: (selector: string) => string | null;
  readonly checked: (selector: string) => boolean;
  readonly protectedBranch: (branch: string) => boolean;
  readonly guardedWrite: (body: Record<string, unknown>) => Record<string, unknown>;
  readonly headSha: () => string;
  readonly rememberHead: (commit: unknown) => void;
  readonly refreshMetadata: () => Promise<unknown>;
  readonly refreshRate: () => void;
  /* The open file's draft cleared, a draft kept under another path, and the offer to restore one put away. */
  readonly drafts: { clear(path: string): void; keep(path: string, text: string): void; removeBar(): void };
  readonly commitable: (on: boolean) => void;
  readonly safePassage: (error: unknown, change: { content: string; message: string | undefined; sha: unknown }) => Promise<unknown>;
  readonly queueCommit: (op: Record<string, unknown>, error: unknown) => Promise<unknown>;
  readonly presentError: (error: unknown) => void;
  readonly stage: (op: Record<string, unknown>) => void;
  readonly openStage: () => void;
  readonly closeDrawer: () => void;
  readonly closeFile: () => void;
  readonly openFile: (path: string) => unknown;
  /* The tree read again, and the file index with it. */
  readonly reloadTree: () => void;
  readonly timeAgo: (at: unknown) => string;
  readonly toast: (message: string, kind?: string) => void;
}

export interface FileActions {
  commit(): Promise<void>;
  stage(): void;
  remove(): Promise<void>;
  rename(): Promise<void>;
  history(): Promise<void>;
  create(): Promise<void>;
}

const text = (value: unknown): string => (value == null ? '' : String(value));
const typedPath = (value: string | null): string => text(value).trim().replace(/^\/+/, '');

export function createFileActions(deps: FileActionsDeps): FileActions {
  /* The protected branches the reader chose to commit to anyway, once each. */
  const warned = new Set<string>();
  const where = (): { owner: string; repo: string; branch: string; at: string } => {
    const work = deps.work();
    const owner = text(field(work, 'owner'));
    const repo = text(field(work, 'repo'));
    return { owner, repo, branch: text(field(work, 'branch')), at: `/api/repo/${owner}/${repo}` };
  };

  async function protectedGate(): Promise<boolean> {
    const { owner, repo, branch } = where();
    if (!deps.protectedBranch(branch)) return true;
    const key = `${owner}/${repo}@${branch}`;
    if (warned.has(key)) return true;
    const ok = await deps.modal({
      title: 'Protected branch',
      okText: 'Commit anyway',
      danger: true,
      bodyHTML: `<p class="hint"><b>${escapeHtml(branch)}</b> is protected. Direct commits may be rejected by the server \u2014 the safer path is a new branch + pull request.</p>`
    });
    if (ok) warned.add(key);
    return Boolean(ok);
  }

  /* Whether the editor still differs from `sent`, said on the file and its buttons, if it is still the file open. */
  function edited(file: OpenFile, sent: string, change?: (open: OpenFile) => void): boolean {
    if (deps.file() !== file) return false;
    const dirty = deps.text() !== sent;
    deps.mutateFile(open => {
      if (change) change(open);
      open.dirty = dirty;
    });
    deps.commitable(dirty);
    return true;
  }

  async function commit(): Promise<void> {
    if (!(await protectedGate())) return;
    const file = deps.file();
    if (!file || file.binary) return;
    const { owner, repo, branch, at } = where();
    const ok = await deps.modal({
      title: 'Commit changes',
      bodyHTML: `<label class="field-label" for="cmMsg">Commit message</label>
      <input id="cmMsg" type="text" value="Update ${escapeAttribute(file.path)}" spellcheck="false">
      <p class="hint">Committing directly to <b>${escapeHtml(branch)}</b></p>`,
      okText: 'Commit \u2726'
    });
    if (!ok) return;
    if (deps.file() !== file) {
      deps.toast(`${file.path} is no longer open; nothing was committed.`, 'err');
      return;
    }
    /* Read while the dialog that holds it is the one on the page: the overwrite question and Safe Passage each replace it. */
    const message = deps.value('#cmMsg') ?? undefined;
    const sent = deps.text();
    try {
      /* Has the file changed on the provider since it was opened? */
      try {
        const remote = await deps.api(`${at}/file?ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(file.path)}`);
        const remoteSha = field(remote, 'sha');
        if (remoteSha && file.sha && remoteSha !== file.sha) {
          const overwrite = await deps.modal({
            title: 'File changed on GitHub',
            bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Someone (or another session) committed a newer version of <b class="mono">${escapeHtml(file.path)}</b> after you opened it.<br><br>Overwrite it with your version, or cancel and reload the latest first?</p>`,
            okText: 'Overwrite anyway', danger: true
          });
          if (!overwrite) return;
          if (deps.file() === file) deps.mutateFile(open => { open.sha = remoteSha; });
          else file.sha = remoteSha;
          await deps.refreshMetadata();
        }
      } catch { /* the provider could not say: the write itself will */ }
      const out = await deps.api(`${at}/file`, {
        method: 'PUT',
        body: deps.guardedWrite({ path: file.path, content: sent, message: message || undefined, branch, sha: file.sha })
      });
      deps.rememberHead(field(out, 'commit'));
      /* Committed as far as it was sent; an edit made since stays an edit, and its draft is kept. */
      if (edited(file, sent, open => { open.sha = field(out, 'sha'); open.original = sent; }) && !file.dirty) {
        deps.drafts.clear(file.path);
        deps.drafts.removeBar();
      }
      deps.toast('Committed \u2726', 'ok');
      deps.refreshRate();
    } catch (error) {
      /*
       * A refusal that needs approval carries the route to approval. Taking it
       * puts the change on a branch of its own, so the editor is left exactly
       * as it is: this file on this branch still differs from what is
       * committed here.
       */
      const routed = await deps.safePassage(error, { content: sent, message, sha: file.sha });
      if (routed) return;
      const queued = await deps.queueCommit({
        kind: 'put', owner, repo, branch, path: file.path, content: sent, message, sha: file.sha, expectedHeadSha: deps.headSha()
      }, error);
      if (queued) edited(file, sent);
      else deps.presentError(error);
    }
  }

  function stage(): void {
    const file = deps.file();
    if (!file || file.binary) return;
    deps.stage({ op: 'put', path: file.path, content: deps.text() });
    deps.mutateFile(open => { open.dirty = false; });
    deps.commitable(false);
    deps.drafts.clear(file.path);
    deps.drafts.removeBar();
    deps.toast(`Staged ${file.path}`, 'ok');
  }

  async function remove(): Promise<void> {
    const file = deps.file();
    if (!file || !file.sha) { deps.toast('Cannot delete: metadata unavailable', 'err'); return; }
    const { branch, at } = where();
    const choice = await deps.modal({
      title: 'Delete file',
      bodyHTML: `<p style="font-size:.9rem;line-height:1.5">Delete <b class="mono">${escapeHtml(file.path)}</b> from <b>${escapeHtml(branch)}</b>?</p>
      <label class="check"><input type="checkbox" id="delStage"> Stage the deletion instead of committing now</label>`,
      okText: 'Delete', danger: true
    });
    if (!choice) return;
    if (deps.checked('#delStage')) {
      deps.stage({ op: 'delete', path: file.path });
      deps.toast(`Deletion of ${file.path} staged`, 'ok');
      return;
    }
    try {
      const out = await deps.api(`${at}/file`, { method: 'DELETE', body: deps.guardedWrite({ path: file.path, branch, sha: file.sha }) });
      deps.rememberHead(field(out, 'commit'));
      deps.toast('File deleted', 'ok');
      /* Another file opened meanwhile stays open. */
      if (deps.file() === file) deps.closeFile();
      deps.reloadTree();
    } catch (error) { deps.presentError(error); }
  }

  async function rename(): Promise<void> {
    const file = deps.file();
    if (!file) return;
    const { branch, at } = where();
    const ok = await deps.modal({
      title: 'Rename / move file',
      bodyHTML: `<label class="field-label" for="rnTo">New path</label>
      <input id="rnTo" type="text" value="${escapeAttribute(file.path)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="hint">Works for files of any size \u2014 the blob is re-linked, not re-uploaded.</p>`,
      okText: 'Rename \u2726'
    });
    if (!ok) return;
    const to = typedPath(deps.value('#rnTo'));
    if (!to || to === file.path) return;
    try {
      const out = await deps.api(`${at}/rename`, { method: 'POST', body: deps.guardedWrite({ from: file.path, to, branch }) });
      deps.rememberHead(field(out, 'commit'));
      deps.toast(`Renamed to ${to} \u2726`, 'ok');
      deps.reloadTree();
      /*
       * The file renamed opens at its new path, unless another was opened
       * meanwhile. The rename moved what was committed; edits not yet
       * committed go with it as a draft, offered back there.
       */
      if (deps.file() !== file) return;
      if (file.dirty) {
        deps.drafts.keep(to, deps.text());
        deps.drafts.clear(file.path);
      }
      deps.openFile(to);
    } catch (error) { deps.presentError(error); }
  }

  async function history(): Promise<void> {
    const file = deps.file();
    if (!file) return;
    const path = file.path;
    const { branch, at } = where();
    void deps.modal({ title: `History \u2014 ${path.split('/').pop()}`, okText: 'Close', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
    const owns = deps.modalOwner();
    let html: string;
    try {
      const commits = await deps.api(`${at}/commits?ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`);
      if (!Array.isArray(commits)) throw new Error('The history could not be read.');
      html = commits.length ? items(commits).map(entry => `
      <div class="comment">
        <div class="comment-head"><span class="mono commit-sha">${escapeHtml(text(field(entry, 'sha')).slice(0, 7))}</span><span>${escapeHtml(field(entry, 'author'))}</span><span>${deps.timeAgo(field(entry, 'date'))}</span></div>
        <div class="comment-body">${escapeHtml(text(field(entry, 'message')).split('\n')[0])}</div>
      </div>`).join('') : '<p class="hint">No history found for this path.</p>';
    } catch (error) {
      html = `<p class="hint">\u26a0 ${escapeHtml(text(field(error, 'message')) || 'The history could not be read.')}</p>`;
    }
    if (owns()) deps.modalBody(html);
  }

  async function create(): Promise<void> {
    if (!deps.work()) return;
    const scope = (): string => { const { owner, repo, branch } = where(); return `${owner}/${repo}@${branch}`; };
    const asked = scope();
    const epoch = deps.epoch();
    const ok = await deps.modal({
      title: 'New file',
      bodyHTML: `<label class="field-label" for="nfPath">Path</label><input id="nfPath" type="text" placeholder="docs/notes.md" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="hint">Creates an empty file in your staged changes. Review the diff, repository and branch before committing; nothing is sent yet.</p>`,
      okText: 'Stage file'
    });
    if (!ok) return;
    /* Another repository, branch or session -- or none -- is not the one this file was asked for. */
    if (epoch !== deps.epoch() || asked !== scope()) {
      deps.toast('The repository changed. Open New file again for the intended branch.', 'err');
      return;
    }
    const path = typedPath(deps.value('#nfPath'));
    if (!path) return;
    deps.stage({ op: 'put', path, content: '', newFile: true });
    deps.toast(`New file ${path} staged for review`);
    deps.closeDrawer();
    deps.openStage();
  }

  return { commit, stage, remove, rename, history, create };
}
