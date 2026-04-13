import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, indentOnInput } from "@codemirror/language";

export interface EditorOptions {
  initialDoc: string;
  onChange(source: string): void;
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(value: string): void;
  destroy(): void;
}

export function mountEditor(host: HTMLElement, opts: EditorOptions): EditorHandle {
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
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
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
    destroy: () => view.destroy(),
  };
}
