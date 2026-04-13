/**
 * Virtual filesystem the rest of the app sees.
 *
 * Implementations: in-memory (tests / fallback), OPFS (browser default),
 * future remote (HTTP/WebDAV/Git). The DAG and adapter layers consume this
 * interface only — they never touch the underlying storage directly.
 */

export interface FileEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface FileSystem {
  init(): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, contents: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<FileEntry[]>;
}
