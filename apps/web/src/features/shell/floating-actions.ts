/*
 * The floating action: the controls a screen's top bar had no room for.
 *
 * Not a written list. Below the breakpoint the bar drops controls, marked as
 * dropped in the markup, and those are exactly the ones that then have
 * nowhere to be -- so the dock reads them off the bar and cannot fall out of
 * step with it. Of what the bar drops it carries two, Settings and the
 * command palette, in that order; the others the bar drops on a phone have a
 * place of their own there, and a dock that grew with every control that
 * stopped fitting became a second, longer menu. A control the screen already
 * offers somewhere a thumb can reach is not repeated.
 *
 * It steps aside while the reader moves down the page -- down is reading --
 * and returns as they move back up, near the top, whenever its menu is open,
 * and whenever it takes focus (the stylesheet's :focus-within, which needs no
 * listener to run).
 */

export const DOCK_LABELS: Readonly<Record<string, string>> = Object.freeze({ overview: 'Overview actions', repos: 'Repository actions', work: 'Workspace actions' });
export const DOCK_ACTIONS: readonly string[] = Object.freeze(['settings', 'palette']);

/* What a bar control does, as the dock knows it: by its id. */
export function dockAction(id: string): string {
  return /^settingsBtn/.test(id) ? 'settings' : id === 'paletteBtn' ? 'palette' : '';
}

export interface Named {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}
/* The name a control is announced by. */
export function accessibleName(control: Named): string {
  return (control.getAttribute('aria-label') || control.textContent || '').replace(/\s+/g, ' ').trim();
}

export interface BarControl extends Named {
  readonly id: string;
  readonly offsetParent: unknown;
  contains(other: unknown): boolean;
}
export interface Screen<C extends BarControl = BarControl> {
  querySelector(selector: string): { querySelectorAll(selector: string): Iterable<C> } | null;
  querySelectorAll(selector: string): Iterable<BarControl>;
}

/* The same action somewhere a thumb can already reach: shown, outside the control, by the same name. */
export function placedElsewhere(screen: Screen, control: BarControl, name: string): boolean {
  return [...screen.querySelectorAll('button, a[href]')].some(other => other !== control
    && !control.contains(other)
    && other.offsetParent !== null
    && accessibleName(other) === name);
}

export interface DockEntry<C extends BarControl = BarControl> {
  readonly control: C;
  readonly label: string;
}
/* What the dock holds on a screen, and what it is called; null when the screen leaves it nothing to carry. */
export function dockFor<C extends BarControl>(name: string, screen: Screen<C> | null): { readonly label: string; readonly items: readonly DockEntry<C>[] } | null {
  if (!screen) return null;
  const bar = screen.querySelector('.topbar');
  if (!bar) return null;
  const order = (entry: DockEntry<C>): number => DOCK_ACTIONS.indexOf(dockAction(entry.control.id));
  const dropped = [...bar.querySelectorAll('button.hide-sm')]
    .filter(control => DOCK_ACTIONS.includes(dockAction(control.id)))
    .map(control => ({ control, label: accessibleName(control) }))
    .filter(entry => entry.label && !placedElsewhere(screen, entry.control, entry.label))
    .sort((a, b) => order(a) - order(b));
  if (!dropped.length) return null;
  return { label: DOCK_LABELS[name] || 'Actions', items: dropped };
}

/* Near the top it is always there, and a move of six pixels or less is jitter, not a gesture. */
export const DOCK_TOP = 80;
export const DOCK_JITTER = 6;
/* Whether the dock steps aside after a scroll from `last` to `y`; null leaves it as it is. */
export function retracted(y: number, last: number, menuOpen: boolean): boolean | null {
  if (menuOpen || y < DOCK_TOP) return false;
  if (y > last + DOCK_JITTER) return true;
  if (y < last - DOCK_JITTER) return false;
  return null;
}
