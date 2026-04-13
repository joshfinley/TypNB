import type { Cell } from "../parser/types.ts";
import type { CellAnalysis, DagNode } from "./types.ts";

/**
 * Build the dependency DAG from cells + per-cell analyses.
 *
 * Edge rule: cell A reads symbol s and cell B writes s ⇒ B is upstream of A.
 * If multiple cells write the same symbol, the *last one in source order
 * before the reader* is the upstream — same convention as Marimo. (We will
 * surface a warning when this happens; for now silently choose the last.)
 */
export function buildDag(
  cells: readonly Cell[],
  analyses: ReadonlyMap<string, CellAnalysis>,
): Map<string, DagNode> {
  const nodes = new Map<string, DagNode>();
  const upstream = new Map<string, Set<string>>();
  const downstream = new Map<string, Set<string>>();

  for (const cell of cells) {
    upstream.set(cell.id, new Set());
    downstream.set(cell.id, new Set());
  }

  // Track which cells produce a symbol, in source order.
  const writers = new Map<string, string[]>(); // symbol -> ordered cell ids

  for (const cell of cells) {
    const a = analyses.get(cell.id);
    if (!a) continue;
    for (const sym of a.reads) {
      const producers = writers.get(sym);
      if (!producers || producers.length === 0) continue;
      const lastWriter = producers[producers.length - 1]!;
      if (lastWriter === cell.id) continue;
      upstream.get(cell.id)!.add(lastWriter);
      downstream.get(lastWriter)!.add(cell.id);
    }
    for (const sym of a.writes) {
      let arr = writers.get(sym);
      if (!arr) {
        arr = [];
        writers.set(sym, arr);
      }
      arr.push(cell.id);
    }
  }

  for (const cell of cells) {
    const a = analyses.get(cell.id) ?? { reads: new Set<string>(), writes: new Set<string>() };
    nodes.set(cell.id, {
      cell,
      analysis: a,
      upstream: upstream.get(cell.id)!,
      downstream: downstream.get(cell.id)!,
    });
  }

  return nodes;
}
