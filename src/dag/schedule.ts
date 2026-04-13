import type { DagNode } from "./types.ts";

/**
 * Topologically sort cells into a valid execution order.
 * Throws on cycles — the parser/analyser must produce a DAG.
 */
export function topoSort(nodes: ReadonlyMap<string, DagNode>): string[] {
  const result: string[] = [];
  const tempMark = new Set<string>();
  const permMark = new Set<string>();

  const visit = (id: string): void => {
    if (permMark.has(id)) return;
    if (tempMark.has(id)) throw new Error(`cycle through cell ${id}`);
    tempMark.add(id);
    const node = nodes.get(id);
    if (node) {
      for (const dep of node.upstream) visit(dep);
    }
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
