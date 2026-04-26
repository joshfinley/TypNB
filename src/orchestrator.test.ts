import { describe, test, expect } from "vitest";
import { Orchestrator, type PersistedState } from "./orchestrator.ts";
import type { Kernel } from "./kernel/types.ts";

// The persistence path doesn't touch the kernel — a stub is enough.
const noopKernel: Kernel = {
  init: async () => {},
  analyseScope: async () => ({ reads: new Set(), writes: new Set() }),
  execute: async function* () {},
  interrupt: async () => {},
  restart: async () => {},
  definedNames: async () => new Set<string>(),
};

const noopEvents = {
  onAugmentedSource: () => {},
  onStatus: () => {},
};

function makeOrchestrator() {
  return new Orchestrator(noopKernel, noopEvents);
}

describe("Orchestrator persistence", () => {
  test("getState on a fresh orchestrator returns empty entries", () => {
    const s = makeOrchestrator().getState();
    expect(s.version).toBe(1);
    expect(s.outputCache).toEqual([]);
    expect(s.analysisCache).toEqual([]);
    expect(s.knownHash).toEqual([]);
    expect(s.prevWrites).toEqual([]);
  });

  test("restoreState applies the shape and getState round-trips it", () => {
    const seed: PersistedState = {
      version: 1,
      outputCache: [
        [
          "c1",
          {
            cellId: "c1",
            state: "ok",
            typstOutput: "= hi",
            stdout: "",
            stderr: "",
            durationMs: 5,
          },
        ],
      ],
      analysisCache: [["abcdef", { reads: ["x"], writes: ["y"] }]],
      knownHash: [["c1", "abcdef"]],
      prevWrites: [["c1", ["y"]]],
    };
    const o = makeOrchestrator();
    o.restoreState(seed);
    // round-trip equality up to deep structure (Maps/Sets are exposed as arrays)
    expect(o.getState()).toEqual(seed);
  });

  test("survives a JSON.stringify → JSON.parse round-trip", () => {
    const seed: PersistedState = {
      version: 1,
      outputCache: [
        [
          "c1",
          {
            cellId: "c1",
            state: "error",
            typstOutput: "...",
            stdout: "",
            stderr: "err",
            errorMessage: "ValueError: nope",
            durationMs: 12,
          },
        ],
      ],
      analysisCache: [["h", { reads: ["a"], writes: [] }]],
      knownHash: [["c1", "h"]],
      prevWrites: [["c1", []]],
    };
    const o = makeOrchestrator();
    o.restoreState(JSON.parse(JSON.stringify(seed)));
    expect(o.getState()).toEqual(seed);
  });

  test("ignores invalid versions and shapes", () => {
    const o = makeOrchestrator();
    o.restoreState({ version: 999, outputCache: [], analysisCache: [], knownHash: [], prevWrites: [] });
    o.restoreState(null);
    o.restoreState("not an object");
    o.restoreState({ version: 1, outputCache: "wrong shape" });
    // After all that, state should still be empty.
    expect(o.getState().outputCache).toEqual([]);
  });
});
