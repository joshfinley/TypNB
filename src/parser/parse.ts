import type { Cell, CellLang, SourceRange } from "./types.ts";

/**
 * Extract `#cell(...)` invocations from a Typst document.
 *
 * v0: regex-based scan. Captures the whole arg block then parses it for
 * `id: "..."`, `lang: "..."`, `lazy: true|false` in any order. Once cells
 * stabilise we will swap this for a real Typst-aware parser (likely a thin
 * Lezer grammar) so cells inside conditionals, functions, or imports parse
 * correctly.
 */

const CELL_RE = /#cell\(([^)]*)\)\s*\[\s*```\s*\w*\s*\n([\s\S]*?)```\s*\]/g;

const VALID_LANGS = new Set<CellLang>(["python", "javascript", "typst"]);

export async function parseCells(source: string): Promise<Cell[]> {
  const cells: Cell[] = [];
  CELL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  // Disambiguate auto-derived ids when two cells share (lang, body). Explicit
  // ids are passed through unchanged — duplicates there are user error.
  const autoSeen = new Map<string, number>();
  while ((match = CELL_RE.exec(source)) !== null) {
    const [whole, argsRaw, body] = match;
    if (argsRaw === undefined || body === undefined) continue;
    const args = parseCellArgs(argsRaw);
    if (args.lang === undefined || !VALID_LANGS.has(args.lang as CellLang)) continue;
    const lang = args.lang as CellLang;
    const hash = await sha256(`${lang}\0${body}`);
    let id: string;
    if (args.id !== undefined) {
      id = args.id;
    } else {
      const base = `cell-${hash.slice(0, 8)}`;
      const n = autoSeen.get(base) ?? 0;
      autoSeen.set(base, n + 1);
      id = n === 0 ? base : `${base}-${n}`;
    }
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
      hash,
      lazy: args.lazy ?? false,
    });
  }
  return cells;
}

interface CellArgs {
  id?: string;
  lang?: string;
  lazy?: boolean;
}

function parseCellArgs(raw: string): CellArgs {
  const out: CellArgs = {};
  // Match `key: "string"` or `key: identifier` (true / false / bare names).
  const RE = /(\w+)\s*:\s*(?:"([^"]*)"|(\w+))/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(raw)) !== null) {
    const [, key, str, ident] = m;
    if (key === "id" || key === "lang") {
      if (str !== undefined) out[key] = str;
    } else if (key === "lazy") {
      if (ident === "true") out.lazy = true;
      else if (ident === "false") out.lazy = false;
    }
    // Other keys are ignored — Typst may carry them for the template.
  }
  return out;
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
