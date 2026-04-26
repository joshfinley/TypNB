/**
 * Per-cell executor. Owns the kernel→event→Typst-content adaptation:
 *   1. Drive the kernel's async event stream.
 *   2. Route MIME bundles through the adapter registry.
 *   3. Concatenate stdout / stderr / errors into a single Typst content
 *      string the orchestrator splices into the source.
 *
 * Pure with respect to orchestrator state: no caches, no DAG awareness.
 * Caller decides when to invoke; this module decides how.
 */

import type { Cell } from "../parser/types.ts";
import type { CellState } from "../dag/types.ts";
import type { Kernel, MimeBundle, OutputEvent } from "../kernel/types.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";

export interface CellRunResult {
  readonly cellId: string;
  readonly state: CellState;
  readonly typstOutput: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
}

export async function runCell(
  cell: Cell,
  kernel: Kernel,
  registry: AdapterRegistry,
): Promise<CellRunResult> {
  if (cell.lang !== "python") {
    // Non-Python cells aren't wired yet. Surface the gap loudly rather
    // than letting the cell render as a silent green dot — and so any cell
    // that depends on them (today: nothing, since analyseScope returns
    // empty for non-python) doesn't look mysteriously stale.
    const message = `unsupported cell language: ${cell.lang}`;
    return {
      cellId: cell.id,
      state: "error",
      typstOutput: asErrorBlock(message),
      stdout: "",
      stderr: "",
      durationMs: 0,
      errorMessage: message,
    };
  }

  const t0 = performance.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const outputTypst: string[] = [];
  let errorMessage: string | undefined;

  try {
    for await (const event of kernel.execute(cell.source, { cellId: cell.id })) {
      applyEvent(event, registry, stdoutChunks, stderrChunks, outputTypst, (e) => {
        errorMessage = `${e.name}: ${e.message}`;
      });
    }
  } catch (err) {
    errorMessage = (err as Error).message ?? String(err);
  }

  const durationMs = Math.round(performance.now() - t0);
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  let typstOutput = outputTypst.join("\n\n");
  if (stdout) typstOutput = (typstOutput ? typstOutput + "\n\n" : "") + asRawBlock(stdout);
  if (stderr) typstOutput = (typstOutput ? typstOutput + "\n\n" : "") + asErrorBlock(stderr);
  if (errorMessage) typstOutput = (typstOutput ? typstOutput + "\n\n" : "") + asErrorBlock(errorMessage);

  return {
    cellId: cell.id,
    state: errorMessage ? "error" : "ok",
    typstOutput,
    stdout,
    stderr,
    durationMs,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function applyEvent(
  event: OutputEvent,
  registry: AdapterRegistry,
  stdout: string[],
  stderr: string[],
  outputs: string[],
  onError: (e: { name: string; message: string }) => void,
): void {
  switch (event.kind) {
    case "stdout":
      stdout.push(event.data);
      return;
    case "stderr":
      stderr.push(event.data);
      return;
    case "result":
    case "display": {
      const bundle: MimeBundle = event.data;
      outputs.push(registry.renderHtml(bundle).typst);
      return;
    }
    case "error":
      onError({ name: event.name, message: event.message });
      return;
  }
}

function asRawBlock(s: string): string {
  // Insert a zero-width space inside any literal ``` so the user's text
  // doesn't prematurely close our wrapping raw block.
  return "```\n" + s.replace(/```/g, "``​`") + "\n```";
}

function asErrorBlock(s: string): string {
  // Re-use the unsupported badge style for now; a dedicated #cell-error helper comes later.
  return `#block(width: 100%, fill: rgb("#fef2f2"), stroke: (left: 2pt + rgb("#dc2626")), inset: (x: 12pt, y: 10pt), radius: (right: 4pt))[${asRawBlock(s)}]`;
}
