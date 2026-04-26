/**
 * Topbar DOM helpers — cell-status dot strip and the mobile pane toggle.
 * Pure DOM, no orchestrator coupling: feed it `NodeStatus[]`, get visual
 * state. The topbar is also where the filename and the global status pill
 * live, but those are owned by their respective modules (status.ts and
 * the document-path constants in persist.ts).
 */

import type { NodeStatus } from "../dag/types.ts";
import type { CellMarker } from "../ui/editor.ts";

/** Diff-in-place renderer for the per-cell dot strip in the topbar. */
export function renderCellStatuses(host: HTMLElement, statuses: readonly NodeStatus[]): void {
  // Only mutate when the per-cell shape actually changes, so typing in the
  // editor doesn't replay a full DOM rebuild on every keystroke.
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

/** Map orchestrator NodeStatus.state to the editor-marker state subset. */
export function toMarkerState(s: NodeStatus["state"] | undefined): CellMarker["state"] {
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

/**
 * Wire the mobile-pane toggle button. Persists the active pane in
 * localStorage so a refresh on a phone keeps the user where they were.
 */
export function mountMobileToggle(root: HTMLElement, button: HTMLButtonElement): void {
  if (localStorage.getItem("notebook.activePane") === "preview") {
    root.classList.add("show-preview");
  }
  button.addEventListener("click", () => {
    root.classList.toggle("show-preview");
    localStorage.setItem(
      "notebook.activePane",
      root.classList.contains("show-preview") ? "preview" : "editor",
    );
  });
}
