/*
 * What stands for each node on the Neural map: an icon for every type, drawn
 * from the same 24-unit path on the canvas and in the node's card, so a node
 * and its details are recognisably the same thing.
 *
 * These replaced single letters. The letters were chosen when nodes were 9px
 * spheres, where a legible initial beat a smudged picture; nodes are now drawn
 * at 14 to 26px on a solid disc, where a stroked icon reads and "W" for a
 * workflow never did. The letters and marks stay in the node styles as the
 * fallback for a canvas without Path2D.
 */
import type { NodeMark } from './graph-model.ts';

export const TYPE_ICON: Readonly<Record<string, string>> = Object.freeze({
  repo: 'M12 3.4c.6 3.6 1.8 5.4 5.4 6.6-3.6 1.2-4.8 3-5.4 6.6-.6-3.6-1.8-5.4-5.4-6.6 3.6-1.2 4.8-3 5.4-6.6z',
  user: 'M12 12.2a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8zM4.8 20.2a7.2 7.2 0 0 1 14.4 0',
  session: 'M4 5h16v10.5H4zM9 19.5h6M12 15.5v4',
  branch: 'M6.5 4v11M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 9.5c0 4.5-5 5-11 7.5',
  tag: 'M3.8 12.2L12 4h6.8A1.2 1.2 0 0 1 20 5.2V12l-8.2 8.2zM15.8 8.2h.01',
  commit: 'M3 12h5.5M15.5 12H21M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  pull: 'M6.5 8.5v7M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 15.5V9a3 3 0 0 0-3-3H11M13 3.8L11 6l2 2.2',
  issue: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM12 13.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
  release: 'M5.5 20.5V4M5.5 4.5h11.8l-2.4 4 2.4 4H5.5',
  workflow: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM10 8.6l5.4 3.4-5.4 3.4z',
  package: 'M12 3.5l7.5 4.1v8.8L12 20.5l-7.5-4.1V7.6zM4.5 7.6l7.5 4.2 7.5-4.2M12 11.8v8.7',
  vulnerability: 'M12 4.2l8.6 15H3.4zM12 10v4.2M12 16.8v.1',
  protected: 'M6.5 3.5h7.5l4 4v13H6.5zM14 3.5v4h4M9.6 14.2h4.8v3.8H9.6zM10.6 14.2V13a1.4 1.4 0 0 1 2.8 0v1.2',
  snapshot: 'M4.8 12a7.2 7.2 0 1 0 2.1-5.1M4.8 6.2v5.1h5.1',
  safety: 'M12 3.6l7 2.9v5.1c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.5zM9.2 12.1l2 2.1 3.6-3.9',
  external: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM3.8 12h16.4M12 3.8c2.2 2.3 3.2 5 3.2 8.2s-1 5.9-3.2 8.2M12 3.8C9.8 6.1 8.8 8.8 8.8 12s1 5.9 3.2 8.2',
  scan: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8.2 12.2l2.6 2.6 5-5.2',
  credential: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM10.9 12.1L19 4M15.5 7.5l2.5 2.5M13.4 9.6l1.8 1.8',
  /* The key, with the warning stroke where its teeth were: a credential that
   * is out in the open. */
  leak: 'M7.5 19.8a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8zM10.3 13.2l5.6-5.6M13 10.5l1.7 1.7M19.5 3.6v5.2M19.5 11.6v.1',
  integration: 'M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2'
});

/*
 * The same four marks for the inspector, which is DOM rather than canvas.
 * Node types that carry a letter keep it; the drawn ones get the drawing, so
 * the panel and the graph agree about what a node looks like.
 */
export const INSPECTOR_MARK: Readonly<Record<NodeMark, string>> = Object.freeze({
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M12 3.4c.6 3.6 1.8 5.4 5.4 6.6-3.6 1.2-4.8 3-5.4 6.6-.6-3.6-1.8-5.4-5.4-6.6 3.6-1.2 4.8-3 5.4-6.6z"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1"/><path d="M4.8 6.2v5.1h5.1"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l7 2.9v5.1c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.5z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.4 12.4l4.2 4.2 9-9.2"/></svg>'
});

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/* The inspector's mark for a drawn type, or nothing for a type set in a letter. */
export function inspectorMark(mark: string | undefined): string | undefined {
  return mark && own(INSPECTOR_MARK, mark) ? INSPECTOR_MARK[mark as NodeMark] : undefined;
}

/*
 * Four node types are drawn rather than typed. Every other type is a single
 * letter, set in Public Sans. These four were a sparkle, a restoring turn, a
 * diamond and a check -- characters that Public Sans does not carry, so they
 * fell through the stack to whatever font on the machine happened to have
 * them: two typefaces on one graph, decided by the viewer's system. Drawn as
 * paths they are the same on every machine, and they still read at these
 * radii (9 to 22).
 */
export function drawNodeMark(ctx: CanvasRenderingContext2D, mark: string, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1, size * 0.16);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = ctx.fillStyle;
  const u = size / 2;
  ctx.beginPath();
  if (mark === 'star') {
    /* The brand's four-point mark, filled so the hub reads as solid. */
    ctx.moveTo(0, -u);
    ctx.quadraticCurveTo(u * 0.2, -u * 0.2, u, 0);
    ctx.quadraticCurveTo(u * 0.2, u * 0.2, 0, u);
    ctx.quadraticCurveTo(-u * 0.2, u * 0.2, -u, 0);
    ctx.quadraticCurveTo(-u * 0.2, -u * 0.2, 0, -u);
    ctx.fill();
  } else if (mark === 'restore') {
    ctx.arc(0, 0, u * 0.78, Math.PI * 0.55, Math.PI * 2.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-u * 0.78, -u * 0.32);
    ctx.lineTo(-u * 0.78, u * 0.2);
    ctx.lineTo(-u * 0.24, u * 0.2);
    ctx.stroke();
  } else if (mark === 'shield') {
    ctx.moveTo(0, -u);
    ctx.lineTo(u * 0.82, -u * 0.55);
    ctx.lineTo(u * 0.82, u * 0.12);
    ctx.quadraticCurveTo(u * 0.82, u * 0.76, 0, u);
    ctx.quadraticCurveTo(-u * 0.82, u * 0.76, -u * 0.82, u * 0.12);
    ctx.lineTo(-u * 0.82, -u * 0.55);
    ctx.closePath();
    ctx.stroke();
  } else if (mark === 'check') {
    ctx.moveTo(-u * 0.72, 0);
    ctx.lineTo(-u * 0.16, u * 0.56);
    ctx.lineTo(u * 0.76, -u * 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/* Paths are compiled once; a Path2D is reused every frame. */
const ICON_CACHE = new Map<string, Path2D>();
function iconPath(type: string): Path2D | null {
  if (typeof Path2D !== 'function' || !own(TYPE_ICON, type)) return null;
  let path = ICON_CACHE.get(type);
  if (!path) { path = new Path2D(TYPE_ICON[type]); ICON_CACHE.set(type, path); }
  return path;
}

/* A type's icon, centred on (x, y): false where the canvas cannot draw a path. */
export function drawIcon(ctx: CanvasRenderingContext2D, type: string, x: number, y: number, size: number, color: string): boolean {
  const path = iconPath(type);
  if (!path) return false;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  if (type === 'repo') { ctx.fillStyle = color; ctx.fill(path); }
  else ctx.stroke(path);
  ctx.restore();
  return true;
}
