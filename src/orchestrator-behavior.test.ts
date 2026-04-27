import { describe, test, expect } from "vitest";
import { Orchestrator, type OrchestratorEvents } from "./orchestrator.ts";
import type { Kernel, OutputEvent } from "./kernel/types.ts";
import type { CellAnalysis, NodeStatus } from "./dag/types.ts";
import type { Cell } from "./parser/types.ts";

/**
 * Recording mock kernel. Tracks every execute() call so tests can verify
 * which cells actually ran. analyseScope returns a configurable reads/writes
 * map keyed by source body.
 */
class MockKernel implements Kernel {
  readonly executions: { cellId: string; source: string }[] = [];
  /** Keyed by exact source string. Defaults to empty reads/writes if missing. */
  readonly analyses = new Map<string, CellAnalysis>();
  /** Optional event stream emitted on execute, keyed by cell source. */
  readonly events = new Map<string, OutputEvent[]>();

  async init(): Promise<void> {}

  async analyseScope(source: string): Promise<CellAnalysis> {
    return this.analyses.get(source) ?? { reads: new Set(), writes: new Set() };
  }

  async *execute(source: string, opts: { cellId: string }): AsyncIterable<OutputEvent> {
    this.executions.push({ cellId: opts.cellId, source });
    const events = this.events.get(source) ?? [];
    for (const e of events) yield e;
  }

  async interrupt(): Promise<void> {}
  async restart(): Promise<void> {}
  async definedNames(): Promise<ReadonlySet<string>> { return new Set(); }
}

/**
 * Drain the orchestrator's async pipeline. Several macrotask ticks so
 * crypto.subtle.digest (which parseCells awaits per cell) and the inner
 * drain loop both get to flush.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const cellSrc = (id: string, body: string, extras = "") =>
  `#cell(id: "${id}", lang: "python"${extras})[\`\`\`python\n${body}\n\`\`\`]`;

interface Recorder {
  events: OrchestratorEvents;
  statuses: NodeStatus[][];
  cellSnapshots: Cell[][];
  augmented: string[];
  stateChanges: number;
}
function recorder(): Recorder {
  const r: Recorder = {
    statuses: [],
    cellSnapshots: [],
    augmented: [],
    stateChanges: 0,
    events: {
      onAugmentedSource: (s) => { r.augmented.push(s); },
      onStatus: (s) => { r.statuses.push([...s]); },
      onCells: (cs) => { r.cellSnapshots.push([...cs]); },
      onStateChanged: () => { r.stateChanges += 1; },
    },
  };
  return r;
}

async function freshOrchestrator() {
  const kernel = new MockKernel();
  const r = recorder();
  const o = new Orchestrator(kernel, r.events);
  return { kernel, r, o };
}

describe("Orchestrator manual-mode behaviour", () => {
  test("opening a doc with cells does NOT auto-execute anything", async () => {
    const { kernel, o, r } = await freshOrchestrator();
    o.update(`${cellSrc("a", "x = 1")}\n${cellSrc("b", "y = 2")}`);
    await settle();
    expect(kernel.executions).toEqual([]);
    // Statuses should report idle for both — never executed, no cached result.
    const last = r.statuses.at(-1)!;
    expect(last.map((s) => s.state)).toEqual(["idle", "idle"]);
    // No state-change persistence needed — nothing actually ran.
    expect(r.stateChanges).toBe(0);
  });

  test("forceRun executes only the targeted cell when downstream is empty", async () => {
    const { kernel, o, r } = await freshOrchestrator();
    o.update(cellSrc("solo", "x = 1"));
    await settle();
    expect(kernel.executions).toEqual([]);
    o.forceRun("solo");
    await settle();
    expect(kernel.executions.map((e) => e.cellId)).toEqual(["solo"]);
    expect(r.stateChanges).toBe(1);
  });

  test("forceRun on an upstream cell ALSO runs downstream cells (closure)", async () => {
    const { kernel, o } = await freshOrchestrator();
    // a writes x; b reads x → b is downstream of a. forceRun(a) should
    // re-execute b too, even though the user only clicked ▶ on a.
    // Cell bodies are exactly the text between ```python\n and ```.
    kernel.analyses.set("x = 1\n", { reads: new Set(), writes: new Set(["x"]) });
    kernel.analyses.set("print(x)\n", { reads: new Set(["x"]), writes: new Set() });
    o.update(`${cellSrc("a", "x = 1")}\n${cellSrc("b", "print(x)")}`);
    await settle();
    expect(kernel.executions).toEqual([]);
    o.forceRun("a");
    await settle();
    expect(kernel.executions.map((e) => e.cellId).sort()).toEqual(["a", "b"]);
  });

  test("editing a cell marks it stale but does not execute it", async () => {
    const { kernel, o, r } = await freshOrchestrator();
    o.update(cellSrc("a", "x = 1"));
    await settle();
    o.forceRun("a");
    await settle();
    expect(kernel.executions.length).toBe(1);
    // Edit the cell — hash changes, cell is stale, but no auto-execute.
    o.update(cellSrc("a", "x = 999"));
    await settle();
    expect(kernel.executions.length).toBe(1); // still just the original run
    const last = r.statuses.at(-1)!;
    expect(last[0]!.state).toBe("stale");
  });

  test("forceRunAllStale runs every cell currently in the stale set", async () => {
    const { kernel, o } = await freshOrchestrator();
    o.update(`${cellSrc("a", "x = 1")}\n${cellSrc("b", "y = 2")}`);
    await settle();
    o.forceRunAllStale();
    await settle();
    expect(kernel.executions.map((e) => e.cellId).sort()).toEqual(["a", "b"]);
  });

  test("force flags are cleared after the run — a subsequent unrelated edit doesn't re-trigger them", async () => {
    const { kernel, o } = await freshOrchestrator();
    o.update(cellSrc("a", "x = 1"));
    await settle();
    o.forceRun("a");
    await settle();
    expect(kernel.executions.length).toBe(1);
    // Edit the cell — should NOT re-execute even though forceRun was just used.
    o.update(cellSrc("a", "x = 2"));
    await settle();
    expect(kernel.executions.length).toBe(1);
  });

  test("cellAtOffset resolves cursor position to the containing cell's id", async () => {
    const { o } = await freshOrchestrator();
    const a = cellSrc("a", "x = 1");
    const b = cellSrc("b", "y = 2");
    o.update(`${a}\n${b}`);
    await settle();
    // Offset 0 is inside cell a; an offset deep inside the doc lands in b.
    expect(o.cellAtOffset(0)).toBe("a");
    expect(o.cellAtOffset(a.length + 5)).toBe("b");
    // Past the end → null.
    expect(o.cellAtOffset(a.length + b.length + 100)).toBe(null);
  });

  test("hidden cells parse and surface in onCells with hidden=true", async () => {
    const { o, r } = await freshOrchestrator();
    o.update(cellSrc("a", "x = 1", `, hidden: true`));
    await settle();
    const lastCells = r.cellSnapshots.at(-1)!;
    expect(lastCells[0]!.hidden).toBe(true);
  });

  test("emits an augmented source containing cell-output for cells that have run", async () => {
    const { kernel, o, r } = await freshOrchestrator();
    kernel.events.set("x = 1\n", [
      { kind: "stdout", data: "hello\n" },
    ]);
    o.update(cellSrc("a", "x = 1"));
    await settle();
    o.forceRun("a");
    await settle();
    const last = r.augmented.at(-1)!;
    expect(last).toContain("#cell-output[");
    expect(last).toContain("hello");
  });

  test("preserves newlines across multiple stdout chunks (regression)", async () => {
    // Pyodide's batched callback delivers each line WITHOUT its trailing
    // newline; the worker re-appends "\n" before posting events. If that
    // ever regresses, multiple print() calls collapse onto one line.
    const { kernel, o, r } = await freshOrchestrator();
    kernel.events.set("x = 1\n", [
      { kind: "stdout", data: "first\n" },
      { kind: "stdout", data: "second\n" },
    ]);
    o.update(cellSrc("a", "x = 1"));
    await settle();
    o.forceRun("a");
    await settle();
    const last = r.augmented.at(-1)!;
    // Both lines present, in order, with a real newline between them
    // (not just adjacent text — that would be the regression).
    expect(last).toMatch(/first\nsecond/);
  });
});
