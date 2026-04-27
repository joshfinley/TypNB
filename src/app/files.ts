/**
 * Notebook file management — pure FS ops on top of the FileSystem
 * interface, plus the active-path bookkeeping in localStorage.
 *
 * Conventions:
 * - Notebooks live as `/<name>.typ` at the FS root.
 * - Each notebook's persisted orchestrator state lives at
 *   `/<name>.typ.outputs.json` (see `outputsPathFor`). list() filters
 *   the .outputs.json files out so they don't show in the picker.
 */

import type { FileSystem } from "../fs/types.ts";

export interface NotebookFile {
  /** Full path including leading `/` and `.typ` extension. */
  readonly path: string;
  /** Display name — basename minus the `.typ` extension. */
  readonly name: string;
}

const ACTIVE_PATH_KEY = "notebook.activeFile";
const DEFAULT_PATH = "/main.typ";

export function getActivePath(): string {
  return localStorage.getItem(ACTIVE_PATH_KEY) ?? DEFAULT_PATH;
}

export function setActivePath(path: string): void {
  localStorage.setItem(ACTIVE_PATH_KEY, path);
}

export function outputsPathFor(docPath: string): string {
  return `${docPath}.outputs.json`;
}

/**
 * Turn a user-supplied name (e.g. "scratch", "scratch.typ", "/scratch.typ")
 * into a canonical notebook path. Throws on names that would escape the
 * root or contain path separators.
 */
export function pathFromName(name: string): string {
  let n = name.trim();
  if (!n) throw new Error("Notebook name is required.");
  n = n.replace(/^\/+/, "");
  if (n.includes("/")) throw new Error("Notebook name may not contain '/'.");
  if (n.includes("..")) throw new Error("Notebook name may not contain '..'.");
  if (!n.endsWith(".typ")) n += ".typ";
  return "/" + n;
}

export function nameFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.typ$/, "");
}

/** List notebooks at the FS root, sorted by display name. */
export async function listNotebooks(fs: FileSystem): Promise<NotebookFile[]> {
  const entries = await fs.list("/");
  return entries
    .filter((e) => e.kind === "file")
    .filter((e) => e.path.endsWith(".typ"))
    // Exclude the per-notebook outputs.json sidecars (they end in `.outputs.json`).
    .filter((e) => !e.path.endsWith(".outputs.json"))
    .map((e) => ({ path: e.path, name: nameFromPath(e.path) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createNotebook(fs: FileSystem, path: string, seed: string): Promise<void> {
  if (await fs.exists(path)) {
    throw new Error(`A notebook already exists at ${path}.`);
  }
  await fs.writeText(path, seed);
}

export async function renameNotebook(
  fs: FileSystem,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (oldPath === newPath) return;
  if (await fs.exists(newPath)) {
    throw new Error(`A notebook already exists at ${newPath}.`);
  }
  const text = await fs.readText(oldPath);
  await fs.writeText(newPath, text);
  await fs.remove(oldPath);
  // Rename the outputs sidecar too if it exists, so cached results
  // follow the notebook to its new name.
  const oldOutputs = outputsPathFor(oldPath);
  const newOutputs = outputsPathFor(newPath);
  if (await fs.exists(oldOutputs)) {
    const outputs = await fs.readText(oldOutputs);
    await fs.writeText(newOutputs, outputs);
    await fs.remove(oldOutputs);
  }
}

export async function deleteNotebook(fs: FileSystem, path: string): Promise<void> {
  if (await fs.exists(path)) await fs.remove(path);
  const outputs = outputsPathFor(path);
  if (await fs.exists(outputs)) await fs.remove(outputs);
}
