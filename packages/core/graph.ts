/**
 * Pure graph slicing for residual pipeline synthesis.
 *
 * Deliberately generic: it knows nothing about RocketRide. The adapter maps a
 * `.pipe` document onto `GraphNode[]`, so this algorithm — the heart of the
 * recovery mechanism — stays unit-testable with no engine running.
 */

export interface GraphNode {
  id: string;
  /** Data-flow edges: ids of components feeding this one. */
  inputs: string[];
  /** Control-flow (agent invoke) edges: ids of components wired via control[]. */
  control?: string[];
}

/**
 * Every node reachable downstream of `startId` via data edges, inclusive.
 *
 * Q3 fallback (see docs/architecture.md): control-flow edges are treated as
 * non-sliceable. If any node in the residual set participates in a control
 * edge, the whole connected control group is pulled in rather than sliced
 * through — we never cut an agent away from the tools it invokes.
 */
export function residualSet(nodes: readonly GraphNode[], startId: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(startId)) {
    throw new Error(`residualSet: unknown start node "${startId}"`);
  }

  // Forward data-flow closure.
  const result = new Set<string>([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (result.has(node.id)) continue;
      if (node.inputs.some((src) => result.has(src))) {
        result.add(node.id);
        changed = true;
      }
    }
  }

  // Widen across control-flow groups until stable.
  changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const links = node.control ?? [];
      if (links.length === 0) continue;
      const touches = result.has(node.id) || links.some((id) => result.has(id));
      if (!touches) continue;
      if (!result.has(node.id)) {
        result.add(node.id);
        changed = true;
      }
      for (const id of links) {
        if (!result.has(id)) {
          result.add(id);
          changed = true;
        }
      }
    }
  }

  return result;
}

/**
 * Edges crossing into the residual set from outside it. These are exactly the
 * points where a cached checkpoint value must be supplied, because their
 * producer will not run again.
 */
export interface FrontierEdge {
  /** Node outside the residual set whose cached output is needed. */
  from: string;
  /** Node inside the residual set that consumes it. */
  to: string;
}

export function frontier(
  nodes: readonly GraphNode[],
  residual: ReadonlySet<string>,
): FrontierEdge[] {
  const edges: FrontierEdge[] = [];
  for (const node of nodes) {
    if (!residual.has(node.id)) continue;
    for (const src of node.inputs) {
      if (!residual.has(src)) edges.push({ from: src, to: node.id });
    }
  }
  return edges;
}
