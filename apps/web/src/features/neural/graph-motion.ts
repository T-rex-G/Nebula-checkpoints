/*
 * How the Neural map moves between frames: every node eases toward the place
 * the layout gave it, and the camera toward where it was sent. Eased rather
 * than cut, so changing mode, filtering, searching or opening a group moves
 * the graph instead of replacing it. With motion off, each arrives at once.
 */
import type { CameraTarget } from './graph-camera.ts';

/* A node as it moves: where it is, where it is going, and how far it has grown in. */
export interface Moving {
  readonly visible: boolean;
  x: number;
  y: number;
  tx?: number | undefined;
  ty?: number | undefined;
  appear?: number | undefined;
}

/* One frame of `dt` milliseconds for every visible node; true while any still moves. */
export function easeNodes(nodes: Iterable<Moving>, dt: number, motion: boolean): boolean {
  const k = motion ? 1 - Math.exp(-dt / 130) : 1;
  let moving = false;
  for (const n of nodes) {
    if (!n.visible) continue;
    if (n.tx == null) { n.tx = n.x; n.ty = n.y; }
    const tx = n.tx, ty = n.ty ?? n.y;
    const dx = tx - n.x, dy = ty - n.y;
    if (Math.abs(dx) > .25 || Math.abs(dy) > .25) { n.x += dx * k; n.y += dy * k; moving = true; }
    else if (dx || dy) { n.x = tx; n.y = ty; moving = true; }
    /* A node arriving grows out of the hub over a little more than a quarter of a second. */
    const appear = n.appear ?? 1;
    if (appear < 1) { n.appear = Math.min(1, appear + (motion ? dt / 280 : 1)); moving = true; }
  }
  return moving;
}

export interface CameraState { zoom: number; panX: number; panY: number }

/* One frame of the camera toward its target; true once it has arrived, when the target is spent. */
export function easeCamera(camera: CameraState, target: CameraTarget, dt: number, motion: boolean): boolean {
  const c = motion ? 1 - Math.exp(-dt / 110) : 1;
  camera.zoom += (target.zoom - camera.zoom) * c;
  camera.panX += (target.panX - camera.panX) * c;
  camera.panY += (target.panY - camera.panY) * c;
  if (Math.abs(target.zoom - camera.zoom) < .001 && Math.abs(target.panX - camera.panX) < .5 && Math.abs(target.panY - camera.panY) < .5) {
    camera.zoom = target.zoom; camera.panX = target.panX; camera.panY = target.panY;
    return true;
  }
  return false;
}
