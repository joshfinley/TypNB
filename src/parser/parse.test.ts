import { describe, test, expect } from "vitest";
import { parseCells } from "./parse.ts";

const py = (body: string, id?: string) =>
  id !== undefined
    ? `#cell(id: "${id}", lang: "python")[\`\`\`python\n${body}\n\`\`\`]`
    : `#cell(lang: "python")[\`\`\`python\n${body}\n\`\`\`]`;

describe("parseCells", () => {
  test("extracts a single cell with explicit id", async () => {
    const cells = await parseCells(py("x = 1", "first"));
    expect(cells).toHaveLength(1);
    expect(cells[0]!.id).toBe("first");
    expect(cells[0]!.lang).toBe("python");
    expect(cells[0]!.source).toBe("x = 1\n");
  });

  test("auto-derives a hash-shaped id when no id is given", async () => {
    const cells = await parseCells(py("x = 1"));
    expect(cells[0]!.id).toMatch(/^cell-[0-9a-f]{8}$/);
  });

  test("auto-ids are stable across cell insertion above", async () => {
    const a = py("x = 1");
    const b = py("y = 2");
    const before = await parseCells(`${a}\n\n${b}`);
    const after = await parseCells(`${py("z = 0")}\n\n${a}\n\n${b}`);

    expect(after).toHaveLength(3);
    // The two original cells must keep the ids they had before — that's the
    // whole point of hashing the body instead of numbering by position.
    expect(after[1]!.id).toBe(before[0]!.id);
    expect(after[2]!.id).toBe(before[1]!.id);
  });

  test("disambiguates auto-ids when two cells share (lang, body)", async () => {
    const cells = await parseCells(`${py("x = 1")}\n\n${py("x = 1")}`);
    expect(cells).toHaveLength(2);
    expect(cells[0]!.id).not.toBe(cells[1]!.id);
    expect(cells[1]!.id).toBe(`${cells[0]!.id}-1`);
  });

  test("explicit ids pass through unchanged even if duplicated", async () => {
    // Duplicate explicit ids are user error — we don't silently rename.
    const cells = await parseCells(`${py("x = 1", "same")}\n\n${py("y = 2", "same")}`);
    expect(cells.map((c) => c.id)).toEqual(["same", "same"]);
  });

  test("hash is deterministic and depends on (lang, body)", async () => {
    const a = await parseCells(py("x = 1"));
    const b = await parseCells(py("x = 1"));
    expect(a[0]!.hash).toBe(b[0]!.hash);
    const c = await parseCells(py("x = 2"));
    expect(c[0]!.hash).not.toBe(a[0]!.hash);
  });

  test("range and bodyRange point at the right substrings", async () => {
    const src = `prefix\n${py("x = 1", "c1")}\nsuffix`;
    const cells = await parseCells(src);
    const c = cells[0]!;
    expect(src.slice(c.range.start, c.range.end)).toMatch(/^#cell\(.*\]$/s);
    expect(src.slice(c.bodyRange.start, c.bodyRange.end)).toBe("x = 1\n");
  });

  test("returns no cells for source without #cell calls", async () => {
    expect(await parseCells("= just a heading\n\nsome prose")).toEqual([]);
  });

  test("lazy defaults to false", async () => {
    const cells = await parseCells(py("x = 1"));
    expect(cells[0]!.lazy).toBe(false);
  });

  test("lazy: true is captured", async () => {
    const cells = await parseCells(
      `#cell(id: "load", lang: "python", lazy: true)[\`\`\`python\nx = 1\n\`\`\`]`,
    );
    expect(cells[0]!.lazy).toBe(true);
  });

  test("attribute order is independent (lang before id, lazy anywhere)", async () => {
    const cells = await parseCells(
      `#cell(lazy: true, lang: "python", id: "x")[\`\`\`python\ny = 1\n\`\`\`]`,
    );
    expect(cells[0]!.id).toBe("x");
    expect(cells[0]!.lang).toBe("python");
    expect(cells[0]!.lazy).toBe(true);
  });

  test("skips cells with unknown lang", async () => {
    const cells = await parseCells(
      `#cell(lang: "ruby")[\`\`\`ruby\nputs 1\n\`\`\`]`,
    );
    expect(cells).toEqual([]);
  });
});
