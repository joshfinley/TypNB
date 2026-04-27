# TypNB

A notebook that pairs **Typst** typesetting with **Pyodide**-powered live
cells. Browser-native (no server, no Node runtime needed at runtime),
manual cell execution with a reactive dependency DAG that tells you what's
stale, and outputs render as first-class Typst content rather than degraded
fallbacks.

> Not affiliated with the [Typst](https://typst.app) project — TypNB is a
> downstream tool that uses Typst as a rendering backend.

Status: **prototype**. Python cells run end-to-end, share state, persist
their outputs in OPFS, and the user runs them on demand (▶ in the gutter,
Cmd-Enter, or Cmd-Shift-Enter). matplotlib figures render inline. Pandas
DataFrames have an adapter but the kernel-side hook isn't wired yet.

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
├── app.ts             — composes layers (mount → kernel init → restore state → first run)
├── app/               — persistence, source-edit helpers (toggle hidden), topbar DOM
├── orchestrator.ts    — parser + DAG + kernel + adapters → augmented Typst source
├── exec/              — per-cell executor (run-cell.ts) + augmented-source splice (augment.ts)
├── parser/            — extracts #cell(...) calls from .typ source
├── dag/               — dependency graph (build, topoSort, downstream closure)
├── kernel/            — Kernel interface; PyodideKernel runs in a Web Worker; bootstrap.py
├── adapters/          — MimeBundle → Typst content; registry-based
├── renderer/          — typst.ts (WASM) wrapper
├── fs/                — virtual filesystem (OPFS, in-memory fallback)
├── ui/                — editor (CodeMirror 6 + Lezer Python), preview, status, styles
├── templates/         — notebook.typ + sample.typ
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

Cells run on demand, not on edit. On every edit (300 ms debounce):

1. **Parse** all `#cell(...)` calls out of the source.
2. **Analyse** each (changed) cell's reads/writes via Python AST in Pyodide.
3. **Build the DAG**: edges from writers → readers of each symbol.
4. **Mark stale**: the downstream closure of any cell whose hash changed.
5. **Render**: splice cached outputs into the source and compile to SVG.

Nothing executes automatically — opening a notebook shows whatever
outputs the previous run left in the cache, and edits just mark cells
stale. The user runs cells explicitly:

- **▶ button in the editor gutter** — runs that cell.
- **Cmd/Ctrl + Enter** — runs the cell at the cursor.
- **Cmd/Ctrl + Shift + Enter** — runs every currently stale cell.

Forced runs include the downstream closure of the targeted cell(s),
executed in topological order through the persistent Pyodide kernel.

`lazy: true` is parsed and stored on cells but is currently a no-op —
the global default is already manual. It's reserved for a future opt-in
"reactive mode" where it would pin a cell to manual semantics.

## Output adapters (current)

| Adapter             | Matches MIME                                 | Notes                                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| `typst-passthrough` | `application/x-typst`                        | Power-user escape hatch; passes Typst verbatim.  |
| `pandas`            | `application/vnd.notebook.dataframe+json`    | Custom MIME emitted by a Pyodide-side helper. **Not yet wired.** |
| `matplotlib`        | `image/svg+xml`                              | Inlines SVG via `image(bytes(...), format: "svg")`. |
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

### Closing real gaps

- [ ] **Surface compile diagnostics in the preview.** typst.ts errors print
      to console; they should overlay the preview pane like the playground does.
- [ ] **Cancel + interrupt.** Hook Pyodide's SharedArrayBuffer-based interrupt
      so a stuck cell doesn't wedge the kernel. Requires COOP/COEP headers
      (already set in `vite.config.ts`).

### Output adapters

- [ ] **pandas DataFrame.** Monkey-patch `DataFrame._repr_mimebundle_` in the
      Pyodide bootstrap to emit `application/vnd.notebook.dataframe+json`,
      then the existing `pandas-dataframe` adapter lights up.
- [ ] **Sympy → Typst math.** `_repr_latex_` → mitex-style transform → Typst
      math. High value, low surface area; would also light up matplotlib's
      LaTeX text rendering.

### Persistence & files

- [ ] **Multi-file notebooks.** Doc lives at `/main.typ` in OPFS today
      (with cached outputs at `/main.typ.outputs.json`). Add a file picker /
      sidebar against the FS interface to support multiple notebooks.
- [ ] **Import / export.** Drag-and-drop `.typ` in; "download" out as both
      `.typ` and `.pdf` (typst.ts has a PDF backend too).

### Editor UX

- [ ] **`/cell` and `/py` snippet expansion.** Type `/py`, hit Tab, get a
      `#cell(id:..., lang: "python")[...]` skeleton with the cursor in the body.

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

## Colophon

This codebase was written collaboratively with Claude (Claude Opus 4.7
via Claude Code). Almost all lines of code are model-generated with
opinionated human feedback. If this seems like a deal-breaker despite
the tool seeming useful, consider giving it a try anyway! I've already
started using TypNB for some personal projects and have been happy
with it, and feedback in the form of issues or commits is welcome.

Most commits carry a `Co-Authored-By: Claude` trailer if you want to
trace the provenance.
