import { describe, test, expect } from "vitest";
import { topoSort, downstreamClosure, CycleError } from "./schedule.ts";
import type { DagNode } from "./types.ts";

const node = (id: string, upstream: string[], downstream: string[]): DagNode =>
  ({
    cell: { id } as DagNode["cell"],
    analysis: { reads: new Set(), writes: new Set() },
    upstream: new Set(upstream),
    downstream: new Set(downstream),
  });

describe("topoSort", () => {
  test("orders a linear chain by dependency", () => {
    // A → B → C
    const dag = new Map([
      ["A", node("A", [], ["B"])],
      ["B", node("B", ["A"], ["C"])],
      ["C", node("C", ["B"], [])],
    ]);
    expect(topoSort(dag)).toEqual(["A", "B", "C"]);
  });

  test("throws CycleError carrying the cycle path", () => {
    const dag = new Map([
      ["A", node("A", ["B"], ["B"])],
      ["B", node("B", ["A"], ["A"])],
    ]);
    expect(() => topoSort(dag)).toThrow(CycleError);
    try {
      topoSort(dag);
    } catch (err) {
      expect(err).toBeInstanceOf(CycleError);
      const ce = err as CycleError;
      expect(ce.cells.length).toBeGreaterThanOrEqual(2);
      // Path closes the loop: first id repeats at the end.
      expect(ce.cells[0]).toBe(ce.cells[ce.cells.length - 1]);
    }
  });

  test("handles disconnected sub-graphs", () => {
    // A → B   and   C → D, no edge between them
    const dag = new Map([
      ["A", node("A", [], ["B"])],
      ["B", node("B", ["A"], [])],
      ["C", node("C", [], ["D"])],
      ["D", node("D", ["C"], [])],
    ]);
    const order = topoSort(dag);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  });
});

describe("downstreamClosure", () => {
  test("includes the seed plus everything reachable from its downstream", () => {
    // A → B → C, and B → D
    const dag = new Map([
      ["A", node("A", [], ["B"])],
      ["B", node("B", ["A"], ["C", "D"])],
      ["C", node("C", ["B"], [])],
      ["D", node("D", ["B"], [])],
    ]);
    expect([...downstreamClosure(dag, ["A"])].sort()).toEqual(["A", "B", "C", "D"]);
    expect([...downstreamClosure(dag, ["B"])].sort()).toEqual(["B", "C", "D"]);
    expect([...downstreamClosure(dag, ["C"])]).toEqual(["C"]);
  });

  test("dedupes when multiple seeds share descendants", () => {
    const dag = new Map([
      ["A", node("A", [], ["C"])],
      ["B", node("B", [], ["C"])],
      ["C", node("C", ["A", "B"], [])],
    ]);
    expect([...downstreamClosure(dag, ["A", "B"])].sort()).toEqual(["A", "B", "C"]);
  });

  test("returns the empty set for an empty seed", () => {
    const dag = new Map([["A", node("A", [], [])]]);
    expect([...downstreamClosure(dag, [])]).toEqual([]);
  });
});
