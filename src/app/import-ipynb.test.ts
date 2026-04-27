import { describe, test, expect } from "vitest";
import { ipynbToTypst, markdownToTypst } from "./import-ipynb.ts";

describe("ipynbToTypst", () => {
  test("rejects non-notebook input", () => {
    expect(() => ipynbToTypst({})).toThrow();
    expect(() => ipynbToTypst("not a notebook")).toThrow();
    expect(() => ipynbToTypst(null)).toThrow();
  });

  test("handles an empty notebook", () => {
    const out = ipynbToTypst({ cells: [] });
    expect(out).toContain(`#import "/notebook.typ"`);
    expect(out).toContain("notebook.with");
  });

  test("converts a code cell into a runnable #cell block", () => {
    const out = ipynbToTypst({
      cells: [{ cell_type: "code", source: ["print(", "'hi')\n"] }],
    });
    expect(out).toMatch(/#cell\(id: "cell-1", lang: "python"\)\[```python\nprint\('hi'\)\n```\]/);
  });

  test("converts a markdown cell with an ATX heading", () => {
    const out = ipynbToTypst({
      cells: [{ cell_type: "markdown", source: "# Title\n\nSome prose." }],
    });
    expect(out).toContain("= Title");
    expect(out).toContain("Some prose.");
  });

  test("multiple cells alternate cleanly with double newlines", () => {
    const out = ipynbToTypst({
      cells: [
        { cell_type: "markdown", source: "intro" },
        { cell_type: "code", source: "x = 1" },
        { cell_type: "markdown", source: "outro" },
      ],
    });
    expect(out).toMatch(/intro\n\n#cell\([^)]*\)\[```python\nx = 1\n```\]\n\noutro/);
  });

  test("source can be a string OR an array of lines (Jupyter quirk)", () => {
    const fromArray = ipynbToTypst({
      cells: [{ cell_type: "code", source: ["print(", "'hi')"] }],
    });
    const fromString = ipynbToTypst({
      cells: [{ cell_type: "code", source: "print('hi')" }],
    });
    // Bodies should match (modulo cell ids).
    expect(fromArray.replace("cell-1", "X")).toBe(fromString.replace("cell-1", "X"));
  });

  test("drops outputs from code cells (we regenerate them)", () => {
    const out = ipynbToTypst({
      cells: [
        {
          cell_type: "code",
          source: "print('hi')",
          // Real notebooks have outputs[]; we shouldn't emit anything from them.
          outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }],
        } as any,
      ],
    });
    expect(out).not.toContain("hi\n");
  });
});

describe("markdownToTypst", () => {
  test("converts ATX heading levels to repeated equals signs", () => {
    expect(markdownToTypst("# A")).toBe("= A");
    expect(markdownToTypst("## B")).toBe("== B");
    expect(markdownToTypst("###### F")).toBe("====== F");
  });

  test("**bold** becomes *bold*", () => {
    expect(markdownToTypst("**bold**")).toBe("*bold*");
  });

  test("*italic* becomes _italic_", () => {
    expect(markdownToTypst("*italic*")).toBe("_italic_");
  });

  test("bold and italic together (one inside the other)", () => {
    // No nesting in the simple converter — just make sure they don't
    // collide. **bold word *italic* still bold** is real, but we punt.
    expect(markdownToTypst("**hello** and *world*")).toBe("*hello* and _world_");
  });

  test("preserves code fences", () => {
    const md = "before\n```python\nx = 1\n```\nafter";
    const out = markdownToTypst(md);
    expect(out).toContain("```python\nx = 1\n```");
  });

  test("preserves inline code without italicising it", () => {
    expect(markdownToTypst("use `*x*` here")).toBe("use `*x*` here");
  });

  test("converts numbered lists to + form", () => {
    const md = "1. one\n2. two\n3. three";
    const out = markdownToTypst(md);
    expect(out).toBe("+ one\n+ two\n+ three");
  });

  test("converts inline links to #link(\"url\")[text]", () => {
    expect(markdownToTypst(`see [the docs](https://example.com)`)).toBe(
      `see #link("https://example.com")[the docs]`,
    );
  });

  test("doesn't break the editor model on multi-line prose", () => {
    const md = "# Big idea\n\nFirst para. Second sentence.\n\nSecond para.";
    const out = markdownToTypst(md);
    expect(out).toContain("= Big idea");
    expect(out).toContain("First para.");
    expect(out).toContain("Second para.");
  });

  test("display math becomes a latex raw block (not Typst math)", () => {
    const md = "before\n$$\n\\sqrt{25}\n$$\nafter";
    const out = markdownToTypst(md);
    // Render the LaTeX as code so Typst doesn't try to parse it as math
    // and choke on `\sqrt{...}` (Typst uses `sqrt(...)`).
    expect(out).toContain("```latex\n\\sqrt{25}\n```");
  });

  test("inline math becomes inline raw, preserving subscripts/superscripts", () => {
    expect(markdownToTypst("see $a_1^2 + b_2^2$ here")).toBe(
      "see `a_1^2 + b_2^2` here",
    );
  });

  test("math content is shielded from later emphasis transforms", () => {
    // a_1 has an underscore; without protection the bold/italic passes
    // could break it (or downstream Typst could try to italicise it).
    const md = "$a_1 \\cdot b_1$ then *separate*";
    const out = markdownToTypst(md);
    expect(out).toContain("`a_1 \\cdot b_1`");
    expect(out).toContain("_separate_");
  });
});
