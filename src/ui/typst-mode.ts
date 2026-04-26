/**
 * Tiny StreamLanguage tokenizer for Typst.
 *
 * v0: just enough to colour comments, strings, headings, function calls,
 * raw blocks, and inline emphasis. The full Typst grammar is much bigger;
 * the README's "Real Typst-aware cell parser" task is also where a proper
 * Lezer grammar would live, and we'd reuse it here.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";

interface State {
  /** Inside a backtick-delimited raw block. */
  inRaw: boolean;
  /** Inside a /* ... *\/ block comment. */
  inBlockComment: boolean;
}

const startState = (): State => ({ inRaw: false, inBlockComment: false });

const TYPST_KEYWORD = /^(?:let|set|show|if|else|for|while|in|return|import|include|as|none|true|false|auto)\b/;

export const typstParser: StreamParser<State> = {
  startState,

  token(stream, state) {
    // Block comment continuation
    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match(/\*\//)) {
          state.inBlockComment = false;
          return "comment";
        }
        stream.next();
      }
      return "comment";
    }

    // Raw block continuation. `[` and `]` inside are literal Typst content,
    // so we don't need to track bracket nesting here.
    if (state.inRaw) {
      while (!stream.eol()) {
        if (stream.match(/```/)) {
          state.inRaw = false;
          return "string";
        }
        stream.next();
      }
      return "string";
    }

    if (stream.eatSpace()) return null;

    // Comments
    if (stream.match(/\/\//)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/\/\*/)) {
      state.inBlockComment = true;
      return "comment";
    }

    // Raw block opening (with optional language tag)
    if (stream.match(/```\w*/)) {
      state.inRaw = true;
      return "string";
    }
    // Inline raw `code`
    if (stream.match(/`[^`]*`/)) return "string";

    // String
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";

    // Headings: leading run of `=` followed by space. Only valid at start
    // of a line; check column. StreamLanguage maps "header" → tags.heading.
    if (stream.column() === 0 && stream.match(/=+\s/)) {
      stream.skipToEnd();
      return "header";
    }

    // # function/variable references — `#fn(...)`, `#var`, `#let`, ...
    if (stream.match(/#/)) {
      // Keyword forms
      if (stream.match(TYPST_KEYWORD)) return "keyword";
      // Identifier (function call or variable reference). StreamLanguage
      // maps "variable" → tags.variableName.
      if (stream.match(/[a-zA-Z_][a-zA-Z0-9_-]*/)) return "variable";
      return "operator";
    }

    // Strong: *...*  (single line, no nesting)
    if (stream.match(/\*[^*\n]+\*/)) return "strong";
    // Emphasis: _..._
    if (stream.match(/_[^_\n]+_/)) return "emphasis";

    // Numbers
    if (stream.match(/\d+(?:\.\d+)?(?:pt|em|in|cm|mm|%)?/)) return "number";

    // Bare keyword (inside code mode after `#let` etc.)
    if (stream.match(TYPST_KEYWORD)) return "keyword";

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },
};

export const typstLanguage = StreamLanguage.define(typstParser);
