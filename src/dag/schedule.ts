import type { DagNode } from "./types.ts";

/**
 * Thrown by topoSort when the dependency graph has a cycle. `cells` is the
 * ordered list of ids forming the cycle (first id repeats at the end).
 */
export class CycleError extends Error {
  readonly cells: readonly string[];
  constructor(cells: readonly string[]) {
    super(`cycle through cells: ${cells.join(" → ")}`);
    this.name = "CycleError";
    this.cells = cells;
  }
}

/**
 * Topologically sort cells into a valid execution order.
 * Throws CycleError on cycles, with the cycle members attached.
 */
export function topoSort(nodes: ReadonlyMap<string, DagNode>): string[] {
  const result: string[] = [];
  const tempMark = new Set<string>();
  const permMark = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (permMark.has(id)) return;
    if (tempMark.has(id)) {
      const start = path.indexOf(id);
      throw new CycleError([...path.slice(start), id]);
    }
    tempMark.add(id);
    path.push(id);
    const node = nodes.get(id);
    if (node) {
      for (const dep of node.upstream) visit(dep);
    }
    path.pop();
    tempMark.delete(id);
    permMark.add(id);
    result.push(id);
  };

  for (const id of nodes.keys()) visit(id);
  return result;
}

/**
 * Closure of a cell and everything downstream of it. Used to mark stale and
 * to drive "rerun all stale" semantics.
 */
export function downstreamClosure(
  nodes: ReadonlyMap<string, DagNode>,
  start: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    for (const child of node.downstream) stack.push(child);
  }
  return out;
}
