/**
 * A cell is a `#cell(id: ..., lang: ...)[\`\`\`<lang> ... \`\`\`]` call inside
 * the document source. The parser extracts these into structured records
 * the DAG layer can hash, dedupe, and topologically order.
 */

export type CellLang = "python" | "javascript" | "typst";

export interface SourceRange {
  /** Byte offset, inclusive */
  readonly start: number;
  /** Byte offset, exclusive */
  readonly end: number;
}

export interface Cell {
  /** Stable identifier — explicit `id:` arg or auto-derived. */
  readonly id: string;
  readonly lang: CellLang;
  /** Cell body (the code inside the raw block). */
  readonly source: string;
  /** Position of the entire `#cell(...)` call in the document. */
  readonly range: SourceRange;
  /** Position of the body within the document, for editing. */
  readonly bodyRange: SourceRange;
  /**
   * Cells with identical hashes are interchangeable for caching.
   * Equals SHA-256 of (lang + "\0" + source), populated by the parser.
   */
  readonly hash: string;
}
