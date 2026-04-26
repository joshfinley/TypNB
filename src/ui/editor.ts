import {
  EditorState,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
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
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
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
  /** Source-hiding state from the cell metadata; collapses the body in the editor and preview. */
  readonly hidden: boolean;
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
  /** Click-handler for the per-cell hide-toggle gutter button. */
  onToggleHidden?: (cellId: string) => void;
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(value: string): void;
  /** Document offset of the primary selection's head. */
  getCursor(): number;
  /** Update the cell-run gutter markers to match the latest parse. */
  setCells(cells: readonly CellMarker[]): void;
  /** Replace a document range with new text — used by the hide toggle. */
  replaceRange(from: number, to: number, insert: string): void;
  destroy(): void;
}

/** Effect that replaces the cell-run gutter markers wholesale. */
const setCellsEffect = StateEffect.define<readonly CellMarker[]>();

interface CellActionsCallbacks {
  onRun?: (cellId: string) => void;
  onToggleHidden?: (cellId: string) => void;
}

class CellActionsMarker extends GutterMarker {
  constructor(
    private readonly cellId: string,
    private readonly state: CellMarker["state"],
    private readonly hidden: boolean,
    private readonly cb: CellActionsCallbacks,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof CellActionsMarker &&
      other.cellId === this.cellId &&
      other.state === this.state &&
      other.hidden === this.hidden
    );
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-cell-actions";

    const run = document.createElement("button");
    run.className = "cm-run-cell";
    run.dataset["state"] = this.state;
    run.type = "button";
    run.textContent = "▶";
    run.title = `Run cell (${this.cellId})`;
    run.addEventListener("mousedown", (e) => {
      // mousedown rather than click: the gutter's own click handling can
      // shift focus and swallow the event before click fires.
      e.preventDefault();
      e.stopPropagation();
      this.cb.onRun?.(this.cellId);
    });
    wrap.appendChild(run);

    const hide = document.createElement("button");
    hide.className = "cm-hide-cell";
    hide.dataset["hidden"] = String(this.hidden);
    hide.type = "button";
    hide.textContent = this.hidden ? "▸" : "▾";
    hide.title = this.hidden ? "Show cell source" : "Hide cell source";
    hide.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onToggleHidden?.(this.cellId);
    });
    wrap.appendChild(hide);

    return wrap;
  }
}

function buildMarkerSet(
  cells: readonly CellMarker[],
  cb: CellActionsCallbacks,
): RangeSet<CellActionsMarker> {
  const sorted = [...cells].sort((a, b) => a.from - b.from);
  return RangeSet.of(
    sorted.map((c) =>
      new CellActionsMarker(c.cellId, c.state, c.hidden, cb).range(c.from),
    ),
    true,
  );
}

// Line decorations spanning each cell's range. Pure visual delineation
// (not in the source, doesn't affect copy) — gives the user a sense of
// where one cell ends and the next begins without intrusive markup.
const cellLineDeco = Decoration.line({ class: "cm-cell-line" });
const cellLineFirstDeco = Decoration.line({ class: "cm-cell-line cm-cell-line-first" });
const cellLineLastDeco = Decoration.line({ class: "cm-cell-line cm-cell-line-last" });

/**
 * Replacement widget for hidden cells: collapses the body lines into a
 * single `··· hidden ···` placeholder. The text is still in the document,
 * so cursor / undo / copy all work — only the rendering is collapsed.
 */
class HiddenBodyWidget extends WidgetType {
  constructor(private readonly cellId: string) { super(); }
  override eq(other: WidgetType): boolean {
    return other instanceof HiddenBodyWidget && other.cellId === this.cellId;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-hidden-body";
    el.textContent = "  ··· hidden ···  ";
    el.title = `Cell source hidden (${this.cellId})`;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Compute the decoration set for cell line delineation + collapse of any
 * hidden-cell bodies. Uses Decoration.set rather than RangeSetBuilder so
 * the line decorations and the hidden-body Replace decoration can interleave
 * (the Replace sits mid-cell, between later line starts) without violating
 * the builder's strict monotonic-add requirement.
 */
function buildLineDecorations(
  doc: EditorState["doc"],
  cells: readonly CellMarker[],
): DecorationSet {
  if (cells.length === 0) return Decoration.none;
  const sorted = [...cells].sort((a, b) => a.from - b.from);
  const ranges: Range<Decoration>[] = [];
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
      ranges.push(deco.range(line.from));
    }
    if (cell.hidden && cell.bodyTo > cell.bodyFrom) {
      ranges.push(
        Decoration.replace({ widget: new HiddenBodyWidget(cell.cellId) }).range(
          cell.bodyFrom,
          cell.bodyTo,
        ),
      );
    }
  }
  return Decoration.set(ranges, true);
}

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const extras: readonly KeyBinding[] = opts.extraKeymap ?? [];
  const cb: CellActionsCallbacks = {
    ...(opts.onRunCell ? { onRun: opts.onRunCell } : {}),
    ...(opts.onToggleHidden ? { onToggleHidden: opts.onToggleHidden } : {}),
  };

  const cellMarkersField = StateField.define<RangeSet<CellActionsMarker>>({
    create: () => RangeSet.empty,
    update(set, tr) {
      set = set.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setCellsEffect)) set = buildMarkerSet(e.value, cb);
      }
      return set;
    },
  });

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

  const cellGutter = gutter({
    class: "cm-cell-gutter",
    markers: (view) => view.state.field(cellMarkersField),
    initialSpacer: () => new CellActionsMarker("", "idle", false, {}),
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
        // classHighlighter emits `tok-*` class names; the CSS for those
        // lives in src/ui/style.css alongside the editor chrome rules.
        syntaxHighlighting(classHighlighter),
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
      // Hidden python cells get no python decorations — body is collapsed.
      const pyBodies = cells
        .filter((c) => c.lang === "python" && !c.hidden)
        .map((c) => ({ from: c.bodyFrom, to: c.bodyTo }));
      view.dispatch({
        effects: [setCellsEffect.of(cells), setPyBodiesEffect.of(pyBodies)],
      });
    },
    replaceRange: (from, to, insert) => {
      view.dispatch({ changes: { from, to, insert } });
    },
    destroy: () => view.destroy(),
  };
}
