/*
 * The page's screens: which one is in view, and how the next one arrives.
 *
 * One screen shows at a time. A change is cross-faded by the browser's view
 * transition -- except with motion off, without the API, for a reader who
 * asked their system for less motion, or while a layer is still leaving: a
 * transition snapshots the whole document, so starting one a frame after a
 * drawer began sliding out froze the drawer half-way and faded that frame
 * over its own animation. The dismissal is the motion the reader is already
 * watching, so it wins, and the screen changes underneath it.
 *
 * Arriving, the screen is shown from its top -- the window's and its own
 * scrolling region's, since which one scrolls depends on the width -- and
 * only the workbench and the findings inbox keep an address. The rail
 * follows at once, the screen's artwork is mounted whichever way the reader
 * came, and the dock is built two frames later, once the new screen is laid
 * out and the transition no longer holds the old frame.
 */

/* Which screen owns which piece of the design's artwork: the kind drawn, and where. */
export const NEBULA_VISUALS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({ repos: Object.freeze(['galaxy', '#gxHeroArt'] as const) });

/* The visual a screen mounts as it arrives, if it has one. */
export function visualFor(name: string): readonly [string, string] | null {
  return Object.prototype.hasOwnProperty.call(NEBULA_VISUALS, name) ? NEBULA_VISUALS[name] ?? null : null;
}

/* The screens whose state is in the address. */
export const keepsAddress = (name: string): boolean => name === 'work' || name === 'findings';

export interface TransitionConditions {
  readonly available: boolean;
  readonly motion: boolean;
  readonly layerLeaving: boolean;
  readonly reducedMotion: boolean;
}
/* Whether a screen change is cross-faded. */
export const crossFades = (when: TransitionConditions): boolean => when.available && when.motion && !when.layerLeaving && !when.reducedMotion;

/*
 * The galaxy leans a few degrees toward the pointer on a desk: twelve
 * degrees across its width, nine down its height, from its centre.
 */
export function lean(box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }, x: number, y: number): { readonly ry: string; readonly rx: string } {
  const across = (x - box.left) / Math.max(box.width, 1) - 0.5;
  const down = (y - box.top) / Math.max(box.height, 1) - 0.5;
  return { ry: `${(across * 12).toFixed(2)}deg`, rx: `${(-down * 9).toFixed(2)}deg` };
}
