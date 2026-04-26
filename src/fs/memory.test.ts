import { describe, test, expect, beforeEach } from "vitest";
import { MemoryFileSystem } from "./memory.ts";

let fs: MemoryFileSystem;
beforeEach(async () => {
  fs = new MemoryFileSystem();
  await fs.init();
});

describe("FileSystem (MemoryFileSystem)", () => {
  test("writeText then readText round-trips", async () => {
    await fs.writeText("/main.typ", "= Hello");
    expect(await fs.readText("/main.typ")).toBe("= Hello");
  });

  test("writeBytes then readBytes round-trips exact bytes", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await fs.writeBytes("/data.bin", bytes);
    const out = await fs.readBytes("/data.bin");
    expect(out).toEqual(bytes);
  });

  test("readText after writeBytes decodes UTF-8", async () => {
    await fs.writeBytes("/u.txt", new TextEncoder().encode("héllo"));
    expect(await fs.readText("/u.txt")).toBe("héllo");
  });

  test("readText for missing file rejects", async () => {
    await expect(fs.readText("/missing.typ")).rejects.toThrow();
  });

  test("exists is true after write, false after remove, false for never-written", async () => {
    expect(await fs.exists("/x")).toBe(false);
    await fs.writeText("/x", "y");
    expect(await fs.exists("/x")).toBe(true);
    await fs.remove("/x");
    expect(await fs.exists("/x")).toBe(false);
  });

  test("remove on missing path is a no-op", async () => {
    await expect(fs.remove("/never-existed")).resolves.toBeUndefined();
  });

  test("writeText overwrites prior contents", async () => {
    await fs.writeText("/c", "1");
    await fs.writeText("/c", "2");
    expect(await fs.readText("/c")).toBe("2");
  });

  test("list filters by prefix", async () => {
    await fs.writeText("/notebooks/a.typ", "a");
    await fs.writeText("/notebooks/b.typ", "b");
    await fs.writeText("/other/c.typ", "c");
    const entries = await fs.list("/notebooks/");
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["/notebooks/a.typ", "/notebooks/b.typ"]);
  });

  test("list returns empty array for unmatched prefix", async () => {
    await fs.writeText("/a", "a");
    expect(await fs.list("/b/")).toEqual([]);
  });
});
