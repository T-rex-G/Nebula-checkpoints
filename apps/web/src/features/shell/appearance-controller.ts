/*
 * The page's look, applied: the stored choices read back, the document
 * dressed in them, a change revealed from the control that asked for it, and
 * the choices kept. What each choice may be is appearance.ts's; this is
 * where they meet the document.
 */
import type { EditorSettings } from '../../platform/page-state.ts';
import { isDesign, nextTheme, radioStep, revealCircle, settingsFrom, themeColor, type Design } from './appearance.ts';
import { field } from '../../platform/values.ts';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Choice {
  readonly dataset: { readonly designChoice?: string };
  setAttribute(name: string, value: string): void;
  tabIndex: number;
  focus?(): void;
  getBoundingClientRect?(): Box;
}

interface ViewTransition {
  readonly ready: Promise<unknown>;
  readonly finished: Promise<unknown>;
}

export interface AppearanceDeps {
  readonly root: {
    readonly dataset: { theme?: string; design?: string; motion?: string };
    readonly style: { setProperty(name: string, value: string): void };
    readonly classList: { add(name: string): void; remove(name: string): void };
    animate?(keyframes: unknown, options: unknown): unknown;
  };
  /* The browser chrome's colour, where the page sets one. */
  readonly themeMeta: () => { content: string } | null;
  readonly designChoices: () => readonly Choice[];
  readonly themeSwitches: () => readonly { setAttribute(name: string, value: string): void }[];
  /* The logo's animated drawings, paused with motion. */
  readonly logos: () => readonly { pauseAnimations(): void; unpauseAnimations(): void }[];
  readonly storage: () => { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  readonly settings: () => EditorSettings;
  readonly mutateSettings: (change: (settings: EditorSettings) => void) => void;
  readonly prefersReducedMotion: () => boolean;
  readonly anyOverlayClosing: () => boolean;
  readonly viewport: () => { readonly width: number; readonly height: number };
  readonly startViewTransition: ((change: () => void) => ViewTransition) | null;
  readonly repaintVisuals: () => void;
  readonly editor: () => { setOption(name: string, value: unknown): void; refresh(): void } | null;
}

export interface Appearance {
  load(): void;
  apply(): void;
  setDesign(next: unknown, origin?: unknown): void;
  toggleTheme(origin?: unknown): void;
  /* A press inside the page: a theme switch or a design choice. */
  onClick(target: { closest(selector: string): unknown } | null): void;
  /* A key on a design choice: the arrows move the choice, as in any radio group. Whether it was used. */
  onKey(target: { closest?(selector: string): unknown } | null, key: string): boolean;
}

const SETTINGS_KEY = 'nv_settings';

/* The box of whatever asked for a change, or null when it has none to give. */
function boxOf(origin: unknown): Box | null {
  const measure = field(origin, 'getBoundingClientRect');
  if (typeof measure !== 'function') return null;
  const box: unknown = measure.call(origin);
  const [left, top, width, height] = ['left', 'top', 'width', 'height'].map(name => field(box, name));
  return typeof left === 'number' && typeof top === 'number' && typeof width === 'number' && typeof height === 'number' ? { left, top, width, height } : null;
}

/* The design a choice names. */
const choiceOf = (choice: unknown): unknown => field(field(choice, 'dataset'), 'designChoice');
const THEME_KEY = 'nv_theme';

export function createAppearance(deps: AppearanceDeps): Appearance {
  const root = deps.root;
  const read = (key: string): string | null => {
    try { const storage = deps.storage(); return storage ? storage.getItem(key) : null; } catch { return null; }
  };
  const keep = (key: string, value: string): void => {
    try { const storage = deps.storage(); if (storage) storage.setItem(key, value); } catch { /* not kept: the look still changes */ }
  };

  function paintThemeColor(): void {
    const meta = deps.themeMeta();
    if (meta) meta.content = themeColor(root.dataset.design, root.dataset.theme);
  }

  function reveal(change: () => void, origin: unknown): void {
    const reduce = !deps.settings().motion || root.dataset.motion === 'off' || deps.prefersReducedMotion();
    const start = deps.startViewTransition;
    if (reduce || !start || deps.anyOverlayClosing()) { change(); return; }
    const { width, height } = deps.viewport();
    const { x, y, radius } = revealCircle(boxOf(origin), width, height);
    root.classList.add('vt-reveal');
    const transition = start(change);
    transition.ready.then(() => root.animate && root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' }
    )).catch(() => {});
    transition.finished.finally(() => root.classList.remove('vt-reveal')).catch(() => {});
  }

  function apply(): void {
    if (!isDesign(deps.settings().design)) deps.mutateSettings(settings => { settings.design = 'nebula'; });
    const settings = deps.settings();
    const designChanged = root.dataset.design !== settings.design;
    root.dataset.design = settings.design;
    paintThemeColor();
    if (designChanged) {
      for (const choice of deps.designChoices()) {
        const on = choice.dataset.designChoice === settings.design;
        choice.setAttribute('aria-checked', String(on));
        choice.tabIndex = on ? 0 : -1;
      }
      deps.repaintVisuals();
    }
    root.style.setProperty('--ed-font', `${settings.fontSize / 16}rem`);
    root.style.setProperty('--ed-family', `'${settings.editorFont}', ui-monospace, monospace`);
    root.dataset.motion = settings.motion ? 'on' : 'off';
    for (const logo of deps.logos()) {
      try { if (settings.motion) logo.unpauseAnimations(); else logo.pauseAnimations(); } catch { /* a drawing that cannot pause keeps moving */ }
    }
    const editor = deps.editor();
    if (editor) {
      editor.setOption('lineWrapping', Boolean(settings.wrap));
      editor.setOption('theme', settings.editorTheme);
      editor.refresh();
    }
    keep(SETTINGS_KEY, JSON.stringify(settings));
  }

  function load(): void {
    /* As theme-boot.js reads it: dark or light, and nothing else. */
    const theme = read(THEME_KEY);
    if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
    let stored: unknown = null;
    /* Kept settings that cannot be read are no settings, but they were kept: the system's wish for less motion does not replace them. */
    try { stored = JSON.parse(read(SETTINGS_KEY) || 'null'); } catch { stored = 'unreadable'; }
    const kept = settingsFrom(stored, deps.prefersReducedMotion());
    if (Object.keys(kept).length) deps.mutateSettings(settings => { Object.assign(settings, kept); });
    apply();
  }

  function setDesign(next: unknown, origin?: unknown): void {
    if (!isDesign(next) || deps.settings().design === next) return;
    const design: Design = next;
    reveal(() => {
      deps.mutateSettings(settings => { settings.design = design; });
      apply();
    }, origin);
  }

  function toggleTheme(origin?: unknown): void {
    const next = nextTheme(root.dataset.theme);
    reveal(() => {
      root.dataset.theme = next;
      paintThemeColor();
      keep(THEME_KEY, next);
      for (const control of deps.themeSwitches()) control.setAttribute('aria-checked', String(next === 'dark'));
      /* The artwork has its own palettes; it follows the toggle like everything else. */
      deps.repaintVisuals();
    }, origin);
  }

  function onClick(target: { closest(selector: string): unknown } | null): void {
    if (!target) return;
    const toggle = target.closest('.theme-toggle');
    if (toggle) toggleTheme(toggle);
    const choice = target.closest('[data-design-choice]');
    if (choice) setDesign(choiceOf(choice), choice);
  }

  function onKey(target: { closest?(selector: string): unknown } | null, key: string): boolean {
    const choice = target && typeof target.closest === 'function' ? target.closest('[data-design-choice]') : null;
    if (!choice) return false;
    const step = radioStep(key);
    if (!step) return false;
    const all = deps.designChoices();
    const next = all[(all.findIndex(item => item === choice) + step + all.length) % all.length];
    if (!next) return false;
    if (next.focus) next.focus();
    setDesign(next.dataset.designChoice, next);
    return true;
  }

  return { load, apply, setDesign, toggleTheme, onClick, onKey };
}
