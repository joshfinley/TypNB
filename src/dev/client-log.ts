/**
 * Dev-only client-side error reporter.
 *
 * Captures `window.onerror`, `unhandledrejection`, and console.{warn,error}
 * and POSTs them to /__client_log, where the Vite middleware prints them to
 * the dev server terminal. Stripped from production builds via import.meta.env.DEV.
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

  // typst.ts (and other Rust-via-WASM toolchains) emit diagnostics through
  // console.log. Mirror anything that *looks* like a Rust diagnostic.
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const msg = args.map(stringify).join(" ");
    if (looksLikeDiagnostic(msg)) {
      send({ level: "error", message: msg });
    }
    origLog(...args);
  };
}

function looksLikeDiagnostic(msg: string): boolean {
  return (
    msg.includes("SourceDiagnostic") ||
    msg.includes("severity: Error") ||
    /\berror:\s/i.test(msg)
  );
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
