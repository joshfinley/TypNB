import type { CellAnalysis } from "../dag/types.ts";
import type { ExecuteOptions, Kernel, OutputEvent } from "./types.ts";
import PyodideWorker from "./pyodide-worker.ts?worker";

/**
 * Main-thread side of the Pyodide kernel. Talks to pyodide-worker.ts over
 * postMessage and adapts the message protocol to the Kernel interface.
 */
export class PyodideKernel implements Kernel {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      stream?: ((event: OutputEvent) => void) | undefined;
    }
  >();

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = new PyodideWorker();
    this.worker.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
    this.worker.addEventListener("error", (e: ErrorEvent) => {
      // Surface worker-thread errors via the same console that the dev sink mirrors.
      console.error(`[pyodide-worker] ${e.message}`, e.error);
    });
    this.worker.addEventListener("messageerror", (e: MessageEvent) => {
      console.error(`[pyodide-worker] messageerror`, e);
    });
    await this.send<null>("init", {});
  }

  async analyseScope(source: string): Promise<CellAnalysis> {
    return await this.send<CellAnalysis>("analyse", { source });
  }

  async *execute(source: string, opts: ExecuteOptions): AsyncIterable<OutputEvent> {
    const events: OutputEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const stream = (event: OutputEvent) => {
      events.push(event);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    const finishPromise = this.send<null>("execute", { cellId: opts.cellId, source }, stream)
      .then(() => {
        done = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      })
      .catch((err: Error) => {
        error = err;
        done = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      });

    try {
      while (true) {
        while (events.length > 0) {
          yield events.shift()!;
        }
        if (done) {
          if (error) throw error;
          return;
        }
        await new Promise<void>((res) => {
          resolveNext = res;
        });
      }
    } finally {
      await finishPromise;
    }
  }

  async interrupt(): Promise<void> {
    await this.send<null>("interrupt", {});
  }

  async restart(): Promise<void> {
    await this.send<null>("restart", {});
  }

  async definedNames(): Promise<ReadonlySet<string>> {
    return await this.send<Set<string>>("definedNames", {});
  }

  private send<T>(
    type: string,
    args: Record<string, unknown>,
    stream?: (event: OutputEvent) => void,
  ): Promise<T> {
    if (!this.worker) throw new Error("kernel not initialised");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        stream,
      });
      this.worker!.postMessage({ id, type, ...args });
    });
  }

  private onMessage(msg: {
    id: number;
    type: "result" | "stream" | "error";
    value?: unknown;
    event?: OutputEvent;
    message?: string;
  }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "stream" && msg.event) {
      p.stream?.(msg.event);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === "result") p.resolve(msg.value);
    else p.reject(new Error(msg.message ?? "kernel error"));
  }
}
