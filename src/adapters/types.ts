/**
 * MIME bundle → Typst content. Each adapter renders for both targets.
 *
 * Per architecture: ship 4 adapters that work perfectly. Unsupported MIME
 * types render a visible "unsupported" badge, never silently degrade and
 * never fail the build. Adapter registry is data, not code — adapters are
 * looked up by `matches(mime)` in priority order.
 */

import type { MimeBundle } from "../kernel/types.ts";

export interface TypstHtmlContent {
  readonly typst: string;
}

export interface TypstStaticContent {
  readonly typst: string;
}

export interface OutputAdapter {
  readonly name: string;
  /** Higher = considered first. */
  readonly priority: number;
  matches(mime: MimeBundle): boolean;
  toHtml(mime: MimeBundle): TypstHtmlContent;
  toPdf(mime: MimeBundle): TypstStaticContent;
}
