import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

/**
 * pandas DataFrame → Typst `#table(...)`.
 *
 * The kernel-side helper is expected to emit a structured representation under
 * a custom `application/vnd.notebook.dataframe+json` MIME with shape:
 *   { columns: string[], rows: (string|number|null)[][] }
 *
 * pandas does NOT emit this MIME natively; the Pyodide bootstrap script will
 * monkey-patch DataFrame._repr_mimebundle_ to add it. Until that lands, this
 * adapter is registered but won't match anything.
 */

const MIME = "application/vnd.notebook.dataframe+json";

interface DataFramePayload {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export const pandasAdapter: OutputAdapter = {
  name: "pandas-dataframe",
  priority: 60,
  matches: (mime) => typeof mime[MIME] === "object" && mime[MIME] !== null,
  toHtml: (mime) => render(mime),
  toPdf: (mime) => render(mime),
};

function render(mime: MimeBundle): TypstHtmlContent & TypstStaticContent {
  const df = mime[MIME] as DataFramePayload;
  const ncols = df.columns.length;
  const headerCells = df.columns.map((c) => `[*${escape(c)}*]`).join(", ");
  const bodyCells = df.rows
    .flatMap((row) => row.map((v) => `[${escape(v == null ? "" : String(v))}]`))
    .join(", ");
  return {
    typst: `#table(columns: ${ncols}, ${headerCells}, ${bodyCells})`,
  };
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
