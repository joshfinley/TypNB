import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

export const plainAdapter: OutputAdapter = {
  name: "plain",
  priority: 1,
  matches: (mime) => typeof mime["text/plain"] === "string",
  toHtml: (mime) => render(mime),
  toPdf: (mime) => render(mime),
};

function render(mime: MimeBundle): TypstHtmlContent & TypstStaticContent {
  const text = String(mime["text/plain"] ?? "");
  return { typst: "```\n" + escapeFences(text) + "\n```" };
}

function escapeFences(s: string): string {
  // Avoid prematurely closing a Typst raw block.
  return s.replace(/```/g, "``\u200b`");
}
