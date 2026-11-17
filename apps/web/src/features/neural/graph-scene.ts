/*
 * What the Neural map's drawing reads: the graph as the map holds it, the
 * camera on it, and what the reader has their hand on.
 *
 * The map keeps all of it and hands it to each layer that draws; nothing here
 * keeps state of its own.
 */
import type { GraphEdge, GraphNode } from './graph-model.ts';
import type { LayoutMode, Panel } from './graph-layout.ts';

export interface Point { readonly x: number; readonly y: number }
export interface Cubic { readonly start: Point; readonly c1: Point; readonly c2: Point; readonly end: Point }
export interface Segment { readonly line?: readonly [Point, Point]; readonly cubic?: Cubic; len?: number }
/* A strand measured for a signal to travel along at an even pace. */
export interface Route { readonly segs: readonly Segment[]; readonly total: number }

/* A node as the map holds it: where the layout sent it, and the strand drawn to it. */
export interface MapNode extends GraphNode {
  tx?: number;
  ty?: number;
  folded?: boolean;
  curve?: Cubic;
  path?: Route;
  tail?: Route | null;
  onView?: boolean;
}

export interface MapEdge extends GraphEdge {
  visible?: boolean;
}

export interface Camera {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface Scene extends Camera {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly panels?: readonly Panel[];
  readonly panelByType?: ReadonlyMap<string, Panel> | null;
  readonly layoutMode: LayoutMode | null;
  readonly selected: MapNode | null;
  readonly hover: MapNode | null;
  readonly focusGroup: string | null;
  /* The path a reader asked to have explained. */
  readonly highlightNodes: ReadonlySet<string>;
  readonly highlightEdges: ReadonlySet<string>;
  /* Moving, panning or dragging: the fine threads are left out. */
  readonly interacting: boolean;
}

/* What stays lit; everything else is dimmed. */
export interface Focus { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> }

export interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/* A node's own fixed number, which seeds where its signals and threads begin. */
export function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function worldToScreen(camera: Camera, x: number, y: number): Point {
  return { x: camera.width / 2 + camera.panX + x * camera.zoom, y: camera.height / 2 + camera.panY + y * camera.zoom };
}

export function screenToWorld(camera: Camera, x: number, y: number): Point {
  return { x: (x - camera.width / 2 - camera.panX) / camera.zoom, y: (y - camera.height / 2 - camera.panY) / camera.zoom };
}

/* Draw in world units: everything scales with the zoom, text included. */
export function worldSpace(ctx: CanvasRenderingContext2D, camera: Camera): void {
  const z = camera.zoom, d = camera.dpr;
  ctx.setTransform(d * z, 0, 0, d * z, d * (camera.width / 2 + camera.panX), d * (camera.height / 2 + camera.panY));
}

export function screenSpace(ctx: CanvasRenderingContext2D, camera: Camera): void {
  ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0);
}

/* The part of the world on screen, with a margin, for skipping what is not. */
export function worldView(camera: Camera): Box {
  const a = screenToWorld(camera, -40, -40), b = screenToWorld(camera, camera.width + 40, camera.height + 40);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

export function inView(view: Box, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return maxX >= view.minX && minX <= view.maxX && maxY >= view.minY && minY <= view.maxY;
}

export function curveInView(view: Box, c: Cubic): boolean {
  return inView(view,
    Math.min(c.start.x, c.c1.x, c.c2.x, c.end.x) - 14, Math.min(c.start.y, c.c1.y, c.c2.y, c.end.y) - 14,
    Math.max(c.start.x, c.c1.x, c.c2.x, c.end.x) + 14, Math.max(c.start.y, c.c1.y, c.c2.y, c.end.y) + 14);
}

/* Which nodes stay lit: the explained path, else the selection and its
 * neighbours, else the group chosen from the legend, else the hovered node's
 * neighbourhood. Null means nothing is dimmed. */
export function focusSets(scene: Scene): Focus | null {
  if (scene.highlightNodes.size) return { nodes: scene.highlightNodes, edges: scene.highlightEdges };
  const anchor = scene.selected || (scene.focusGroup ? null : scene.hover);
  if (anchor) {
    const nodes = new Set([anchor.id]);
    const edges = new Set<string>();
    for (const e of scene.edges) {
      if (!e.visible) continue;
      if (e.source === anchor.id || e.target === anchor.id) { nodes.add(e.source); nodes.add(e.target); edges.add(e.id); }
    }
    return { nodes, edges };
  }
  if (scene.focusGroup) {
    const group = scene.focusGroup;
    const nodes = new Set(scene.nodes.filter(n => n.visible && (n.type === group || n.type === 'repo')).map(n => n.id));
    const edges = new Set(scene.edges.filter(e => e.visible && nodes.has(e.source) && nodes.has(e.target)).map(e => e.id));
    return { nodes, edges };
  }
  return null;
}
