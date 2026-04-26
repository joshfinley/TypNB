import type { FileEntry, FileSystem } from "./types.ts";

/**
 * Origin Private File System backend.
 *
 * Path conventions:
 *   - All paths are absolute and start with "/". Leading and trailing
 *     slashes are normalised away when resolving against OPFS handles.
 *   - Intermediate directories are created on write and skipped silently
 *     on remove. `exists` returns false for missing parents (no throw).
 *   - `list(prefix)` walks the entire tree from root and filters; for
 *     this app's data sizes (a handful of .typ files) that's fine.
 */
export class OpfsFileSystem implements FileSystem {
  private root: FileSystemDirectoryHandle | null = null;

  async init(): Promise<void> {
    this.root = await navigator.storage.getDirectory();
  }

  async readText(path: string): Promise<string> {
    const file = await this.openFile(path);
    return await file.text();
  }

  async writeText(path: string, contents: string): Promise<void> {
    const handle = await this.fileHandle(path, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file = await this.openFile(path);
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeBytes(path: string, contents: Uint8Array): Promise<void> {
    const handle = await this.fileHandle(path, { create: true });
    const writable = await handle.createWritable();
    // Wrap in Blob so we sidestep the Uint8Array<ArrayBufferLike> vs
    // <ArrayBuffer> generic mismatch TS surfaces against FileSystemWriteChunkType.
    await writable.write(new Blob([contents as BlobPart]));
    await writable.close();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fileHandle(path, { create: false });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async remove(path: string): Promise<void> {
    const segments = splitPath(path);
    if (segments.length === 0) throw new Error(`cannot remove root`);
    const fileName = segments.pop()!;
    const dir = await this.dirHandle(segments, { create: false });
    if (!dir) return; // parent missing → already gone
    try {
      await dir.removeEntry(fileName, { recursive: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async list(prefix: string): Promise<FileEntry[]> {
    const root = this.requireRoot();
    const out: FileEntry[] = [];
    await walk(root, "", out);
    const norm = normalisePrefix(prefix);
    return out.filter((e) => e.path.startsWith(norm));
  }

  // ── private ─────────────────────────────────────────────────────────

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.root) throw new Error("OpfsFileSystem.init() not called");
    return this.root;
  }

  private async fileHandle(
    path: string,
    opts: { create: boolean },
  ): Promise<FileSystemFileHandle> {
    const segments = splitPath(path);
    if (segments.length === 0) throw new Error(`invalid path: ${path}`);
    const fileName = segments.pop()!;
    const dir = await this.dirHandle(segments, opts);
    if (!dir) throw notFound(path);
    return await dir.getFileHandle(fileName, { create: opts.create });
  }

  private async dirHandle(
    segments: string[],
    opts: { create: boolean },
  ): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.requireRoot();
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create: opts.create });
      } catch (err) {
        if (!opts.create && isNotFound(err)) return null;
        throw err;
      }
    }
    return dir;
  }

  private async openFile(path: string): Promise<File> {
    const handle = await this.fileHandle(path, { create: false });
    return await handle.getFile();
  }
}

async function walk(
  dir: FileSystemDirectoryHandle,
  base: string,
  out: FileEntry[],
): Promise<void> {
  // FileSystemDirectoryHandle is async-iterable as [name, handle] pairs.
  for await (const [name, entry] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    const path = `${base}/${name}`;
    if (entry.kind === "directory") {
      out.push({ path, kind: "directory" });
      await walk(entry as FileSystemDirectoryHandle, path, out);
    } else {
      out.push({ path, kind: "file" });
    }
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function normalisePrefix(prefix: string): string {
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  return prefix;
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

function notFound(path: string): DOMException {
  return new DOMException(`ENOENT: ${path}`, "NotFoundError");
}
