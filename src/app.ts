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

import { mountEditor } from "./ui/editor.ts";
import { mountPreview } from "./ui/preview.ts";
import { mountStatus } from "./ui/status.ts";
import { createTypstRenderer } from "./renderer/typst-wasm.ts";
import { OpfsFileSystem } from "./fs/opfs.ts";
import { MemoryFileSystem } from "./fs/memory.ts";
import type { FileSystem } from "./fs/types.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PyodideKernel } from "./kernel/pyodide.ts";
import notebookTemplate from "./templates/notebook.typ?raw";
import type { NodeStatus } from "./dag/types.ts";

const SAMPLE = `#import "/notebook.typ": *
#show: notebook.with(title: "Hello, Reactive Typst", kernel: "python")

= Welcome

This notebook combines *Typst* typesetting with *Pyodide*-powered live cells.
Edit either the prose or the code; the affected cells re-run automatically.

== A first computation

#cell(id: "primes", lang: "python")[\`\`\`python
def primes_below(n):
    sieve = [True] * n
    sieve[:2] = [False, False]
    for i in range(2, int(n ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, n, i):
                sieve[j] = False
    return [i for i, p in enumerate(sieve) if p]

ps = primes_below(50)
print("first ten:", ps[:10])
ps
\`\`\`]

== Downstream cell

This cell consumes \`ps\` from above. Try changing the limit in the cell above
from \`50\` to \`200\` and watch this cell re-execute on its own.

#cell(id: "summary", lang: "python")[\`\`\`python
print("count:", len(ps))
print("largest:", ps[-1])
\`\`\`]

== Notes

Cells share Python-runtime state (\`ps\` flows from one to the next) and Typst
document state (this section's heading numbering carries through).
`;

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

  const fs: FileSystem = supportsOpfs() ? new OpfsFileSystem() : new MemoryFileSystem();
  await fs.init();
  void fs; // wired later when persistence lands

  const renderer = await createTypstRenderer();
  const status = mountStatus(statusHost);
  const preview = mountPreview(previewHost);

  // Kick off Pyodide in the worker. Fire-and-forget; the orchestrator's first
  // cell-bearing run will await the kernel via analyseScope.
  const kernel = new PyodideKernel();
  void kernel.init().catch((err) => console.error("kernel init failed:", err));

  // The renderer needs the notebook template available at the import path
  // referenced from the document. typst.ts uses an in-memory access model
  // we configure on first use.
  await renderer.setExtraSource("/notebook.typ", notebookTemplate);

  const orchestrator = new Orchestrator(kernel, {
    onAugmentedSource: (source) => {
      void compile(source);
    },
    onStatus: (statuses) => renderCellStatuses(cellsStatus, statuses),
  });

  let compileTimer: number | undefined;
  let inflight = 0;

  function scheduleUpdate(source: string) {
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = window.setTimeout(() => orchestrator.update(source), 300);
  }

  async function compile(source: string) {
    const ticket = ++inflight;
    status.set("compiling");
    try {
      const t0 = performance.now();
      const result = await renderer.compile(source);
      if (ticket !== inflight) return;
      preview.render(result);
      status.set("ok", `${Math.round(performance.now() - t0)}ms`);
    } catch (err) {
      if (ticket !== inflight) return;
      preview.renderError(String(err));
      status.set("error");
    }
  }

  const editor = mountEditor(editorHost, {
    initialDoc: SAMPLE,
    onChange: (src) => scheduleUpdate(src),
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
  if (statuses.length === 0) {
    host.textContent = "";
    return;
  }
  host.innerHTML = statuses
    .map((s) => {
      const tip = s.error ? ` title="${escapeAttr(s.error)}"` : s.durationMs ? ` title="${s.durationMs}ms"` : "";
      return `<span class="cell-dot" data-state="${s.state}"${tip}></span>`;
    })
    .join("");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function supportsOpfs(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  );
}
