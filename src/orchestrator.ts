/**
 * Reactive orchestrator: parser + DAG + kernel + adapters.
 *
 * Lifecycle on each editor change:
 *   1. parseCells(source)
 *   2. analyseScope on each cell whose hash changed (cached otherwise)
 *   3. buildDag → topoSort
 *   4. invalidate downstream-closure of any cell whose source hash changed
 *   5. execute stale cells in topo order, capturing OutputEvents
 *   6. route MIME bundles through AdapterRegistry → Typst content
 *   7. produce an "augmented source" with #cell-output(...) inserted after
 *      each cell, and hand it to the renderer
 *
 * v0 simplification: we splice outputs directly into the source rather than
 * writing them as separate _outputs/<id>.typ files for #include. Simpler
 * (no typst.ts VFS gymnastics) and reaches the same rendered result.
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
      this.events.onAugmentedSource(source);
      this.events.onStatus([]);
      return;
    }

    // 1. analyse only cells whose hash isn't cached. ownChanged tracks
    //    cells whose own source changed, separate from cells made stale by
    //    upstream propagation — needed for the lazy skip below.
    const analyses = new Map<string, CellAnalysis>();
    const changed = new Set<string>();
    const ownChanged = new Set<string>();
    for (const cell of cells) {
      const prevHash = this.knownHash.get(cell.id);
      if (prevHash !== cell.hash) {
        changed.add(cell.id);
        ownChanged.add(cell.id);
      }
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

    // 5. re-execute stale cells in topo order. A lazy cell with a cached
    //    result is skipped on upstream-only changes; only its own source
    //    edit, an explicit forceRun, or forceRunAllStale will re-execute it.
    //    The cell's status surfaces as "stale" so the user can see it's
    //    out of sync with upstream and choose to re-run manually.
    const cellById = new Map(cells.map((c) => [c.id, c]));
    const statuses: NodeStatus[] = [];
    for (const cellId of order) {
      const cell = cellById.get(cellId);
      if (!cell) continue;
      let result = this.outputCache.get(cellId);
      const wantsRun = stale.has(cellId) || !result;
      const skipLazy =
        cell.lazy &&
        result !== undefined &&
        !ownChanged.has(cellId) &&
        !this.forcedSet.has(cellId) &&
        !this.forceAll;
      if (wantsRun && !skipLazy) {
        // mark running before executing — but only if our source is still current
        if (source === this.currentSource) {
          this.events.onStatus(buildStatuses(cells, this.outputCache, cellId, "running", cycleMembers));
        }
        result = await runCell(cell, this.kernel, this.registry);
        this.outputCache.set(cellId, result);
      }
      const reportedState: CellState = skipLazy && wantsRun ? "stale" : result!.state;
      statuses.push({
        cellId,
        state: reportedState,
        ...(result!.durationMs ? { durationMs: result!.durationMs } : {}),
        ...(result!.errorMessage ? { error: result!.errorMessage } : {}),
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
