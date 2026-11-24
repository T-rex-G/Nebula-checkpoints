/*
 * The rail: the page's chrome around its screens, as what it shows.
 *
 * It appears on the screens a signed-in reader works in and marks the one in
 * view, which is what someone navigating by landmark relies on to know where
 * they are. Five of the workbench's tabs are destinations of their own, and
 * when one of them is in view the rail marks that entry rather than the
 * workbench it sits in.
 *
 * Wide, it is standing chrome, and may be narrowed to its marks; then each
 * entry's name has to survive where a pointer can reach it as well as in the
 * accessibility tree. Narrow, it is a drawer that follows the finger closing
 * it. Magnetar Sec folds like a menu: folded, its tools leave the tab order
 * as well as the screen -- except on a rail narrowed to marks, where the marks
 * are the only way to them.
 */

/* The screens the rail stands beside. */
export const RAIL_SCREENS: ReadonlySet<string> = new Set(['overview', 'repos', 'work', 'site', 'findings']);

/* The workbench's tabs that are destinations of their own, by the tab's id and the rail entry that names it. */
export const PROMOTED_TABS: Readonly<Record<string, string>> = Object.freeze({
  'tab-neural': 'neural', 'tab-governance': 'governance', 'tab-exposure': 'exposure', 'tab-audit': 'audit', 'tab-safeguards': 'safeguards'
});
/* The same destinations, as the rail names them. */
export const REPOSITORY_TOOLS: readonly string[] = Object.freeze(Object.values(PROMOTED_TABS));
export const isRepositoryTool = (entry: unknown): boolean => typeof entry === 'string' && REPOSITORY_TOOLS.includes(entry);

/* From this width the rail is standing chrome; below it, a drawer. */
export const WIDE_RAIL = 1140;

/* The rail entry that is current: the promoted tool in view on the workbench, or the screen itself. */
export function currentEntry(page: string, activeTab: string): string {
  return page === 'work' && Object.prototype.hasOwnProperty.call(PROMOTED_TABS, activeTab) ? PROMOTED_TABS[activeTab] ?? page : page;
}

/* What a pointer is told about an entry on a rail narrowed to marks; nothing when the rail shows its names. */
export function entryTitle(name: string, sub: string, collapsed: boolean): string | null {
  if (!collapsed) return null;
  return sub ? `${name} — ${sub}` : name;
}

/* Magnetar Sec, folded or open, on a rail narrowed to marks or not. */
export interface FoldView {
  readonly inert: boolean;
  readonly tabIndex: number;
  readonly badge: string;
  readonly label: string;
}
export function foldView(open: boolean, narrowed: boolean, tools: number): FoldView {
  return {
    inert: !open && !narrowed,
    tabIndex: narrowed ? -1 : 0,
    badge: String(tools),
    label: `Magnetar Sec, ${tools} security ${tools === 1 ? 'tool' : 'tools'}`
  };
}

/* The reader in the rail's foot: hidden with nobody signed in. */
export interface RailUser {
  readonly hidden: boolean;
  readonly initial: string;
  readonly name: string;
  readonly sub: string;
}
export function railUser(me: { readonly name?: unknown; readonly login?: unknown } | null): RailUser {
  const label = me ? me.name || me.login : '';
  if (!label) return { hidden: true, initial: '', name: '', sub: '' };
  const text = String(label);
  return { hidden: false, initial: text.trim().charAt(0).toUpperCase(), name: text, sub: me && me.login ? `@${String(me.login)}` : '' };
}

/*
 * A drag on the drawer. Past eight pixels it is decided: horizontal moves the
 * drawer with the finger (only ever to the left), vertical is the list
 * scrolling and is left alone. Let go past a third of the drawer's width, or
 * with a flick faster than half a pixel a millisecond over more than 24
 * pixels, and it closes; otherwise it springs back.
 */
export const DRAG_DECIDES = 8;
export function dragAxis(dx: number, dy: number, decided: boolean | null): boolean | null {
  if (decided !== null) return decided;
  return Math.abs(dx) > DRAG_DECIDES || Math.abs(dy) > DRAG_DECIDES ? Math.abs(dx) > Math.abs(dy) : null;
}
export const dragOffset = (dx: number): number => Math.min(0, dx);
export function dragCloses(dx: number, elapsedMs: number, width: number): boolean {
  const fast = Math.abs(dx) / Math.max(1, elapsedMs) > 0.5;
  return -dx > width / 3 || (fast && dx < -24);
}
