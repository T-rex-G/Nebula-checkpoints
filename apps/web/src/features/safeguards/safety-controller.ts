/*
 * The safety record at work: read from the server and shown -- the page's
 * read-only state, its two chips, and the controls read-only takes away --
 * changed through the server, and a file locked or unlocked from its menu.
 *
 * Read-only takes New file and Commit away and gives them back: New file
 * whenever read-only ends, Commit when the open file has changes to commit.
 * Turning read-only off once left New file disabled until the page was
 * loaded again.
 */
import { field } from '../../platform/values.ts';
import { isExactProtected, isProtected, protectedList, safetyKey } from './protected-paths.ts';

interface Control { disabled: boolean }
interface Chip { hidden: boolean }

export interface SafetyDeps {
  readonly api: (path: string, options?: { method: string; body: unknown }) => Promise<unknown>;
  /* The safety record the page holds, and its replacement. */
  readonly safety: () => unknown;
  readonly setSafety: (value: unknown) => void;
  readonly work: () => unknown;
  readonly toast: (message: unknown, kind?: string) => void;
  readonly body: () => { readonly classList: { toggle(name: string, on: boolean): unknown } };
  readonly $: (selector: string) => Chip | Control | null;
  /* Whether the file open has changes that Commit would send. */
  readonly fileChanged: () => boolean;
  readonly openSafeguards: () => unknown;
}

export interface Safety {
  /* The record read again; a failure keeps the one held, or a record with nothing on. */
  refresh(): Promise<void>;
  /* A change sent; true once the server has it, a refusal said. */
  set(patch: unknown): Promise<boolean>;
  apply(): void;
  key(): string;
  list(): readonly string[];
  isProtected(path: unknown): boolean;
  isExactProtected(path: unknown): boolean;
  /* A file locked, or its own lock lifted; a file locked by a folder or a pattern is sent to Safeguards. */
  toggleProtect(path: unknown): Promise<unknown>;
}

const NOTHING_ON = Object.freeze({ readOnly: false, freezeSync: false, protected: {} });

export function createSafety(deps: SafetyDeps): Safety {
  const key = (): string => safetyKey(deps.work());
  const list = (): readonly string[] => protectedList(deps.safety(), key());

  function apply(): void {
    const safety = deps.safety();
    const readOnly = Boolean(field(safety, 'readOnly'));
    deps.body().classList.toggle('read-only', readOnly);
    const chip = deps.$('#roChip') as Chip | null;
    if (chip) chip.hidden = !readOnly;
    const freeze = deps.$('#freezeChip') as Chip | null;
    if (freeze) freeze.hidden = !field(safety, 'freezeSync');
    const create = deps.$('#newFileBtn') as Control | null;
    if (create) create.disabled = readOnly;
    const commit = deps.$('#commitFileBtn') as Control | null;
    if (commit) commit.disabled = readOnly || !deps.fileChanged();
  }

  async function refresh(): Promise<void> {
    try { deps.setSafety(await deps.api('/api/safety')); } catch { deps.setSafety(deps.safety() || { ...NOTHING_ON, protected: {} }); }
    apply();
  }

  async function set(patch: unknown): Promise<boolean> {
    try {
      deps.setSafety(await deps.api('/api/safety', { method: 'POST', body: patch }));
      apply();
      return true;
    } catch (error) {
      deps.toast(field(error, 'message'), 'err');
      return false;
    }
  }

  async function toggleProtect(path: unknown): Promise<unknown> {
    const locks = list();
    if (isProtected(locks, path) && !isExactProtected(locks, path)) {
      deps.toast(`${String(path)} is protected by a wildcard or folder policy. Remove that policy in Safeguards.`, 'err');
      return deps.openSafeguards();
    }
    const on = !isExactProtected(locks, path);
    if (await set({ protect: { repo: key(), path, on } })) deps.toast(on ? `${String(path)} is now protected` : `${String(path)} unlocked`, 'ok');
    return undefined;
  }

  return {
    refresh, set, apply, key, list, toggleProtect,
    isProtected: path => isProtected(list(), path),
    isExactProtected: path => isExactProtected(list(), path)
  };
}
