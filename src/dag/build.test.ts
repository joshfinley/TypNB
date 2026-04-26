import { describe, test, expect } from "vitest";
import { buildDag } from "./build.ts";
import type { CellAnalysis } from "./types.ts";
import type { Cell } from "../parser/types.ts";

const cell = (id: string): Cell => ({
  id,
  lang: "python",
  source: "",
  range: { start: 0, end: 0 },
  bodyRange: { start: 0, end: 0 },
  hash: id,
  lazy: false,
});

const analysis = (reads: string[], writes: string[]): CellAnalysis => ({
  reads: new Set(reads),
  writes: new Set(writes),
});

describe("buildDag", () => {
  test("connects a single writer to its reader", () => {
    const cells = [cell("A"), cell("B")];
    const dag = buildDag(
      cells,
      new Map([
        ["A", analysis([], ["x"])],
        ["B", analysis(["x"], [])],
      ]),
    );
    expect([...dag.get("B")!.upstream]).toEqual(["A"]);
    expect([...dag.get("A")!.downstream]).toEqual(["B"]);
  });

  test("uses last writer in source order when a symbol has multiple writers", () => {
    // A writes x, B writes x (shadows A), C reads x → C reads from B, not A.
    const cells = [cell("A"), cell("B"), cell("C")];
    const dag = buildDag(
      cells,
      new Map([
        ["A", analysis([], ["x"])],
        ["B", analysis([], ["x"])],
        ["C", analysis(["x"], [])],
      ]),
    );
    expect([...dag.get("C")!.upstream]).toEqual(["B"]);
    expect([...dag.get("A")!.downstream]).toEqual([]); // A's write is shadowed
  });

  test("ignores reads of names with no producer", () => {
    // C reads `undefined_name` → no edge, but no error either.
    const cells = [cell("C")];
    const dag = buildDag(
      cells,
      new Map([["C", analysis(["undefined_name"], [])]]),
    );
    expect([...dag.get("C")!.upstream]).toEqual([]);
  });

  test("does not create a self-loop when a cell reads its own writes", () => {
    // A writes x, A reads x — this is normal Python (e.g. `x = x + 1` after a
    // prior `x = ...` in the same cell). No self-edge.
    const cells = [cell("A")];
    const dag = buildDag(
      cells,
      new Map([["A", analysis(["x"], ["x"])]]),
    );
    expect([...dag.get("A")!.upstream]).toEqual([]);
  });

  test("source order matters: a reader before its writer has no edge", () => {
    // A reads x first; B writes x later. A can't depend on B.
    const cells = [cell("A"), cell("B")];
    const dag = buildDag(
      cells,
      new Map([
        ["A", analysis(["x"], [])],
        ["B", analysis([], ["x"])],
      ]),
    );
    expect([...dag.get("A")!.upstream]).toEqual([]);
    expect([...dag.get("B")!.downstream]).toEqual([]);
  });

  test("cell missing from analyses gets an empty analysis", () => {
    const cells = [cell("A")];
    const dag = buildDag(cells, new Map());
    expect(dag.get("A")!.analysis.reads.size).toBe(0);
    expect(dag.get("A")!.analysis.writes.size).toBe(0);
  });
});
