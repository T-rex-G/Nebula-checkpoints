/*
 * Where the Neural map puts what it draws.
 *
 * The repository is the hub in the middle, and every other node belongs to a
 * group drawn as a panel: a header with the group's icon, name and count, and
 * one row per member with its name always printed beside it. On a wide stage
 * the panels form two columns, one each side of the hub, with each member's
 * node on the edge that faces it; on a tall stage they stack in one column
 * beside a spine that runs down from the hub. Either way the picture reads
 * like a table of contents rather than a cloud: a reader finds "workflows" by
 * reading, not by hunting.
 *
 * A group longer than a few rows folds its tail into "+ n more", which opens
 * it; an opened group pages through its rows. A panel the reader has moved
 * stands where they put it, and its rows face the hub, or the spine, from
 * whichever side of it the panel now stands.
 *
 * This decides only where each thing belongs: the panels, and each node's
 * target. Easing toward a target, the camera, and what a reader has opened,
 * paged or moved belong to the map, which hands the last three in.
 */
import type { GraphNode, NodeType, Severity } from './graph-model.ts';

export const PANEL_W = 272;
export const HEAD_H = 56;
export const ROW_H = 44;
export const PANEL_PAD = 12;
export const PANEL_GAP = 22;
export const COLUMN_GAP = 300;
/* A group longer than this folds its tail behind "+ n more". */
export const MAX_ROWS = 6;
/* An opened group shows this many rows at a time and pages through the
 * rest, so no panel becomes a column taller than the stage. */
export const PAGE_ROWS = 10;
export const NODE_R = 16;
export const HUB_R = 58;
/* On a tall stage the spine every row branches from: straight down from
 * the bottom of the hub, on its centre line. */
export const SPINE_X = 0;
export const LEFT_GROUPS: readonly NodeType[] = Object.freeze(['user', 'credential', 'leak', 'session', 'protected', 'safety', 'snapshot', 'scan', 'release', 'tag']);
export const RIGHT_GROUPS: readonly NodeType[] = Object.freeze(['branch', 'commit', 'workflow', 'pull', 'issue', 'integration', 'external', 'package', 'vulnerability']);
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ critical: 0, warning: 1, normal: 2 });

/*
 * When one column is far longer than the other, groups without a natural side
 * cross over. Groups that belong together -- packages and their advisories,
 * branches, commits and the workflows they run, identities and their
 * credentials -- never do.
 */
const FLEX: ReadonlySet<NodeType> = new Set<NodeType>(['release', 'tag', 'pull', 'issue', 'external', 'scan', 'snapshot', 'safety', 'integration']);

export type LayoutMode = 'stack' | 'split';
export type Side = 'left' | 'right';
/* What closes a panel: nothing, the "+ n more" that opens it, or the pager of an opened group. */
export type Footer = 'more' | 'pager' | null;

export interface Panel {
  readonly type: NodeType;
  /* Every member, in the order the panel lists them. */
  readonly members: readonly GraphNode[];
  /* The rows drawn: the first few of a folded group, or one page of an opened one. */
  readonly shown: readonly GraphNode[];
  readonly rows: number;
  readonly footer: Footer;
  readonly page: number;
  readonly pages: number;
  /* Rows the panel keeps room for: every page as tall as the first. */
  readonly slots: number;
  readonly hiddenCount: number;
  /* How many there are, which a reading's total can say is more than the graph holds. */
  readonly total: number;
  readonly w: number;
  readonly h: number;
  readonly side: Side;
  readonly x: number;
  readonly y: number;
  /* Where the reader put it, rather than where the layout would. */
  readonly placed: boolean;
  /* Where its rows' nodes stand: on the edge that faces the hub. */
  readonly nodeX: number;
  /* The footer's row, where everything off the current page waits. */
  readonly moreY: number | null;
}

/* A node's place: where it eases to, and whether it waits behind its panel's footer. */
export interface Target {
  readonly x: number;
  readonly y: number;
  readonly folded: boolean;
}

export interface Placement { readonly x: unknown; readonly y: unknown }

export interface LayoutInput {
  /* Every node of the graph; the layout places the visible ones. */
  readonly nodes: readonly GraphNode[];
  /* Groups the reader opened, and the page each opened one is on. */
  readonly expanded: ReadonlySet<string>;
  readonly pages: ReadonlyMap<string, number>;
  /* How many of each type the readings say there are. */
  readonly totals: Readonly<Record<string, number>>;
  /* The stage's shape, from layoutAspect. */
  readonly aspect: number;
  /* Where the reader put a panel, by its type, for this mode. */
  readonly placed: Readonly<Record<string, Placement | undefined>>;
}

export interface Layout {
  readonly panels: readonly Panel[];
  readonly byType: ReadonlyMap<NodeType, Panel>;
  readonly targets: ReadonlyMap<GraphNode, Target>;
  /* The page each opened, paged group is on, kept within its pages. */
  readonly pages: ReadonlyMap<NodeType, number>;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/* The stage's shape: below about 1 the stage is wider than tall. */
export function layoutAspect(width: number, height: number): number {
  return width && height ? clamp((height / width) * .92, .66, 1.55) : .8;
}

/* A tall stage stacks the panels beside the spine; a wide one splits them either side of the hub. */
export function layoutModeOf(aspect: number): LayoutMode {
  return aspect > 1.05 ? 'stack' : 'split';
}

export function worldRadius(node: { readonly type: string }): number {
  return node.type === 'repo' ? HUB_R : NODE_R;
}

function groupOrder(type: NodeType): number {
  const left = LEFT_GROUPS.indexOf(type);
  if (left >= 0) return left;
  const right = RIGHT_GROUPS.indexOf(type);
  return right >= 0 ? 100 + right : 200;
}

function stackHeight(list: readonly { readonly h: number }[]): number {
  return list.reduce((sum, panel) => sum + panel.h, 0) + PANEL_GAP * Math.max(0, list.length - 1);
}

const rankOf = (severity: string): number => (Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity as Severity] : 2);

/* A panel before it has a place: its rows and its size. */
interface Rows {
  readonly type: NodeType;
  readonly members: readonly GraphNode[];
  readonly shown: readonly GraphNode[];
  readonly rows: number;
  readonly footer: Footer;
  readonly page: number;
  readonly pages: number;
  readonly slots: number;
  readonly hiddenCount: number;
  readonly total: number;
  readonly w: number;
  readonly h: number;
}

interface Spot { side: Side; x: number; y: number; placed: boolean }

function rowsOf(type: NodeType, group: readonly GraphNode[], input: LayoutInput, pages: Map<NodeType, number>): Rows {
  /* Critical first, then in the source's own order where it has one --
   * newest commit, default branch -- then by name. */
  const members = group.slice().sort((a, b) =>
    rankOf(a.severity) - rankOf(b.severity)
    || (a.order ?? 1e9) - (b.order ?? 1e9)
    || a.label.localeCompare(b.label));
  let shown: readonly GraphNode[] = members;
  let footer: Footer = null;
  let page = 0;
  let count = 1;
  let slots = members.length;
  if (members.length > MAX_ROWS && !input.expanded.has(type)) {
    shown = members.slice(0, MAX_ROWS - 1); footer = 'more'; slots = shown.length;
  } else if (members.length > MAX_ROWS) {
    count = Math.ceil(members.length / PAGE_ROWS);
    page = clamp(input.pages.get(type) || 0, 0, count - 1);
    pages.set(type, page);
    shown = members.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
    footer = 'pager';
    /* Every page is as tall as the first, so paging never moves the panels below. */
    slots = count > 1 ? PAGE_ROWS : shown.length;
  }
  const rows = slots + (footer ? 1 : 0);
  const said = Object.prototype.hasOwnProperty.call(input.totals, type) ? Number(input.totals[type]) || 0 : 0;
  return {
    type, members, shown, rows, footer, page, pages: count, slots,
    hiddenCount: members.length - shown.length,
    total: Math.max(members.length, said),
    w: PANEL_W, h: HEAD_H + rows * ROW_H + PANEL_PAD
  };
}

/* Where each panel stands before the reader has moved any. */
function arrange(list: readonly Rows[], mode: LayoutMode): Map<Rows, Spot> {
  const spots = new Map<Rows, Spot>();
  if (mode === 'stack') {
    let y = HUB_R + 58;
    for (const panel of list) { spots.set(panel, { side: 'right', x: 64, y, placed: false }); y += panel.h + PANEL_GAP; }
    return spots;
  }
  const left = list.filter(panel => LEFT_GROUPS.includes(panel.type));
  const right = list.filter(panel => !LEFT_GROUPS.includes(panel.type));
  for (let guard = 0; guard < 16; guard++) {
    const hl = stackHeight(left), hr = stackHeight(right);
    if (Math.max(hl, hr) < Math.min(hl, hr) * 1.12 + 60) break;
    const from = hl > hr ? left : right, to = hl > hr ? right : left;
    const index = from.map(panel => FLEX.has(panel.type)).lastIndexOf(true);
    if (index < 0 || from.length < 2) break;
    const moving = from[index];
    if (!moving || Math.abs(Math.abs(hl - hr) - 2 * (moving.h + PANEL_GAP)) >= Math.abs(hl - hr)) break;
    from.splice(index, 1);
    to.push(moving);
  }
  for (const [column, side] of [[left, 'left'], [right, 'right']] as const) {
    let y = -stackHeight(column) / 2;
    for (const panel of column) {
      spots.set(panel, { side, x: side === 'left' ? -COLUMN_GAP - PANEL_W : COLUMN_GAP, y, placed: false });
      y += panel.h + PANEL_GAP;
    }
  }
  return spots;
}

export function placeGraph(input: LayoutInput): Layout {
  const visible = input.nodes.filter(n => n.visible);
  const groups = new Map<NodeType, GraphNode[]>();
  for (const n of visible) {
    if (n.type === 'repo') continue;
    const group = groups.get(n.type);
    if (group) group.push(n); else groups.set(n.type, [n]);
  }
  const pages = new Map<NodeType, number>();
  const listed = [...groups.keys()].sort((a, b) => groupOrder(a) - groupOrder(b))
    .map(type => rowsOf(type, groups.get(type) ?? [], input, pages));
  const mode = layoutModeOf(input.aspect);
  const spots = arrange(listed, mode);
  /* A moved panel stands where the reader put it, its rows facing what they
   * are wired to: the hub on a wide stage, the spine on a tall one. */
  const toward = mode === 'stack' ? SPINE_X : 0;
  const targets = new Map<GraphNode, Target>();
  const panels = listed.map((rows): Panel => {
    const spot = spots.get(rows) ?? { side: 'right', x: 0, y: 0, placed: false };
    const at = Object.prototype.hasOwnProperty.call(input.placed, rows.type) ? input.placed[rows.type] : undefined;
    const placed = !!at && typeof at.x === 'number' && typeof at.y === 'number' && Number.isFinite(at.x) && Number.isFinite(at.y);
    const x = placed && typeof at?.x === 'number' ? at.x : spot.x;
    const y = placed && typeof at?.y === 'number' ? at.y : spot.y;
    const side: Side = placed ? (x + rows.w / 2 < toward ? 'left' : 'right') : spot.side;
    const nodeX = side === 'left' ? x + rows.w - 30 : x + 30;
    const moreY = rows.footer ? y + HEAD_H + rows.slots * ROW_H + ROW_H / 2 : null;
    rows.shown.forEach((n, i) => targets.set(n, { x: nodeX, y: y + HEAD_H + i * ROW_H + ROW_H / 2, folded: false }));
    /* Everything not on the panel's current page waits behind its footer. */
    const onPage = new Set(rows.shown);
    for (const n of rows.members) {
      if (!onPage.has(n)) targets.set(n, { x: nodeX, y: moreY == null ? y + HEAD_H : moreY, folded: true });
    }
    return { ...rows, side, x, y, placed, nodeX, moreY };
  });
  for (const n of visible) if (n.type === 'repo') targets.set(n, { x: 0, y: 0, folded: false });
  return { panels, byType: new Map(panels.map(panel => [panel.type, panel])), targets, pages };
}

/* The whole picture's extent in world units, for fitting it to the stage. */
export function layoutBounds(panels: readonly Pick<Panel, 'x' | 'y' | 'w' | 'h'>[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = -HUB_R - 20, maxX = HUB_R + 20, minY = -HUB_R - 30, maxY = HUB_R + 50;
  for (const panel of panels) {
    minX = Math.min(minX, panel.x); maxX = Math.max(maxX, panel.x + panel.w);
    minY = Math.min(minY, panel.y); maxY = Math.max(maxY, panel.y + panel.h);
  }
  return { minX: minX - 16, minY: minY - 16, maxX: maxX + 16, maxY: maxY + 16 };
}
