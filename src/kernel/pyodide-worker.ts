/// <reference lib="webworker" />
/**
 * Web Worker that hosts the Pyodide runtime.
 *
 * Wire protocol (main ⇄ worker):
 *   request:  { id, type: "init" | "analyse" | "execute" | "interrupt" | "restart" | "definedNames", ...args }
 *   response: { id, type: "result", value }
 *             | { id, type: "stream", event }   ← only during "execute"
 *             | { id, type: "error", message, stack? }
 *
 * Heavy lifting (loadPyodide, package detection, AST analysis) runs here so
 * the main thread stays responsive.
 */

import { loadPyodide, type PyodideInterface } from "pyodide";
import type { CellAnalysis } from "../dag/types.ts";
import type { OutputEvent } from "./types.ts";

type ReqId = number;

interface InitReq    { id: ReqId; type: "init" }
interface AnalyseReq { id: ReqId; type: "analyse"; source: string }
interface ExecuteReq { id: ReqId; type: "execute"; cellId: string; source: string }
interface InterruptReq { id: ReqId; type: "interrupt" }
interface RestartReq   { id: ReqId; type: "restart" }
interface DefinedReq   { id: ReqId; type: "definedNames" }
type Request = InitReq | AnalyseReq | ExecuteReq | InterruptReq | RestartReq | DefinedReq;

type Response =
  | { id: ReqId; type: "result"; value: unknown }
  | { id: ReqId; type: "stream"; event: OutputEvent }
  | { id: ReqId; type: "error"; message: string; stack?: string | undefined };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface PyProxyLike {
  toJs(opts?: { dict_converter?: (entries: Iterable<[unknown, unknown]>) => unknown; depth?: number }): unknown;
  destroy(): void;
}

function isProxy(v: unknown): v is PyProxyLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toJs?: unknown }).toJs === "function" &&
    typeof (v as { destroy?: unknown }).destroy === "function"
  );
}

/**
 * Convert a Python MIME-bundle dict (PyProxy) into a plain JS object that
 * survives postMessage cloning. Bytes (e.g. PNG) become Uint8Array; strings
 * stay strings; nested dicts (rare) become plain objects.
 */
function toPlainBundle(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (!isProxy(v)) return null;
  const obj = v.toJs({ dict_converter: Object.fromEntries, depth: -1 }) as Record<string, unknown>;
  return cleanBundle(obj);
}

function cleanBundle(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [k, val] of Object.entries(obj)) {
    if (val instanceof Uint8Array || typeof val === "string" || typeof val === "number" || typeof val === "boolean") continue;
    if (val == null) continue;
    obj[k] = String(val);
  }
  return obj;
}

/**
 * Call `__notebook_post_execute(value)` to capture and close any open
 * matplotlib figures. Returns the figure bundles as plain objects (postMessage-safe).
 */
function capturePendingFigures(
  py: PyodideInterface,
  value: unknown,
): Record<string, unknown>[] {
  const fn = py.globals.get("__notebook_post_execute");
  if (!fn) return [];
  let proxy: unknown;
  try {
    proxy = (fn as unknown as (v: unknown) => unknown)(value);
  } finally {
    (fn as unknown as PyProxyLike).destroy();
  }
  if (!isProxy(proxy)) return [];
  const arr = (proxy as PyProxyLike).toJs({
    dict_converter: Object.fromEntries,
    depth: -1,
  }) as Record<string, unknown>[];
  (proxy as PyProxyLike).destroy();
  return arr.map(cleanBundle);
}
let py: PyodideInterface | null = null;
let initPromise: Promise<PyodideInterface> | null = null;

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";

/** Python-side helpers for static analysis and execution capture. */
const PY_BOOTSTRAP = `
import ast
import io
import os
import sys
import json
import builtins as _builtins
import contextlib

# Pyodide's matplotlib defaults to the webagg backend, which does
# \`from js import document\` and fails in a Web Worker (no DOM here).
# Force the non-interactive Agg backend before any matplotlib import.
# Users can still override via os.environ['MPLBACKEND'] = ... in a cell.
os.environ.setdefault('MPLBACKEND', 'Agg')

# Under Agg, plt.show() emits a UserWarning ("FigureCanvasAgg is
# non-interactive, and thus cannot be shown."). __notebook_post_execute
# already inlines any open figure; the warning is just noise. Suppress it
# at registration time so it's filtered before any matplotlib import.
import warnings
warnings.filterwarnings(
    'ignore',
    message=r'.*FigureCanvasAgg is non-interactive.*',
    category=UserWarning,
)

# ── static analysis ──────────────────────────────────────────────────────

_PY_BUILTINS = set(dir(_builtins))

class _ScopeVisitor(ast.NodeVisitor):
    def __init__(self):
        self.reads = set()
        self.writes = set()
        self.locals_stack = [set()]  # tracks names bound inside enclosing functions/comprehensions

    def _is_local(self, name):
        return any(name in scope for scope in self.locals_stack)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            if not self._is_local(node.id) and node.id not in _PY_BUILTINS:
                self.reads.add(node.id)
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            if len(self.locals_stack) == 1:  # top-level binding
                self.writes.add(node.id)

    def visit_FunctionDef(self, node):
        self.writes.add(node.name)
        self._enter_scope(node)

    def visit_AsyncFunctionDef(self, node):
        self.writes.add(node.name)
        self._enter_scope(node)

    def visit_ClassDef(self, node):
        self.writes.add(node.name)
        for base in node.bases:
            self.visit(base)
        for kw in node.keywords:
            self.visit(kw)
        # Class body is its own scope-ish; skip body to avoid misclassifying class-attr names as writes.

    def visit_Import(self, node):
        for alias in node.names:
            name = alias.asname or alias.name.split('.')[0]
            self.writes.add(name)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            name = alias.asname or alias.name
            if name == '*':
                continue  # we cannot know what * imports without executing
            self.writes.add(name)

    def visit_For(self, node):
        # The loop variable is a top-level binding when at module scope.
        self._collect_assign_targets(node.target)
        self.generic_visit(node)

    def visit_With(self, node):
        for item in node.items:
            if item.optional_vars is not None:
                self._collect_assign_targets(item.optional_vars)
        self.generic_visit(node)

    def visit_Try(self, node):
        for handler in node.handlers:
            if handler.name and len(self.locals_stack) == 1:
                self.writes.add(handler.name)
        self.generic_visit(node)

    def _collect_assign_targets(self, target):
        if len(self.locals_stack) != 1:
            return
        if isinstance(target, ast.Name):
            self.writes.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._collect_assign_targets(elt)
        elif isinstance(target, ast.Starred):
            self._collect_assign_targets(target.value)

    def _enter_scope(self, node):
        local = set()
        for arg in getattr(node.args, 'args', []):
            local.add(arg.arg)
        for arg in getattr(node.args, 'kwonlyargs', []):
            local.add(arg.arg)
        if getattr(node.args, 'vararg', None):
            local.add(node.args.vararg.arg)
        if getattr(node.args, 'kwarg', None):
            local.add(node.args.kwarg.arg)
        self.locals_stack.append(local)
        for n in node.body:
            self.visit(n)
        self.locals_stack.pop()


def __notebook_analyse(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return json.dumps({"reads": [], "writes": [], "syntaxError": str(e)})
    v = _ScopeVisitor()
    v.visit(tree)
    return json.dumps({"reads": sorted(v.reads), "writes": sorted(v.writes)})


# ── execution capture ────────────────────────────────────────────────────

def __notebook_matplotlib_svg(value):
    """If value is a matplotlib Figure (or has gcf attached), render to SVG."""
    try:
        from matplotlib.figure import Figure
    except ImportError:
        return None
    if not isinstance(value, Figure):
        return None
    import io
    buf = io.StringIO()
    try:
        value.savefig(buf, format='svg', bbox_inches='tight')
    except Exception:
        return None
    return buf.getvalue()


def __notebook_repr(value):
    """Best-effort MIME bundle for a Python value."""
    if value is None:
        return None
    bundle = {}
    # Prefer the Jupyter-style _repr_mimebundle_ if available.
    repr_bundle = getattr(value, '_repr_mimebundle_', None)
    if callable(repr_bundle):
        try:
            data = repr_bundle()
            if isinstance(data, tuple):
                data = data[0]
            if isinstance(data, dict):
                bundle.update(data)
        except Exception:
            pass
    for mime, attr in (
        ('image/svg+xml', '_repr_svg_'),
        ('image/png', '_repr_png_'),
        ('text/html', '_repr_html_'),
        ('text/latex', '_repr_latex_'),
        ('application/json', '_repr_json_'),
    ):
        if mime in bundle:
            continue
        m = getattr(value, attr, None)
        if callable(m):
            try:
                v = m()
                if v is not None:
                    bundle[mime] = v
            except Exception:
                pass
    # matplotlib Figures don't expose _repr_svg_; render via savefig instead.
    # The default _repr_html_ is a base64 PNG — we prefer SVG for Typst.
    if 'image/svg+xml' not in bundle:
        svg = __notebook_matplotlib_svg(value)
        if svg is not None:
            bundle['image/svg+xml'] = svg
    if 'text/plain' not in bundle:
        try:
            bundle['text/plain'] = repr(value)
        except Exception:
            bundle['text/plain'] = '<unrepr-able>'
    return bundle


def __notebook_post_execute(result_value):
    """Render and close any open matplotlib figures.

    Returns a list of MIME bundles for figures NOT represented by
    result_value, so a cell ending in 'plt.gcf()' doesn't double-render.
    Closing every open figure prevents accumulation across cells —
    matching Jupyter's %matplotlib inline post-execute behaviour.
    """
    bundles = []
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return bundles
    try:
        from matplotlib.figure import Figure
        result_fig_num = result_value.number if isinstance(result_value, Figure) else None
    except Exception:
        result_fig_num = None
    for num in plt.get_fignums():
        if num == result_fig_num:
            continue
        fig = plt.figure(num)
        bundle = __notebook_repr(fig)
        if bundle:
            bundles.append(bundle)
        plt.close(fig)
    if result_fig_num is not None:
        try:
            plt.close(plt.figure(result_fig_num))
        except Exception:
            pass
    return bundles
`;

async function ensureInit(): Promise<PyodideInterface> {
  if (py) return py;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const instance = await loadPyodide({ indexURL: PYODIDE_INDEX });
    instance.runPython(PY_BOOTSTRAP);
    py = instance;
    return instance;
  })();
  return initPromise;
}

function post(msg: Response): void {
  ctx.postMessage(msg);
}

ctx.addEventListener("message", async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case "init": {
        await ensureInit();
        post({ id: req.id, type: "result", value: null });
        return;
      }
      case "analyse": {
        const py = await ensureInit();
        const fn = py.globals.get("__notebook_analyse");
        const json = fn(req.source) as string;
        fn.destroy();
        const parsed = JSON.parse(json) as { reads: string[]; writes: string[]; syntaxError?: string };
        const analysis: CellAnalysis = {
          reads: new Set(parsed.reads),
          writes: new Set(parsed.writes),
        };
        post({ id: req.id, type: "result", value: analysis });
        return;
      }
      case "execute": {
        const py = await ensureInit();
        // Stream stdout/stderr as events.
        const flushAndStream = (kind: "stdout" | "stderr") => (s: string) => {
          if (s.length === 0) return;
          post({ id: req.id, type: "stream", event: { kind, data: s } });
        };
        py.setStdout({ batched: flushAndStream("stdout") });
        py.setStderr({ batched: flushAndStream("stderr") });

        try {
          // Detect imports first; lazy-load any known Pyodide packages they need.
          await py.loadPackagesFromImports(req.source);

          // runPythonAsync evaluates the source as a top-level module and
          // returns the value of the final expression (matching IPython).
          const value = await py.runPythonAsync(req.source);

          // 1. Compute the result bundle while figures are still open
          //    (matplotlib savefig fails after plt.close).
          let resultBundle: Record<string, unknown> | null = null;
          if (value !== undefined && value !== null) {
            const reprFn = py.globals.get("__notebook_repr");
            const bundleProxy = reprFn(value) as unknown;
            reprFn.destroy();
            resultBundle = toPlainBundle(bundleProxy);
            if (isProxy(bundleProxy)) bundleProxy.destroy();
          }

          // 2. Capture any other open matplotlib figures as display events.
          //    `__notebook_post_execute(value)` excludes the figure that
          //    matches the result (so we don't double-render), then closes
          //    every open figure — matches Jupyter's inline behaviour where
          //    figures don't persist across cell executions.
          const figureBundles = capturePendingFigures(py, value);

          // Emit displays first, then the result. Order matches the
          // execution order the user expects: figures created mid-cell
          // appear before the cell's final value.
          for (const fig of figureBundles) {
            post({ id: req.id, type: "stream", event: { kind: "display", data: fig } });
          }
          if (resultBundle && Object.keys(resultBundle).length > 0) {
            post({ id: req.id, type: "stream", event: { kind: "result", data: resultBundle } });
          }
          if (isProxy(value)) (value as PyProxyLike).destroy();

          post({ id: req.id, type: "result", value: null });
        } catch (err) {
          const e = err as { name?: string; message?: string; stack?: string };
          post({
            id: req.id,
            type: "stream",
            event: {
              kind: "error",
              name: e.name ?? "Error",
              message: e.message ?? String(err),
              traceback: (e.stack ?? "").split("\n"),
            },
          });
          post({ id: req.id, type: "result", value: null });
        }
        return;
      }
      case "interrupt": {
        // Pyodide supports SharedArrayBuffer-based interrupts; not wired yet.
        post({ id: req.id, type: "result", value: null });
        return;
      }
      case "restart": {
        py = null;
        initPromise = null;
        await ensureInit();
        post({ id: req.id, type: "result", value: null });
        return;
      }
      case "definedNames": {
        const py = await ensureInit();
        const names = py.runPython(
          "sorted(n for n in globals() if not n.startswith('_'))",
        ) as unknown[];
        post({ id: req.id, type: "result", value: new Set(names.map(String)) });
        return;
      }
    }
  } catch (err) {
    const e = err as Error;
    post({
      id: req.id,
      type: "error",
      message: e.message ?? String(err),
      stack: e.stack ?? undefined,
    });
  }
});
