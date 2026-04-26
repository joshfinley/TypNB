/**
 * Manual-mode orchestrator: parser + DAG + kernel + adapters.
 *
 * Lifecycle on each editor change:
 *   1. parseCells(source)
 *   2. analyseScope on each cell whose hash changed (cached otherwise)
 *   3. buildDag → topoSort
 *   4. compute the stale set (downstream-closure of changed cells)
 *   5. ONLY execute cells the user explicitly forced via forceRun /
 *      forceRunAllStale. Stale-but-unforced cells keep their cached
 *      output and surface as "stale" in the status pills.
 *   6. produce an "augmented source" splicing in cached outputs for
 *      cells that have a result; cells without one render as plain.
 *
 * The auto-execute model worked for tiny notebooks but became hostile
 * once a single cell took >1s — every keystroke triggered cascading
 * runs. Now the user runs cells explicitly (gutter ▶ / Cmd-Enter /
 * Cmd-Shift-Enter) and the DAG only tells them what's stale.
 */

import { parseCells } from "./parser/parse.ts";
import type { Cell } from "./parser/types.ts";
import { buildDag } from "./dag/build.ts";
import { topoSort, downstreamClosure, CycleError } from "./dag/schedule.ts";
import type { CellAnalysis, CellState, NodeStatus } from "./dag/types.ts";
import type { Kernel } from "./kernel/types.ts";
import { AdapterRegistry } from "./adapters/registry.ts";
import { plainAdapter } from "./adapters/plain.ts";
import { typstPassthroughAdapter } from "./adapters/typst-passthrough.ts";
import { matplotlibAdapter } from "./adapters/matplotlib.ts";
import { pandasAdapter } from "./adapters/pandas.ts";
import { runCell, type CellRunResult } from "./exec/run-cell.ts";
import { augment } from "./exec/augment.ts";

export interface OrchestratorEvents {
  /** Called whenever the augmented Typst source changes (post-execute, or on parse-only updates). */
  onAugmentedSource(source: string): void;
  /** Called when per-cell statuses change. */
  onStatus(statuses: readonly NodeStatus[]): void;
  /** Called after each parse with the current cells, so the editor can sync gutter markers. */
  onCells?(cells: readonly Cell[]): void;
  /**
   * Fires after a run that actually executed at least one cell — i.e. when
   * the persisted state would change. App layer hooks this to schedule a
   * debounced write of `getState()` to the FS.
   */
  onStateChanged?(): void;
}

/**
 * JSON-friendly snapshot of the orchestrator's reload-relevant state.
 * Versioned so the format can evolve; restoreState ignores any payload
 * whose `version` doesn't match.
 */
export interface PersistedState {
  readonly version: 1;
  readonly outputCache: ReadonlyArray<readonly [string, CellRunResult]>;
  readonly analysisCache: ReadonlyArray<readonly [string, { reads: string[]; writes: string[] }]>;
  readonly knownHash: ReadonlyArray<readonly [string, string]>;
  readonly prevWrites: ReadonlyArray<readonly [string, string[]]>;
}

export class Orchestrator {
  private readonly registry = new AdapterRegistry();
  private readonly analysisCache = new Map<string, CellAnalysis>(); // hash → analysis
  private readonly outputCache = new Map<string, CellRunResult>();   // cellId → last result
  private currentSource = "";
  private inflight: Promise<void> | null = null;
  private pendingSource: string | null = null;
  private knownHash = new Map<string, string>(); // cellId → last hash
  private prevWrites = new Map<string, ReadonlySet<string>>(); // cellId → last analysis.writes
  private currentCells: readonly Cell[] = [];
  /** Cells whose lazy skip is overridden for the next run. Cleared after each runOnce. */
  private forcedSet = new Set<string>();
  /** When true, lazy skip is overridden for the entire stale set. Cleared after each runOnce. */
  private forceAll = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly events: OrchestratorEvents,
  ) {
    for (const a of [
      typstPassthroughAdapter,
      pandasAdapter,
      matplotlibAdapter,
      plainAdapter,
    ]) {
      this.registry.register(a);
    }
  }

  /** Schedule a reactive run. Coalesces concurrent calls — only the latest source wins. */
  update(source: string): void {
    this.pendingSource = source;
    if (this.inflight) return;
    void this.drain();
  }

  /**
   * Force-run a single cell: overrides its lazy skip and re-executes it
   * plus its downstream closure on the next run. Downstream lazy cells
   * stay skipped — they only re-run if the user forces them too.
   */
  forceRun(cellId: string): void {
    this.forcedSet.add(cellId);
    this.update(this.currentSource);
  }

  /**
   * Override lazy skips for the entire current stale set on the next run.
   * Used by "run all stale" — re-runs every cell that's marked dirty,
   * including ones the user has flagged lazy.
   */
  forceRunAllStale(): void {
    this.forceAll = true;
    this.update(this.currentSource);
  }

  /**
   * Resolve a document offset to the cell whose `#cell(...)` call contains
   * it, or null if the cursor is outside any cell. Used by the editor's
   * "run current cell" keybind.
   */
  cellAtOffset(offset: number): string | null {
    for (const cell of this.currentCells) {
      if (offset >= cell.range.start && offset <= cell.range.end) return cell.id;
    }
    return null;
  }

  /** Snapshot the reload-relevant state in a JSON-friendly shape. */
  getState(): PersistedState {
    return {
      version: 1,
      outputCache: [...this.outputCache.entries()],
      analysisCache: [...this.analysisCache.entries()].map(([h, a]) => [
        h,
        { reads: [...a.reads], writes: [...a.writes] },
      ]),
      knownHash: [...this.knownHash.entries()],
      prevWrites: [...this.prevWrites.entries()].map(([id, set]) => [id, [...set]]),
    };
  }

  /**
   * Replace the orchestrator's caches with a previously snapshotted state.
   * Silently no-ops if the version doesn't match — caller can decide to
   * start fresh. Stale entries (cells no longer in the source) are pruned
   * naturally on the next runOnce.
   */
  restoreState(state: unknown): void {
    if (!isValidState(state)) return;
    this.outputCache.clear();
    for (const [k, v] of state.outputCache) this.outputCache.set(k, v);
    this.analysisCache.clear();
    for (const [h, a] of state.analysisCache) {
      this.analysisCache.set(h, { reads: new Set(a.reads), writes: new Set(a.writes) });
    }
    this.knownHash.clear();
    for (const [k, v] of state.knownHash) this.knownHash.set(k, v);
    this.prevWrites.clear();
    for (const [k, arr] of state.prevWrites) this.prevWrites.set(k, new Set(arr));
  }

  private async drain(): Promise<void> {
    while (this.pendingSource !== null) {
      const source = this.pendingSource;
      this.pendingSource = null;
      this.inflight = this.runOnce(source);
      try {
        await this.inflight;
      } finally {
        this.inflight = null;
      }
    }
  }

  private async runOnce(source: string): Promise<void> {
    this.currentSource = source;
    const cells = await parseCells(source);
    const cellIds = new Set(cells.map((c) => c.id));

    if (cells.length === 0) {
      // No cells → just hand the source through unchanged. Clear stale state
      // so subsequent runs don't reuse outputs from cells the user deleted.
      this.outputCache.clear();
      this.knownHash.clear();
      this.prevWrites.clear();
      this.currentCells = [];
      this.forcedSet.clear();
      this.forceAll = false;
      this.events.onCells?.([]);
      this.events.onAugmentedSource(source);
      this.events.onStatus([]);
      return;
    }
    // Surface cells to the editor immediately so gutter markers update
    // even before any kernel-bound analyse step completes.
    this.events.onCells?.(cells);

    // 1. analyse only cells whose hash isn't cached.
    const analyses = new Map<string, CellAnalysis>();
    const changed = new Set<string>();
    for (const cell of cells) {
      const prevHash = this.knownHash.get(cell.id);
      if (prevHash !== cell.hash) changed.add(cell.id);
      this.knownHash.set(cell.id, cell.hash);

      let a = this.analysisCache.get(cell.hash);
      if (!a) {
        if (cell.lang === "python") {
          try {
            a = await this.kernel.analyseScope(cell.source);
            this.analysisCache.set(cell.hash, a);
          } catch {
            a = { reads: new Set(), writes: new Set() };
          }
        } else {
          a = { reads: new Set(), writes: new Set() };
        }
      }
      analyses.set(cell.id, a);
    }

    // 2. invalidate readers when the structure of writes shifts. Captures:
    //   - a writer was deleted (its old symbols are now provided by an
    //     earlier writer, or by no one)
    //   - a cell's writes set shrank or grew
    //   - a cell that used to write a symbol no longer does
    // Without this, hash-only invalidation misses topology changes that
    // weren't a direct edit to the affected reader.
    const symsTouched = new Set<string>();
    for (const cell of cells) {
      const prev = this.prevWrites.get(cell.id);
      const curr = analyses.get(cell.id)!.writes;
      if (!setsEqual(prev, curr)) {
        if (prev) for (const s of prev) symsTouched.add(s);
        for (const s of curr) symsTouched.add(s);
      }
    }
    for (const [id, prev] of this.prevWrites) {
      if (!cellIds.has(id)) for (const s of prev) symsTouched.add(s);
    }
    if (symsTouched.size > 0) {
      for (const cell of cells) {
        const a = analyses.get(cell.id)!;
        for (const r of a.reads) {
          if (symsTouched.has(r)) {
            changed.add(cell.id);
            break;
          }
        }
      }
    }

    // 3. build DAG, find what's stale. Force-run cells seed the closure too,
    //    so downstream propagation kicks in for cells the user explicitly
    //    re-ran (their own re-run is enforced by the lazy-skip override below).
    const dag = buildDag(cells, analyses);
    const staleSeeds = new Set<string>(changed);
    for (const id of this.forcedSet) staleSeeds.add(id);
    const stale = downstreamClosure(dag, staleSeeds);

    // 4. topo-order; on cycle, mark cycle members as error and run the rest.
    let order: string[];
    let cycleMembers: ReadonlySet<string> = new Set();
    try {
      order = topoSort(dag);
    } catch (err) {
      if (!(err instanceof CycleError)) throw err;
      cycleMembers = new Set(err.cells);
      // Schedule everything outside the cycle in a stable order; cycle members
      // are reported but not executed.
      order = cells.filter((c) => !cycleMembers.has(c.id)).map((c) => c.id);
    }

    // 5. execute only cells the user explicitly forced. Everything else
    //    keeps its cached result (or stays "idle" if never run). Stale
    //    cells with a cached result surface as "stale" so the user can
    //    spot what's out of sync with the current source and decide.
    const cellById = new Map(cells.map((c) => [c.id, c]));
    const statuses: NodeStatus[] = [];
    let didExecute = false;
    for (const cellId of order) {
      const cell = cellById.get(cellId);
      if (!cell) continue;
      let result = this.outputCache.get(cellId);
      const isForced =
        this.forcedSet.has(cellId) || (this.forceAll && stale.has(cellId));
      if (isForced) {
        if (source === this.currentSource) {
          this.events.onStatus(buildStatuses(cells, this.outputCache, cellId, "running", cycleMembers));
        }
        result = await runCell(cell, this.kernel, this.registry);
        this.outputCache.set(cellId, result);
        didExecute = true;
      }
      let reportedState: CellState;
      if (!result) reportedState = "idle";
      else if (stale.has(cellId)) reportedState = "stale";
      else reportedState = result.state;
      statuses.push({
        cellId,
        state: reportedState,
        ...(result?.durationMs ? { durationMs: result.durationMs } : {}),
        ...(result?.errorMessage ? { error: result.errorMessage } : {}),
      });
    }
    // Append cycle members as error statuses.
    for (const cellId of cycleMembers) {
      statuses.push({
        cellId,
        state: "error",
        error: `cycle: ${[...cycleMembers].join(" → ")}`,
      });
    }

    // 6. evict caches for cells/hashes that no longer exist
    const liveHashes = new Set(cells.map((c) => c.hash));
    for (const id of this.outputCache.keys()) if (!cellIds.has(id)) this.outputCache.delete(id);
    for (const id of this.knownHash.keys()) if (!cellIds.has(id)) this.knownHash.delete(id);
    for (const h of this.analysisCache.keys()) if (!liveHashes.has(h)) this.analysisCache.delete(h);
    this.prevWrites.clear();
    for (const cell of cells) this.prevWrites.set(cell.id, analyses.get(cell.id)!.writes);
    this.currentCells = cells;
    // Force flags consumed; clear so the next run is back to normal reactive.
    this.forcedSet.clear();
    this.forceAll = false;

    // 7. emit augmented source + final statuses
    if (source === this.currentSource) {
      this.events.onAugmentedSource(augment(source, cells, (id) => this.outputCache.get(id)));
      this.events.onStatus(statuses);
    }
    // 8. notify the persistence layer if the run actually mutated state.
    //    Pure parse/DAG runs don't need a save — knownHash and outputCache
    //    didn't change in any user-visible way.
    if (didExecute) this.events.onStateChanged?.();
  }
}

function buildStatuses(
  cells: readonly Cell[],
  cache: ReadonlyMap<string, CellRunResult>,
  runningId: string,
  runningState: CellState,
  cycleMembers: ReadonlySet<string>,
): NodeStatus[] {
  return cells.map((c) => {
    if (cycleMembers.has(c.id)) return { cellId: c.id, state: "error" as CellState };
    if (c.id === runningId) return { cellId: c.id, state: runningState };
    const r = cache.get(c.id);
    return r
      ? { cellId: c.id, state: r.state, ...(r.durationMs ? { durationMs: r.durationMs } : {}) }
      : { cellId: c.id, state: "idle" as CellState };
  });
}

function setsEqual(a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean {
  if (!a) return false;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function isValidState(s: unknown): s is PersistedState {
  return (
    typeof s === "object" &&
    s !== null &&
    (s as { version?: unknown }).version === 1 &&
    Array.isArray((s as { outputCache?: unknown }).outputCache) &&
    Array.isArray((s as { analysisCache?: unknown }).analysisCache) &&
    Array.isArray((s as { knownHash?: unknown }).knownHash) &&
    Array.isArray((s as { prevWrites?: unknown }).prevWrites)
  );
}
