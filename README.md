# notebook

A reactive notebook that pairs **Typst** typesetting with **Pyodide**-powered
live cells. Browser-native (no server, no Node runtime needed at runtime),
reactive DAG execution (cells re-run automatically when their dependencies
change), and outputs render as first-class Typst content rather than degraded
fallbacks.

Status: **early prototype**. Two real Python cells run end-to-end, share state,
and re-execute reactively. Most adapters and persistence are stubbed.

## Quick start

Requires [Bun](https://bun.sh) (other Node-compatible runtimes work too — Bun is just what the project was bootstrapped with).

```bash
bun install
bun run dev
```

Open http://localhost:5173. First load downloads typst.ts WASM (~2 MB) and
Pyodide (~10 MB); both are cached after that.

Other scripts:

```bash
bun run typecheck   # tsc -b --noEmit, strict mode
bun run build       # production bundle to dist/
bun run preview     # serve the production build
```

## Architecture at a glance

```
src/
├── main.ts            — entry; installs dev client logger, mounts app
├── app.ts             — composition only; no domain logic
├── orchestrator.ts    — parser + DAG + kernel + adapters → augmented Typst source
├── parser/            — extracts #cell(...) calls from .typ source
├── dag/               — reactive dependency graph (build, topoSort, downstream closure)
├── kernel/            — Kernel interface; PyodideKernel runs in a Web Worker
├── adapters/          — MimeBundle → Typst content; registry-based
├── renderer/          — typst.ts (WASM) wrapper
├── fs/                — virtual filesystem interface (memory + OPFS stub)
├── ui/                — editor (CodeMirror 6), preview, status, styles
├── templates/         — notebook.typ (the cell/output/notebook helpers)
└── dev/               — dev-only client error logger (stripped from prod)
```

The contract is "no DOM widgets for output." Everything visible is Typst
content rendered by typst.ts. The TS layer is parser + DAG + kernel + FS only.

## How a cell works

```typst
#import "/notebook.typ": *
#show: notebook.with(title: "My doc", kernel: "python")

#cell(id: "primes", lang: "python")[```python
ps = [p for p in range(50) if all(p % d for d in range(2, p))]
ps
```]
```

On every edit (300 ms debounce):

1. **Parse** all `#cell(...)` calls out of the source.
2. **Analyse** each (changed) cell's reads/writes via Python AST in Pyodide.
3. **Build the DAG**: edges from writers → readers of each symbol.
4. **Invalidate** the downstream closure of any cell whose source hash changed.
5. **Execute** stale cells in topological order in the persistent Pyodide kernel.
6. **Adapt** each result's MIME bundle to Typst content via the registry.
7. **Splice** outputs back into the source as `#cell-output[...]` blocks.
8. **Render** the augmented source with typst.ts → SVG.

## Output adapters (current)

| Adapter             | Matches MIME                                 | Notes                                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| `typst-passthrough` | `application/x-typst`                        | Power-user escape hatch; passes Typst verbatim.  |
| `pandas`            | `application/vnd.notebook.dataframe+json`    | Custom MIME emitted by a Pyodide-side helper. **Not yet wired.** |
| `matplotlib`        | `image/svg+xml`                              | Returns `#image(path)`. Path-write step **not yet wired**. |
| `plain`             | `text/plain`                                 | Fenced raw block. Always-available fallback.     |

Anything not matched renders as a visible **UNSUPPORTED OUTPUT** badge —
loud, never silent. Adding an adapter is a few hundred lines against
`OutputAdapter` in `src/adapters/types.ts`.

## Dev-loop conveniences

- **Client error sink.** `src/dev/client-log.ts` mirrors `window.onerror`,
  `unhandledrejection`, and `console.{error,warn}` to the Vite dev terminal.
  Production builds strip this. There's an explicit `devLog()` helper for
  any diagnostic that needs forwarding without going through `console`.
- **Worker error forwarding.** `PyodideKernel` listens on `worker.error` and
  re-emits via `console.error`, so worker crashes also reach the dev sink.

## Next steps

Roughly in priority order:

### Closing real gaps in the reactive loop

- [ ] **Per-cell status in the editor gutter.** Today's per-cell dots live in
      the topbar. CodeMirror gutter markers next to each cell give the visual
      that `running / stale / ok / error` is per-cell.
- [ ] **Surface compile diagnostics in the preview.** typst.ts errors print
      to console; they should overlay the preview pane like the playground does.
- [ ] **Cancel + interrupt.** Hook Pyodide's SharedArrayBuffer-based interrupt
      so a stuck cell doesn't wedge the kernel. Requires COOP/COEP headers
      (already set in `vite.config.ts`).
- [ ] **Cell-id stability.** Today, `id:` defaults to `cell-N` by source order.
      A cell without an explicit id that's reordered breaks DAG cache.
      Auto-derive a stable id from a content hash if no `id:` is provided.

### Output adapters

- [ ] **pandas DataFrame.** Monkey-patch `DataFrame._repr_mimebundle_` in the
      Pyodide bootstrap to emit `application/vnd.notebook.dataframe+json`,
      then the existing `pandas-dataframe` adapter lights up.
- [ ] **matplotlib SVG.** Wire the figure-bytes-to-FS step. Either splice the
      SVG inline (cheaper for small figures) or write to typst.ts's virtual
      FS via `addSource(...)` and reference by path.
- [ ] **Sympy → Typst math.** `_repr_latex_` → mitex-style transform → Typst
      math. High value, low surface area; would also light up matplotlib's
      LaTeX text rendering.

### Persistence & files

- [ ] **OPFS impl.** `OpfsFileSystem` is currently a stub. Wire read/write/list
      so the notebook auto-saves to the browser's origin-private FS.
- [ ] **Multi-file notebooks.** Today `app.ts` carries one document literal.
      Add a file picker / sidebar against the FS interface.
- [ ] **Import / export.** Drag-and-drop `.typ` in; "download" out as both
      `.typ` and `.pdf` (typst.ts has a PDF backend too).

### Editor UX

- [ ] **Typst syntax highlighting.** Port the StreamLanguage grammar from
      the sibling Typst playground.
- [ ] **`/cell` and `/py` snippet expansion.** Type `/py`, hit Tab, get a
      `#cell(id:..., lang: "python")[...]` skeleton with the cursor in the body.
- [ ] **Cmd+Enter to force-rerun, Cmd+Shift+Enter to rerun all stale.**

### Architectural hardening

- [ ] **Real Typst-aware cell parser.** Today's regex misses cells inside
      `if`/`for`/imports. A small Lezer Typst grammar (or a worker-side call
      into typst.ts's syntax tree) replaces it.
- [ ] **Web Worker pool for typst.ts.** The compiler currently runs on the
      main thread; on big docs the editor stalls. Move it.
- [ ] **Self-host Pyodide.** Drop the `cdn.jsdelivr.net/pyodide` URL; serve
      from `public/pyodide/` so the app works fully offline.
- [ ] **Self-host typst.ts WASM.** Same deal — currently from jsdelivr.

### Future (after the above)

- Reactive-DAG fast path: only re-execute cells whose **content** hash
  changed (skip moved-but-unchanged cells), with a "force topological
  re-run" command for safety.
- Remote kernels over SSE behind the same `Kernel` interface (Modal /
  fly.io / your VPS), once the in-browser story is solid.
- Yjs collaboration on the same source-file model.
- Typst HTML output mode (`--format html`) for an interactive HTML view
  of the notebook alongside the SVG/PDF render.

