/**
 * Dev-only client-side error reporter.
 *
 * Captures `window.onerror`, `unhandledrejection`, and console.{warn,error}
 * and POSTs them to /__client_log, where the Vite middleware prints them to
 * the dev server terminal. Stripped from production via import.meta.env.DEV.
 *
 * Deliberately does NOT patch console.log: the previous implementation
 * forwarded any console.log message matching `/error:/i` to the dev server,
 * which silently exfiltrated user/library logs (Python tracebacks, HTTP
 * messages, etc.). If you have a diagnostic that genuinely belongs in the
 * dev terminal, route it explicitly through `devLog()`.
 */

interface LogPayload {
  level: "error" | "warn" | "log";
  message: string;
  stack?: string | undefined;
  url?: string | undefined;
}

function send(payload: LogPayload): void {
  const body = JSON.stringify(payload);
  // navigator.sendBeacon doesn't honour content-type but is fire-and-forget;
  // fall back to fetch when sendBeacon is unavailable.
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/__client_log", new Blob([body], { type: "application/json" }));
  } else {
    void fetch("/__client_log", { method: "POST", body, headers: { "Content-Type": "application/json" } });
  }
}

/**
 * Explicit channel for forwarding a message to the dev terminal. Use this
 * instead of relying on a global console patch — call sites are then
 * grep-able and the patch surface stays minimal.
 */
export function devLog(level: "error" | "warn" | "log", message: string, stack?: string): void {
  if (!import.meta.env.DEV) return;
  send({ level, message, ...(stack ? { stack } : {}) });
}

export function installClientLogger(): void {
  if (!import.meta.env.DEV) return;

  window.addEventListener("error", (e) => {
    send({
      level: "error",
      message: e.message,
      stack: e.error?.stack ?? undefined,
      url: e.filename,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason: unknown = e.reason;
    const message =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : JSON.stringify(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    send({ level: "error", message: `unhandledrejection: ${message}`, stack: stack ?? undefined });
  });

  // Mirror console.error / console.warn — these are intentional, low-traffic
  // diagnostic calls inside our own code. We do NOT mirror console.log; see
  // the module-level comment.
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    send({ level: "error", message: args.map(stringify).join(" ") });
    origError(...args);
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    send({ level: "warn", message: args.map(stringify).join(" ") });
    origWarn(...args);
  };
}

function stringify(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
