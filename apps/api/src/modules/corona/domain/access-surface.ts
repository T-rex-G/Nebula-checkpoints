/*
 * Who and what can reach a repository besides its owner -- deploy keys,
 * webhooks and collaborators -- and how much that should worry the people
 * who look after it; and, on the access graph, the shortest way from one
 * node to another, so a reader can see how a key reaches what it reaches.
 */
import { iterable, listOf, member, read } from '../../../platform/values/fields.ts';

const MAX_REASON_COUNT = 12;

export interface SurfaceReason {
  readonly points: number;
  readonly code: string;
  readonly message: string;
}
export interface SurfaceRisk {
  readonly score: number;
  readonly severity: 'critical' | 'warning' | 'normal';
  readonly reasons: SurfaceReason[];
}

export function riskForAccessSurface(surface: unknown = {}): SurfaceRisk {
  let score = 0;
  const reasons: SurfaceReason[] = [];
  const add = (points: number, code: string, message: string): void => {
    score += points;
    if (reasons.length < MAX_REASON_COUNT) reasons.push({ points, code, message });
  };
  const deployKeys = listOf(member(surface, 'deployKeys'));
  const webhooks = listOf(member(surface, 'webhooks'));
  const collaborators = listOf(member(surface, 'collaborators'));
  const writable = deployKeys.filter(key => key && read(key, 'readOnly') === false);
  if (writable.length) add(Math.min(60, 30 + (writable.length - 1) * 10), 'WRITABLE_DEPLOY_KEY', `${writable.length} deploy key(s) can write to the repository.`);
  const unverified = deployKeys.filter(key => key && read(key, 'verified') === false);
  if (unverified.length) add(15, 'UNVERIFIED_DEPLOY_KEY', `${unverified.length} deploy key(s) are not verified.`);
  const insecure = webhooks.filter(hook => hook && read(hook, 'insecureSsl') === true);
  if (insecure.length) add(40, 'INSECURE_WEBHOOK_TLS', `${insecure.length} webhook(s) disable TLS certificate verification.`);
  const inactive = webhooks.filter(hook => hook && read(hook, 'active') === false);
  if (inactive.length) add(8, 'INACTIVE_WEBHOOK', `${inactive.length} inactive webhook(s) remain configured.`);
  const admins = collaborators.filter(c => c && String(read(c, 'permission') || '').toLowerCase() === 'admin');
  if (admins.length > 8) add(10, 'BROAD_ADMIN_ACCESS', `${admins.length} collaborators have repository administration permission.`);
  if (member(surface, 'partial')) add(12, 'ACCESS_INVENTORY_PARTIAL', 'One or more access surfaces could not be enumerated with the current token.');
  score = Math.min(100, score);
  return { score, severity: score >= 70 ? 'critical' : score >= 35 ? 'warning' : 'normal', reasons };
}

export interface GraphPath {
  readonly nodeIds: unknown[];
  readonly edges: unknown[];
}

/*
 * A breadth-first search over an undirected view of the graph. The path's
 * edges are the graph's own edge objects; one walked against its direction is
 * a copy marked `reversed`.
 */
export function shortestPath(nodes: unknown, edges: unknown, startId: unknown, endId: unknown): GraphPath | null {
  const listed = nodes || [];
  if (!Array.isArray(listed)) throw new TypeError('(nodes || []).map is not a function');
  const ids = new Set(listed.map(n => member(n, 'id')));
  if (!ids.has(startId) || !ids.has(endId)) return null;
  if (startId === endId) return { nodeIds: [startId], edges: [] };
  const adjacency = new Map<unknown, { readonly next: unknown; readonly edge: unknown }[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of iterable(edges || [], '(edges || [])')) {
    const source = member(edge, 'source');
    const target = member(edge, 'target');
    if (!ids.has(source) || !ids.has(target)) continue;
    adjacency.get(source)?.push({ next: target, edge });
    adjacency.get(target)?.push({ next: source, edge: Object.assign({}, edge, { reversed: true }) });
  }
  const queue: unknown[] = [startId];
  const prev = new Map<unknown, { readonly node: unknown; readonly edge: unknown } | null>([[startId, null]]);
  while (queue.length) {
    const cur = queue.shift();
    for (const item of adjacency.get(cur) || []) {
      if (prev.has(item.next)) continue;
      prev.set(item.next, { node: cur, edge: item.edge });
      if (item.next === endId) {
        const nodeIds: unknown[] = [endId];
        const pathEdges: unknown[] = [];
        let p: unknown = endId;
        while (p !== startId) {
          const step = prev.get(p);
          if (!step) break;
          pathEdges.unshift(step.edge);
          p = step.node;
          nodeIds.unshift(p);
        }
        return { nodeIds, edges: pathEdges };
      }
      queue.push(item.next);
    }
  }
  return null;
}
