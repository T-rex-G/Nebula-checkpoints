/*
 * A file opened in the editor: its text read from the provider and shown with
 * the mode its name implies, a draft kept from before offered back; an image,
 * a video or a PDF previewed; a Git LFS pointer or a file too large for the
 * editor offered as a download; and the file closed.
 *
 * Each open has its own turn. A file answered after another was opened, or
 * after the file was closed, changes nothing: the editor never shows one
 * file's text under another's name. From the moment a file is asked for, it
 * is the file open and is marked as loading, so the editor's placeholder is
 * never taken for an edit of the file open before -- never saved as its
 * draft, never offered to be committed over it. A file that cannot be read
 * leaves no file open, and nothing to commit.
 */
import { field } from '../../platform/values.ts';

/* Files previewed rather than edited. */
export const IMAGE_EXTENSIONS: readonly string[] = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
export const VIDEO_EXTENSIONS: readonly string[] = Object.freeze(['mp4', 'webm']);

export interface OpenFile {
  path: string;
  sha: unknown;
  binary?: boolean;
  dirty?: boolean;
  original?: string;
  _loading?: boolean;
}

export interface FileOpenerDeps {
  readonly api: (path: string) => Promise<unknown>;
  /* The open repository: owner, name and branch. */
  readonly work: () => unknown;
  readonly editor: () => { setValue(text: string): void; setOption(name: string, value: unknown): void; refresh(): void };
  /* The editor's mode for a file name, if it knows one. */
  readonly mode: (path: string) => unknown;
  readonly decode: (base64: string) => string;
  readonly size: (bytes: unknown) => string;
  readonly file: { set(file: OpenFile | null): void; mutate(change: (file: OpenFile) => void): void };
  readonly ui: {
    /* The editor's frame shown for a file: its name, the Markdown preview offered for Markdown, everything else of the last file cleared. */
    shell(path: string, markdown: boolean): void;
    closed(): void;
    size(text: string): void;
    /* A preview in place of the editor. */
    preview(html: string): void;
    commitable(on: boolean): void;
  };
  readonly closeFind: () => void;
  readonly removeDraftBar: () => void;
  readonly showEditor: () => void;
  readonly remember: (path: string) => void;
  readonly saveRoute: () => void;
  readonly offerDraft: (path: string, text: string) => void;
  /* Words to find in the file once it is open, if a search opened it. */
  readonly takeFind: () => string | null;
  readonly openFind: (words: string) => void;
  readonly toast: (message: string, kind?: string) => void;
  readonly later: (run: () => void, ms: number) => void;
}

export interface FileOpener {
  open(path: string): Promise<void>;
  close(): void;
}

const text = (value: unknown): string => (value == null ? '' : String(value));
/* What follows a path's last dot, lower-cased: the whole path when it has none. */
export const extensionOf = (path: string): string => (path.split('.').pop() || '').toLowerCase();

export function createFileOpener(deps: FileOpenerDeps): FileOpener {
  let turn = 0;

  const urls = (path: string): { file: string; raw: string } => {
    const work = deps.work();
    const at = `/api/repo/${text(field(work, 'owner'))}/${text(field(work, 'repo'))}`;
    const query = `?ref=${encodeURIComponent(text(field(work, 'branch')))}&path=${encodeURIComponent(path)}`;
    return { file: `${at}/file${query}`, raw: `${at}/raw${query}` };
  };

  async function open(path: string): Promise<void> {
    const mine = ++turn;
    const current = (): boolean => mine === turn;
    const ext = extensionOf(path);
    const { file, raw } = urls(path);
    deps.ui.shell(path, ext === 'md');
    deps.closeFind();
    deps.removeDraftBar();
    deps.showEditor();

    if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext) || ext === 'pdf') {
      deps.file.set({ path, sha: null, binary: true });
      deps.ui.commitable(false);
      deps.ui.preview(IMAGE_EXTENSIONS.includes(ext) ? `<img src="${raw}" alt="">`
        : VIDEO_EXTENSIONS.includes(ext) ? `<video src="${raw}" controls playsinline></video>`
          : `<p>Binary file.</p><a class="btn btn-ghost" href="${raw}" download>Download</a>`);
      try {
        const meta = await deps.api(file);
        if (!current()) return;
        deps.file.mutate(open => { open.sha = field(meta, 'sha'); });
        deps.ui.size(deps.size(field(meta, 'size')));
      } catch { /* the preview stands without its size */ }
      return;
    }

    /* Asked for: this is the file open now, and what the editor shows until it answers is not an edit of anything. */
    deps.file.set({ path, sha: null, _loading: true });
    deps.ui.commitable(false);
    const editor = deps.editor();
    editor.setValue('Loading\u2026');
    try {
      const answer = await deps.api(file);
      if (!current()) return;
      const bytes = field(answer, 'size');
      if (field(answer, 'lfs')) {
        deps.file.set({ path, sha: field(answer, 'sha'), binary: true });
        deps.ui.preview(`<span class="lfs-pill">\u2726 Git LFS object</span>
        <p>Stored in Large File Storage \u2014 real size <b>${deps.size(bytes)}</b>.<br>Nebulaverse-X resolves the pointer automatically: download streams the actual file.</p>
        <a class="btn btn-primary" href="${raw}" download>Download ${deps.size(bytes)}</a>`);
        deps.ui.size(`${deps.size(bytes)} \u00b7 LFS`);
        return;
      }
      if (field(answer, 'tooLarge')) {
        deps.file.set({ path, sha: field(answer, 'sha'), binary: true });
        deps.ui.preview(`<p>This file is ${deps.size(bytes)} \u2014 too large for the in-browser editor.<br>Use <b>Push</b> to replace it, or download it.</p>
        <a class="btn btn-ghost" href="${raw}" download>Download</a>`);
        deps.ui.size(deps.size(bytes));
        return;
      }
      const content = deps.decode(text(field(answer, 'content')));
      deps.file.set({ path, sha: field(answer, 'sha'), dirty: false, original: content, _loading: true });
      deps.ui.size(deps.size(bytes));
      const info = deps.mode(path);
      editor.setOption('mode', info ? (field(info, 'mime') || field(info, 'mode')) : null);
      editor.setValue(content);
      deps.file.mutate(open => { open._loading = false; });
      deps.remember(path);
      deps.saveRoute();
      deps.offerDraft(path, content);
      const words = deps.takeFind();
      if (words) deps.later(() => deps.openFind(words), 120);
      deps.ui.commitable(false);
      deps.later(() => editor.refresh(), 30);
    } catch (error) {
      if (!current()) return;
      /* Nothing was read: no file is open, and there is nothing to commit. */
      deps.file.set(null);
      editor.setValue('');
      deps.toast(text(field(error, 'message')) || 'The file could not be read.', 'err');
    }
  }

  function close(): void {
    turn += 1;
    deps.later(() => deps.saveRoute(), 0);
    deps.file.set(null);
    deps.ui.closed();
  }

  return { open, close };
}
