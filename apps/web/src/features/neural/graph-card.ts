/*
 * The card a chosen node opens on the Neural map: what it says -- its kind,
 * name and state, what it is, a few facts, what it is connected to and what
 * can be done from it -- where it stands, and the line that ties it to its
 * node. It opens beside the node when the stage has room for both, along the
 * bottom of the stage when it does not, and on a phone as a sheet over the
 * page, the only place there with room to read it.
 */
import { severityRank } from './graph-layout.ts';
import { TYPE_STYLE, isNodeType, short, type GraphEdge, type GraphNode, type NodeMark, type Severity } from './graph-model.ts';
import { timeAgo } from './graph-summary.ts';

export const CARD_WIDTH = 312;

export type CardMode = 'sheet' | 'docked' | 'float';

/* A phone's page has room only for a sheet; a narrow stage, for a card along its foot. */
export function cardMode(viewportWidth: number, expanded: boolean, stageWidth: number): CardMode {
  if (viewportWidth < 720 && !expanded) return 'sheet';
  return stageWidth < CARD_WIDTH + 300 ? 'docked' : 'float';
}

const styleOf = (type: string) => TYPE_STYLE[isNodeType(type) ? type : 'repo'];

const DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  repo: 'Central node connecting repository activity, protection, dependencies and recovery state.',
  branch: 'A mutable Git reference. Protected branches reduce the risk of destructive direct changes.',
  commit: 'A historical repository change observed during the selected activity window.',
  workflow: 'A CI/CD execution connected to a branch or commit.',
  vulnerability: 'A known advisory affecting a dependency version found in the repository manifest.',
  protected: 'A path guarded by the Nebulaverse-X protected-file policy.',
  snapshot: 'A retained reference manifest used for rapid repository-state recovery.',
  session: 'An authenticated Nebulaverse-X session associated with this identity.',
  credential: 'A repository deploy key. Writable keys represent a direct non-human modification path.',
  leak: 'A credential an Exposure scan found in the repository or its history. The secret itself is never stored or shown.',
  integration: 'A repository webhook integration and its destination security posture.'
});

/* What a kind of node is, where its reading said nothing of its own. */
export function describe(node: Pick<GraphNode, 'type'>): string {
  return Object.prototype.hasOwnProperty.call(DESCRIPTIONS, node.type) ? DESCRIPTIONS[node.type] ?? '' : 'Repository intelligence object correlated by the Neural Command Center.';
}

/* Fields of a node's reading that are not facts to list: its prose, and where it links. */
export const FACT_SKIP: ReadonlySet<string> = new Set(['description', 'summary', 'message', 'title', 'verifiedEvent', 'url']);

/* A fact as the card says it: yes or no, a time as how long ago, anything else cut to 40 characters. */
export function factValue(value: unknown, now: number): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) return timeAgo(text, now);
  return short(text, 40);
}

/* A field's name as words: "lastPushedAt" is "last pushed at". */
export const factLabel = (name: string): string => name.replace(/([A-Z])/g, ' $1').toLowerCase();

export interface CardAction {
  readonly action: string;
  readonly label: string;
  /* What the action needs, carried on its control as data-path, data-branch and data-url. */
  readonly path?: string;
  readonly branch?: string;
  readonly url?: string;
}

/* What can be done from a node, by its kind; every node can start or end an explained connection. */
export function cardActions(node: Pick<GraphNode, 'type' | 'label' | 'meta'>, explaining: boolean): readonly CardAction[] {
  const actions: CardAction[] = [];
  const path = node.meta['path'];
  const url = node.meta['url'];
  if (node.type === 'protected' && path) actions.push({ action: 'open-file', label: 'Open protected file', path: String(path) });
  if (node.type === 'branch') actions.push({ action: 'branch', label: 'Switch to this branch', branch: node.label });
  if (node.type === 'commit') actions.push({ action: 'commits', label: 'Open commit history' });
  if (node.type === 'pull') actions.push({ action: 'pulls', label: 'Open pull requests' });
  if (node.type === 'issue') actions.push({ action: 'issues', label: 'Open issues' });
  if (node.type === 'workflow') {
    actions.push({ action: 'actions', label: 'Open workflow runs' });
    if (url) actions.push({ action: 'external-url', label: 'Open on provider', url: String(url) });
  }
  if (node.type === 'package' || node.type === 'vulnerability' || node.type === 'scan') actions.push({ action: 'security-scan', label: 'Run full dependency scan' });
  if (node.type === 'snapshot') {
    actions.push({ action: 'snapshot', label: 'Capture fresh references' }, { action: 'recovery-preview', label: 'Preview recovery impact' }, { action: 'recovery', label: 'Open recovery workflow' });
  }
  if (node.type === 'safety' || node.type === 'repo' || node.type === 'protected') actions.push({ action: 'safeguards', label: 'Open safeguards' });
  if (node.type === 'leak') actions.push({ action: 'exposure', label: 'Open in Exposure' });
  if (node.type === 'session' || node.type === 'user') actions.push({ action: 'revoke', label: 'Revoke other sessions' });
  actions.push({ action: 'explain', label: explaining ? 'Explain from selected start' : 'Use for connection path' });
  return actions;
}

export interface CardLink {
  readonly id: string;
  readonly type: string;
  readonly color: string;
  readonly label: string;
  readonly relation: string;
  readonly severity: Severity;
}

export interface CardModel {
  readonly type: string;
  /* For a kind with no icon: its drawn mark, else its letter. */
  readonly mark: NodeMark | undefined;
  readonly glyph: string;
  readonly color: string;
  readonly kicker: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly description: string;
  readonly facts: readonly (readonly [string, string])[];
  /* How many it is connected to in this mode, the first eight of them, and how many more. */
  readonly connected: number;
  readonly links: readonly CardLink[];
  readonly more: number;
  readonly actions: readonly CardAction[];
}

export interface CardInput {
  readonly node: GraphNode;
  readonly edges: readonly (GraphEdge & { readonly visible?: boolean | undefined })[];
  readonly nodeById: (id: string) => GraphNode | undefined;
  readonly explaining: boolean;
  readonly now: number;
}

/*
 * What the card says. Its connections are the relations drawn in this mode,
 * the most severe first and then by name; the card lists eight and says how
 * many more the graph holds.
 */
export function cardModel(input: CardInput): CardModel {
  const { node } = input;
  const links = input.edges
    .filter(e => e.visible && (e.source === node.id || e.target === node.id))
    .map(edge => ({ edge, other: input.nodeById(edge.source === node.id ? edge.target : edge.source) }))
    .flatMap(item => (item.other ? [{ edge: item.edge, other: item.other }] : []))
    .sort((a, b) => severityRank(a.edge.severity) - severityRank(b.edge.severity) || a.other.label.localeCompare(b.other.label));
  const facts = Object.entries(node.meta || {})
    .filter(([key, value]) => !FACT_SKIP.has(key) && value !== '' && value != null && typeof value !== 'object')
    .slice(0, 6)
    .map(([key, value]) => [factLabel(key), factValue(value, input.now)] as const);
  const shown = links.slice(0, 8);
  return {
    type: node.type,
    mark: node.mark,
    glyph: node.glyph || '',
    color: node.color,
    kicker: styleOf(node.type).label,
    title: node.label,
    severity: node.severity || 'normal',
    status: node.severity === 'critical' ? 'Critical signal' : node.severity === 'warning' ? 'Review recommended' : 'Normal',
    description: String(node.meta['description'] || describe(node)),
    facts,
    connected: links.length,
    links: shown.map(({ edge, other }) => ({
      id: other.id, type: other.type, color: other.color, label: short(other.label, 30), relation: edge.type, severity: edge.severity
    })),
    more: links.length - shown.length,
    actions: cardActions(node, input.explaining)
  };
}

/* What a screen reader hears when the keyboard chooses a node. */
export function announcement(node: Pick<GraphNode, 'id' | 'type' | 'label' | 'severity'>, edges: readonly (GraphEdge & { readonly visible?: boolean | undefined })[]): string {
  const count = edges.filter(e => e.visible && (e.source === node.id || e.target === node.id)).length;
  const severity = node.severity === 'critical' ? 'critical signal' : node.severity === 'warning' ? 'review recommended' : 'normal';
  const label = isNodeType(node.type) ? TYPE_STYLE[node.type].label : 'Node';
  return `${label}: ${node.label}. ${severity}. ${count} connection${count === 1 ? '' : 's'}.`;
}

export interface Placement { readonly left: number; readonly top: number; readonly side: 'left' | 'right' }

export interface PlacementInput {
  readonly width: number;
  readonly height: number;
  readonly size: { readonly w: number; readonly h: number };
  /* The node on the stage. */
  readonly at: { readonly x: number; readonly y: number };
  /* What the card must stand clear of: the node's panel on the stage, or the node itself. */
  readonly span: { readonly left: number; readonly right: number };
  readonly insets: { readonly left: number; readonly top: number; readonly bottom: number };
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/*
 * A floating card stands beside the node's panel, not over it -- the rows
 * under it are the node's own group, which the reader is usually comparing
 * it with -- to the right where it fits, else to the left, and level with the
 * node, inside the part of the stage nothing covers.
 */
export function cardPlacement(input: PlacementInput): Placement {
  const { width: W, height: H, size, insets } = input;
  let left = input.span.right + 16;
  let side: Placement['side'] = 'right';
  if (left + size.w > W - 60) { left = input.span.left - 16 - size.w; side = 'left'; }
  const leftEdge = insets.left - 4;
  left = clamp(left, leftEdge, Math.max(leftEdge, W - size.w - 60));
  const top = clamp(input.at.y - 44, insets.top - 2, Math.max(insets.top - 2, H - size.h - insets.bottom + 8));
  return { left, top, side };
}

export interface Leader { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number } }

/*
 * The line from a node to its floating card, so the card is visibly about
 * that node after the graph has moved under it: it meets the card's near
 * edge level with the node (within the card's height), and leaves from the
 * end of the node's row, so it runs along the row it names -- or, for a node
 * in no panel, from just outside its disc.
 */
export function leaderLine(at: { readonly x: number; readonly y: number }, radius: number, card: Placement & { readonly w: number; readonly h: number }, rowEnd: { readonly x: number; readonly y: number } | null): Leader {
  const ex = card.side === 'right' ? card.left : card.left + card.w;
  const ey = clamp(at.y, card.top + 18, card.top + card.h - 18);
  const angle = Math.atan2(ey - at.y, ex - at.x);
  const from = rowEnd ? { x: rowEnd.x, y: rowEnd.y } : { x: at.x + Math.cos(angle) * (radius + 3), y: at.y + Math.sin(angle) * (radius + 3) };
  return { from, to: { x: ex, y: ey } };
}
