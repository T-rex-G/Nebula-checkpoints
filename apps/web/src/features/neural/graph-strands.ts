/*
 * The strands of the Neural map: one from the hub to every member of every
 * group, the signals that run along them, and the relationships between
 * members drawn on demand.
 */
import { HUB_R, NODE_R, SPINE_X } from './graph-layout.ts';
import { hexAlpha, type Palette } from './graph-paint.ts';
import {
  clamp, curveInView, hashCode, inView,
  type Box, type Cubic, type Focus, type MapNode, type Point, type Route, type Scene, type Segment
} from './graph-scene.ts';

export interface Geometry {
  /* The branch drawn for this row. */
  readonly branch: Cubic;
  /* The segments a signal travels along -- on a tall stage, the spine's run and the branch. */
  readonly segs: Segment[];
  readonly tail?: Segment[];
  /* On a tall stage: where the strand leaves the hub's rim, and where its branch leaves the spine. */
  readonly spine?: { readonly rim: Point; readonly bendY: number };
}

/*
 * One strand from the hub to a node.
 *
 * On a wide stage it is a cubic that leaves the hub's rim level and arrives
 * level, so a column of strands fans out like fibres rather than crossing. On
 * a tall stage every group has a single trunk down from the rim, and each row
 * takes a short branch off its group's trunk: as many wires as there are
 * groups run the length of the stage, not one per row.
 */
export function fiberGeometry(scene: Scene, hub: Point, n: MapNode): Geometry {
  if (scene.layoutMode === 'stack') {
    const tx = hub.x + SPINE_X;
    const reach = Math.sqrt(Math.max(0, HUB_R * HUB_R - (tx - hub.x) ** 2));
    const below = n.y >= hub.y;
    const rim = { x: tx, y: hub.y + (below ? reach : -reach) * .98 };
    const sign = n.x >= tx ? 1 : -1;
    const end = { x: n.x - sign * NODE_R, y: n.y };
    const bendY = below ? Math.max(rim.y + 8, n.y - 26) : Math.min(rim.y - 8, n.y + 26);
    const branch = {
      start: { x: tx, y: bendY }, c1: { x: tx, y: n.y + (below ? -4 : 4) },
      c2: { x: tx + (end.x - tx) * .45, y: n.y }, end
    };
    return { branch, spine: { rim, bendY }, segs: [{ line: [rim, branch.start] }, { cubic: branch }], tail: [{ cubic: branch }] };
  }
  const panel = scene.panelByType ? scene.panelByType.get(n.type) : undefined;
  if (panel && panel.placed) {
    /* A panel the reader moved can be anywhere, even under the hub: the
     * strand leaves the rim toward it and arrives from outside the panel, on
     * the side its rows face, so it never crosses a label. */
    const approach = panel.side === 'left' ? 1 : -1;
    const end = { x: n.x + approach * NODE_R, y: n.y };
    const toward = Math.atan2(end.y - hub.y, end.x - hub.x);
    const start = { x: hub.x + Math.cos(toward) * HUB_R * .96, y: hub.y + Math.sin(toward) * HUB_R * .96 };
    const d = Math.hypot(end.x - start.x, end.y - start.y);
    const branch = {
      start, c1: { x: start.x + Math.cos(toward) * d * .35, y: start.y + Math.sin(toward) * d * .35 },
      c2: { x: end.x + approach * Math.max(50, d * .35), y: end.y }, end
    };
    return { branch, segs: [{ cubic: branch }] };
  }
  const sign = n.x >= hub.x ? 1 : -1;
  const angle = clamp(Math.atan2(n.y - hub.y, Math.abs(n.x - hub.x)) * .55, -1.05, 1.05);
  const start = { x: hub.x + sign * HUB_R * .96 * Math.cos(angle), y: hub.y + HUB_R * .96 * Math.sin(angle) };
  const end = { x: n.x - sign * NODE_R, y: n.y };
  const dx = Math.abs(end.x - start.x);
  const branch = { start, c1: { x: start.x + sign * dx * .5, y: start.y }, c2: { x: end.x - sign * dx * .5, y: end.y }, end };
  return { branch, segs: [{ cubic: branch }] };
}

/* The length of each segment, measured once, so a signal moves at an even
 * pace along a trunk and its branch. */
export function measurePath(segs: Segment[]): Route {
  let total = 0;
  for (const seg of segs) {
    if (seg.line) seg.len = Math.hypot(seg.line[1].x - seg.line[0].x, seg.line[1].y - seg.line[0].y);
    else if (seg.cubic) {
      const c = seg.cubic;
      const chord = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y);
      const poly = Math.hypot(c.c1.x - c.start.x, c.c1.y - c.start.y) + Math.hypot(c.c2.x - c.c1.x, c.c2.y - c.c1.y) + Math.hypot(c.end.x - c.c2.x, c.end.y - c.c2.y);
      seg.len = (chord + poly) / 2;
    }
    total += seg.len ?? 0;
  }
  return { segs, total: Math.max(1, total) };
}

export function cubicPoint(c: Cubic, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * c.start.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.end.x,
    y: u * u * u * c.start.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.end.y
  };
}

const ORIGIN: Point = { x: 0, y: 0 };
const pointOn = (seg: Segment | undefined, f: number): Point => {
  if (!seg) return ORIGIN;
  if (seg.line) return { x: seg.line[0].x + (seg.line[1].x - seg.line[0].x) * f, y: seg.line[0].y + (seg.line[1].y - seg.line[0].y) * f };
  return seg.cubic ? cubicPoint(seg.cubic, f) : ORIGIN;
};

/* A point a fraction t of the way along a route; a step past either end stays at that end. */
export function pathPoint(path: Route, t: number): Point {
  let d = t * path.total;
  const last = path.segs[path.segs.length - 1];
  for (const seg of path.segs) {
    const len = seg.len ?? 0;
    if (d <= len || seg === last) return pointOn(seg, len ? clamp(d / len, 0, 1) : 0);
    d -= len;
  }
  return pointOn(last, 1);
}

export function strokeCubic(ctx: CanvasRenderingContext2D, c: Cubic, offset = 0): void {
  ctx.beginPath();
  ctx.moveTo(c.start.x, c.start.y);
  ctx.bezierCurveTo(c.c1.x, c.c1.y + offset, c.c2.x, c.c2.y - offset, c.end.x, c.end.y);
  ctx.stroke();
}

interface Style { readonly lit: boolean; readonly dim: boolean; readonly color: string; readonly stroke: string; readonly base: number }

/* The strand wears its group's colour, so a column of strands reads as that
 * group from across the stage; only a critical node turns it red. A warning
 * stays on the node's badge. */
function fiberStyle(scene: Scene, n: MapNode, focus: Focus | null, hub: MapNode, colors: Palette): Style {
  const lit = !!focus && focus.nodes.has(n.id) && (focus.nodes.has(hub.id) || scene.focusGroup === n.type);
  const dim = !!focus && !lit;
  const color = n.severity === 'critical' ? '#F43F6E' : n.color;
  const base = (n.appear ?? 1) * (dim ? .2 : 1);
  return { lit, dim, color, stroke: colors.ink(color), base };
}

interface Reach { x: number; from: number; to: number; lit: { to: number; color: string } | null; base: number }
interface Band { x: number; from: number; to: number; color: string; dim: boolean; base: number }

/*
 * The strands. Each member of each group is joined to the hub; a selection
 * lights its own strands and dims the rest. Each strand is kept on its node
 * -- the branch, and the route a signal runs -- for the animated layer.
 */
export function drawFibers(ctx: CanvasRenderingContext2D, scene: Scene, colors: Palette, focus: Focus | null, hub: MapNode, view: Box): void {
  ctx.save();
  if (colors.glow) ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  /* The strands' fine offset threads are invisible past a certain distance
   * and while the graph is moving; they are drawn only when they can be seen,
   * which is most of the cost of a frame spent dragging. */
  const fine = scene.zoom > .45 && !scene.interacting;
  const stack = scene.layoutMode === 'stack';
  /* On a tall stage: one spine each way from the rim, as far as its furthest
   * branch; a band in each group's colour where its rows branch off; and the
   * stretch to a lit node drawn lit. */
  const reaches = new Map<number, Reach>();
  const bands = new Map<string, Band>();
  for (const n of scene.nodes) {
    if (!n.visible || n.folded || n.type === 'repo') continue;
    const geo = fiberGeometry(scene, hub, n);
    n.curve = geo.branch;
    n.path = measurePath(geo.segs);
    n.tail = geo.tail ? measurePath(geo.tail) : null;
    n.onView = geo.segs.some(seg => (seg.line
      ? inView(view, Math.min(seg.line[0].x, seg.line[1].x) - 14, Math.min(seg.line[0].y, seg.line[1].y), Math.max(seg.line[0].x, seg.line[1].x) + 14, Math.max(seg.line[0].y, seg.line[1].y))
      : !!seg.cubic && curveInView(view, seg.cubic)));
    const style = fiberStyle(scene, n, focus, hub, colors);
    if (stack && geo.spine) {
      const { rim, bendY } = geo.spine;
      const way = bendY < rim.y ? -1 : 1;
      const reach = reaches.get(way) || { x: rim.x, from: rim.y, to: rim.y, lit: null, base: 0 };
      if (Math.abs(bendY - reach.from) > Math.abs(reach.to - reach.from)) reach.to = bendY;
      if (style.lit && (!reach.lit || Math.abs(bendY - reach.from) > Math.abs(reach.lit.to - reach.from))) reach.lit = { to: bendY, color: style.color };
      reach.base = Math.max(reach.base, n.appear ?? 1);
      reaches.set(way, reach);
      const key = `${n.type}:${way}`;
      const band = bands.get(key) || { x: rim.x, from: bendY, to: bendY, color: n.color, dim: true, base: 0 };
      band.from = Math.min(band.from, bendY); band.to = Math.max(band.to, bendY);
      band.dim = band.dim && style.dim;
      band.base = Math.max(band.base, n.appear ?? 1);
      bands.set(key, band);
    }
    if (!curveInView(view, geo.branch)) continue;
    const { lit, color, stroke, base } = style;
    if (colors.glow) {
      ctx.globalAlpha = base * (lit ? .24 : .1);
      ctx.strokeStyle = color; ctx.lineWidth = lit ? 8 : 5.5;
      strokeCubic(ctx, geo.branch);
    }
    ctx.globalAlpha = base * (lit ? 1 : colors.glow ? .62 : .5);
    ctx.strokeStyle = stroke; ctx.lineWidth = lit ? 2 : 1.3;
    strokeCubic(ctx, geo.branch);
    if (!fine || stack) continue;
    const seed = (hashCode(n.id) % 1000) / 1000;
    ctx.globalAlpha = base * (lit ? .6 : .3);
    ctx.lineWidth = .8;
    strokeCubic(ctx, geo.branch, (seed - .5) * 26);
    ctx.globalAlpha = base * (lit ? .45 : .2);
    strokeCubic(ctx, geo.branch, (.5 - seed) * 18 + 6);
  }
  const run = (x: number, from: number, to: number, color: string, alpha: number, width: number, glow: number): void => {
    if (!inView(view, x - 14, Math.min(from, to), x + 14, Math.max(from, to))) return;
    ctx.beginPath(); ctx.moveTo(x, from); ctx.lineTo(x, to);
    if (colors.glow && glow) {
      ctx.globalAlpha = alpha * glow;
      ctx.strokeStyle = color; ctx.lineWidth = width * 3.6;
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colors.ink(color); ctx.lineWidth = width;
    ctx.stroke();
  };
  const spineColor = colors.spine;
  for (const reach of reaches.values()) {
    run(reach.x, reach.from, reach.to, spineColor, reach.base * (focus ? .45 : colors.glow ? .78 : .6), 2.4, .16);
  }
  for (const band of bands.values()) {
    /* A group's band covers the stretch its rows branch from, and a little
     * either side so a single row's is still seen. */
    run(band.x, band.from - 9, band.to + 9, band.color, band.base * (band.dim && focus ? .2 : colors.glow ? .9 : .75), 3, .22);
  }
  for (const reach of reaches.values()) {
    if (reach.lit) run(reach.x, reach.from, reach.lit.to, reach.lit.color, reach.base, 2.6, .3);
  }
  ctx.restore();
}

/* A glowing dot, drawn once per colour and stamped from then on: a radial
 * gradient per signal per frame was most of the frame's cost. */
type Sprite = OffscreenCanvas | HTMLCanvasElement;
const SPRITES = new Map<string, Sprite>();
function spriteCanvas(size: number): { readonly sprite: Sprite; readonly g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null } {
  if (typeof OffscreenCanvas === 'function') {
    const sprite = new OffscreenCanvas(size, size);
    sprite.width = size; sprite.height = size;
    return { sprite, g: sprite.getContext('2d') };
  }
  const sprite = document.createElement('canvas');
  sprite.width = size; sprite.height = size;
  return { sprite, g: sprite.getContext('2d') };
}
function signalSprite(color: string): Sprite {
  const kept = SPRITES.get(color);
  if (kept) return kept;
  const size = 64;
  const { sprite, g } = spriteCanvas(size);
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(.35, color); grad.addColorStop(1, hexAlpha(color, 0));
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
  }
  SPRITES.set(color, sprite);
  return sprite;
}

export function drawSignals(ctx: CanvasRenderingContext2D, scene: Scene, now: number, colors: Palette, focus: Focus | null, hub: MapNode): void {
  ctx.save();
  if (colors.glow) ctx.globalCompositeOperation = 'lighter';
  for (const n of scene.nodes) {
    if (!n.visible || n.folded || n.type === 'repo' || !n.path || n.onView === false) continue;
    const { lit, dim, color, base } = fiberStyle(scene, n, focus, hub, colors);
    if (dim) continue;
    const seed = (hashCode(n.id) % 1000) / 1000;
    /* On the spine, only what matters travels all the way to the hub -- a
     * critical node's signal, or the lit node's; the rest pulse along their
     * own branch at the same pace, so the spine stays readable however many
     * rows hang from it. */
    const full = !n.tail || lit || n.severity === 'critical';
    const path = full || !n.tail ? n.path : n.tail;
    const speed = (n.severity === 'critical' ? .00042 : .00017) * Math.min(4, n.path.total / path.total);
    const r = lit ? 7 : 5;
    const sprite = signalSprite(color);
    for (const phase of lit ? [0, .5] : [0]) {
      const t = 1 - ((seed + phase + now * speed) % 1);
      /* Signals fade in and out at the ends rather than popping over the hub
       * and the node they run between. */
      const edge = Math.min(1, t / .08, (1 - t) / .08);
      const p = pathPoint(path, t);
      ctx.globalAlpha = base * (lit ? 1 : .85) * edge;
      ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
    }
  }
  ctx.restore();
}

/*
 * The relationships between members -- a branch to the workflow it ran, a
 * package to its advisory, one commit to the next -- drawn only for what is
 * in focus. Drawn always, they were the tangle that made the old graph hard
 * to read; drawn on demand, they answer "what is this connected to".
 */
export function drawRelations(ctx: CanvasRenderingContext2D, scene: Scene, now: number, colors: Palette, focus: Focus | null, animated: boolean): void {
  if (!focus) return;
  const byId = new Map(scene.nodes.map(n => [n.id, n]));
  ctx.save();
  ctx.lineCap = 'round';
  for (const e of scene.edges) {
    if (!e.visible || !focus.edges.has(e.id)) continue;
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b || a.type === 'repo' || b.type === 'repo' || a.folded || b.folded) continue;
    const bend = Math.max(60, Math.abs(b.x - a.x) * .45);
    /* Each end leaves its disc on the side facing the hub -- the side the
     * strands arrive on -- so the dashes never cross an icon. */
    const sa = scene.layoutMode === 'stack' || a.x >= 0 ? 1 : -1, sb = scene.layoutMode === 'stack' || b.x >= 0 ? 1 : -1;
    const curve = {
      start: { x: a.x - sa * (NODE_R + 2), y: a.y }, end: { x: b.x - sb * (NODE_R + 2), y: b.y },
      c1: { x: a.x - sa * bend, y: a.y }, c2: { x: b.x - sb * bend, y: b.y }
    };
    const color = e.severity === 'critical' ? '#F43F6E' : e.severity === 'warning' ? '#F59E0B' : '#a78bfa';
    ctx.globalAlpha = .9;
    ctx.strokeStyle = colors.ink(color); ctx.lineWidth = 1.6;
    if (animated) { ctx.setLineDash([6, 7]); ctx.lineDashOffset = -now * .03; }
    strokeCubic(ctx, curve);
    ctx.setLineDash([]);
  }
  ctx.restore();
}
