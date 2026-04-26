import { EditorState, StateEffect, StateField, RangeSet, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { typstLanguage } from "./typst-mode.ts";
import { pythonHighlight, setPyBodiesEffect } from "./python-highlight.ts";

/** A cell to render a run-button gutter marker against. */
export interface CellMarker {
  /** Document offset of the cell's first byte (the line that begins `#cell(...)`). */
  readonly from: number;
  /** Document offset just past the cell's last byte; used for line-decoration spans. */
  readonly to: number;
  /** Range of the cell's source body inside the raw block — fed to the language parser. */
  readonly bodyFrom: number;
  readonly bodyTo: number;
  readonly cellId: string;
  /** Cell's declared language; only "python" gets sub-language highlighting today. */
  readonly lang: string;
  readonly state: "idle" | "ok" | "stale" | "running" | "error";
}

export interface EditorOptions {
  initialDoc: string;
  onChange(source: string): void;
  /**
   * Extra keybindings appended ahead of the defaults so they can pre-empt
   * built-ins (e.g. Cmd-Enter for run-current-cell).
   */
  extraKeymap?: readonly KeyBinding[];
  /** Click-handler for the per-cell ▶ gutter button. */
  onRunCell?: (cellId: string) => void;
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(value: string): void;
  /** Document offset of the primary selection's head. */
  getCursor(): number;
  /** Update the cell-run gutter markers to match the latest parse. */
  setCells(cells: readonly CellMarker[]): void;
  destroy(): void;
}

/** Effect that replaces the cell-run gutter markers wholesale. */
const setCellsEffect = StateEffect.define<readonly CellMarker[]>();

class RunCellMarker extends GutterMarker {
  constructor(
    private readonly cellId: string,
    private readonly state: CellMarker["state"],
    private readonly onRun: ((cellId: string) => void) | undefined,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof RunCellMarker &&
      other.cellId === this.cellId &&
      other.state === this.state
    );
  }
  override toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "cm-run-cell";
    btn.dataset["state"] = this.state;
    btn.type = "button";
    btn.textContent = "▶";
    btn.title = `Run cell (${this.cellId})`;
    btn.addEventListener("mousedown", (e) => {
      // mousedown rather than click: the gutter's own click handling can
      // shift focus and swallow the event before click fires.
      e.preventDefault();
      e.stopPropagation();
      this.onRun?.(this.cellId);
    });
    return btn;
  }
}

function buildMarkerSet(
  cells: readonly CellMarker[],
  onRun: ((cellId: string) => void) | undefined,
): RangeSet<RunCellMarker> {
  const sorted = [...cells].sort((a, b) => a.from - b.from);
  return RangeSet.of(
    sorted.map((c) => new RunCellMarker(c.cellId, c.state, onRun).range(c.from)),
    true,
  );
}

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const extras: readonly KeyBinding[] = opts.extraKeymap ?? [];

  const cellMarkersField = StateField.define<RangeSet<RunCellMarker>>({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setCellsEffect)) set = buildMarkerSet(e.value, opts.onRunCell);
      }
      return set;
    },
  });

  // Line decorations spanning each cell's range. Pure visual delineation
  // (not in the source, doesn't affect copy) — gives the user a sense of
  // where one cell ends and the next begins without intrusive markup.
  const cellLineDeco = Decoration.line({ class: "cm-cell-line" });
  const cellLineFirstDeco = Decoration.line({ class: "cm-cell-line cm-cell-line-first" });
  const cellLineLastDeco = Decoration.line({ class: "cm-cell-line cm-cell-line-last" });

  const cellLinesField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setCellsEffect)) set = buildLineDecorations(tr.state.doc, e.value);
      }
      return set;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function buildLineDecorations(
    doc: EditorState["doc"],
    cells: readonly CellMarker[],
  ): DecorationSet {
    if (cells.length === 0) return Decoration.none;
    const sorted = [...cells].sort((a, b) => a.from - b.from);
    const builder = new RangeSetBuilder<Decoration>();
    for (const cell of sorted) {
      const startLine = doc.lineAt(Math.min(cell.from, doc.length));
      const endLine = doc.lineAt(Math.min(cell.to, doc.length));
      for (let n = startLine.number; n <= endLine.number; n++) {
        const line = doc.line(n);
        const deco =
          n === startLine.number
            ? cellLineFirstDeco
            : n === endLine.number
              ? cellLineLastDeco
              : cellLineDeco;
        builder.add(line.from, line.from, deco);
      }
    }
    return builder.finish();
  }

  const cellGutter = gutter({
    class: "cm-cell-gutter",
    markers: (view) => view.state.field(cellMarkersField),
    initialSpacer: () => new RunCellMarker("", "idle", undefined),
  });

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: opts.initialDoc,
      extensions: [
        lineNumbers(),
        cellMarkersField,
        cellLinesField,
        cellGutter,
        pythonHighlight,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        highlightSelectionMatches(),
        typstLanguage,
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([...extras, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) opts.onChange(v.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)" },
          ".cm-scroller": { fontFamily: "var(--mono)" },
          ".cm-content": { padding: "12px 0" },
          ".cm-line": { padding: "0 12px" },
          ".cm-gutters": {
            backgroundColor: "var(--panel)",
            color: "var(--muted)",
            border: "none",
            borderRight: "1px solid var(--border)",
          },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
        }),
      ],
    }),
  });

  return {
    getDoc: () => view.state.doc.toString(),
    setDoc: (value) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    getCursor: () => view.state.selection.main.head,
    setCells: (cells) => {
      const pyBodies = cells
        .filter((c) => c.lang === "python")
        .map((c) => ({ from: c.bodyFrom, to: c.bodyTo }));
      view.dispatch({
        effects: [setCellsEffect.of(cells), setPyBodiesEffect.of(pyBodies)],
      });
    },
    destroy: () => view.destroy(),
  };
}
