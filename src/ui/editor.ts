import { EditorState, StateEffect, StateField, RangeSet } from "@codemirror/state";
import {
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
import { bracketMatching, indentOnInput } from "@codemirror/language";

/** A cell to render a run-button gutter marker against. */
export interface CellMarker {
  /** Document offset of the cell's first byte (the line that begins `#cell(...)`). */
  readonly from: number;
  readonly cellId: string;
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
        cellGutter,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        highlightSelectionMatches(),
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
      view.dispatch({ effects: setCellsEffect.of(cells) });
    },
    destroy: () => view.destroy(),
  };
}
