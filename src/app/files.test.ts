import { describe, test, expect, beforeEach } from "vitest";
import { MemoryFileSystem } from "../fs/memory.ts";
import {
  createNotebook,
  deleteNotebook,
  listNotebooks,
  nameFromPath,
  outputsPathFor,
  pathFromName,
  renameNotebook,
} from "./files.ts";

let fs: MemoryFileSystem;
beforeEach(async () => {
  fs = new MemoryFileSystem();
  await fs.init();
});

describe("pathFromName", () => {
  test("appends .typ when missing", () => {
    expect(pathFromName("scratch")).toBe("/scratch.typ");
  });
  test("preserves .typ when present", () => {
    expect(pathFromName("scratch.typ")).toBe("/scratch.typ");
  });
  test("strips leading slash", () => {
    expect(pathFromName("/scratch")).toBe("/scratch.typ");
  });
  test("rejects empty name", () => {
    expect(() => pathFromName("")).toThrow();
    expect(() => pathFromName("   ")).toThrow();
  });
  test("rejects path separators", () => {
    expect(() => pathFromName("foo/bar")).toThrow();
  });
  test("rejects ..", () => {
    expect(() => pathFromName("..")).toThrow();
  });
});

describe("nameFromPath", () => {
  test("strips directory and extension", () => {
    expect(nameFromPath("/foo/bar.typ")).toBe("bar");
    expect(nameFromPath("/main.typ")).toBe("main");
  });
});

describe("outputsPathFor", () => {
  test("appends .outputs.json", () => {
    expect(outputsPathFor("/x.typ")).toBe("/x.typ.outputs.json");
  });
});

describe("listNotebooks", () => {
  test("returns empty when FS is empty", async () => {
    expect(await listNotebooks(fs)).toEqual([]);
  });
  test("filters to .typ files", async () => {
    await fs.writeText("/notes.typ", "= notes");
    await fs.writeText("/data.json", "{}");
    await fs.writeText("/readme.md", "# readme");
    const list = await listNotebooks(fs);
    expect(list.map((n) => n.name)).toEqual(["notes"]);
  });
  test("filters out the .outputs.json sidecars", async () => {
    await fs.writeText("/main.typ", "= main");
    await fs.writeText("/main.typ.outputs.json", "{}");
    const list = await listNotebooks(fs);
    expect(list.map((n) => n.name)).toEqual(["main"]);
  });
  test("sorts by display name", async () => {
    await fs.writeText("/zeta.typ", "");
    await fs.writeText("/alpha.typ", "");
    await fs.writeText("/mu.typ", "");
    const list = await listNotebooks(fs);
    expect(list.map((n) => n.name)).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("createNotebook", () => {
  test("writes the seed and rejects duplicates", async () => {
    await createNotebook(fs, "/new.typ", "seed");
    expect(await fs.readText("/new.typ")).toBe("seed");
    await expect(createNotebook(fs, "/new.typ", "x")).rejects.toThrow();
  });
});

describe("renameNotebook", () => {
  test("moves the doc and its outputs sidecar", async () => {
    await fs.writeText("/old.typ", "doc");
    await fs.writeText("/old.typ.outputs.json", "{}");
    await renameNotebook(fs, "/old.typ", "/new.typ");
    expect(await fs.exists("/old.typ")).toBe(false);
    expect(await fs.exists("/old.typ.outputs.json")).toBe(false);
    expect(await fs.readText("/new.typ")).toBe("doc");
    expect(await fs.readText("/new.typ.outputs.json")).toBe("{}");
  });
  test("noop if old === new", async () => {
    await fs.writeText("/x.typ", "doc");
    await renameNotebook(fs, "/x.typ", "/x.typ");
    expect(await fs.readText("/x.typ")).toBe("doc");
  });
  test("rejects if target already exists", async () => {
    await fs.writeText("/a.typ", "a");
    await fs.writeText("/b.typ", "b");
    await expect(renameNotebook(fs, "/a.typ", "/b.typ")).rejects.toThrow();
  });
  test("works without an outputs sidecar", async () => {
    await fs.writeText("/a.typ", "a");
    await renameNotebook(fs, "/a.typ", "/b.typ");
    expect(await fs.readText("/b.typ")).toBe("a");
  });
});

describe("deleteNotebook", () => {
  test("removes the doc and its outputs sidecar", async () => {
    await fs.writeText("/x.typ", "doc");
    await fs.writeText("/x.typ.outputs.json", "{}");
    await deleteNotebook(fs, "/x.typ");
    expect(await fs.exists("/x.typ")).toBe(false);
    expect(await fs.exists("/x.typ.outputs.json")).toBe(false);
  });
  test("is idempotent for missing files", async () => {
    await expect(deleteNotebook(fs, "/never.typ")).resolves.toBeUndefined();
  });
});
