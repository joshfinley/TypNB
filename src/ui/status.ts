/**
 * Status surface. Rendered as DOM in the topbar for now; once cells exist it
 * will additionally write a `_status.typ` file the notebook template imports
 * to render per-cell gutters in the preview.
 */

export type StatusKind = "idle" | "compiling" | "ok" | "error";

export interface StatusHandle {
  set(kind: StatusKind, detail?: string): void;
}

export function mountStatus(host: HTMLElement): StatusHandle {
  host.innerHTML = `<span class="dot"></span><span class="label">ready</span>`;
  const dot = host.querySelector<HTMLElement>(".dot")!;
  const label = host.querySelector<HTMLElement>(".label")!;
  return {
    set(kind, detail) {
      dot.dataset["state"] = kind;
      label.textContent = detail ? `${labelOf(kind)} · ${detail}` : labelOf(kind);
    },
  };
}

function labelOf(k: StatusKind): string {
  switch (k) {
    case "idle":
      return "ready";
    case "compiling":
      return "compiling…";
    case "ok":
      return "ready";
    case "error":
      return "error";
  }
}
