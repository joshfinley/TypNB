/**
 * A cell is a `#cell(id: ..., lang: ...)[\`\`\`<lang> ... \`\`\`]` call inside
 * the document source. The parser extracts these into structured records
 * the DAG layer can hash, dedupe, and topologically order.
 */

export type CellLang = "python" | "javascript" | "typst";

export interface SourceRange {
  /** UTF-16 code-unit offset (matches String.prototype.slice / indexOf), inclusive. */
  readonly start: number;
  /** UTF-16 code-unit offset, exclusive. */
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
  /**
   * When true, the cell skips re-execution on upstream changes — its
   * cached output is reused. Only the cell's own source change OR an
   * explicit user trigger invalidates it. Mark expensive loaders/queries
   * lazy so downstream edits don't re-trigger them.
   */
  readonly lazy: boolean;
}
