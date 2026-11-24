/*
 * The repository picker at work: the dialog drawn for the tool that asked,
 * the list read a page at a time when the page holds none, drawn again as the
 * reader types, the keyboard moving through it and Enter opening, and the
 * chosen repository opened into the tool. A dialog the reader has left, or
 * that another has replaced, draws nothing more.
 */
import { field, items } from '../../platform/values.ts';
import { PICK_PAGE, pickBody, pickMeta, pickTool, pickView, pickVisibility } from './repository-picker.ts';
import type { PickRepo } from './repository-picker.ts';
import type { RecentRepository } from './recent-repositories.ts';
import type { RepositoryReference } from './repository-reference.ts';

interface Node { appendChild(node: unknown): unknown }
interface Element extends Node {
  className: string;
  id: string;
  textContent: string | null;
  innerHTML: string;
  title: string;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { add(name: string): void };
  setAttribute(name: string, value: string): void;
  append(...nodes: unknown[]): void;
  addEventListener(type: string, listener: () => void): void;
  scrollIntoView(options: { block: string }): void;
}
interface PickDocument {
  createElement(tag: string): Element;
  createTextNode(text: string): unknown;
}
interface Input {
  value: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key: string; preventDefault(): void }) => void): void;
}
interface Holder { replaceChildren(...nodes: unknown[]): void; appendChild(node: unknown): unknown }
export interface PickBody { querySelector(selector: string): unknown }

export interface PickerState {
  readonly repos: unknown;
  readonly repoPage: number;
  readonly repoSort: string;
}

export interface PickerDeps {
  readonly state: PickerState;
  readonly api: (path: string) => Promise<unknown>;
  readonly modal: (request: { title: string; okText: string; autofocus: boolean; bodyHTML: string; onOpen: (body: PickBody) => void }) => Promise<unknown>;
  /* Whether the dialog drawn is still this one's. */
  readonly owner: () => () => boolean;
  readonly closeModal: (confirmed: boolean) => void;
  readonly okButton: () => { disabled: boolean } | null;
  /* The rail's own mark for the tool, as markup. */
  readonly railMark: (target: string) => string;
  /* A touch device: the search field is not focused, so the keyboard does not rise over the list. */
  readonly coarse: () => boolean;
  readonly doc: PickDocument;
  readonly sigil: (fullName: string) => unknown;
  readonly timeAgo: (iso: unknown) => string;
  readonly host: () => string;
  readonly recent: () => readonly RecentRepository[];
  readonly reference: (text: string) => RepositoryReference | null;
  /* The repositories read, added to the page's list through its store. */
  readonly append: (fresh: readonly unknown[]) => void;
  readonly open: (owner: string, name: string) => Promise<unknown>;
  readonly switchTab: (tool: string) => void;
}

export interface RepositoryPicker {
  /* Asks which repository, then opens it into the tool; resolves once that is done or the reader left. */
  pick(target: string, options?: { own?: boolean }): Promise<void>;
}

export function createRepositoryPicker(deps: PickerDeps): RepositoryPicker {
  const { state, doc } = deps;
  /* The listing's place, kept between pickers: the page read last, and whether there may be more. */
  let page = 0;
  let more = false;

  async function pick(target: string, options: { own?: boolean } = {}): Promise<void> {
    const tool = pickTool(target);
    if (!tool) return;
    const own = !!options.own;
    const railMark = deps.railMark(target);
    /* The row lit, and the one chosen by a press or Enter; read once the dialog has closed. */
    const held: { highlighted: PickRepo | null; chosen: PickRepo | null } = { highlighted: null, chosen: null };
    const ok = await deps.modal({
      title: 'Choose a repository',
      okText: `Open ${tool.title}`,
      autofocus: !deps.coarse(),
      bodyHTML: pickBody(target, tool, railMark, own),
      onOpen: body => {
        const input = body.querySelector('#rpPickQuery') as Input;
        const listEl = body.querySelector('#rpPickList') as Holder;
        const foot = body.querySelector('#rpPickFoot') as Holder;
        const owns = deps.owner();
        let rows: { el: Element; repo: PickRepo }[] = [];
        let loading = false;
        let failed = '';
        const choose = (row: { repo: PickRepo } | undefined): void => {
          if (!row) return;
          held.chosen = row.repo;
          deps.closeModal(true);
        };
        const light = (index: number): void => {
          rows.forEach((row, at) => row.el.setAttribute('aria-selected', at === index ? 'true' : 'false'));
          const row = rows[index];
          held.highlighted = row ? row.repo : null;
          if (row) {
            input.setAttribute('aria-activedescendant', row.el.id);
            row.el.scrollIntoView({ block: 'nearest' });
          } else input.removeAttribute('aria-activedescendant');
          const button = deps.okButton();
          if (button) button.disabled = !held.highlighted;
        };
        const draw = (repo: PickRepo, id: string): Element => {
          const el = doc.createElement('div');
          el.className = 'rp-pick-item';
          el.id = id;
          el.setAttribute('role', 'option');
          const sigil = doc.createElement('span');
          sigil.className = 'rp-pick-sigil';
          const mark = deps.sigil(`${String(repo.owner)}/${String(repo.name)}`);
          if (mark) sigil.appendChild(mark);
          const text = doc.createElement('span');
          text.className = 'rp-pick-text';
          const name = doc.createElement('span');
          name.className = 'rp-pick-name';
          const ownerPart = doc.createElement('span');
          ownerPart.className = 'rp-pick-owner';
          ownerPart.textContent = `${String(repo.owner)}/`;
          name.append(ownerPart, doc.createTextNode(String(repo.name)));
          const meta = doc.createElement('span');
          meta.className = 'rp-pick-meta';
          meta.textContent = pickMeta(repo, deps.host(), deps.timeAgo);
          if (repo.any) el.classList.add('rp-pick-any');
          text.append(name, meta);
          const vis = doc.createElement('span');
          vis.className = 'rp-pick-vis';
          const visibility = pickVisibility(repo);
          vis.dataset.visibility = visibility.state;
          if (visibility.mark) {
            vis.innerHTML = visibility.mark;
            vis.title = visibility.word;
            const word = doc.createElement('span');
            word.className = 'sr-only';
            word.textContent = visibility.word;
            vis.appendChild(word);
          }
          el.append(sigil, text, vis);
          return el;
        };
        const paint = (): void => {
          if (!owns()) return;
          const view = pickView({
            query: input.value, repos: state.repos, recent: deps.recent(), own,
            reference: deps.reference(input.value), loading, failed, more, host: deps.host()
          });
          listEl.replaceChildren();
          rows = [];
          for (const entry of view.groups) {
            const head = doc.createElement('div');
            head.className = 'rp-pick-group';
            head.setAttribute('role', 'presentation');
            head.textContent = entry.label;
            listEl.appendChild(head);
            for (const repo of entry.repos) {
              const el = draw(repo, `rpPick-${rows.length}`);
              const index = rows.length;
              el.addEventListener('mousemove', () => { if (held.highlighted !== repo) light(index); });
              el.addEventListener('click', () => choose({ repo }));
              listEl.appendChild(el);
              rows.push({ el, repo });
            }
          }
          for (let index = 0; index < view.ghosts; index += 1) {
            const ghost = doc.createElement('div');
            ghost.className = 'rp-pick-ghost';
            listEl.appendChild(ghost);
          }
          if (view.empty !== null) {
            const empty = doc.createElement('p');
            empty.className = 'rp-pick-empty';
            empty.textContent = view.empty;
            listEl.appendChild(empty);
          }
          foot.replaceChildren();
          const count = doc.createElement('span');
          count.textContent = view.count;
          foot.appendChild(count);
          if (view.more) {
            const button = doc.createElement('button');
            button.setAttribute('type', 'button');
            button.className = 'btn btn-ghost small';
            button.textContent = 'Load more';
            button.addEventListener('click', () => { void load(); });
            foot.appendChild(button);
          }
          light(rows.length ? 0 : -1);
        };
        const load = async (): Promise<void> => {
          loading = true;
          failed = '';
          paint();
          try {
            const batch = await deps.api(`/api/repos?page=${page + 1}&sort=${state.repoSort}`);
            if (!owns()) return;
            /* A page that is not a list of repositories is refused whole: nothing of it joins the list, and the next press asks for it again. */
            if (!Array.isArray(batch) || !batch.every(repo => repo !== null && typeof repo === 'object')) throw new TypeError('the answer was not a list of repositories');
            page += 1;
            const known = new Set(items(state.repos).map(repo => field(repo, 'full_name')));
            deps.append(batch.filter(repo => !known.has(field(repo, 'full_name'))));
            more = batch.length >= PICK_PAGE;
          } catch (error) {
            const message = field(error, 'message');
            failed = message ? `Repositories could not be listed: ${String(message)}` : 'Repositories could not be listed.';
          }
          loading = false;
          paint();
        };
        input.addEventListener('input', paint);
        input.addEventListener('keydown', event => {
          const at = rows.findIndex(row => row.repo === held.highlighted);
          if (event.key === 'ArrowDown') { event.preventDefault(); light(Math.min(rows.length - 1, at + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); light(Math.max(0, at - 1)); }
          else if (event.key === 'Home' && rows.length) { event.preventDefault(); light(0); }
          else if (event.key === 'End' && rows.length) { event.preventDefault(); light(rows.length - 1); }
          else if (event.key === 'Enter') { event.preventDefault(); choose(rows[at]); }
        });
        if (!items(state.repos).length) { page = 0; void load(); }
        else { page = state.repoPage; more = items(state.repos).length >= state.repoPage * PICK_PAGE; paint(); }
      }
    });
    const button = deps.okButton();
    if (button) button.disabled = false;
    const repo = held.chosen || (ok ? held.highlighted : null);
    if (!repo) return;
    if (await deps.open(String(repo.owner), String(repo.name))) deps.switchTab(target);
  }

  return { pick };
}
