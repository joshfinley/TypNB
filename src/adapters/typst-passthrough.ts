import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

const MIME = "application/x-typst";

/** Power-user / library escape hatch: emit Typst source verbatim. */
export const typstPassthroughAdapter: OutputAdapter = {
  name: "typst-passthrough",
  priority: 100,
  matches: (mime) => typeof mime[MIME] === "string",
  toHtml: (mime) => render(mime),
  toPdf: (mime) => render(mime),
};

function render(mime: MimeBundle): TypstHtmlContent & TypstStaticContent {
  return { typst: String(mime[MIME] ?? "") };
}
