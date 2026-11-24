/*
 * Safeguards at work: the screen drawn for the repository and branch open,
 * its controls bound in the same turn as its markup, the provider's rules
 * read and the posture they decide, the files each lock and preset covers
 * counted once the list is in hand, and a lock or unlock redrawing it in
 * place.
 *
 * Safeguards is a section of the workbench, not a dialog over it: changing a
 * lock redraws it rather than closing and reopening a window. A drawing
 * belongs to the repository and branch it was started for, and to the
 * latest one: a reading that answers after another was opened, or after the
 * screen was drawn again, is dropped. A lock pressed belongs to the
 * repository it was pressed on: it is checked against that repository's
 * locks and sent for it, and its success is said and drawn only while that
 * repository is still open.
 *
 * Focus stays with the reader. A pressed preset or Unlock is disabled while
 * the server answers, and the browser lets go of a disabled control's focus,
 * so the press is remembered: the redraw puts focus on the next preset, or
 * on the Unlock that takes the row's place, and a refusal gives it back to
 * the control pressed.
 */
import { field } from '../../platform/values.ts';
import { protectedList } from './protected-paths.ts';
import {
  RULES_SILENT, SAFEGUARD_PRESETS, matchCount, posture, readRules, rulesFigure, rulesHTML, screenHTML, snapshotTakenAt,
  type RulesReading
} from './safeguards-view.ts';

/* The parts of an element the screen uses. */
export interface ScreenElement {
  innerHTML: string;
  textContent: string | null;
  disabled: boolean;
  checked: boolean;
  value: string;
  readonly id: string;
  readonly dataset: { [name: string]: string | undefined };
  readonly isConnected: boolean;
  readonly children: { readonly length: number };
  querySelector(selector: string): ScreenElement | null;
  querySelectorAll(selector: string): Iterable<ScreenElement>;
  addEventListener(type: string, listener: (event: { readonly key?: string; preventDefault(): void }) => unknown): void;
  replaceChildren(): void;
  contains(node: unknown): boolean;
  focus(options?: { preventScroll?: boolean }): void;
  click(): void;
}

export interface SafeguardsDeps {
  readonly root: () => ScreenElement | null;
  /* The open repository: a record whose identity is the repository, its branch changed in place. */
  readonly work: () => unknown;
  /* The safety record held, and the controller that reads and changes it (safety-controller.ts). */
  readonly record: () => unknown;
  readonly safety: {
    key(): string;
    list(): readonly string[];
    refresh(): Promise<void>;
    set(patch: unknown): Promise<boolean>;
  };
  /* Every file path of the open branch, or null when it could not be read (features/workbench/file-index.ts). */
  readonly files: () => Promise<readonly string[] | null>;
  readonly api: (path: string) => Promise<unknown>;
  readonly toast: (message: string, kind?: string) => void;
  readonly ago: (iso: string) => string;
  /* What the browser kept under a name, or null. */
  readonly stored: (name: string) => string | null;
  readonly capabilities: (root: ScreenElement) => unknown;
  readonly flows: {
    readonly snapshot: () => unknown;
    readonly recover: () => unknown;
    readonly scan: () => unknown;
    readonly activity: () => unknown;
    readonly evidence: () => unknown;
  };
  readonly activeElement: () => unknown;
  /* Whether focus is on nothing in particular: the page itself. */
  readonly focusFree: () => boolean;
  readonly escapeSelector: (value: string) => string;
  readonly now: () => number;
}

export interface Safeguards {
  /* The screen drawn for the repository open; `fresh` reads the provider's rules again rather than from the last minute's. */
  render(options?: { readonly fresh?: boolean }): Promise<void>;
  /* Another repository opened: the screen emptied, its readings dropped and its rules forgotten. */
  reset(): void;
}

const RULES_FOR = 60000;

type Spot = { readonly id: string } | { readonly preset: number } | { readonly unlock: number };

export function createSafeguards(deps: SafeguardsDeps): Safeguards {
  let rendering = 0;
  let cache: { readonly key: string; readonly at: number; readonly value: RulesReading } | null = null;
  let asked = 0;
  /* The preset or Unlock pressed, while the server answers; the redraw it causes puts focus after it. */
  let pressed: { readonly work: unknown; readonly spot: Spot } | null = null;

  async function branchRules(force: boolean): Promise<RulesReading> {
    const work = deps.work();
    const branch = String(field(work, 'branch'));
    const key = `${deps.safety.key()}@${branch}`;
    if (!force && cache && cache.key === key && deps.now() - cache.at < RULES_FOR) return cache.value;
    const mine = ++asked;
    let value: RulesReading;
    try {
      value = readRules(await deps.api(`/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}/branch-protection?branch=${encodeURIComponent(branch)}`));
    } catch (error) {
      const message = field(error, 'message');
      value = Object.freeze({ error: typeof message === 'string' && message ? message : RULES_SILENT });
    }
    if (mine === asked) cache = { key, at: deps.now(), value };
    return value;
  }

  function spotOf(node: unknown): Spot | null {
    const element = node as ScreenElement;
    if (element.id) return { id: element.id };
    const dataset = field(element, 'dataset');
    const preset = field(dataset, 'preset');
    if (typeof preset === 'string') return { preset: Number(preset) };
    const unlock = field(dataset, 'unlock');
    if (typeof unlock === 'string') return { unlock: Number(unlock) };
    return null;
  }

  /* The control that has focus after a redraw: the one used, or the one that takes its place. */
  function successor(root: ScreenElement, spot: Spot): ScreenElement | null {
    const usable = (node: ScreenElement | null): node is ScreenElement => Boolean(node) && !(node as ScreenElement).disabled;
    const input = root.querySelector('#sgProtectPattern');
    if ('id' in spot) {
      const same = root.querySelector(`#${deps.escapeSelector(spot.id)}`);
      return usable(same) ? same : input;
    }
    if ('preset' in spot) {
      const presets = [...root.querySelectorAll('[data-preset]')];
      const next = presets.slice(spot.preset).find(usable) ?? presets.slice(0, spot.preset).reverse().find(usable);
      return next ?? input;
    }
    const unlocks = [...root.querySelectorAll('[data-unlock]')];
    return unlocks[spot.unlock] ?? unlocks[unlocks.length - 1] ?? input;
  }

  async function render(options: { readonly fresh?: boolean } = {}): Promise<void> {
    const root = deps.root();
    const work = deps.work();
    if (!root || !work) return;
    const branch = field(work, 'branch');
    const generation = ++rendering;
    const sameRepository = (): boolean => deps.work() === work;
    const owns = (): boolean => generation === rendering && root.isConnected && sameRepository() && field(work, 'branch') === branch;
    if (!root.children.length) root.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    await deps.safety.refresh();
    if (!owns()) return;
    const record = deps.record();
    const key = deps.safety.key();
    const locks = deps.safety.list();
    const snapshotAt = snapshotTakenAt(deps.stored('nv_snap_' + key));
    const active = deps.activeElement();
    const note = pressed && pressed.work === work ? pressed.spot : null;
    pressed = null;
    const spot = note ?? (active && root.contains(active) ? spotOf(active) : null);
    root.innerHTML = screenHTML({
      key, branch: String(branch), locks, snapshotAt, ago: deps.ago,
      readOnly: Boolean(field(record, 'readOnly')),
      freeze: Boolean(field(record, 'freezeSync')),
      global: field(record, 'globalControls') !== false
    });
    /* Bound in the same turn as the markup: no control is ever on screen without its handler. */
    deps.capabilities(root);
    const bind = (id: string, run: () => unknown): void => {
      const node = root.querySelector('#' + id);
      if (node) node.addEventListener('click', () => { void run(); });
    };
    for (const [id, name] of [['sgReadOnly', 'readOnly'], ['sgFreeze', 'freezeSync']] as const) {
      const toggle = root.querySelector('#' + id);
      if (toggle) toggle.addEventListener('change', async () => { if (!(await deps.safety.set({ [name]: toggle.checked }))) toggle.checked = !toggle.checked; });
    }
    bind('sgSnap', deps.flows.snapshot);
    bind('sgActivity', deps.flows.activity);
    bind('sgRecover', deps.flows.recover);
    bind('sgScan', deps.flows.scan);
    bind('sgEvidence', deps.flows.evidence);
    /* Each pattern not yet locked for this repository, one by one; false at the first refusal. */
    const lock = async (patterns: readonly string[]): Promise<boolean> => {
      for (const pattern of patterns) {
        if (protectedList(deps.record(), key).includes(pattern)) continue;
        if (!(await deps.safety.set({ protect: { repo: key, path: pattern, on: true } }))) return false;
      }
      return true;
    };
    /* A change made: said, and the screen drawn again, while this repository is still the one open. */
    const done = (message: string): void => {
      if (!sameRepository()) { pressed = null; return; }
      deps.toast(message, 'ok');
      void render();
    };
    /* A refusal: the control given back, with the focus it lost. */
    const refused = (control: ScreenElement): void => {
      pressed = null;
      control.disabled = false;
      if (root.contains(control) && deps.focusFree()) control.focus({ preventScroll: true });
    };
    bind('sgAddProtect', async () => {
      const input = root.querySelector('#sgProtectPattern');
      const pattern = input ? input.value.trim().replace(/^\/+/, '') : '';
      if (!pattern) return deps.toast('Enter a file, folder or wildcard pattern', 'err');
      if (await lock([pattern])) done(`${pattern} locked`);
      return undefined;
    });
    const input = root.querySelector('#sgProtectPattern');
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        root.querySelector('#sgAddProtect')?.click();
      });
    }
    for (const control of root.querySelectorAll('[data-preset]')) {
      control.addEventListener('click', async () => {
        const index = Number(control.dataset.preset);
        const preset = SAFEGUARD_PRESETS[index];
        if (!preset) return;
        pressed = { work, spot: { preset: index } };
        control.disabled = true;
        if (await lock(preset.patterns)) done(`${preset.label} locked`);
        else refused(control);
      });
    }
    for (const control of root.querySelectorAll('[data-unlock]')) {
      control.addEventListener('click', async () => {
        const index = Number(control.dataset.unlock);
        const pattern = locks[index];
        if (!pattern) return;
        pressed = { work, spot: { unlock: index } };
        control.disabled = true;
        if (await deps.safety.set({ protect: { repo: key, path: pattern, on: false } })) done(`${pattern} unlocked`);
        else refused(control);
      });
    }
    if (spot) {
      const again = successor(root, spot);
      if (again) again.focus({ preventScroll: true });
    }
    /* How much each preset and lock would cover, once the file list is in hand. */
    void deps.files().then(files => {
      if (!owns() || !files) return;
      const filesNote = root.querySelector('#sgFilesNote');
      if (filesNote) filesNote.textContent = `${files.length === 1 ? '1 file' : `${files.length.toLocaleString()} files`} on ${String(branch)}`;
      SAFEGUARD_PRESETS.forEach((preset, index) => {
        const slot = root.querySelector(`[data-preset-n="${index}"]`);
        if (slot) slot.textContent = String(matchCount(preset.patterns, files));
      });
      locks.forEach((pattern, index) => {
        const slot = root.querySelector(`[data-lock-n="${index}"]`);
        if (!slot) return;
        const n = matchCount([pattern], files);
        slot.textContent = n === 1 ? '1 file' : `${n} files`;
        slot.dataset.zero = n ? 'false' : 'true';
      });
    });
    /* The provider's rules, and the posture they decide; only the latest reading is drawn. */
    let reading = 0;
    const paint = (mine: number, rules: RulesReading): void => {
      if (!owns() || mine !== reading) return;
      const host = root.querySelector('#sgRules');
      if (host) host.innerHTML = rulesHTML(rules);
      const stat = root.querySelector('#sgStatRules');
      if (stat) stat.textContent = rulesFigure(rules);
      const now = posture(rules, locks.length, snapshotAt);
      const section = root.querySelector('.sg-posture');
      if (section) section.dataset.tone = now.tone;
      const word = root.querySelector('#sgPostureWord');
      if (word) word.textContent = now.word;
    };
    const read = (force: boolean): void => {
      const mine = ++reading;
      void branchRules(force).then(rules => paint(mine, rules));
    };
    bind('sgRulesRefresh', () => {
      const host = root.querySelector('#sgRules');
      if (host) host.innerHTML = rulesHTML(null);
      read(true);
    });
    read(Boolean(options.fresh));
  }

  function reset(): void {
    rendering += 1;
    pressed = null;
    cache = null;
    deps.root()?.replaceChildren();
  }

  return { render, reset };
}
