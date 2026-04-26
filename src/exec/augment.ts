/**
 * Splice `#cell-output[...]` blocks into the document source after each
 * `#cell(...)` call. Pure: takes the original source plus a lookup of
 * per-cell run results, returns the augmented source.
 *
 * Insertions happen in reverse source order so earlier ranges aren't
 * shifted while we're still iterating later ones.
 */

import type { Cell } from "../parser/types.ts";
import type { CellRunResult } from "./run-cell.ts";

export function augment(
  source: string,
  cells: readonly Cell[],
  getResult: (cellId: string) => CellRunResult | undefined,
): string {
  const sorted = [...cells].sort((a, b) => b.range.start - a.range.start);
  let out = source;
  for (const cell of sorted) {
    const result = getResult(cell.id);
    if (!result || (!result.typstOutput && result.state !== "error")) continue;
    const insertion = `\n\n#cell-output[\n${result.typstOutput}\n]`;
    out = out.slice(0, cell.range.end) + insertion + out.slice(cell.range.end);
  }
  return out;
}
