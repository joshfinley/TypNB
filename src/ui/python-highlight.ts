/**
 * Lezer-based Python syntax highlighting layered onto cell bodies.
 *
 * The editor's host language is StreamLanguage Typst (good enough for
 * prose). For each python cell, we run @lezer/python's parser on the
 * body text and emit Mark decorations via highlightTree, using the same
 * defaultHighlightStyle palette so the colours compose with the Typst
 * tokens around them.
 *
 * Body ranges are tracked in a state field that maps through document
 * changes — so when the user types inside a cell, the range expands
 * and the next decoration build picks up the new text. Orchestrator
 * parses (debounced) replace the ranges wholesale via setPyBodiesEffect.
 */

import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { parser as pythonParser } from "@lezer/python";
import { classHighlighter, highlightTree } from "@lezer/highlight";

export interface PyCellBody {
  readonly from: number;
  readonly to: number;
}

export const setPyBodiesEffect = StateEffect.define<readonly PyCellBody[]>();

const pyBodiesField = StateField.define<readonly PyCellBody[]>({
  create: () => [],
  update(val, tr) {
    for (const e of tr.effects) {
      if (e.is(setPyBodiesEffect)) return e.value;
    }
    if (tr.docChanged) {
      // Body ranges follow the user's edits between orchestrator parses.
      // Bias both ends to associate inserted text *inside* the body with
      // the body, not the surrounding ``` fences.
      return val.map((b) => ({
        from: tr.changes.mapPos(b.from, 1),
        to: tr.changes.mapPos(b.to, -1),
      }));
    }
    return val;
  },
});

function buildPyDecorations(
  state: EditorState,
  bodies: readonly PyCellBody[],
): DecorationSet {
  if (bodies.length === 0) return Decoration.none;
  const sorted = [...bodies].sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const body of sorted) {
    if (body.to <= body.from) continue;
    const text = state.sliceDoc(body.from, body.to);
    const tree = pythonParser.parse(text);
    // classHighlighter emits concrete `tok-*` class names (debuggable in
    // DevTools, fixed across builds). Pair with the .tok-* CSS rules in
    // style.css for the visual styling. The Typst host tokenizer leaves
    // raw-block bodies untagged, so these classes apply cleanly without
    // an outer tok-string fighting them on specificity.
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      const start = body.from + from;
      const end = body.from + to;
      if (end > start) {
        builder.add(start, end, Decoration.mark({ class: classes }));
      }
    });
  }
  return builder.finish();
}

const pyDecorationsField = StateField.define<DecorationSet>({
  create: (state) => buildPyDecorations(state, state.field(pyBodiesField, false) ?? []),
  update(deco, tr) {
    const bodiesChanged = tr.effects.some((e) => e.is(setPyBodiesEffect));
    if (tr.docChanged || bodiesChanged) {
      const bodies = tr.state.field(pyBodiesField);
      return buildPyDecorations(tr.state, bodies);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Extension bundle to plug into mountEditor's extensions array. */
export const pythonHighlight: Extension = [pyBodiesField, pyDecorationsField];
