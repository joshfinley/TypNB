import type { Cell, CellLang, SourceRange } from "./types.ts";

/**
 * Extract `#cell(...)` invocations from a Typst document.
 *
 * v0: regex-based scan for the canonical form:
 *   #cell(id: "name", lang: "python")[
 *     ```python
 *     ...
 *     ```
 *   ]
 *
 * The full Typst grammar is non-trivial; once cells stabilise we will swap
 * this for a real Typst-aware parser (likely a thin Lezer grammar) so that
 * cells inside conditionals, functions, or imports parse correctly.
 */

const CELL_RE =
  /#cell\(\s*(?:id:\s*"([^"]+)"\s*,\s*)?lang:\s*"(python|javascript|typst)"\s*\)\s*\[\s*```\s*\w*\s*\n([\s\S]*?)```\s*\]/g;

export async function parseCells(source: string): Promise<Cell[]> {
  const cells: Cell[] = [];
  CELL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let auto = 0;
  while ((match = CELL_RE.exec(source)) !== null) {
    const [whole, idArg, langArg, body] = match;
    if (langArg === undefined || body === undefined) continue;
    const id = idArg ?? `cell-${++auto}`;
    const lang = langArg as CellLang;
    const start = match.index;
    const end = start + whole.length;
    const bodyStart = source.indexOf(body, start);
    const bodyRange: SourceRange = { start: bodyStart, end: bodyStart + body.length };
    const range: SourceRange = { start, end };
    cells.push({
      id,
      lang,
      source: body,
      range,
      bodyRange,
      hash: await sha256(`${lang}\0${body}`),
    });
  }
  return cells;
}

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}
