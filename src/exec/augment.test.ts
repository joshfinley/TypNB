import { describe, test, expect } from "vitest";
import { augment } from "./augment.ts";
import type { CellRunResult } from "./run-cell.ts";
import type { Cell } from "../parser/types.ts";

const mkCell = (id: string, start: number, end: number, hidden = false): Cell => ({
  id,
  lang: "python",
  source: "",
  range: { start, end },
  bodyRange: { start: start + 5, end: end - 1 },
  hash: id,
  lazy: false,
  hidden,
});

const mkResult = (id: string, typstOutput: string, state: CellRunResult["state"] = "ok"): CellRunResult => ({
  cellId: id,
  state,
  typstOutput,
  stdout: "",
  stderr: "",
  durationMs: 1,
});

describe("augment", () => {
  test("inserts cell-output blocks after each cell", () => {
    const source = "[cell A][cell B]";
    const cells = [mkCell("a", 0, 8), mkCell("b", 8, 16)];
    const results = new Map<string, CellRunResult>([
      ["a", mkResult("a", "out-a")],
      ["b", mkResult("b", "out-b")],
    ]);
    const out = augment(source, cells, (id) => results.get(id));
    expect(out).toBe("[cell A]\n\n#cell-output[\nout-a\n][cell B]\n\n#cell-output[\nout-b\n]");
  });

  test("skips cells with no result", () => {
    const source = "[cell A][cell B]";
    const cells = [mkCell("a", 0, 8), mkCell("b", 8, 16)];
    const results = new Map<string, CellRunResult>([["a", mkResult("a", "out-a")]]);
    const out = augment(source, cells, (id) => results.get(id));
    expect(out).toBe("[cell A]\n\n#cell-output[\nout-a\n][cell B]");
  });

  test("emits an output for an error result even if typstOutput is empty", () => {
    const source = "[cell A]";
    const cells = [mkCell("a", 0, 8)];
    const results = new Map<string, CellRunResult>([
      ["a", { ...mkResult("a", "", "error"), errorMessage: "boom" }],
    ]);
    const out = augment(source, cells, (id) => results.get(id));
    expect(out).toContain("#cell-output[");
  });

  test("inserts in reverse source order so earlier ranges aren't shifted", () => {
    // Ranges are processed back-to-front so earlier-cell offsets stay valid
    // while we mutate later regions of the source. Multi-cell ordering test.
    const source = "AAAABBBBCCCC";
    const cells = [mkCell("a", 0, 4), mkCell("b", 4, 8), mkCell("c", 8, 12)];
    const results = new Map<string, CellRunResult>([
      ["a", mkResult("a", "1")],
      ["b", mkResult("b", "2")],
      ["c", mkResult("c", "3")],
    ]);
    const out = augment(source, cells, (id) => results.get(id));
    // All three outputs land in the right slots, in document order.
    expect(out).toBe("AAAA\n\n#cell-output[\n1\n]BBBB\n\n#cell-output[\n2\n]CCCC\n\n#cell-output[\n3\n]");
  });

  test("hidden cells still get their output spliced — template suppresses the source, not the output", () => {
    const source = "[cell A]";
    const cells = [mkCell("a", 0, 8, true)];
    const results = new Map<string, CellRunResult>([["a", mkResult("a", "out-a")]]);
    const out = augment(source, cells, (id) => results.get(id));
    expect(out).toContain("#cell-output[\nout-a\n]");
  });

  test("returns source unchanged when no cells", () => {
    expect(augment("hello", [], () => undefined)).toBe("hello");
  });
});
