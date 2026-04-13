import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

/**
 * matplotlib hands us SVG via `image/svg+xml`. Same content for HTML and PDF
 * targets — Typst's image element handles SVG natively.
 *
 * The adapter does NOT inline the SVG into Typst source (bad for caching and
 * ugly diffs). Instead it returns a synthesised path; the runtime is expected
 * to write the SVG bytes to that path on the virtual FS before invoking
 * typst compile. The path scheme is documented and stable.
 */
export const matplotlibAdapter: OutputAdapter = {
  name: "matplotlib-svg",
  priority: 50,
  matches: (mime) => typeof mime["image/svg+xml"] === "string",
  toHtml: (mime) => render(mime),
  toPdf: (mime) => render(mime),
};

function render(mime: MimeBundle): TypstHtmlContent & TypstStaticContent {
  // The runtime writes mime["image/svg+xml"] to this path before compiling.
  // Path is content-addressed so duplicate figures share a single file.
  const svg = String(mime["image/svg+xml"] ?? "");
  const hash = quickHash(svg);
  const path = `_outputs/figures/${hash}.svg`;
  return { typst: `#figure(image("${path}"))` };
}

function quickHash(s: string): string {
  // Fast non-crypto hash — just for content addressing of cached figures.
  // Real impl will use the kernel-provided cell id + figure index.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
