/*
 * What the reader's hand is on, on the Neural map: the node under a point on
 * the stage, the part of a panel a press landed on, the cursor that says what
 * a press there would do, and where an arrow key goes from the node chosen
 * now. Points are in the stage's pixels; the camera turns them into the
 * world's.
 */
import type { NodeType } from './graph-model.ts';
import { FOOTER, HEAD_H, ROW_H, worldRadius, type Panel } from './graph-layout.ts';
import { screenToWorld, type Camera, type MapNode } from './graph-scene.ts';

/* A press is not yet a click: past this many pixels it becomes a drag or a pan. */
export const DRAG_THRESHOLD = 5;

/* The graph a point is looked up in: its nodes and panels, through the camera. */
export interface Ground extends Camera {
  readonly nodes: readonly MapNode[];
  readonly panels?: readonly Panel[] | null | undefined;
}

/*
 * The node under a point. A node is hit on its disc, with a little to spare
 * round it, or anywhere on its row, so its name is as good a target as its
 * icon; of two discs under the point, the nearer centre wins.
 */
export function hitNode(ground: Ground, sx: number, sy: number): MapNode | null {
  const w = screenToWorld(ground, sx, sy);
  let best: MapNode | null = null, bestD = Infinity;
  for (const n of ground.nodes) {
    if (!n.visible || n.folded) continue;
    const r = worldRadius(n) + (n.type === 'repo' ? 10 : 7);
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    if (d < r && d < bestD) { best = n; bestD = d; }
  }
  if (best) return best;
  for (const panel of ground.panels || []) {
    if (w.x < panel.x + 6 || w.x > panel.x + panel.w - 6) continue;
    const row = Math.floor((w.y - panel.y - HEAD_H) / ROW_H);
    if (row >= 0 && row < panel.shown.length) return panel.shown[row] ?? null;
  }
  return null;
}

/*
 * The parts of a panel away from its rows: the header, which lights and
 * frames the group and is the handle a panel is dragged by; the footer's
 * "+ n more", which opens a folded group; an opened group's "Show less" and
 * its pager's two chevrons; and the rest of the card, which is ground.
 */
export type PanelPart = 'header' | 'more' | 'less' | 'prev' | 'next' | 'body';
export interface PanelHit { readonly kind: PanelPart; readonly type: NodeType }

export function panelHitAt(ground: Ground, sx: number, sy: number): PanelHit | null {
  const w = screenToWorld(ground, sx, sy);
  for (const panel of ground.panels || []) {
    if (w.x < panel.x || w.x > panel.x + panel.w || w.y < panel.y || w.y > panel.y + panel.h) continue;
    if (w.y < panel.y + HEAD_H) return { kind: 'header', type: panel.type };
    if (panel.moreY != null && Math.abs(w.y - panel.moreY) <= ROW_H / 2) {
      if (panel.footer === 'more') return { kind: 'more', type: panel.type };
      if (w.x - panel.x < FOOTER.lessEnd) return { kind: 'less', type: panel.type };
      const right = panel.x + panel.w;
      if (panel.pages > 1 && Math.abs(w.x - (right + FOOTER.prevX)) <= FOOTER.hit) return { kind: 'prev', type: panel.type };
      if (panel.pages > 1 && Math.abs(w.x - (right + FOOTER.nextX)) <= FOOTER.hit) return { kind: 'next', type: panel.type };
    }
    return { kind: 'body', type: panel.type };
  }
  return null;
}

/* What the cursor says over a point: a node or a control is pressed, a header is moved, the ground is grabbed. */
export function cursorFor(node: MapNode | null, part: PanelHit | null): 'pointer' | 'move' | 'grab' {
  if (node || (part && part.kind !== 'body' && part.kind !== 'header')) return 'pointer';
  return part && part.kind === 'header' ? 'move' : 'grab';
}

/* The arrow keys, as a step on the stage. */
const WALK: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  ArrowRight: Object.freeze([1, 0] as const),
  ArrowLeft: Object.freeze([-1, 0] as const),
  ArrowDown: Object.freeze([0, 1] as const),
  ArrowUp: Object.freeze([0, -1] as const)
});

/* The step a key takes, or null for a key that is not an arrow. */
export function walkStep(key: string): readonly [number, number] | null {
  return Object.prototype.hasOwnProperty.call(WALK, key) ? WALK[key] ?? null : null;
}

/*
 * The node an arrow key moves to: the nearest in that direction, counting
 * distance off the line of travel more than distance along it, so the walk
 * keeps to a row or a column rather than cutting across. Measured between
 * where the nodes are going, not where an easing frame has them; a node the
 * layout has not placed yet is going nowhere, and is not walked to or from.
 */
export function walk(nodes: readonly MapNode[], from: MapNode, dx: number, dy: number): MapNode | null {
  const fx = from.tx, fy = from.ty;
  if (fx == null || fy == null) return null;
  let best: MapNode | null = null, bestScore = Infinity;
  for (const n of nodes) {
    if (!n.visible || n.folded || n === from || n.tx == null || n.ty == null) continue;
    const vx = n.tx - fx, vy = n.ty - fy;
    const along = vx * dx + vy * dy;
    if (along <= 1) continue;
    const across = Math.abs(vx * dy - vy * dx);
    const score = along + across * 2.2;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}
