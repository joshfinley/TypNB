import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, indentOnInput } from "@codemirror/language";

export interface EditorOptions {
  initialDoc: string;
  onChange(source: string): void;
  /**
   * Extra keybindings appended ahead of the defaults so they can pre-empt
   * built-ins (e.g. Cmd-Enter for run-current-cell).
   */
  extraKeymap?: readonly KeyBinding[];
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(value: string): void;
  /** Document offset of the primary selection's head. */
  getCursor(): number;
  destroy(): void;
}

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const extras: readonly KeyBinding[] = opts.extraKeymap ?? [];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: opts.initialDoc,
      extensions: [
        lineNumbers(),
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
    destroy: () => view.destroy(),
  };
}
