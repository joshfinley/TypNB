/**
 * Topbar file-picker dropdown. Uses native <details>/<summary> for
 * open/close behaviour — click the summary to toggle, click outside
 * to dismiss (we wire that explicitly since <details> doesn't do it).
 *
 * The menu re-renders its body every time it opens, so the file list
 * stays in sync with whatever's on disk.
 */

import type { NotebookFile } from "./files.ts";

export interface FileMenuActions {
  /** Read the live file list. */
  list(): Promise<NotebookFile[]>;
  /** Path of the currently-open notebook (so we can mark it). */
  currentPath(): string;
  /** Switch the open notebook. */
  open(path: string): Promise<void>;
  /** Create a new notebook (prompts for name). */
  createNew(): Promise<void>;
  /** Rename the currently-open notebook (prompts for new name). */
  renameCurrent(): Promise<void>;
  /** Delete the currently-open notebook (confirms first). */
  deleteCurrent(): Promise<void>;
}

/**
 * Mount the dropdown into the topbar's filename slot. Returns a render()
 * function the caller can invoke when the active path changes (so the
 * summary label updates without waiting for a menu open).
 */
export function mountFileMenu(host: HTMLElement, actions: FileMenuActions): { refresh: () => void } {
  host.innerHTML = `
    <details class="file-menu">
      <summary class="file-menu-summary"></summary>
      <div class="file-menu-body" role="menu"></div>
    </details>
  `;
  const details = host.querySelector<HTMLDetailsElement>("details")!;
  const summary = host.querySelector<HTMLElement>(".file-menu-summary")!;
  const body = host.querySelector<HTMLElement>(".file-menu-body")!;

  function setLabel(): void {
    summary.textContent = `${actions.currentPath().replace(/^\//, "")} ▾`;
  }

  async function renderBody(): Promise<void> {
    const files = await actions.list();
    const current = actions.currentPath();
    body.replaceChildren(
      ...files.map((f) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "file-menu-item";
        if (f.path === current) item.dataset["active"] = "true";
        item.textContent = f.name;
        item.addEventListener("click", async () => {
          close();
          await actions.open(f.path);
        });
        return item;
      }),
      separator(),
      action("+ New notebook…", async () => {
        close();
        await actions.createNew();
      }),
      action("Rename current…", async () => {
        close();
        await actions.renameCurrent();
      }),
      action("Delete current…", async () => {
        close();
        await actions.deleteCurrent();
      }),
    );
  }

  function close(): void {
    details.open = false;
  }

  // Re-render the body each time the menu opens so the file list is
  // always fresh — cheap, runs at most on every click of the summary.
  details.addEventListener("toggle", () => {
    if (details.open) void renderBody();
  });

  // Click-outside to dismiss. Only listens while the menu is open.
  document.addEventListener("click", (e) => {
    if (!details.open) return;
    if (!details.contains(e.target as Node)) close();
  });

  setLabel();
  return { refresh: setLabel };
}

function separator(): HTMLElement {
  const el = document.createElement("div");
  el.className = "file-menu-separator";
  el.setAttribute("role", "separator");
  return el;
}

function action(label: string, run: () => void | Promise<void>): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "file-menu-item file-menu-action";
  btn.textContent = label;
  btn.addEventListener("click", () => void run());
  return btn;
}
