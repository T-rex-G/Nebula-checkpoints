/*
 * The file tree: a folder's entries read from the provider and drawn as rows,
 * a folder opened in place beneath its row and read once, a file opened in
 * the editor, and the editor's resting state told whether there is anything
 * to pick.
 *
 * A reading belongs to the repository and branch it was asked for, and a
 * root reading to the latest one: one that answers after another repository
 * or branch was opened, or after the tree was read again from the top, is
 * dropped rather than drawn over the tree now shown. An answer that is not a
 * list of entries is a failure, not an empty repository. A name is drawn as
 * text, never as markup.
 *
 * The marks are drawn rather than typed, on the same 24 box as every other
 * icon: stroked, no fill. A folder's chevron points right and is turned by
 * CSS when its row opens, so open and closed are one mark in two positions.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';

export const TREE_ICON = Object.freeze({
  dir: '<svg class="ti-mark ti-mark-dir" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  file: '<svg class="ti-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/></svg>',
  hit: '<svg class="ti-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>'
});

/* The parts of an element the tree uses. */
export interface TreeNode {
  className: string;
  innerHTML: string;
  textContent: string | null;
  hidden: boolean;
  readonly style: { animationDelay: string; display: string };
  readonly classList: { toggle(name: string, on?: boolean): unknown; add(name: string): void; remove(name: string): void };
  querySelector(selector: string): TreeNode | null;
  addEventListener(type: string, listener: () => unknown): void;
  appendChild(node: unknown): unknown;
  after(node: unknown): void;
}
export interface TreeDocument {
  createElement(tag: string): TreeNode;
  createDocumentFragment(): { appendChild(node: unknown): unknown };
}

/* One entry of a folder, as the server lists it. */
export interface TreeEntry {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly type?: unknown;
  readonly size?: unknown;
  readonly sha?: unknown;
}

export interface FileTreeDeps {
  readonly doc: TreeDocument;
  readonly $: (selector: string) => TreeNode | null;
  /* Every row of every tree on the page, so one row is marked active. */
  readonly rows: () => Iterable<TreeNode>;
  readonly api: (path: string) => Promise<unknown>;
  /* The open repository: a record whose identity is the repository, its branch changed in place. */
  readonly work: () => unknown;
  readonly visiting: () => boolean;
  readonly size: (bytes: unknown) => string;
  /* The long-press and right-click menu, attached before the row's own press. */
  readonly attachMenu: (row: TreeNode, entry: TreeEntry) => void;
  readonly openFile: (path: unknown) => unknown;
  readonly closeDrawer: () => void;
}

export interface FileTree {
  /* A folder read into a host; the root replaces the tree, a folder beneath a row adds to it. */
  load(dirPath: string, host: TreeNode, isRoot: boolean): Promise<void>;
  /* The editor's resting state: something to pick, an empty repository, or somebody else's. */
  markEmpty(bare: boolean): void;
}

export const UNREADABLE = 'The repository\u2019s files could not be read.';

export function createFileTree(deps: FileTreeDeps): FileTree {
  let generation = 0;

  function markEmpty(bare: boolean): void {
    const pick = deps.$('.editor-empty-pick');
    const empty = deps.$('.editor-empty-bare');
    const visiting = deps.$('.editor-empty-visitor');
    if (!pick || !empty) return;
    pick.hidden = bare;
    /* Somebody else's repository is not the reader's to fill: it is told what there is, not what to add. */
    empty.hidden = !bare || deps.visiting();
    if (visiting) visiting.hidden = !bare || !deps.visiting();
  }

  function row(entry: TreeEntry, index: number): TreeNode {
    const node = deps.doc.createElement('div');
    const folder = entry.type === 'dir';
    node.className = 'tree-item' + (folder ? ' dir' : '');
    node.style.animationDelay = Math.min(index * 20, 240) + 'ms';
    node.innerHTML = `<span class="ti-icon">${folder ? TREE_ICON.dir : TREE_ICON.file}</span><span class="ti-name"></span>
        ${entry.type === 'file' ? `<span class="tree-size">${deps.size(entry.size)}</span>` : ''}`;
    const name = node.querySelector('.ti-name');
    if (name) name.textContent = entry.name == null ? '' : String(entry.name);
    deps.attachMenu(node, entry);
    if (folder) {
      let open = false;
      let sub: TreeNode | null = null;
      node.addEventListener('click', async () => {
        open = !open;
        node.classList.toggle('open', open);
        if (open && !sub) {
          sub = deps.doc.createElement('div');
          sub.className = 'tree-indent';
          node.after(sub);
          await load(String(entry.path), sub, false);
        } else if (sub) sub.style.display = open ? '' : 'none';
      });
    } else {
      node.addEventListener('click', () => {
        for (const other of deps.rows()) other.classList.remove('active');
        node.classList.add('active');
        deps.openFile(entry.path);
        deps.closeDrawer();
      });
    }
    return node;
  }

  async function load(dirPath: string, host: TreeNode, isRoot: boolean): Promise<void> {
    const work = deps.work();
    const branch = field(work, 'branch');
    const mine = isRoot ? ++generation : generation;
    const current = (): boolean => mine === generation && deps.work() === work && field(work, 'branch') === branch;
    if (isRoot) host.innerHTML = '<div class="skeleton" style="height:160px"></div>';
    try {
      const answer = await deps.api(`/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}/tree?ref=${encodeURIComponent(String(branch))}&path=${encodeURIComponent(dirPath)}`);
      if (!current()) return;
      if (!Array.isArray(answer)) throw new Error(UNREADABLE);
      const entries = answer as TreeEntry[];
      const frag = deps.doc.createDocumentFragment();
      entries.forEach((entry, index) => { frag.appendChild(row(entry, index)); });
      if (isRoot) host.innerHTML = '';
      host.appendChild(frag);
      if (isRoot && !entries.length) host.innerHTML = '<div class="tree-item">Empty repository</div>';
      /*
       * The editor's resting state follows the tree: "Pick a file" is true with
       * files, and an instruction that cannot be carried out without them.
       */
      if (isRoot) markEmpty(!entries.length);
    } catch (error) {
      if (isRoot && current()) host.innerHTML = `<div class="tree-item">\u26a0 ${escapeHtml(field(error, 'message'))}</div>`;
    }
  }

  return { load, markEmpty };
}
