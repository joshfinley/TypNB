import type { FileEntry, FileSystem } from "./types.ts";

export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, Uint8Array>();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  async init(): Promise<void> {}

  async readText(path: string): Promise<string> {
    const bytes = await this.readBytes(path);
    return this.decoder.decode(bytes);
  }

  async writeText(path: string, contents: string): Promise<void> {
    this.files.set(path, this.encoder.encode(contents));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  }

  async writeBytes(path: string, contents: Uint8Array): Promise<void> {
    this.files.set(path, contents);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(prefix: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) out.push({ path, kind: "file" });
    }
    return out;
  }
}
