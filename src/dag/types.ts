/**
 * Reactive execution graph. Cells declare reads/writes; the DAG topologically
 * orders execution and computes the affected sub-graph when one changes.
 *
 * v0 reads/writes are produced by static AST analysis on the kernel side
 * (see kernel/pyodide.ts → analyseScope). The DAG layer treats them as opaque
 * symbol sets — it knows nothing about Python.
 */

import type { Cell } from "../parser/types.ts";

export interface CellAnalysis {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
}

export interface DagNode {
  readonly cell: Cell;
  readonly analysis: CellAnalysis;
  readonly upstream: ReadonlySet<string>;   // cell ids
  readonly downstream: ReadonlySet<string>; // cell ids
}

export type CellState = "idle" | "stale" | "running" | "ok" | "error";

export interface NodeStatus {
  readonly cellId: string;
  readonly state: CellState;
  /** Wall-clock duration of last successful run, ms. */
  readonly durationMs?: number;
  readonly error?: string;
}
