/**
 * Minimal kernel interface. One implementation today (PyodideKernel); the
 * same interface is what a remote-over-SSE backend would satisfy later, so
 * the DAG and adapter layers stay unchanged.
 */

import type { CellAnalysis } from "../dag/types.ts";

export type MimeBundle = Readonly<Record<string, unknown>>;

export type OutputEvent =
  | { kind: "stdout"; data: string }
  | { kind: "stderr"; data: string }
  | { kind: "result"; data: MimeBundle }
  | { kind: "display"; data: MimeBundle }
  | { kind: "error"; name: string; message: string; traceback: readonly string[] };

export interface ExecuteOptions {
  /** Stable identifier used by the kernel for tracing & display routing. */
  readonly cellId: string;
}

export interface Kernel {
  init(): Promise<void>;
  /** Static analysis: extract reads/writes from cell source without running it. */
  analyseScope(source: string): Promise<CellAnalysis>;
  execute(source: string, opts: ExecuteOptions): AsyncIterable<OutputEvent>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  /** Names currently bound in the global scope. */
  definedNames(): Promise<ReadonlySet<string>>;
}
