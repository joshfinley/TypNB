import type { FileEntry, FileSystem } from "./types.ts";

/**
 * Origin Private File System backend.
 * Real impl deferred — stub that throws on use so callers can detect support
 * and fall back to MemoryFileSystem until this is wired up.
 */
export class OpfsFileSystem implements FileSystem {
  private root: FileSystemDirectoryHandle | null = null;

  async init(): Promise<void> {
    this.root = await navigator.storage.getDirectory();
  }

  async readText(_path: string): Promise<string> {
    throw new Error("OpfsFileSystem.readText not implemented");
  }
  async writeText(_path: string, _contents: string): Promise<void> {
    throw new Error("OpfsFileSystem.writeText not implemented");
  }
  async readBytes(_path: string): Promise<Uint8Array> {
    throw new Error("OpfsFileSystem.readBytes not implemented");
  }
  async writeBytes(_path: string, _contents: Uint8Array): Promise<void> {
    throw new Error("OpfsFileSystem.writeBytes not implemented");
  }
  async exists(_path: string): Promise<boolean> {
    throw new Error("OpfsFileSystem.exists not implemented");
  }
  async remove(_path: string): Promise<void> {
    throw new Error("OpfsFileSystem.remove not implemented");
  }
  async list(_prefix: string): Promise<FileEntry[]> {
    throw new Error("OpfsFileSystem.list not implemented");
  }
}
