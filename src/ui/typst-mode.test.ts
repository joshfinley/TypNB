import { describe, test, expect } from "vitest";
import { typstParser } from "./typst-mode.ts";

interface Token {
  text: string;
  type: string | null;
}

/**
 * Drive the StreamParser by hand line-by-line and collect emitted tokens.
 * Mirrors what CodeMirror does internally. Whitespace-only matches return
 * null; we keep them so test cases can verify they aren't tokenised as
 * something coloured.
 */
function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let state = typstParser.startState!(0);
  for (const line of source.split("\n")) {
    let pos = 0;
    const stream = makeStream(line);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const type = typstParser.token(stream as never, state) ?? null;
      const text = line.slice(stream.start, stream.pos);
      if (text.length === 0) {
        // Defensive: no progress means infinite loop. Bail.
        out.push({ text: "<no-progress>", type });
        break;
      }
      out.push({ text, type });
      pos = stream.pos;
    }
    void pos;
  }
  return out;
}

/** A minimal StringStream-like object good enough for the parser we wrote. */
function makeStream(line: string) {
  let pos = 0;
  let start = 0;
  return {
    get pos() { return pos; },
    set pos(v: number) { pos = v; },
    get start() { return start; },
    set start(v: number) { start = v; },
    eol: () => pos >= line.length,
    next: () => {
      if (pos >= line.length) return undefined;
      return line.charAt(pos++);
    },
    peek: () => (pos >= line.length ? null : line.charAt(pos)),
    skipToEnd: () => { pos = line.length; },
    eatSpace: () => {
      const before = pos;
      while (pos < line.length && /\s/.test(line.charAt(pos))) pos++;
      return pos > before;
    },
    column: () => start,
    match(re: RegExp | string, consume?: boolean) {
      if (typeof re === "string") {
        if (line.slice(pos, pos + re.length) === re) {
          if (consume !== false) pos += re.length;
          return re;
        }
        return null;
      }
      // Mirror real StringStream: slice from current pos so ^ anchors match
      // at the cursor rather than at start-of-string.
      const slice = line.slice(pos);
      const m = slice.match(re);
      if (m && m.index === 0) {
        if (consume !== false) pos += m[0].length;
        return m;
      }
      return null;
    },
  };
}

describe("typstParser", () => {
  test("tokenises a line comment", () => {
    const tokens = tokenize("// a comment");
    expect(tokens.find((t) => t.type === "comment")).toBeTruthy();
  });

  test("tokenises a string literal", () => {
    const tokens = tokenize(`#let x = "hello"`);
    expect(tokens.find((t) => t.type === "string" && t.text === `"hello"`)).toBeTruthy();
  });

  test("tokenises a heading", () => {
    const tokens = tokenize("= My heading");
    // The whole line is consumed as header; just check the type appears.
    expect(tokens.find((t) => t.type === "header")).toBeTruthy();
  });

  test("tokenises a #function reference as variable (includes the # prefix)", () => {
    const tokens = tokenize("#image(path)");
    expect(tokens.find((t) => t.type === "variable" && t.text === "#image")).toBeTruthy();
  });

  test("tokenises a keyword form like #let (includes the # prefix)", () => {
    const tokens = tokenize("#let cell = ...");
    expect(tokens.find((t) => t.type === "keyword" && t.text === "#let")).toBeTruthy();
  });

  test("raw-block body returns null tokens (so inline language decorations win)", () => {
    const src = "```python\nx = 1\n```";
    const tokens = tokenize(src);
    // Opening fence is "string"; body line "x = 1" should NOT carry a class.
    const fence = tokens.find((t) => t.text.startsWith("```"));
    expect(fence?.type).toBe("string");
    const bodyToken = tokens.find((t) => t.text === "x" || t.text.includes("x = 1"));
    expect(bodyToken?.type).toBeNull();
  });
});
