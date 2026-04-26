/**
 * Cell-source mutations triggered by editor UI actions (today: hide toggle).
 *
 * The shape of a #cell(...) call is regex-flat — the parser uses [^)]* for
 * the args and we mirror that here. If the args grammar ever needs nesting,
 * both this and parser/parse.ts have to upgrade together.
 */

/**
 * Toggle the `hidden:` attribute in a `#cell(...)` arg list.
 * - If `hidden: true` is present, removes it (and the surrounding comma if any).
 * - If `hidden: false` is present, flips it to `true`.
 * - Otherwise, appends `hidden: true` (with a leading comma if other args exist).
 */
export function toggleHiddenInArgs(args: string): string {
  // Match an existing `hidden: bool` attribute with optional surrounding commas.
  // Captures the boolean so we can flip vs. remove.
  const HIDDEN_RE = /(,\s*)?hidden\s*:\s*(true|false)(\s*,)?/;
  const m = args.match(HIDDEN_RE);
  if (m) {
    const [whole, leadingComma, value, trailingComma] = m;
    if (value === "false") {
      return args.replace(whole, `${leadingComma ?? ""}hidden: true${trailingComma ?? ""}`);
    }
    // value === "true": remove the attribute entirely. If we ate a comma on
    // either side, leave one behind so the remaining args stay valid.
    const replacement = leadingComma && trailingComma ? "," : "";
    return args.replace(whole, replacement).trim();
  }
  const trimmed = args.trim();
  return trimmed ? `${trimmed}, hidden: true` : `hidden: true`;
}

/**
 * Locate the `(args)` region inside a `#cell(...)` call's full text and
 * return its document offsets, or null if the parens aren't where we expect.
 *
 * Caller passes the cell's overall range; this function reads from `doc`
 * (the live editor text) so the args can be modified surgically without
 * round-tripping through getDoc/setDoc.
 */
export function findCellArgsRange(
  doc: string,
  cellRangeStart: number,
  cellRangeEnd: number,
): { argsStart: number; argsEnd: number; argsText: string } | null {
  const cellText = doc.slice(cellRangeStart, cellRangeEnd);
  const openParen = cellText.indexOf("(");
  const closeParen = cellText.indexOf(")", openParen);
  if (openParen < 0 || closeParen < 0) return null;
  const argsStart = cellRangeStart + openParen + 1;
  const argsEnd = cellRangeStart + closeParen;
  return { argsStart, argsEnd, argsText: doc.slice(argsStart, argsEnd) };
}
