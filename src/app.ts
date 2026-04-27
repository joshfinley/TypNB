/**
 * Top-level wiring. Composes layers; helpers live in src/app/*. The bulk
 * of mountApp is now lifecycle (mount, kernel init, restore state, hook
 * orchestrator events, mount editor, register pagehide).
 *
 * Layers, top-down:
 *   ui/           — editor, preview, status (DOM only)
 *   renderer/     — typst.ts wrapper (compiles .typ -> SVG)
 *   orchestrator  — parser + DAG + kernel + adapters
 *   parser/       — extracts #cell(...) calls from .typ source
 *   dag/          — reactive DAG over cells
 *   exec/         — per-cell execution + augmented-source splice
 *   kernel/       — Pyodide in a Web Worker
 *   adapters/     — MIME -> Typst content
 *   fs/           — virtual filesystem (OPFS / memory)
 *   app/          — persistence, source-edit helpers, topbar DOM, file mgmt
 */

import { mountEditor, type EditorHandle } from "./ui/editor.ts";
import { mountPreview } from "./ui/preview.ts";
import { mountStatus } from "./ui/status.ts";
import { createTypstRenderer } from "./renderer/typst-wasm.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PyodideKernel } from "./kernel/pyodide.ts";
import notebookTemplate from "./templates/notebook.typ?raw";
import sampleDoc from "./templates/sample.typ?raw";
import type { NodeStatus } from "./dag/types.ts";
import { initFileSystem, loadOrSeed, loadPersistedState } from "./app/persist.ts";
import { findCellArgsRange, toggleHiddenInArgs } from "./app/cells-edit.ts";
import {
  mountMobileToggle,
  renderCellStatuses,
  toMarkerState,
} from "./app/topbar.ts";
import {
  createNotebook,
  deleteNotebook,
  getActivePath,
  listNotebooks,
  nameFromPath,
  outputsPathFor,
  pathFromName,
  renameNotebook,
  setActivePath,
} from "./app/files.ts";
import { mountFileMenu } from "./app/file-menu.ts";

/** Debounce after the last keystroke before kicking the orchestrator. */
const PARSE_DEBOUNCE_MS = 300;
/** Debounce after the last keystroke before persisting the doc to FS. */
const SAVE_DEBOUNCE_MS = 600;
/** Debounce after a state-change event before persisting outputs to FS. */
const OUTPUTS_SAVE_DEBOUNCE_MS = 600;

export async function mountApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <header class="topbar">
      <span class="logo">Notebook</span>
      <span class="filename" id="fname"></span>
      <span class="cells-status" id="cells-status"></span>
      <span class="spacer"></span>
      <button class="mobile-toggle" id="mobile-toggle" aria-label="Toggle pane">⇄</button>
      <span class="status-host" id="status-host"></span>
    </header>
    <main class="split">
      <section class="pane editor-pane" id="editor-host"></section>
      <section class="pane preview-pane" id="preview-host"></section>
    </main>
  `;

  const editorHost = root.querySelector<HTMLElement>("#editor-host")!;
  const previewHost = root.querySelector<HTMLElement>("#preview-host")!;
  const statusHost = root.querySelector<HTMLElement>("#status-host")!;
  const cellsStatus = root.querySelector<HTMLElement>("#cells-status")!;
  const mobileToggle = root.querySelector<HTMLButtonElement>("#mobile-toggle")!;
  const fnameLabel = root.querySelector<HTMLElement>("#fname")!;

  const fs = await initFileSystem();
  let currentPath = getActivePath();
  // Make sure the active file actually exists; if it was deleted out-of-band
  // (e.g. another tab), fall back to /main.typ which loadOrSeed creates.
  const initialDoc = await loadOrSeed(fs, currentPath, sampleDoc);
  setActivePath(currentPath);
  const initialOutputs = await loadPersistedState(fs, outputsPathFor(currentPath));

  const renderer = await createTypstRenderer();
  const status = mountStatus(statusHost);
  const preview = mountPreview(previewHost);

  // Pyodide cold-load takes ~10s; surface that via the status pill instead
  // of leaving the user staring at a "ready" indicator while nothing happens.
  const kernel = new PyodideKernel();
  let kernelReady = false;
  status.set("kernel-loading");
  void kernel
    .init()
    .then(() => {
      kernelReady = true;
      status.set("ok");
    })
    .catch((err) => {
      console.error("kernel init failed:", err);
      status.set("error", "kernel init failed");
    });

  await renderer.setExtraSource("/notebook.typ", notebookTemplate);

  // Editor is declared here so the orchestrator callbacks can capture it,
  // and assigned below — events fire only after orchestrator.update runs,
  // which is after the assignment.
  let editor: EditorHandle | undefined;

  let lastStatuses: readonly NodeStatus[] = [];
  interface CellSnapshot {
    id: string;
    lang: string;
    range: { start: number; end: number };
    bodyRange: { start: number; end: number };
    hidden: boolean;
  }
  let lastCells: readonly CellSnapshot[] = [];

  function syncEditorMarkers() {
    if (!editor) return;
    const stateById = new Map(lastStatuses.map((s) => [s.cellId, s.state]));
    editor.setCells(
      lastCells.map((c) => ({
        from: c.range.start,
        to: c.range.end,
        bodyFrom: c.bodyRange.start,
        bodyTo: c.bodyRange.end,
        cellId: c.id,
        lang: c.lang,
        state: toMarkerState(stateById.get(c.id)),
        hidden: c.hidden,
      })),
    );
  }

  let outputsSaveTimer: number | undefined;
  function schedulePersistOutputs() {
    if (outputsSaveTimer) clearTimeout(outputsSaveTimer);
    outputsSaveTimer = window.setTimeout(() => {
      const snapshot = orchestrator.getState();
      const target = outputsPathFor(currentPath);
      void fs
        .writeText(target, JSON.stringify(snapshot))
        .catch((err) => console.error(`failed to save ${target}:`, err));
    }, OUTPUTS_SAVE_DEBOUNCE_MS);
  }

  const orchestrator = new Orchestrator(kernel, {
    onAugmentedSource: (source) => {
      void compile(source);
    },
    onStatus: (statuses) => {
      lastStatuses = statuses;
      renderCellStatuses(cellsStatus, statuses);
      syncEditorMarkers();
    },
    onCells: (cells) => {
      lastCells = cells.map((c) => ({
        id: c.id,
        lang: c.lang,
        range: { ...c.range },
        bodyRange: { ...c.bodyRange },
        hidden: c.hidden,
      }));
      syncEditorMarkers();
    },
    onStateChanged: () => schedulePersistOutputs(),
  });

  // Restore cached outputs/analyses BEFORE the first update — otherwise
  // the first parse runs with empty knownHash, marks every cell changed,
  // and the augmented source compiles without any cell outputs spliced in.
  if (initialOutputs) orchestrator.restoreState(initialOutputs);

  let compileTimer: number | undefined;
  let saveTimer: number | undefined;
  let inflight = 0;
  /** Most recent source we successfully compiled. Used to short-circuit
   *  re-compiles when a parse fires but the spliced source is identical
   *  (typing in prose between cells, etc.). */
  let lastCompiledSource: string | undefined;

  function scheduleUpdate(source: string) {
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = window.setTimeout(() => orchestrator.update(source), PARSE_DEBOUNCE_MS);
    if (saveTimer) clearTimeout(saveTimer);
    const target = currentPath;
    saveTimer = window.setTimeout(() => {
      void fs.writeText(target, source).catch((err) =>
        console.error(`failed to save ${target}:`, err),
      );
    }, SAVE_DEBOUNCE_MS);
  }

  async function compile(source: string) {
    // typst.ts compile is the most expensive thing in the per-edit loop
    // (50–400ms depending on doc size). The orchestrator emits the augmented
    // source on every parse — even when the parse is just hash bookkeeping
    // and no cell ran — so most of those emissions land here with the same
    // source we just compiled. Skip those.
    if (source === lastCompiledSource) return;
    const ticket = ++inflight;
    if (kernelReady) status.set("compiling");
    try {
      const t0 = performance.now();
      const result = await renderer.compile(source);
      if (ticket !== inflight) return;
      preview.render(result);
      lastCompiledSource = source;
      if (kernelReady) status.set("ok", `${Math.round(performance.now() - t0)}ms`);
    } catch (err) {
      if (ticket !== inflight) return;
      preview.renderError(String(err));
      status.set("error");
    }
  }

  function toggleCellHidden(cellId: string) {
    if (!editor) return;
    const cell = lastCells.find((c) => c.id === cellId);
    if (!cell) return;
    const args = findCellArgsRange(editor.getDoc(), cell.range.start, cell.range.end);
    if (!args) return;
    editor.replaceRange(args.argsStart, args.argsEnd, toggleHiddenInArgs(args.argsText));
    if (compileTimer) {
      clearTimeout(compileTimer);
      compileTimer = undefined;
    }
    orchestrator.update(editor.getDoc());
  }

  /**
   * Switch the open notebook to `nextPath`. Flushes any pending save of
   * the outgoing file, then resets the orchestrator and editor for the
   * incoming one. Source / outputs are loaded from disk; if the new file
   * is fresh it gets seeded from the sample template (matching how a
   * brand-new notebook just-created via the menu shows something useful).
   */
  async function switchToFile(nextPath: string): Promise<void> {
    if (nextPath === currentPath) return;
    // Flush outgoing file's pending writes synchronously into the request
    // queue so the next reload sees current state, even if the user
    // immediately reloads after switching.
    if (saveTimer && editor) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      const outgoingPath = currentPath;
      const outgoingDoc = editor.getDoc();
      void fs.writeText(outgoingPath, outgoingDoc).catch(() => {});
    }
    if (outputsSaveTimer) {
      clearTimeout(outputsSaveTimer);
      outputsSaveTimer = undefined;
      const outgoingOutputs = outputsPathFor(currentPath);
      void fs.writeText(outgoingOutputs, JSON.stringify(orchestrator.getState())).catch(() => {});
    }

    currentPath = nextPath;
    setActivePath(nextPath);
    fileMenu.refresh();

    const newDoc = await loadOrSeed(fs, nextPath, sampleDoc);
    const newOutputs = await loadPersistedState(fs, outputsPathFor(nextPath));

    orchestrator.reset();
    if (newOutputs) orchestrator.restoreState(newOutputs);
    lastCompiledSource = undefined;
    if (editor) editor.setDoc(newDoc);
    orchestrator.update(newDoc);
  }

  async function createNewNotebook(): Promise<void> {
    const name = window.prompt("New notebook name (.typ):", "scratch");
    if (name == null) return;
    let path: string;
    try {
      path = pathFromName(name);
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    try {
      await createNotebook(fs, path, sampleDoc);
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    await switchToFile(path);
  }

  async function renameCurrent(): Promise<void> {
    const current = nameFromPath(currentPath);
    const name = window.prompt("Rename notebook to:", current);
    if (name == null) return;
    let nextPath: string;
    try {
      nextPath = pathFromName(name);
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    if (nextPath === currentPath) return;
    // Flush the outgoing file's pending writes BEFORE the rename moves
    // the doc out from under the saver — otherwise scheduleUpdate's
    // lingering writeText() lands at the OLD path and re-creates it.
    if (saveTimer && editor) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await fs.writeText(currentPath, editor.getDoc()).catch(() => {});
    }
    if (outputsSaveTimer) {
      clearTimeout(outputsSaveTimer);
      outputsSaveTimer = undefined;
      await fs.writeText(outputsPathFor(currentPath), JSON.stringify(orchestrator.getState()))
        .catch(() => {});
    }
    try {
      await renameNotebook(fs, currentPath, nextPath);
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    currentPath = nextPath;
    setActivePath(nextPath);
    fileMenu.refresh();
  }

  async function deleteCurrent(): Promise<void> {
    const ok = window.confirm(`Delete ${nameFromPath(currentPath)}? This cannot be undone.`);
    if (!ok) return;
    const toDelete = currentPath;
    // Pick a fallback to switch to. If only one notebook exists, we'll
    // create a fresh /main.typ from the sample.
    const remaining = (await listNotebooks(fs)).filter((n) => n.path !== toDelete);
    const next = remaining[0]?.path ?? "/main.typ";
    // Cancel any pending writes against the doc we're deleting so they
    // can't resurrect it after deleteNotebook.
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    if (outputsSaveTimer) { clearTimeout(outputsSaveTimer); outputsSaveTimer = undefined; }
    await deleteNotebook(fs, toDelete);
    if (next === toDelete) {
      // shouldn't happen given the filter above, but guard anyway
      currentPath = "/main.typ";
      setActivePath(currentPath);
    }
    await switchToFile(next);
  }

  const fileMenu = mountFileMenu(fnameLabel, {
    list: () => listNotebooks(fs),
    currentPath: () => currentPath,
    open: switchToFile,
    createNew: createNewNotebook,
    renameCurrent,
    deleteCurrent,
  });

  editor = mountEditor(editorHost, {
    initialDoc,
    onChange: (src) => scheduleUpdate(src),
    onRunCell: (cellId) => orchestrator.forceRun(cellId),
    onToggleHidden: (cellId) => toggleCellHidden(cellId),
    extraKeymap: [
      {
        key: "Mod-Enter",
        run: () => {
          if (!editor) return false;
          const cellId = orchestrator.cellAtOffset(editor.getCursor());
          if (cellId) orchestrator.forceRun(cellId);
          // Always handle the keystroke so the editor doesn't insert a newline.
          return true;
        },
      },
      {
        key: "Mod-Shift-Enter",
        run: () => {
          orchestrator.forceRunAllStale();
          return true;
        },
      },
    ],
  });

  // Flush any pending debounced saves before navigation.
  window.addEventListener("pagehide", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      if (editor) void fs.writeText(currentPath, editor.getDoc()).catch(() => {});
    }
    if (outputsSaveTimer) {
      clearTimeout(outputsSaveTimer);
      outputsSaveTimer = undefined;
      void fs.writeText(outputsPathFor(currentPath), JSON.stringify(orchestrator.getState()))
        .catch(() => {});
    }
  });

  mountMobileToggle(root, mobileToggle);

  // Initial run
  orchestrator.update(editor.getDoc());
}
