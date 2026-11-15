/*
 * The groups list beside the Neural map: the groups actually in scope,
 * organised by what they are about -- who can reach the repository, its
 * code, how it ships, what it depends on, what protects it -- each with its
 * count (and the repository's total where the graph holds fewer), its
 * critical and warning counts, whether it is lit or hidden, and the tools
 * that open or fold every group, show every hidden one, and put moved panels
 * back. For a large repository this is where the picture is managed.
 */
import { MAX_ROWS } from './graph-layout.ts';
import { TYPE_STYLE, isNodeType, type NodeType } from './graph-model.ts';

export const GROUP_CATEGORIES: readonly (readonly [string, readonly NodeType[]])[] = Object.freeze([
  ['Access', ['user', 'credential', 'leak', 'session', 'integration']],
  ['Code', ['branch', 'commit', 'tag', 'pull', 'issue', 'release']],
  ['Delivery', ['workflow', 'external']],
  ['Supply chain', ['package', 'vulnerability', 'scan']],
  ['Protection', ['protected', 'safety', 'snapshot']]
]);

export interface LegendRow {
  readonly type: string;
  readonly color: string;
  /* The name on the row, shortened where the full one would not fit beside its counts. */
  readonly name: string;
  /* The full name, the row's tooltip and the panel's header. */
  readonly plural: string;
  readonly count: number;
  /* How many the readings say there are, where the graph holds fewer. */
  readonly total: number | null;
  readonly critical: number;
  readonly warning: number;
  readonly hidden: boolean;
  readonly on: boolean;
}

export interface LegendCategory { readonly name: string; readonly rows: readonly LegendRow[] }

export type LegendTool = 'open' | 'fold' | 'show' | 'reset-layout';

export interface Legend {
  readonly tools: readonly { readonly action: LegendTool; readonly label: string }[];
  readonly categories: readonly LegendCategory[];
  /* The lit group, unless it has left the graph or been hidden. */
  readonly focusGroup: string | null;
  /* Nothing in scope: the list is not shown. */
  readonly empty: boolean;
}

export interface LegendInput {
  readonly nodes: readonly { readonly type: string; readonly severity: string; readonly inScope?: boolean | undefined }[];
  readonly panels: readonly { readonly type: string; readonly members: readonly unknown[] }[];
  readonly expanded: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
  readonly focusGroup: string | null;
  readonly totals: Readonly<Record<string, number>>;
  /* The reader has moved a panel in this view. */
  readonly moved: boolean;
}

interface Tally { count: number; critical: number; warning: number }

export function legendModel(input: LegendInput): Legend {
  const stats = new Map<string, Tally>();
  for (const n of input.nodes) {
    if (!n.inScope || n.type === 'repo') continue;
    const entry = stats.get(n.type) || { count: 0, critical: 0, warning: 0 };
    entry.count++;
    if (n.severity === 'critical') entry.critical++;
    else if (n.severity === 'warning') entry.warning++;
    stats.set(n.type, entry);
  }
  const focusGroup = input.focusGroup && (!stats.has(input.focusGroup) || input.hidden.has(input.focusGroup)) ? null : input.focusGroup;
  const known = new Set<string>(GROUP_CATEGORIES.flatMap(([, types]) => types));
  const grouped: (readonly [string, readonly string[]])[] = GROUP_CATEGORIES.map(([name, types]) => [name, types.filter(type => stats.has(type))]);
  const other = [...stats.keys()].filter(type => !known.has(type));
  if (other.length) grouped.push(['Other', other]);
  const foldable = input.panels.filter(panel => panel.members.length > MAX_ROWS);
  const allOpen = foldable.length > 0 && foldable.every(panel => input.expanded.has(panel.type));
  const hiddenHere = [...input.hidden].filter(type => stats.has(type));
  const tools: { action: LegendTool; label: string }[] = [];
  if (foldable.length) tools.push(allOpen ? { action: 'fold', label: 'Fold all' } : { action: 'open', label: 'Open all' });
  if (hiddenHere.length) tools.push({ action: 'show', label: `Show all (${hiddenHere.length} hidden)` });
  if (input.moved) tools.push({ action: 'reset-layout', label: 'Reset layout' });
  const categories = grouped.filter(([, types]) => types.length).map(([name, types]) => ({
    name,
    rows: types.map(type => {
      const style = TYPE_STYLE[isNodeType(type) ? type : 'repo'];
      const entry = stats.get(type) || { count: 0, critical: 0, warning: 0 };
      const plural = style.plural || style.label;
      const total = Object.prototype.hasOwnProperty.call(input.totals, type) ? input.totals[type] : undefined;
      return {
        type, color: style.color, name: style.short || plural, plural,
        count: entry.count, total: typeof total === 'number' && total > entry.count ? total : null,
        critical: entry.critical, warning: entry.warning,
        hidden: input.hidden.has(type), on: focusGroup === type
      };
    })
  }));
  return { tools, categories, focusGroup, empty: !stats.size };
}
