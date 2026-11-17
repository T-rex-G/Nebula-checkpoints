/*
 * Where a layer grows from.
 *
 * A panel that scales up from its own centre appears; a panel that scales up
 * from the control that summoned it arrives, and the reader's eye is already
 * there. It is the difference between a dialog and a menu, and it costs one
 * transform-origin, written as `--nv-origin` for the stylesheet to read.
 *
 * The origin is the opener's centre expressed in the panel's own box, so it
 * stays right wherever the panel lands -- centred on a wide screen, full
 * width on a narrow one. When the opener is gone, unknown or has no size, or
 * the panel has none yet, nothing is written and the stylesheet's own
 * fallback, the centre, holds: the right answer for a dialog that nothing in
 * particular opened.
 */
import { field } from '../platform/values.ts';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface OriginPanel {
  getBoundingClientRect(): Box;
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

export interface OriginOpener {
  getBoundingClientRect(): Box;
  readonly isConnected?: boolean;
}

/*
 * An origin far outside the panel swings it in from off-screen, which reads
 * as a lurch rather than as growth: it is held within 35% of either edge.
 */
const REACH = 0.35;

/* The origin, as a percentage of the panel's box on each axis, or null when there is none to give. */
export function originOf(panel: Box, opener: Box): readonly [number, number] | null {
  if (!opener.width && !opener.height) return null;
  if (!panel.width || !panel.height) return null;
  const clamp = (value: number, span: number): number => Math.max(-REACH, Math.min(1 + REACH, value / span));
  return [
    clamp(opener.left + opener.width / 2 - panel.left, panel.width),
    clamp(opener.top + opener.height / 2 - panel.top, panel.height)
  ];
}

/* Grow `panel` from `opener`: the origin written, or the last one cleared when there is none. */
export function anchorOverlayOrigin(panel: OriginPanel | null | undefined, opener: unknown): void {
  if (!panel) return;
  panel.style.removeProperty('--nv-origin');
  if (!isOpener(opener) || !opener.isConnected) return;
  const origin = originOf(panel.getBoundingClientRect(), opener.getBoundingClientRect());
  if (!origin) return;
  panel.style.setProperty('--nv-origin', `${(origin[0] * 100).toFixed(1)}% ${(origin[1] * 100).toFixed(1)}%`);
}

function isOpener(value: unknown): value is OriginOpener {
  return typeof field(value, 'getBoundingClientRect') === 'function';
}
