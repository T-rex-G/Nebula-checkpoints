/*
 * How the Neural map is drawn.
 *
 * Drawing is two canvases. The graph canvas holds everything that only
 * changes when the reader does something -- the panels, the strands, the
 * nodes, the hub (drawStatic). The effects canvas above it holds what really
 * animates: the signals on the strands, the breathing ring of a critical node,
 * the hub's turning arcs and the relationship dashes (drawAnimated). The map
 * decides when each is drawn; this draws what it is handed.
 */
import { TYPE_STYLE } from './graph-model.ts';
import { HEAD_H, HUB_R, NODE_R, PAGE_ROWS, ROW_H, layoutBounds, type Panel } from './graph-layout.ts';
import { drawIcon, drawNodeMark } from './graph-marks.ts';
import { hexAlpha, type Palette } from './graph-paint.ts';
import {
  clamp, hashCode, inView, screenSpace, screenToWorld, worldSpace, worldToScreen,
  type Box, type Focus, type MapNode, type Scene
} from './graph-scene.ts';
import { drawFibers, drawRelations, drawSignals } from './graph-strands.ts';

/* A dot grid fixed to the graph rather than the screen, so panning and
 * zooming read as moving over a surface. It thins out as it shrinks. The
 * ground under it is the stage's CSS background. */
export function drawBackdrop(ctx: CanvasRenderingContext2D, scene: Scene, colors: Palette): void {
  const W = scene.width, H = scene.height;
  const spacing = 28 * scene.zoom;
  if (spacing < 9) return;
  const origin = worldToScreen(scene, 0, 0);
  const startX = ((origin.x % spacing) + spacing) % spacing;
  const startY = ((origin.y % spacing) + spacing) % spacing;
  const dot = clamp(1.1 * scene.zoom, .7, 1.6);
  ctx.fillStyle = colors.grid;
  for (let x = startX; x < W; x += spacing) {
    for (let y = startY; y < H; y += spacing) ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
  }
}

/* Concentric dotted rings around the hub: the centre of the picture announces
 * itself. Two arcs turn on the inner ring in the animated layer. */
export function drawRings(ctx: CanvasRenderingContext2D, colors: Palette, hub: MapNode | undefined): void {
  if (!hub) return;
  ctx.save();
  ctx.strokeStyle = colors.ring;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 7]);
  for (const r of [HUB_R * 1.7, HUB_R * 2.6, HUB_R * 3.7]) {
    ctx.beginPath(); ctx.arc(hub.x, hub.y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* Text that fits a width, ellipsised once per label and width rather than
 * measured down character by character every frame. */
const FIT_CACHE = new Map<string, string>();
export function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  const key = `${ctx.font}|${width}|${text}`;
  const kept = FIT_CACHE.get(key);
  if (kept !== undefined) return kept;
  let out = String(text);
  if (ctx.measureText(out).width > width) {
    while (out.length > 1 && ctx.measureText(`${out}…`).width > width) out = out.slice(0, -1);
    out = `${out.trimEnd()}…`;
  }
  if (FIT_CACHE.size > 800) FIT_CACHE.clear();
  FIT_CACHE.set(key, out);
  return out;
}

/* Labels are measured in the fallback font until the web fonts arrive; then measured again. */
export function forgetFittedText(): void {
  FIT_CACHE.clear();
}

const ROW_FONT = "500 13px 'Public Sans Variable', system-ui, sans-serif";
const ROW_FONT_BOLD = "700 13px 'Public Sans Variable', system-ui, sans-serif";
/* Where a panel footer's controls sit, in world units from the panel's right edge. */
export const FOOTER = Object.freeze({ lessEnd: 118, prevX: -140, nextX: -26, rangeX: -83, hit: 15 });

const letterSpacing = (ctx: CanvasRenderingContext2D, value: string): void => {
  if ('letterSpacing' in ctx) ctx.letterSpacing = value;
};

/*
 * A group's panel: a glass card with its icon, name and count in the header,
 * a row per member, and "+ n more" where the group folds. The member's node
 * sits on the edge facing the hub and its name on the other side, so the
 * strands arriving from the hub never cross a word.
 */
export function drawPanels(ctx: CanvasRenderingContext2D, scene: Scene, colors: Palette, focus: Focus | null, view: Box): void {
  const selectedType = scene.selected && scene.selected.type;
  for (const panel of scene.panels || []) {
    if (!inView(view, panel.x - 24, panel.y - 24, panel.x + panel.w + 24, panel.y + panel.h + 24)) continue;
    const st = TYPE_STYLE[panel.type];
    const ink = colors.ink(st.color);
    const lit = scene.focusGroup === panel.type || selectedType === panel.type;
    const dim = !!focus && !lit && !panel.members.some(n => focus.nodes.has(n.id));
    ctx.save();
    ctx.globalAlpha = dim ? .4 : 1;
    roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18);
    ctx.fillStyle = colors.panel; ctx.fill();
    const wash = ctx.createLinearGradient(panel.x, panel.y, panel.x + panel.w * .7, panel.y + panel.h);
    wash.addColorStop(0, hexAlpha(st.color, colors.light ? .11 : .15));
    wash.addColorStop(1, hexAlpha(st.color, 0));
    ctx.fillStyle = wash; ctx.fill();
    if (lit && colors.glow) { ctx.shadowColor = hexAlpha(st.color, .55); ctx.shadowBlur = 22; }
    ctx.lineWidth = lit ? 1.6 : 1;
    ctx.strokeStyle = hexAlpha(st.color, lit ? .8 : colors.panelEdge);
    ctx.stroke();
    ctx.shadowBlur = 0;
    /* Where the light catches the glass: a bright hairline along the top
     * edge, fading out toward the corners. */
    const edge = ctx.createLinearGradient(panel.x, 0, panel.x + panel.w, 0);
    const shine = colors.glow ? .2 : .95;
    edge.addColorStop(0, `rgba(255,255,255,0)`);
    edge.addColorStop(.5, `rgba(255,255,255,${shine})`);
    edge.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.beginPath(); ctx.moveTo(panel.x + 18, panel.y + 1); ctx.lineTo(panel.x + panel.w - 18, panel.y + 1);
    ctx.lineWidth = 1; ctx.strokeStyle = edge; ctx.stroke();
    /* Header: the group's mark and name, and its count in a pill -- "60/312"
     * where the repository has more than the graph holds. */
    const hx = panel.x + 30, hy = panel.y + HEAD_H / 2 + 2;
    ctx.beginPath(); ctx.arc(hx, hy, 17, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(st.color, colors.light ? .12 : .18); ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = hexAlpha(st.color, .7); ctx.stroke();
    if (!drawIcon(ctx, panel.type, hx, hy, 18, ink) && st.glyph) {
      ctx.fillStyle = ink; ctx.font = "700 13px 'Public Sans Variable', system-ui, sans-serif";
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, hx, hy);
    }
    ctx.textBaseline = 'middle';
    ctx.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
    const count = panel.total > panel.members.length ? `${panel.members.length}/${panel.total}` : String(panel.members.length);
    const pillW = ctx.measureText(count).width + 16;
    const pillX = panel.x + panel.w - 16 - pillW;
    roundRect(ctx, pillX, hy - 11, pillW, 22, 11);
    ctx.fillStyle = hexAlpha(st.color, colors.light ? .12 : .16); ctx.fill();
    ctx.fillStyle = colors.light ? ink : colors.text;
    ctx.textAlign = 'center';
    ctx.fillText(count, pillX + pillW / 2, hy + .5);
    ctx.font = "700 12px 'JetBrains Mono Variable', ui-monospace, monospace";
    letterSpacing(ctx, '1.6px');
    ctx.textAlign = 'left';
    ctx.fillStyle = ink;
    ctx.fillText(fitText(ctx, (st.plural || st.label).toUpperCase(), pillX - panel.x - 66), panel.x + 58, hy);
    letterSpacing(ctx, '0px');
    /* Rows. */
    const labelWidth = panel.w - 78;
    ctx.font = ROW_FONT;
    panel.shown.forEach((n: MapNode, i) => {
      const rowY = panel.y + HEAD_H + i * ROW_H;
      if (!inView(view, panel.x, rowY, panel.x + panel.w, rowY + ROW_H)) return;
      const selected = !!scene.selected && scene.selected.id === n.id;
      const hover = !!scene.hover && scene.hover.id === n.id;
      if (selected || hover) {
        roundRect(ctx, panel.x + 8, rowY + 3, panel.w - 16, ROW_H - 6, 12);
        ctx.fillStyle = selected ? hexAlpha(st.color, colors.light ? .14 : .2) : colors.row; ctx.fill();
      }
      const rowDim = !!focus && !focus.nodes.has(n.id) && !dim;
      ctx.globalAlpha = (dim ? .4 : 1) * (rowDim ? .45 : 1) * Math.min(1, (n.appear ?? 1) * 1.4);
      ctx.fillStyle = colors.text;
      const font = selected ? ROW_FONT_BOLD : ROW_FONT;
      if (ctx.font !== font) ctx.font = font;
      const text = fitText(ctx, n.label, labelWidth);
      if (panel.side === 'left') { ctx.textAlign = 'right'; ctx.fillText(text, panel.x + panel.w - 58, rowY + ROW_H / 2); }
      else { ctx.textAlign = 'left'; ctx.fillText(text, panel.x + 58, rowY + ROW_H / 2); }
      ctx.globalAlpha = dim ? .4 : 1;
    });
    if (panel.moreY != null) drawPanelFooter(ctx, panel, colors, ink);
    ctx.restore();
  }
}

function drawPanelFooter(ctx: CanvasRenderingContext2D, panel: Panel, colors: Palette, ink: string): void {
  const y = panel.moreY ?? 0;
  ctx.beginPath();
  ctx.moveTo(panel.x + 16, y - ROW_H / 2); ctx.lineTo(panel.x + panel.w - 16, y - ROW_H / 2);
  ctx.lineWidth = 1; ctx.strokeStyle = hexAlpha(panel.members[0] ? panel.members[0].color : '#818cf8', .18); ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.font = "600 12px 'Public Sans Variable', system-ui, sans-serif";
  ctx.fillStyle = ink;
  if (panel.footer === 'more') {
    ctx.textAlign = 'left';
    ctx.fillText(`+ ${panel.hiddenCount} more`, panel.x + 20, y);
    chevron(ctx, panel.x + panel.w - 26, y, 'down', ink, 1);
    return;
  }
  ctx.textAlign = 'left';
  ctx.fillText('Show fewer', panel.x + 20, y);
  if (panel.pages <= 1) return;
  const first = panel.page * PAGE_ROWS + 1;
  const last = Math.min(panel.members.length, first + PAGE_ROWS - 1);
  ctx.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'center';
  ctx.fillText(`${first}–${last} of ${panel.members.length}`, panel.x + panel.w + FOOTER.rangeX, y + .5);
  chevron(ctx, panel.x + panel.w + FOOTER.prevX, y, 'left', ink, panel.page > 0 ? 1 : .3);
  chevron(ctx, panel.x + panel.w + FOOTER.nextX, y, 'right', ink, panel.page < panel.pages - 1 ? 1 : .3);
}

function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, direction: 'down' | 'left' | 'right', color: string, alpha: number): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.fillStyle = hexAlpha(color, .12); ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = hexAlpha(color, .45); ctx.stroke();
  ctx.beginPath();
  const d = 3.6;
  if (direction === 'down') { ctx.moveTo(x - d, y - d / 2); ctx.lineTo(x, y + d / 2); ctx.lineTo(x + d, y - d / 2); }
  else if (direction === 'left') { ctx.moveTo(x + d / 2, y - d); ctx.lineTo(x - d / 2, y); ctx.lineTo(x + d / 2, y + d); }
  else { ctx.moveTo(x - d / 2, y - d); ctx.lineTo(x + d / 2, y); ctx.lineTo(x - d / 2, y + d); }
  ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.stroke();
  ctx.restore();
}

export function drawNode(ctx: CanvasRenderingContext2D, scene: Scene, node: MapNode, dim: boolean, colors: Palette): void {
  const selected = (!!scene.selected && scene.selected.id === node.id) || scene.highlightNodes.has(node.id);
  const hover = !!scene.hover && scene.hover.id === node.id;
  const appear = node.appear ?? 1;
  let radius = NODE_R * (.55 + .45 * appear);
  if (hover || selected) radius *= 1.12;
  const severity = node.severity === 'critical' ? '#F43F6E' : node.severity === 'warning' ? '#F59E0B' : null;
  const ink = colors.ink(node.color);
  const x = node.x, y = node.y;
  ctx.save();
  ctx.globalAlpha = appear * (dim ? .35 : 1);
  if (colors.glow) { ctx.shadowColor = hexAlpha(severity || node.color, selected ? .9 : .55); ctx.shadowBlur = selected ? 22 : hover ? 16 : 9; }
  ctx.fillStyle = colors.surface;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  const tint = ctx.createRadialGradient(x - radius * .35, y - radius * .4, radius * .1, x, y, radius);
  tint.addColorStop(0, hexAlpha(node.color, colors.light ? .2 : .34));
  tint.addColorStop(1, hexAlpha(node.color, colors.light ? .08 : .1));
  ctx.fillStyle = tint; ctx.fill();
  ctx.lineWidth = selected ? 2.4 : 1.6;
  ctx.strokeStyle = severity || ink;
  ctx.stroke();
  if (selected) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = colors.light ? hexAlpha('#312e81', .5) : 'rgba(255,255,255,.75)';
    ctx.beginPath(); ctx.arc(x, y, radius + 5, 0, Math.PI * 2); ctx.stroke();
  }
  if (drawIcon(ctx, node.type, x, y, radius * 1.08, ink)) { /* drawn */ }
  else if (node.mark) { ctx.fillStyle = ink; drawNodeMark(ctx, node.mark, x, y, radius * 1.02); }
  else if (node.glyph) {
    ctx.fillStyle = ink;
    ctx.font = `600 ${Math.round(radius * .85)}px 'Public Sans Variable', system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(node.glyph, x, y + .3);
  }
  /* Severity is a badge on the rim as well as a colour, so it survives colour
   * blindness and a glance. */
  if (severity) {
    const bx = x + radius * .72, by = y - radius * .72, br = Math.max(3.8, radius * .28);
    ctx.fillStyle = colors.surface; ctx.beginPath(); ctx.arc(bx, by, br + 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = severity; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    if (node.severity === 'critical') { ctx.fillRect(bx - .8, by - br * .55, 1.6, br * .7); ctx.fillRect(bx - .8, by + br * .3, 1.6, 1.6); }
  }
  ctx.restore();
}

/* The brand mark, in the hub. The same four triangles as the #nvMark symbol,
 * so the centre of the graph is the product's own mark. */
const HUB_MARK: readonly { readonly d: string; readonly tone: 'deep' | 'light' }[] = [
  { d: 'M79 25 L40 217 L106 116 Z', tone: 'deep' },
  { d: 'M79 25 L106 116 L171 112 Z', tone: 'light' },
  { d: 'M244 23 L178 124 L205 215 Z', tone: 'deep' },
  { d: 'M178 124 L113 128 L205 215 Z', tone: 'light' }
];
let hubMarkPaths: { readonly path: Path2D; readonly tone: 'deep' | 'light' }[] | null = null;

export function drawHub(ctx: CanvasRenderingContext2D, scene: Scene, node: MapNode, colors: Palette, dim: boolean): void {
  const x = node.x, y = node.y, r = HUB_R;
  const active = (!!scene.selected && scene.selected.id === node.id) || (!!scene.hover && scene.hover.id === node.id);
  ctx.save();
  ctx.globalAlpha = dim ? .55 : 1;
  /* One colour family per preset: the orb, its glow and its edge are the
   * preset's -- Nebula's violet, Obsidian's graphite and silver -- and
   * nothing else; a blue halo, a white highlight and a pale rim read as
   * layers stacked on the mark rather than as the mark. */
  const tone = colors.hub;
  const halo = ctx.createRadialGradient(x, y, r * .6, x, y, r * 2.6);
  halo.addColorStop(0, tone.halo);
  halo.addColorStop(1, hexAlpha(tone.halo, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
  /* The orb is the app icon's own ground, so the mark on it can be the icon's
   * plates rather than white on blue. */
  const orb = ctx.createRadialGradient(x + r * .34, y - r * .5, r * .08, x, y, r * 1.05);
  orb.addColorStop(0, tone.orb[0]); orb.addColorStop(.5, tone.orb[1]); orb.addColorStop(1, tone.orb[2]);
  if (colors.glow) { ctx.shadowColor = tone.glow; ctx.shadowBlur = active ? 40 : 26; }
  ctx.fillStyle = orb; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = active ? 2.2 : 1.4; ctx.strokeStyle = active ? tone.rimOn : tone.rim; ctx.stroke();
  if (typeof Path2D === 'function') {
    if (!hubMarkPaths) hubMarkPaths = HUB_MARK.map(item => ({ path: new Path2D(item.d), tone: item.tone }));
    const size = r * 1.18, scale = size / 228;
    ctx.save();
    ctx.translate(x - 142 * scale, y - 120 * scale);
    ctx.scale(scale, scale);
    const light = ctx.createLinearGradient(40, 23, 244, 217);
    light.addColorStop(0, tone.light[0]); light.addColorStop(1, tone.light[1]);
    const deep = ctx.createLinearGradient(244, 23, 40, 217);
    deep.addColorStop(0, tone.deep[0]); deep.addColorStop(1, tone.deep[1]);
    for (const item of hubMarkPaths) {
      ctx.fillStyle = item.tone === 'light' ? light : deep;
      ctx.fill(item.path);
    }
    ctx.restore();
  }
  /* The repository's name, under the hub -- or above it where the spine of
   * the stacked layout runs down from its bottom. */
  ctx.font = "700 14px 'Public Sans Variable', system-ui, sans-serif";
  const name = fitText(ctx, node.label, 240);
  const w = ctx.measureText(name).width + 22;
  const ly = scene.layoutMode === 'stack' ? y - r - 30 : y + r + 30;
  roundRect(ctx, x - w / 2, ly - 14, w, 28, 10);
  ctx.fillStyle = colors.light ? 'rgba(255,255,255,.94)' : 'rgba(10,12,30,.9)'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = tone.label; ctx.stroke();
  ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, x, ly + .5);
  ctx.restore();
}

/* What only changes when the reader does something. Without the field's own
 * canvas underneath, the graph keeps its plain dot grid. */
export function drawStatic(ctx: CanvasRenderingContext2D, scene: Scene, colors: Palette, focus: Focus | null, hub: MapNode | undefined, view: Box, backdrop: boolean): void {
  screenSpace(ctx, scene);
  if (backdrop) drawBackdrop(ctx, scene, colors);
  worldSpace(ctx, scene);
  drawRings(ctx, colors, hub);
  drawPanels(ctx, scene, colors, focus, view);
  if (hub) drawFibers(ctx, scene, colors, focus, hub, view);
  for (const n of scene.nodes) {
    if (!n.visible || n.folded || n.type === 'repo') continue;
    if (!inView(view, n.x - 30, n.y - 30, n.x + 30, n.y + 30)) continue;
    drawNode(ctx, scene, n, !!focus && !focus.nodes.has(n.id), colors);
  }
  if (hub) drawHub(ctx, scene, hub, colors, !!focus && !focus.nodes.has(hub.id));
}

/* What moves: the relationship dashes, the signals, a critical node's
 * breathing ring and the hub's turning arcs. */
export function drawAnimated(ctx: CanvasRenderingContext2D, scene: Scene, now: number, colors: Palette, focus: Focus | null, hub: MapNode | undefined, view: Box, animated: boolean): void {
  drawRelations(ctx, scene, now, colors, focus, animated);
  if (!animated) return;
  if (hub) drawSignals(ctx, scene, now, colors, focus, hub);
  for (const n of scene.nodes) {
    if (!n.visible || n.folded || n.severity !== 'critical' || n.type === 'repo') continue;
    if (focus && !focus.nodes.has(n.id)) continue;
    if (!inView(view, n.x - 40, n.y - 40, n.x + 40, n.y + 40)) continue;
    /* A critical node breathes: one ring, expanding and fading, in red. */
    const phase = ((now * .0011) + (hashCode(n.id) % 100) / 100) % 1;
    ctx.strokeStyle = hexAlpha('#F43F6E', .55 * (1 - phase) * (n.appear ?? 1));
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R * (1.2 + phase * .9), 0, Math.PI * 2); ctx.stroke();
  }
  if (hub) {
    const turn = now * .0006, r = HUB_R;
    ctx.save();
    ctx.globalAlpha = focus && !focus.nodes.has(hub.id) ? .55 : 1;
    ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.strokeStyle = colors.hub.arc;
    ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.18, turn, turn + 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.18, turn + Math.PI, turn + Math.PI + .8); ctx.stroke();
    const slow = now * .00012;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = hexAlpha(colors.hub.arcOuter, colors.light ? .3 : .4);
    ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.7, slow, slow + 1.1); ctx.stroke();
    ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.7, slow + Math.PI, slow + Math.PI + .6); ctx.stroke();
    ctx.restore();
  }
}

/* Where the minimap draws the world: how far it is scaled, and its origin. */
export interface MiniMap { readonly scale: number; readonly ox: number; readonly oy: number }

/* Whether the whole picture reaches past the stage, which is when the minimap is wanted. */
export function overflows(scene: Scene): boolean {
  const b = layoutBounds(scene.panels || []);
  const a = screenToWorld(scene, 0, 0), c = screenToWorld(scene, scene.width, scene.height);
  return b.minX < a.x - 4 || b.maxX > c.x + 4 || b.minY < a.y - 4 || b.maxY > c.y + 4;
}

/*
 * The minimap: the whole topology in miniature, with the part on screen
 * outlined, on a canvas of cw by ch CSS pixels.
 */
export function drawMinimap(g: CanvasRenderingContext2D, scene: Scene, colors: Palette, cw: number, ch: number): MiniMap {
  const W = scene.width, H = scene.height, dpr = scene.dpr;
  const b = layoutBounds(scene.panels || []);
  const a = screenToWorld(scene, 0, 0), c = screenToWorld(scene, W, H);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const pad = 10;
  const scale = Math.min((cw - pad * 2) / (b.maxX - b.minX), (ch - pad * 2) / (b.maxY - b.minY));
  const ox = (cw - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
  const oy = (ch - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
  for (const panel of scene.panels || []) {
    const st = TYPE_STYLE[panel.type];
    const lit = scene.focusGroup === panel.type || (!!scene.selected && scene.selected.type === panel.type);
    roundRect(g, ox + panel.x * scale, oy + panel.y * scale, panel.w * scale, panel.h * scale, 3);
    g.fillStyle = hexAlpha(colors.ink(st.color), lit ? .6 : .3); g.fill();
    g.lineWidth = 1; g.strokeStyle = hexAlpha(colors.ink(st.color), lit ? .95 : .6); g.stroke();
  }
  g.beginPath(); g.arc(ox, oy, Math.max(3, HUB_R * scale), 0, Math.PI * 2);
  g.fillStyle = '#818cf8'; g.fill();
  const vx = ox + a.x * scale, vy = oy + a.y * scale, vw = (c.x - a.x) * scale, vh = (c.y - a.y) * scale;
  g.fillStyle = colors.glow ? 'rgba(255,255,255,.07)' : 'rgba(49,46,129,.07)';
  g.fillRect(vx, vy, vw, vh);
  g.lineWidth = 1.5; g.strokeStyle = colors.glow ? 'rgba(255,255,255,.9)' : 'rgba(49,46,129,.8)';
  g.strokeRect(vx, vy, vw, vh);
  return { scale, ox, oy };
}
