/*
 * How two nodes of the Neural map are connected: the shortest chain of
 * relations between them, which "Explain this connection" lights and reads
 * out step by step. Relations are followed either way; one followed against
 * its direction is marked reversed, so the explanation can say which way it
 * points. Deterministic: the same graph explains the same way every time.
 */
import type { GraphEdge } from './graph-model.ts';

/* A relation on the path, the way it was walked. */
export interface PathStep extends GraphEdge { readonly reversed?: boolean }

export interface GraphPath {
  /* The nodes from the start to the end, both included. */
  readonly nodeIds: readonly string[];
  /* The relations between them, one fewer than the nodes. */
  readonly edges: readonly PathStep[];
}

interface Way { readonly next: string; readonly edge: PathStep }
interface Came { readonly node: string; readonly edge: PathStep }

/*
 * Breadth first from the start, so the first time the end is reached is by
 * the fewest relations; among paths as short, the one whose relations come
 * first in the graph's order. Null when no chain joins them, when either is
 * not in the graph, or when they are the same node.
 */
export function shortestPath(nodes: readonly { readonly id: string }[], edges: readonly GraphEdge[], startId: string, endId: string): GraphPath | null {
  const ids = new Set(nodes.map(n => n.id));
  if (!ids.has(startId) || !ids.has(endId)) return null;
  const adjacency = new Map<string, Way[]>([...ids].map(id => [id, []]));
  for (const edge of edges) {
    const from = adjacency.get(edge.source), to = adjacency.get(edge.target);
    if (!from || !to) continue;
    from.push({ next: edge.target, edge });
    to.push({ next: edge.source, edge: { ...edge, reversed: true } });
  }
  const queue = [startId];
  const previous = new Map<string, Came | null>([[startId, null]]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] ?? startId;
    for (const step of adjacency.get(current) || []) {
      if (previous.has(step.next)) continue;
      previous.set(step.next, { node: current, edge: step.edge });
      if (step.next === endId) return pathTo(previous, startId, endId);
      queue.push(step.next);
    }
  }
  return null;
}

function pathTo(previous: ReadonlyMap<string, Came | null>, startId: string, endId: string): GraphPath {
  const nodeIds = [endId], steps: PathStep[] = [];
  let at = endId;
  for (let came = previous.get(at); at !== startId && came; came = previous.get(at)) {
    steps.unshift(came.edge);
    at = came.node;
    nodeIds.unshift(at);
  }
  return { nodeIds, edges: steps };
}
