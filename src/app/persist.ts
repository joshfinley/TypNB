/**
 * Filesystem-backed persistence for the open document and the orchestrator's
 * reload-relevant state. Both live in OPFS when available, in-memory when
 * not (private-mode Firefox, enterprise lockdowns, etc.).
 *
 * Path resolution lives in app/files.ts; this module is just FS init plus
 * the read-with-fallback helpers used by the load path.
 */

import { MemoryFileSystem } from "../fs/memory.ts";
import { OpfsFileSystem } from "../fs/opfs.ts";
import type { FileSystem } from "../fs/types.ts";

/** Capability check + init together. Falls through to memory FS on error. */
export async function initFileSystem(): Promise<FileSystem> {
  const opfsAvailable =
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function";
  if (opfsAvailable) {
    try {
      const opfs = new OpfsFileSystem();
      await opfs.init();
      return opfs;
    } catch (err) {
      console.warn("OPFS init failed; falling back to in-memory FS:", err);
    }
  }
  const mem = new MemoryFileSystem();
  await mem.init();
  return mem;
}

/** Read a doc from the FS, seeding it with `seed` if missing. */
export async function loadOrSeed(fs: FileSystem, path: string, seed: string): Promise<string> {
  try {
    if (await fs.exists(path)) return await fs.readText(path);
  } catch (err) {
    console.warn(`failed to read ${path}; seeding fresh:`, err);
  }
  try {
    await fs.writeText(path, seed);
  } catch (err) {
    console.warn(`failed to seed ${path}:`, err);
  }
  return seed;
}

/**
 * Read a previously-persisted orchestrator state from disk. Returns null
 * (with a warning) if the file is missing, unreadable, or corrupt — the
 * orchestrator can rebuild from scratch on the next forced run.
 */
export async function loadPersistedState(fs: FileSystem, path: string): Promise<unknown> {
  try {
    if (!(await fs.exists(path))) return null;
    const raw = await fs.readText(path);
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`failed to load persisted state from ${path}:`, err);
    return null;
  }
}
