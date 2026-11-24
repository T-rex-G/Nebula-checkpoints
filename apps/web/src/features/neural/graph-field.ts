/*
 * The ground under the Neural map is a field, not a pattern.
 *
 * Its dots belong to the graph's world, so panning moves over them. They bend
 * away from the panels standing on the ground, and flow round a panel while
 * it is dragged; they sink toward the repository at the centre, the one mass
 * in the picture. Under the pointer they brighten, swell and join into a fine
 * orthogonal mesh, easing out of the hand's way; a press sends a ripple
 * through them, and so does choosing a node from the keyboard.
 *
 * It is a canvas of its own under the graph, redrawn only when the camera or
 * the layout changes, or while its light or a ripple is moving: a still graph
 * under a still pointer costs nothing. With motion off the bends and the well
 * stay, and the light and the ripples do not.
 */
import type { Palette } from './graph-paint.ts';
import { HUB_R } from './graph-layout.ts';
import { clamp, screenToWorld, worldToScreen, type Point, type Scene } from './graph-scene.ts';

export const FIELD = Object.freeze({
  gap: 28, focus: 210, push: 3.4, bend: 9, bendReach: 60, well: 13, wellReach: 240,
  rippleSpeed: .52, rippleWidth: 36, ripplePush: 6.5, rippleLife: 1500, maxRipples: 4
});

export interface Ripple { readonly wx: number; readonly wy: number; readonly at: number }

/* The field's own clock and light, kept by the map between frames. */
export interface FieldState {
  /* Where the pointer is over the stage, or null when it is not. */
  pointer: Point | null;
  px: number;
  py: number;
  light: number;
  ripples: Ripple[];
  /* What the last settled frame was drawn for; empty while anything moves. */
  sig: string;
  at?: number;
  draws?: number;
}

/* A ripple from a point on the screen, kept where it began in the world. */
export function addRipple(field: FieldState, scene: Scene, sx: number, sy: number, at: number): void {
  const w = screenToWorld(scene, sx, sy);
  field.ripples.push({ wx: w.x, wy: w.y, at });
  if (field.ripples.length > FIELD.maxRipples) field.ripples.shift();
}

interface Buffers { size: number; x: Float32Array; y: Float32Array; lit: Float32Array }
let buffers: Buffers = { size: 0, x: new Float32Array(0), y: new Float32Array(0), lit: new Float32Array(0) };
function arrays(size: number): Buffers {
  if (buffers.size < size) buffers = { size, x: new Float32Array(size), y: new Float32Array(size), lit: new Float32Array(size) };
  return buffers;
}

interface Rect { readonly l: number; readonly t: number; readonly r: number; readonly b: number }
interface Wave { readonly x: number; readonly y: number; readonly radius: number; readonly fade: number }

export function drawField(ctx: CanvasRenderingContext2D, scene: Scene, f: FieldState, colors: Palette, now: number, dt: number, motion: boolean): void {
  if (!scene.width || !scene.height) return;
  /* The light rises quickly under the hand and fades slowly after it. */
  const target = motion && f.pointer ? 1 : 0;
  if (f.pointer) { f.px = f.pointer.x; f.py = f.pointer.y; }
  /* Eased by the wall clock rather than the frame step, which the loop caps:
   * on a device drawing few frames the light still settles on time. */
  const elapsed = Math.min(500, Math.max(0, now - (f.at || now)));
  f.at = now;
  const ease = 1 - Math.exp(-(elapsed || dt) / (target ? 110 : 280));
  f.light += (target - f.light) * ease;
  if (Math.abs(target - f.light) < .004) f.light = target;
  if (!motion) f.ripples.length = 0;
  else f.ripples = f.ripples.filter(r => now - r.at < FIELD.rippleLife);
  const settled = f.light === target && !f.ripples.length;
  /* Keyed on the geometry the ground depends on -- the panels standing on it
   * and the hub -- not on the graph's general version, which also moves for
   * fonts, highlights and resizes that change nothing down here. */
  const hubNode = scene.nodes.find(n => n.type === 'repo' && n.visible);
  let geometry = hubNode ? `${Math.round(hubNode.x)},${Math.round(hubNode.y)}` : '-';
  for (const p of scene.panels || []) geometry += `|${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.w)},${Math.round(p.h)}`;
  const sig = [scene.width, scene.height, scene.dpr, scene.zoom.toFixed(4), scene.panX.toFixed(2), scene.panY.toFixed(2),
    colors.theme, geometry,
    f.light ? `${Math.round(f.px)},${Math.round(f.py)},${f.light.toFixed(3)}` : '', f.ripples.length].join('|');
  if (settled && sig === f.sig) return;
  f.sig = settled ? sig : '';
  f.draws = (f.draws || 0) + 1;

  const W = scene.width, H = scene.height, z = scene.zoom;
  ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  /* Zoomed out, the grid doubles its pitch rather than thickening into a
   * haze -- the surface is always there, never a texture. */
  let gap = FIELD.gap;
  while (gap * z < 13) gap *= 2;
  const step = gap * z;
  const origin = worldToScreen(scene, 0, 0);
  const x0 = ((origin.x % step) + step) % step - step;
  const y0 = ((origin.y % step) + step) % step - step;
  const cols = Math.ceil((W - x0) / step) + 2, rows = Math.ceil((H - y0) / step) + 2;
  const count = cols * rows;
  const buf = arrays(count);

  /* The surfaces standing on the ground, in screen space. */
  const reach = FIELD.bendReach * z, bend = FIELD.bend * z;
  const rects: Rect[] = [];
  for (const p of scene.panels || []) {
    const a = worldToScreen(scene, p.x, p.y);
    const r = { l: a.x, t: a.y, r: a.x + p.w * z, b: a.y + p.h * z };
    if (r.r + reach < 0 || r.l - reach > W || r.b + reach < 0 || r.t - reach > H) continue;
    rects.push(r);
  }
  const hub = hubNode ? worldToScreen(scene, hubNode.x, hubNode.y) : null;
  const hubR = HUB_R * z * 1.08, well = FIELD.well * z, wellReach = FIELD.wellReach * z;
  const focus = FIELD.focus, light = f.light;
  const ripples: Wave[] = f.ripples.map(r => {
    const at = worldToScreen(scene, r.wx, r.wy);
    const age = (now - r.at) / FIELD.rippleLife;
    return { x: at.x, y: at.y, radius: (now - r.at) * FIELD.rippleSpeed, fade: Math.pow(1 - age, 1.6) };
  });

  let anyLit = false;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const x = x0 + col * step, y = y0 + row * step;
      let dx = 0, dy = 0, hidden = false;
      for (const q of rects) {
        if (x < q.l - reach || x > q.r + reach || y < q.t - reach || y > q.b + reach) continue;
        const ex = x - Math.max(q.l, Math.min(x, q.r)), ey = y - Math.max(q.t, Math.min(y, q.b));
        const d = Math.hypot(ex, ey);
        if (d < 2) { hidden = true; break; }
        if (d < reach) { const s = bend * (1 - d / reach) * (1 - d / reach) / d; dx += ex * s; dy += ey * s; }
      }
      if (!hidden && hub) {
        const hx = hub.x - x, hy = hub.y - y, d = Math.hypot(hx, hy);
        if (d < hubR) hidden = true;
        else { const s = well * Math.exp(-(d * d) / (wellReach * wellReach)) / d; dx += hx * s; dy += hy * s; }
      }
      if (hidden) { buf.lit[i] = -1; continue; }
      let lit = 0;
      if (light) {
        const px = x - f.px, py = y - f.py, d = Math.hypot(px, py);
        if (d < focus) {
          const t = 1 - d / focus;
          lit = t * t * (3 - 2 * t) * light;
          if (d > .5) { const s = FIELD.push * t * t * light / d; dx += px * s; dy += py * s; }
        }
      }
      for (const r of ripples) {
        const rx = x - r.x, ry = y - r.y, d = Math.hypot(rx, ry);
        const off = (d - r.radius) / FIELD.rippleWidth;
        if (off < -3 || off > 3) continue;
        const band = Math.exp(-off * off) * r.fade;
        lit = Math.max(lit, band * .85);
        if (d > .5) { const s = FIELD.ripplePush * band / d; dx += rx * s; dy += ry * s; }
      }
      buf.x[i] = x + dx; buf.y[i] = y + dy; buf.lit[i] = lit;
      if (lit > .03) anyLit = true;
    }
  }

  /* The resting dots, in one colour, as squares: a field of a thousand costs
   * a thousand rectangles and no state changes. */
  const dot = clamp(1.1 * z, .7, 1.6);
  ctx.fillStyle = colors.grid;
  for (let i = 0; i < count; i++) {
    const lit = buf.lit[i] ?? 0;
    if (lit < 0 || lit > .03) continue;
    ctx.fillRect((buf.x[i] ?? 0) - dot / 2, (buf.y[i] ?? 0) - dot / 2, dot, dot);
  }
  if (!anyLit) return;
  /* The mesh and the lit dots, bucketed by strength so each level is one path
   * and one fill. */
  const LEVELS = 8;
  const lines: number[][] = Array.from({ length: LEVELS + 1 }, () => []);
  const dots: number[][] = Array.from({ length: LEVELS + 1 }, () => []);
  const litAt = (i: number): number => buf.lit[i] ?? 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col, lit = litAt(i);
      if (lit <= .03) continue;
      dots[Math.round(lit * LEVELS)]?.push(i);
      if (col + 1 < cols && litAt(i + 1) > .03) lines[Math.round(Math.min(lit, litAt(i + 1)) * LEVELS)]?.push(i, i + 1);
      if (row + 1 < rows && litAt(i + cols) > .03) lines[Math.round(Math.min(lit, litAt(i + cols)) * LEVELS)]?.push(i, i + cols);
    }
  }
  const at = (list: readonly number[], k: number): number => list[k] ?? 0;
  ctx.lineWidth = .8;
  for (let level = 1; level <= LEVELS; level++) {
    const list = lines[level] ?? [];
    if (!list.length) continue;
    ctx.strokeStyle = `rgba(${colors.field},${(level / LEVELS * colors.fieldLine).toFixed(3)})`;
    ctx.beginPath();
    for (let k = 0; k < list.length; k += 2) {
      ctx.moveTo(buf.x[at(list, k)] ?? 0, buf.y[at(list, k)] ?? 0);
      ctx.lineTo(buf.x[at(list, k + 1)] ?? 0, buf.y[at(list, k + 1)] ?? 0);
    }
    ctx.stroke();
  }
  for (let level = 0; level <= LEVELS; level++) {
    const list = dots[level] ?? [];
    if (!list.length) continue;
    const strength = level / LEVELS;
    ctx.fillStyle = `rgba(${colors.field},${(colors.fieldBase + (colors.fieldDot - colors.fieldBase) * strength).toFixed(3)})`;
    const radius = dot * (.55 + strength * 1.05);
    ctx.beginPath();
    for (const i of list) {
      const x = buf.x[i] ?? 0, y = buf.y[i] ?? 0;
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
