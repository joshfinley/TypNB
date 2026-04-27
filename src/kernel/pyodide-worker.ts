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
import bootstrapPy from "./bootstrap.py?raw";

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


async function ensureInit(): Promise<PyodideInterface> {
  if (py) return py;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const instance = await loadPyodide({ indexURL: PYODIDE_INDEX });
    instance.runPython(bootstrapPy);
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
        // Stream stdout/stderr as events. Pyodide's `batched` callback
        // delivers each line WITHOUT its trailing newline (per its API
        // contract), so we re-append it before forwarding — otherwise
        // `print("a"); print("b")` arrives as ["a", "b"], joined to "ab"
        // by the orchestrator's runCell, and the newline is lost.
        const flushAndStream = (kind: "stdout" | "stderr") => (s: string) => {
          if (s.length === 0) return;
          post({ id: req.id, type: "stream", event: { kind, data: s + "\n" } });
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
