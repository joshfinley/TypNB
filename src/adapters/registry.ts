import type { MimeBundle } from "../kernel/types.ts";
import type { OutputAdapter, TypstHtmlContent, TypstStaticContent } from "./types.ts";

export class AdapterRegistry {
  private adapters: OutputAdapter[] = [];

  register(adapter: OutputAdapter): void {
    this.adapters.push(adapter);
    this.adapters.sort((a, b) => b.priority - a.priority);
  }

  pick(mime: MimeBundle): OutputAdapter | null {
    for (const a of this.adapters) {
      if (a.matches(mime)) return a;
    }
    return null;
  }

  renderHtml(mime: MimeBundle): TypstHtmlContent {
    return this.pick(mime)?.toHtml(mime) ?? unsupported(mime);
  }

  renderPdf(mime: MimeBundle): TypstStaticContent {
    return this.pick(mime)?.toPdf(mime) ?? unsupported(mime);
  }
}

function unsupported(mime: MimeBundle): TypstHtmlContent {
  const types = Object.keys(mime).join(", ");
  return {
    typst: `#unsupported-output(mime: "${escapeTypst(types)}")`,
  };
}

function escapeTypst(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
