import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

/**
 * matplotlib hands us SVG via `image/svg+xml`. Same content for HTML and PDF
 * targets — Typst's image element handles SVG natively.
 *
 * The SVG is inlined into the Typst source as `image(bytes("..."), ...)`.
 * A path-based VFS scheme would be lighter on bundle size for very large
 * figures, but it requires plumbing a "side-effects map" of (path, bytes)
 * pairs through the orchestrator → renderer boundary plus a stale-file
 * GC pass. Inlining keeps the adapter pure.
 */
export const matplotlibAdapter: OutputAdapter = {
  name: "matplotlib-svg",
  priority: 50,
  matches: (mime) => typeof mime["image/svg+xml"] === "string",
  toHtml: (mime) => render(mime),
  toPdf: (mime) => render(mime),
};

function render(mime: MimeBundle): TypstHtmlContent & TypstStaticContent {
  const svg = String(mime["image/svg+xml"] ?? "");
  const escaped = escapeTypstString(svg);
  return { typst: `#figure(image(bytes("${escaped}"), format: "svg"))` };
}

function escapeTypstString(s: string): string {
  // Typst string literals use C-style backslash escapes — only `\` and `"`
  // need quoting; embedded newlines and other UTF-8 are accepted verbatim.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
