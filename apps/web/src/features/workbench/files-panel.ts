/*
 * The files card on a desk can step aside for the tool beside it. It is a
 * viewer's preference, not repository data, so it lives in this browser and
 * outlives the repository that was open. On a phone the files are a drawer
 * already and none of this applies; the card is made inert only while it is
 * out of sight on a desk, so a hidden tree is never reachable by Tab. Focus
 * inside the card as it goes is handed to the control that brings it back.
 */

export const FILES_HIDDEN_KEY = 'nv_files_hidden';

export interface FilesStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface Card {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(node: unknown): boolean;
}
interface Toggle {
  title: string;
  setAttribute(name: string, value: string): void;
  focus(options: { preventScroll: boolean }): void;
}
interface Workspace { readonly classList: { toggle(name: string, on: boolean): unknown } }
export interface FilesKey {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: unknown;
  readonly target: unknown;
  preventDefault(): void;
}

export interface FilesPanelDeps {
  readonly storage: () => FilesStorage;
  readonly workspace: () => Workspace | null;
  readonly side: () => Card | null;
  readonly toggle: () => Toggle | null;
  readonly mobile: () => boolean;
  /* Whether the workbench is the page shown. */
  readonly onWork: () => boolean;
  readonly active: () => unknown;
}

export interface FilesPanel {
  hidden(): boolean;
  /* The card as the preference and the width say: inert and out of sight, or there. */
  apply(): void;
  set(hidden: boolean): void;
  /* Ctrl+B or Cmd+B on a desk, outside the editor and anything typed into. */
  shortcut(event: FilesKey): void;
}

const EDITING = '.CodeMirror, textarea, [contenteditable="true"]';

export function createFilesPanel(deps: FilesPanelDeps): FilesPanel {
  let hidden = false;
  try { hidden = deps.storage().getItem(FILES_HIDDEN_KEY) === '1'; } catch { /* A browser that keeps nothing shows the files. */ }

  function apply(): void {
    const workspace = deps.workspace();
    const side = deps.side();
    if (!workspace || !side) return;
    const away = hidden && !deps.mobile();
    workspace.classList.toggle('files-hidden', away);
    if (away) side.setAttribute('inert', '');
    else side.removeAttribute('inert');
    const label = away ? 'Show files' : 'Hide files';
    const toggle = deps.toggle();
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!away));
      toggle.setAttribute('aria-label', label);
      toggle.title = `${label} (Ctrl+B)`;
    }
  }

  function set(next: boolean): void {
    const active = deps.active();
    const side = deps.side();
    const returning = Boolean(active && side && side.contains(active));
    hidden = Boolean(next);
    try { deps.storage().setItem(FILES_HIDDEN_KEY, hidden ? '1' : '0'); } catch { /* Kept for this page only. */ }
    apply();
    if (hidden && returning) deps.toggle()?.focus({ preventScroll: true });
  }

  function shortcut(event: FilesKey): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== 'b') return;
    if (!deps.onWork() || deps.mobile()) return;
    const target = event.target as { closest?: (selector: string) => unknown } | null;
    if (target && typeof target.closest === 'function' && target.closest(EDITING)) return;
    event.preventDefault();
    set(!hidden);
  }

  return { hidden: () => hidden, apply, set, shortcut };
}
