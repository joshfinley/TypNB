/**
 * Top-level wiring. Composes layers; holds no domain logic itself.
 *
 * Layers, top-down:
 *   ui/           — editor, preview, status (DOM only)
 *   renderer/     — typst.ts wrapper (compiles .typ -> SVG)
 *   orchestrator  — parser + DAG + kernel + adapters
 *   parser/       — extracts #cell(...) calls from .typ source
 *   dag/          — reactive DAG over cells
 *   kernel/       — Pyodide in a Web Worker
 *   adapters/     — MIME -> Typst content
 *   fs/           — virtual filesystem (OPFS / memory)
 */

import { mountEditor, type CellMarker, type EditorHandle } from "./ui/editor.ts";
import { mountPreview } from "./ui/preview.ts";
import { mountStatus } from "./ui/status.ts";
import { createTypstRenderer } from "./renderer/typst-wasm.ts";
import { OpfsFileSystem } from "./fs/opfs.ts";
import { MemoryFileSystem } from "./fs/memory.ts";
import type { FileSystem } from "./fs/types.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PyodideKernel } from "./kernel/pyodide.ts";
import notebookTemplate from "./templates/notebook.typ?raw";
import sampleDoc from "./templates/sample.typ?raw";
import type { NodeStatus } from "./dag/types.ts";

export async function mountApp(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <header class="topbar">
      <span class="logo">Notebook</span>
      <span class="filename" id="fname">untitled.typ</span>
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

  // Capability check + init together. OPFS can also reject at init() time —
  // private-mode Firefox, certain enterprise policies — so fall through to
  // the memory FS on any error rather than failing to mount.
  const fs: FileSystem = await initFileSystem();
  const docPath = "/main.typ";
  const outputsPath = `${docPath}.outputs.json`;
  const initialDoc = await loadOrSeed(fs, docPath, sampleDoc);
  const persistedOutputs = await loadPersistedState(fs, outputsPath);

  const renderer = await createTypstRenderer();
  const status = mountStatus(statusHost);
  const preview = mountPreview(previewHost);

  // Kick off Pyodide in the worker. The cold-load takes ~10s on first visit;
  // surface that via the status pill instead of leaving the user staring at
  // a "ready" indicator while nothing happens.
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

  // The renderer needs the notebook template available at the import path
  // referenced from the document. typst.ts uses an in-memory access model
  // we configure on first use.
  await renderer.setExtraSource("/notebook.typ", notebookTemplate);

  // Editor is declared here so the orchestrator callbacks can capture it,
  // and assigned below — events fire only after orchestrator.update runs,
  // which is after the assignment.
  let editor: EditorHandle | undefined;

  // Latest per-cell statuses, kept so the gutter markers can colour-code
  // alongside the topbar dots.
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
      void fs
        .writeText(outputsPath, JSON.stringify(snapshot))
        .catch((err) => console.error(`failed to save ${outputsPath}:`, err));
    }, 600);
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
  if (persistedOutputs) orchestrator.restoreState(persistedOutputs);

  let compileTimer: number | undefined;
  let saveTimer: number | undefined;
  let inflight = 0;

  function scheduleUpdate(source: string) {
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = window.setTimeout(() => orchestrator.update(source), 300);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void fs.writeText(docPath, source).catch((err) =>
        console.error(`failed to save ${docPath}:`, err),
      );
    }, 600);
  }

  async function compile(source: string) {
    const ticket = ++inflight;
    // Don't override kernel-loading: that's the more important signal until
    // Pyodide is up. Compile is independent of the kernel — it's typst.ts —
    // so we still do the work, just don't flash the status pill.
    if (kernelReady) status.set("compiling");
    try {
      const t0 = performance.now();
      const result = await renderer.compile(source);
      if (ticket !== inflight) return;
      preview.render(result);
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
    const doc = editor.getDoc();
    const cellText = doc.slice(cell.range.start, cell.range.end);
    const openParen = cellText.indexOf("(");
    const closeParen = cellText.indexOf(")", openParen);
    if (openParen < 0 || closeParen < 0) return;
    const argsStart = cell.range.start + openParen + 1;
    const argsEnd = cell.range.start + closeParen;
    const argsText = doc.slice(argsStart, argsEnd);
    editor.replaceRange(argsStart, argsEnd, toggleHiddenInArgs(argsText));
  }

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

  // Flush any pending debounced saves before navigation. Async writes
  // during pagehide aren't guaranteed to complete, but OPFS resolves
  // quickly enough in practice.
  window.addEventListener("pagehide", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      if (editor) void fs.writeText(docPath, editor.getDoc()).catch(() => {});
    }
    if (outputsSaveTimer) {
      clearTimeout(outputsSaveTimer);
      outputsSaveTimer = undefined;
      void fs.writeText(outputsPath, JSON.stringify(orchestrator.getState())).catch(() => {});
    }
  });

  // Mobile pane toggle (persisted)
  if (localStorage.getItem("notebook.activePane") === "preview") root.classList.add("show-preview");
  mobileToggle.addEventListener("click", () => {
    root.classList.toggle("show-preview");
    localStorage.setItem(
      "notebook.activePane",
      root.classList.contains("show-preview") ? "preview" : "editor",
    );
  });

  // Initial run
  orchestrator.update(editor.getDoc());
}

function renderCellStatuses(host: HTMLElement, statuses: readonly NodeStatus[]): void {
  // Diff in place: only mutate when the per-cell shape actually changes, so
  // typing in the editor doesn't replay a full DOM rebuild on every keystroke.
  if (statuses.length !== host.children.length) {
    host.replaceChildren(...statuses.map(makeCellDot));
    return;
  }
  for (let i = 0; i < statuses.length; i++) {
    updateCellDot(host.children[i] as HTMLElement, statuses[i]!);
  }
}

function makeCellDot(s: NodeStatus): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "cell-dot";
  updateCellDot(el, s);
  return el;
}

function updateCellDot(el: HTMLElement, s: NodeStatus): void {
  if (el.dataset["state"] !== s.state) el.dataset["state"] = s.state;
  const title = s.error ?? (s.durationMs ? `${s.durationMs}ms` : "");
  if (el.title !== title) el.title = title;
}

/**
 * Toggle the `hidden:` attribute in a `#cell(...)` arg list.
 * - If `hidden: true` is present, removes it (and the surrounding comma if any).
 * - If `hidden: false` is present, flips it to `true`.
 * - Otherwise, appends `hidden: true` (with a leading comma if other args exist).
 */
function toggleHiddenInArgs(args: string): string {
  // Match an existing `hidden: bool` attribute with optional surrounding commas.
  // Captures the boolean so we can flip vs. remove.
  const HIDDEN_RE = /(,\s*)?hidden\s*:\s*(true|false)(\s*,)?/;
  const m = args.match(HIDDEN_RE);
  if (m) {
    const [whole, leadingComma, value, trailingComma] = m;
    if (value === "false") {
      return args.replace(whole, `${leadingComma ?? ""}hidden: true${trailingComma ?? ""}`);
    }
    // value === "true": remove the attribute entirely. If we ate a comma on
    // either side, leave one behind so the remaining args stay valid.
    const replacement = leadingComma && trailingComma ? "," : "";
    return args.replace(whole, replacement).trim();
  }
  const trimmed = args.trim();
  return trimmed ? `${trimmed}, hidden: true` : `hidden: true`;
}

/** Map orchestrator NodeStatus.state to the marker state subset. */
function toMarkerState(s: NodeStatus["state"] | undefined): CellMarker["state"] {
  switch (s) {
    case "ok":
    case "error":
    case "running":
    case "stale":
      return s;
    default:
      return "idle";
  }
}

async function loadOrSeed(fs: FileSystem, path: string, seed: string): Promise<string> {
  try {
    if (await fs.exists(path)) return await fs.readText(path);
  } catch (err) {
    console.warn(`failed to read ${path}; seeding fresh:`, err);
  }
  try {
    await fs.writeText(path, seed);
  } catch (err) {
    console.warn(`failed to seed ${path}:`, err);
  }
  return seed;
}

/**
 * Read a previously-persisted orchestrator state from disk. Returns null
 * (with a warning) if the file is missing, unreadable, or corrupt — the
 * orchestrator can rebuild from scratch on the next forced run.
 */
async function loadPersistedState(fs: FileSystem, path: string): Promise<unknown> {
  try {
    if (!(await fs.exists(path))) return null;
    const raw = await fs.readText(path);
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`failed to load persisted state from ${path}:`, err);
    return null;
  }
}

async function initFileSystem(): Promise<FileSystem> {
  const opfsAvailable =
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function";
  if (opfsAvailable) {
    try {
      const opfs = new OpfsFileSystem();
      await opfs.init();
      return opfs;
    } catch (err) {
      console.warn("OPFS init failed; falling back to in-memory FS:", err);
    }
  }
  const mem = new MemoryFileSystem();
  await mem.init();
  return mem;
}

/** Test-only export. Not part of the public API. */
export const __test = { toggleHiddenInArgs };
