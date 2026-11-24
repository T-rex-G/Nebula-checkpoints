/*
 * Where the Neural map's camera goes.
 *
 * The map keeps a camera -- a zoom and a pan from the stage's centre -- and,
 * while it is moving, the target it eases toward. These say where to send it:
 * zoomed about the point under the hand, stepped in or out, framing a part of
 * the world in the room the stage's controls leave free, or brought round so
 * a chosen node stands beside its card. None of them moves the camera itself.
 */
import { HUB_R, worldRadius, type LayoutMode, type Panel } from './graph-layout.ts';
import { clamp, screenToWorld, worldToScreen, type Box, type Camera } from './graph-scene.ts';

/* How far the reader may zoom by hand. */
export const ZOOM = Object.freeze({ min: .35, max: 2.6 });

/*
 * How far a fit may go: never further out than `min`, never closer than the
 * caller's limit (`max` unless it says otherwise). A tall stacked layout is
 * read from the top down and framed by its width, at most `tall`. A graph
 * fitted whole on a wide stage stops at `readable`, where a row can still be
 * read; the minimap shows what lies beyond.
 */
export const FIT = Object.freeze({ min: .3, max: 1.35, tall: 1.1, readable: .78 });

/* Where the camera is sent; the map eases toward it. */
export interface CameraTarget { readonly zoom: number; readonly panX: number; readonly panY: number }

/* How much of each edge of the stage its controls cover, in pixels. */
export interface Insets { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

/* Before the stage has been measured: room for the status above and the tools on the right. */
export const DEFAULT_INSETS: Insets = Object.freeze({ left: 16, right: 64, top: 64, bottom: 20 });

export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number }

/*
 * Measured, not assumed: the status and search may sit below a phone's clock,
 * the tools may have wrapped into a second column on a short stage, and the
 * edges may be clear of a notch -- the fit frames the graph in whatever is
 * actually left. `rail` is the docked rail, when it stands over the stage.
 */
export function stageInsets(stage: Rect, top: Rect | null, tools: Rect | null, rail: Rect | null): Insets {
  let { left, right, top: above, bottom } = DEFAULT_INSETS;
  if (top && top.height) {
    above = Math.max(24, top.bottom - stage.top + 10);
    left = Math.max(16, top.left - stage.left + 3);
  }
  if (tools && tools.width) {
    right = Math.max(16, stage.right - tools.left + 10);
    bottom = Math.max(16, stage.bottom - tools.bottom + 6);
  }
  if (rail) left = Math.max(left, rail.right - stage.left + 16);
  return { left, right, top: above, bottom };
}

/* Zoomed about a point on the stage: what is under it stays under it. */
export function zoomAround(camera: Camera, x: number, y: number, zoom: number): CameraTarget {
  const before = screenToWorld(camera, x, y);
  const next: Camera = { width: camera.width, height: camera.height, dpr: camera.dpr, zoom: clamp(zoom, ZOOM.min, ZOOM.max), panX: camera.panX, panY: camera.panY };
  const after = worldToScreen(next, before.x, before.y);
  return { zoom: next.zoom, panX: camera.panX + (x - after.x), panY: camera.panY + (y - after.y) };
}

/* A step in or out about the stage's centre, from where the camera is going if it is moving. */
export function zoomStep(from: CameraTarget, factor: number): CameraTarget {
  const zoom = clamp(from.zoom * factor, ZOOM.min, ZOOM.max);
  const scale = zoom / from.zoom;
  return { zoom, panX: from.panX * scale, panY: from.panY * scale };
}

/* The stage a fit frames into: its size, what covers its edges, and how the graph is laid on it. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
  readonly layoutMode: LayoutMode | null;
}

/*
 * Frames a world rectangle in the part of the stage nothing covers. A tall
 * stacked layout is framed by its width and read from the top down, the way
 * a list is -- fitting all of its height would shrink it past reading.
 * `whole` frames all of the rectangle whatever the layout: a group, opened
 * or chosen, is shown entire.
 */
export function frameBox(frame: Frame, b: Box, maxZoom: number = FIT.max, whole = false): CameraTarget {
  const { width: W, height: H, insets: inset } = frame;
  const boxW = Math.max(80, W - inset.left - inset.right);
  const boxH = Math.max(80, H - inset.top - inset.bottom);
  const byWidth = boxW / Math.max(1, b.maxX - b.minX);
  const byHeight = boxH / Math.max(1, b.maxY - b.minY);
  const tall = frame.layoutMode === 'stack' && !whole;
  let zoom = clamp(tall ? Math.min(byWidth, FIT.tall) : Math.min(byWidth, byHeight), FIT.min, maxZoom);
  if (!tall && !whole && zoom < FIT.readable) zoom = Math.min(maxZoom, Math.max(zoom, Math.min(byWidth, FIT.readable)));
  const offsetX = inset.left + boxW / 2 - W / 2;
  const panX = offsetX - ((b.minX + b.maxX) / 2) * zoom;
  const panY = tall && (b.maxY - b.minY) * zoom > boxH
    ? inset.top - H / 2 - b.minY * zoom
    : inset.top + boxH / 2 - H / 2 - ((b.minY + b.maxY) / 2) * zoom;
  return { zoom, panX, panY };
}

type PanelBounds = Pick<Panel, 'x' | 'y' | 'w' | 'h'>;

/* An opened group's panel with room round it. */
export function panelBox(panel: PanelBounds): Box {
  return { minX: panel.x - 30, minY: panel.y - 30, maxX: panel.x + panel.w + 30, maxY: panel.y + panel.h + 30 };
}

/* A group chosen from the legend, framed with the hub it hangs from. */
export function groupBox(panel: PanelBounds): Box {
  return {
    minX: Math.min(panel.x, -HUB_R) - 30, minY: Math.min(panel.y, -HUB_R) - 30,
    maxX: Math.max(panel.x + panel.w, HUB_R) + 30, maxY: Math.max(panel.y + panel.h, HUB_R) + 30
  };
}

/* What bringing a node beside its card needs to know of the stage. */
export interface Approach {
  readonly camera: Camera;
  /* Where the camera is going, when it is moving. */
  readonly heading: CameraTarget | null;
  /* The card opens over the stage (docked, or a sheet on a phone) rather than beside the node. */
  readonly docked: boolean;
  /* What covers the stage's edges, measured only if the answer needs it. */
  readonly insets: () => Insets;
  readonly cardWidth: number;
  /* The panel the node's row is in, if it is in one. */
  readonly panel: Pick<Panel, 'x' | 'w'> | null;
}

export interface Approached {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly tx?: number | undefined;
  readonly ty?: number | undefined;
}

/*
 * Where the camera goes for a chosen node, or null where it need not move.
 * It moves only when it has to: when the node is off screen, or where the
 * card is about to cover it. A docked card covers the stage's lower part, so
 * the node is brought into the upper part; a floating card opens to the
 * node's right, so the node's whole panel and the card beside it must fit,
 * the panel's right edge landing just short of the card.
 */
export function approach(view: Approach, node: Approached): CameraTarget | null {
  const { camera, cardWidth, panel, docked } = view;
  const W = camera.width, H = camera.height;
  if (!W || !H) return null;
  const zoom = Math.max(view.heading ? view.heading.zoom : camera.zoom, .75);
  const x = node.tx ?? node.x, y = node.ty ?? node.y;
  const current = worldToScreen(camera, x, y);
  const toRight = panel ? (panel.x + panel.w - x) * zoom : 0;
  const goalLimit = W - 64 - cardWidth - 16 - toRight;
  const comfortable = docked
    ? current.x > W * .15 && current.x < W * .85 && current.y > 70 && current.y < H * .42
    : current.x > view.insets().left + 40 && current.x < goalLimit && current.y > H * .18 && current.y < H * .82;
  if (comfortable && zoom === camera.zoom) return null;
  const insets = view.insets();
  const reach = panel ? toRight : worldRadius(node) * zoom;
  const goalX = docked ? W * .5 : clamp(W - 64 - cardWidth - 16 - reach, insets.left + 50, Math.max(insets.left + 50, W * .6));
  const goalY = docked ? H * .27 : H * .5;
  return { zoom, panX: goalX - W / 2 - x * zoom, panY: goalY - H / 2 - y * zoom };
}
