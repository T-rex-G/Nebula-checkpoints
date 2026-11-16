/*
 * The rail at work: narrowed and widened, Magnetar Sec folded and opened,
 * the screen in view marked, the reader shown in its foot, and -- below the
 * wide breakpoint -- a drawer opened from any top bar, dismissed by its
 * scrim, its close control, Escape, a wider window or a drag to the left.
 *
 * What each state looks like is rail.ts's; this is where it meets the
 * document. Preferences are kept per reader: a rail width is a working
 * preference, restored before the first paint of a signed-in screen so it
 * does not snap narrower a moment after arriving.
 */
import { currentEntry, dragAxis, dragCloses, dragOffset, entryTitle, foldView, railUser, RAIL_SCREENS, WIDE_RAIL, type RailUser } from './rail.ts';

interface Text { textContent: string | null }

export interface RailEntry {
  readonly dataset: { readonly rail?: string };
  readonly hidden: boolean;
  title: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): Text | null;
  closest(selector: string): unknown;
  focus?(options?: { preventScroll?: boolean }): void;
}

export interface RailFold {
  readonly dataset: { open?: string; moving?: string };
  inert: boolean;
  querySelector(selector: string): unknown;
}

export interface RailHead {
  tabIndex: number;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): Text | null;
}

export interface Focusable { focus(options?: { preventScroll?: boolean }): void }

export interface RailDeps {
  readonly body: {
    readonly dataset: { rail?: string };
    readonly classList: { toggle(name: string, force?: boolean): boolean; remove(name: string): void; contains(name: string): boolean };
  };
  readonly collapseToggle: () => { setAttribute(name: string, value: string): void } | null;
  readonly entries: () => readonly RailEntry[];
  /* The entries inside Magnetar Sec. */
  readonly securityEntries: () => readonly RailEntry[];
  readonly fold: () => RailFold | null;
  readonly foldHead: () => RailHead | null;
  readonly rail: () => { hidden: boolean; readonly style: { transform: string }; readonly classList: { add(name: string): void; remove(name: string): void }; getBoundingClientRect(): { readonly width: number } } | null;
  readonly scrim: () => unknown;
  readonly menuButtons: () => readonly { setAttribute(name: string, value: string): void }[];
  readonly user: () => { hidden: boolean } | null;
  readonly userText: (part: 'initial' | 'name' | 'sub') => Text | null;
  readonly storage: () => { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  readonly viewportWidth: () => number;
  readonly openOverlay: (element: unknown) => void;
  readonly closeOverlay: (element: unknown, settled?: () => void) => void;
  readonly activeTab: () => string;
  readonly me: () => { readonly name?: unknown; readonly login?: unknown } | null;
  readonly now: () => number;
  readonly attached: (node: unknown) => boolean;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

export interface Rail {
  setCollapsed(collapsed: boolean): void;
  toggleCollapsed(): void;
  setSecurityFold(open: boolean, options?: { remember?: boolean }): void;
  toggleSecurityFold(): void;
  /* The fold's own height transition ended: it is at rest. */
  foldSettled(event: { readonly target: unknown; readonly currentTarget: unknown; readonly propertyName: string }): void;
  /* The kept preferences, applied before the first paint. */
  restore(): void;
  /* The rail for the screen now in view. */
  paint(page: string): void;
  menuOpen(): boolean;
  setMenu(open: boolean, opener?: Focusable | null): void;
  closeMenu(): void;
  dragStart(touches: readonly { readonly clientX: number; readonly clientY: number }[]): void;
  dragMove(touch: { readonly clientX: number; readonly clientY: number }): void;
  dragEnd(): void;
  /* A key pressed anywhere: Escape closes an open drawer. Whether it was used. */
  onKey(key: string): boolean;
  onResize(): void;
}

const COLLAPSED_KEY = 'nv_rail_collapsed';
export const SECURITY_FOLD_KEY = 'nv_ui:rail-security';
/* How long the fold is clipped while it moves, if its transition never reports its end. */
const FOLD_MOVES_MS = 480;

export function createRail(deps: RailDeps): Rail {
  const keep = (key: string, value: string): void => {
    try { const storage = deps.storage(); if (storage) storage.setItem(key, value); } catch { /* not kept: the rail still changes */ }
  };
  const read = (key: string): string | null => {
    try { const storage = deps.storage(); return storage ? storage.getItem(key) : null; } catch { return null; }
  };
  let settleTimer: unknown = null;
  /* Whether the fold was last laid out for a rail narrowed to marks: a window crossing the breakpoint lays it out again. */
  let laidOutNarrowed: boolean | null = null;
  let opener: Focusable | null = null;
  let drag: { x: number; y: number; t: number; dx: number; horizontal: boolean | null } | null = null;

  function setSecurityFold(open: boolean, { remember = true }: { remember?: boolean } = {}): void {
    const head = deps.foldHead();
    const fold = deps.fold();
    if (!head || !fold) return;
    const narrowed = deps.body.dataset.rail === 'collapsed' && deps.viewportWidth() >= WIDE_RAIL;
    laidOutNarrowed = narrowed;
    /* Clipped while it moves, and only then: at rest the current entry's glow spreads past the list. */
    if (fold.dataset.open !== String(open)) {
      fold.dataset.moving = '';
      deps.clearTimeout(settleTimer);
      settleTimer = deps.setTimeout(() => { delete fold.dataset.moving; }, FOLD_MOVES_MS);
    }
    fold.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
    const tools = deps.securityEntries().filter(entry => !entry.hidden && !entry.closest('[hidden]')).length;
    const view = foldView(open, narrowed, tools);
    fold.inert = view.inert;
    head.tabIndex = view.tabIndex;
    const badge = head.querySelector('.nv-rail-group-n');
    if (badge) badge.textContent = view.badge;
    head.setAttribute('aria-label', view.label);
    if (remember) keep(SECURITY_FOLD_KEY, open ? '1' : '0');
  }

  function setCollapsed(collapsed: boolean): void {
    deps.body.dataset.rail = collapsed ? 'collapsed' : 'expanded';
    const toggle = deps.collapseToggle();
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? 'Expand the sidebar' : 'Collapse the sidebar');
    }
    for (const entry of deps.entries()) {
      const name = (entry.querySelector('.nv-rail-t')?.textContent ?? '').trim();
      const sub = (entry.querySelector('.nv-rail-d')?.textContent ?? '').trim();
      const title = entryTitle(name, sub, collapsed);
      if (title === null) entry.removeAttribute('title');
      else entry.title = title;
    }
    keep(COLLAPSED_KEY, collapsed ? '1' : '0');
    const fold = deps.fold();
    if (fold) setSecurityFold(fold.dataset.open === 'true', { remember: false });
  }

  function restore(): void {
    setSecurityFold(read(SECURITY_FOLD_KEY) !== '0', { remember: false });
    setCollapsed(read(COLLAPSED_KEY) === '1');
  }

  function paintUser(user: RailUser): void {
    const foot = deps.user();
    if (!foot) return;
    foot.hidden = user.hidden;
    if (user.hidden) return;
    const [initial, name, sub] = [deps.userText('initial'), deps.userText('name'), deps.userText('sub')];
    if (initial) initial.textContent = user.initial;
    if (name) name.textContent = user.name;
    if (sub) sub.textContent = user.sub;
  }

  function paint(page: string): void {
    const rail = deps.rail();
    if (!rail) return;
    rail.hidden = !RAIL_SCREENS.has(page);
    const shown = currentEntry(page, deps.activeTab());
    for (const entry of deps.entries()) {
      if (entry.dataset.rail === shown) entry.setAttribute('aria-current', 'page');
      else entry.removeAttribute('aria-current');
    }
    const fold = deps.fold();
    /* The heading opens by itself when the screen in front of the reader is one of its tools. */
    if (fold) setSecurityFold(fold.dataset.open === 'true' || Boolean(fold.querySelector('.nv-rail-item[aria-current="page"]')), { remember: false });
    paintUser(railUser(deps.me()));
  }

  const menuOpen = (): boolean => deps.body.classList.contains('nav-open');

  function setMenu(open: boolean, from?: Focusable | null): void {
    const scrim = deps.scrim();
    const was = menuOpen();
    deps.body.classList.toggle('nav-open', open);
    /*
     * `nav-open` is what makes the rail a drawer at all, so dropping it on
     * close would delete the very thing that is meant to slide away.
     * `nav-closing` carries the same layout for as long as the exit lasts,
     * and is lifted by the callback that hides the scrim -- its timer
     * included, so a window resized mid-dismissal cannot leave the rail
     * stuck as a drawer. It is put on only when there was something open.
     */
    deps.body.classList.toggle('nav-closing', !open && was);
    if (open) deps.openOverlay(scrim);
    else deps.closeOverlay(scrim, () => deps.body.classList.remove('nav-closing'));
    for (const button of deps.menuButtons()) button.setAttribute('aria-expanded', String(open));
    if (open) {
      opener = from ?? null;
      const first = deps.entries()[0];
      /* Without preventScroll the browser scrolls the focused entry into view while the drawer is still sliding in. */
      if (first && first.focus) first.focus({ preventScroll: true });
      return;
    }
    /* Focus returns to whichever bar opened it: a reader dismissed back to the top of the document has lost their place. */
    const restoreTo = opener;
    opener = null;
    if (restoreTo && deps.attached(restoreTo)) restoreTo.focus();
  }

  function closeMenu(): void { if (menuOpen()) setMenu(false); }

  function dragStart(touches: readonly { readonly clientX: number; readonly clientY: number }[]): void {
    const touch = touches[0];
    if (!menuOpen() || touches.length !== 1 || !touch) return;
    drag = { x: touch.clientX, y: touch.clientY, t: deps.now(), dx: 0, horizontal: null };
  }

  function dragMove(touch: { readonly clientX: number; readonly clientY: number }): void {
    const rail = deps.rail();
    if (!drag || !rail) return;
    const dx = touch.clientX - drag.x;
    const dy = touch.clientY - drag.y;
    drag.horizontal = dragAxis(dx, dy, drag.horizontal);
    if (!drag.horizontal) return;
    drag.dx = dragOffset(dx);
    rail.classList.add('is-dragging');
    rail.style.transform = `translateX(${drag.dx}px)`;
  }

  function dragEnd(): void {
    const rail = deps.rail();
    if (!drag || !rail) return;
    const { dx, t, horizontal } = drag;
    drag = null;
    rail.classList.remove('is-dragging');
    rail.style.transform = '';
    if (!horizontal) return;
    if (dragCloses(dx, deps.now() - t, rail.getBoundingClientRect().width)) closeMenu();
  }

  function onKey(key: string): boolean {
    if (key !== 'Escape' || !menuOpen()) return false;
    closeMenu();
    return true;
  }

  /*
   * A drawer is a narrow-screen affordance: widened, the rail is standing
   * chrome again, and a scrim over it would be stranded. And a narrowed
   * rail's marks are shown only at the wide width, so the fold is laid out
   * again whenever the window crosses it: its tools reachable where they are
   * shown, and out of the tab order where they are folded away.
   */
  function onResize(): void {
    if (deps.viewportWidth() >= WIDE_RAIL) closeMenu();
    const narrowed = deps.body.dataset.rail === 'collapsed' && deps.viewportWidth() >= WIDE_RAIL;
    const fold = deps.fold();
    if (fold && laidOutNarrowed !== null && narrowed !== laidOutNarrowed) setSecurityFold(fold.dataset.open === 'true', { remember: false });
  }

  return {
    setCollapsed,
    toggleCollapsed: () => setCollapsed(deps.body.dataset.rail !== 'collapsed'),
    setSecurityFold,
    toggleSecurityFold: () => { const fold = deps.fold(); if (fold) setSecurityFold(fold.dataset.open !== 'true'); },
    foldSettled: event => {
      const fold = deps.fold();
      if (fold && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') delete fold.dataset.moving;
    },
    restore, paint, menuOpen, setMenu, closeMenu, dragStart, dragMove, dragEnd, onKey, onResize
  };
}
