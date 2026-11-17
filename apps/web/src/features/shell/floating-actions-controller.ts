/*
 * The floating action at work: built for the screen in view, opened and
 * closed as a layer, dismissed by Escape from inside it or a press outside
 * it, and stepping aside as the reader reads down the page.
 *
 * What it holds is floating-actions.ts's. An entry runs its bar control after
 * the menu has closed and handed focus back to the dock, so whatever the
 * control opens records the dock as where to return -- not an entry removed
 * with the menu, which left focus on the body.
 */
import { dockFor, retracted, type BarControl, type Screen } from './floating-actions.ts';

interface Element {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  appendChild(child: unknown): unknown;
  cloneNode(deep: boolean): Element;
}

export interface Dock {
  hidden: boolean;
  title: string;
  readonly offsetParent: unknown;
  readonly dataset: { action?: string };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  contains(node: unknown): boolean;
  focus(): void;
}

export interface DockMenu {
  readonly hidden: boolean;
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  contains(node: unknown): boolean;
  appendChild(child: unknown): unknown;
  querySelector(selector: string): { focus(options?: { preventScroll?: boolean }): void } | null;
}

export interface DockControl extends BarControl {
  readonly dataset: { readonly feature?: string };
  querySelector(selector: string): Element | null;
  click(): void;
}

export interface FloatingActionsDeps {
  readonly dock: () => Dock | null;
  readonly menu: () => DockMenu | null;
  /* The box the dock stands in, which carries whether it has stepped aside. */
  readonly stand: () => { readonly dataset: { retracted?: string } } | null;
  readonly screen: (name: string) => Screen<DockControl> | null;
  readonly create: (tag: string) => {
    type?: string;
    className: string;
    textContent: string | null;
    readonly dataset: { feature?: string };
    appendChild(child: unknown): unknown;
    addEventListener(type: string, listener: () => void): void;
  };
  readonly openOverlay: (element: unknown) => void;
  readonly closeOverlay: (element: unknown) => void;
  readonly overlayOpen: (element: unknown) => boolean;
  readonly anchor: (overlay: unknown, origin: unknown) => void;
  /* Freshly built entries are read again against the session's capabilities, or a blocked action arrives looking available. */
  readonly applyCapabilities: (root: unknown) => void;
  readonly activeElement: () => unknown;
  readonly scrollY: () => number;
}

export interface FloatingActions {
  paint(name: string): void;
  open(): void;
  close(options?: { restoreFocus?: boolean }): void;
  /* The dock pressed: its menu opens or closes. */
  toggle(): void;
  setRetracted(retracted: boolean): void;
  /* The page scrolled. */
  onScroll(): void;
  /* A dialog just finished: the reader is between actions, so the dock comes back wherever the page is. */
  settle(): void;
  /* Escape, only while the reader is in the menu or on the dock. Whether it was used. */
  onKey(key: string): boolean;
  /* A press anywhere: outside the menu and the dock it closes without taking focus from where the reader went. */
  onPointerDown(target: unknown): void;
}

export function createFloatingActions(deps: FloatingActionsDeps): FloatingActions {
  let lastY = 0;

  function setRetracted(value: boolean): void {
    const stand = deps.stand();
    if (stand) stand.dataset.retracted = value ? 'true' : 'false';
  }

  function close({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
    const dock = deps.dock();
    const menu = deps.menu();
    if (!dock || !menu || !deps.overlayOpen(menu)) return;
    deps.closeOverlay(menu);
    dock.setAttribute('aria-expanded', 'false');
    if (restoreFocus && dock.offsetParent !== null) dock.focus();
  }

  function open(): void {
    const dock = deps.dock();
    const menu = deps.menu();
    if (!dock || !menu) return;
    deps.openOverlay(menu);
    deps.anchor(menu, dock);
    dock.setAttribute('aria-expanded', 'true');
    /* Whatever the page was doing, the control stays while its menu is open. */
    setRetracted(false);
    const first = menu.querySelector('.nv-fab-item:not([hidden])');
    /* Focused while the menu is still rising; without preventScroll the browser scrolls it into view mid-animation. */
    if (first) first.focus({ preventScroll: true });
  }

  function entryFor(control: DockControl, label: string): unknown {
    const entry = deps.create('button');
    entry.type = 'button';
    entry.className = 'nv-fab-item';
    /* The gate travels with the control: an action refused in the bar and offered here would have no gate at all. */
    if (control.dataset.feature) entry.dataset.feature = control.dataset.feature;
    const mark = control.querySelector('svg');
    if (mark) {
      const copy = mark.cloneNode(true);
      copy.setAttribute('class', 'ico');
      copy.removeAttribute('width');
      copy.removeAttribute('height');
      copy.setAttribute('aria-hidden', 'true');
      entry.appendChild(copy);
    }
    const text = deps.create('span');
    text.textContent = label;
    entry.appendChild(text);
    const slot = deps.create('div');
    slot.className = 'nv-fab-slot';
    slot.appendChild(entry);
    entry.addEventListener('click', () => {
      close();
      control.click();
    });
    return slot;
  }

  function paint(name: string): void {
    const dock = deps.dock();
    const menu = deps.menu();
    if (!dock || !menu) return;
    close({ restoreFocus: false });
    menu.innerHTML = '';
    const action = dockFor(name, deps.screen(name));
    dock.hidden = !action;
    if (!action) return;
    dock.setAttribute('aria-label', action.label);
    dock.title = action.label;
    dock.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', action.label);
    for (const item of action.items) menu.appendChild(entryFor(item.control, item.label));
    dock.dataset.action = name;
    deps.applyCapabilities(menu);
  }

  function onScroll(): void {
    const dock = deps.dock();
    if (!deps.stand() || !dock) return;
    /* Above the top is near the top: a rubber band needs no clamping, the dock is there below DOCK_TOP whatever came before. */
    const y = deps.scrollY();
    const next = retracted(y, lastY, dock.getAttribute('aria-expanded') === 'true');
    if (next !== null) setRetracted(next);
    lastY = y;
  }

  return {
    paint, open, close, setRetracted, onScroll,
    toggle: () => { const menu = deps.menu(); if (!menu) return; if (menu.hidden) open(); else close(); },
    settle: () => { setRetracted(false); lastY = Math.max(0, deps.scrollY()); },
    onKey: key => {
      const menu = deps.menu();
      const dock = deps.dock();
      if (key !== 'Escape' || !menu || menu.hidden) return false;
      /* Only when the reader is in it: Escape belongs to whatever holds focus, a dialog opened over the dock included. */
      const active = deps.activeElement();
      if (!menu.contains(active) && active !== dock) return false;
      close();
      return true;
    },
    onPointerDown: target => {
      const menu = deps.menu();
      const dock = deps.dock();
      if (!menu || menu.hidden) return;
      if (menu.contains(target) || (dock && dock.contains(target))) return;
      close({ restoreFocus: false });
    }
  };
}
