import type { CompileResult } from "../renderer/typst-wasm.ts";

export interface PreviewHandle {
  render(result: CompileResult): void;
  renderError(message: string): void;
}

export function mountPreview(host: HTMLElement): PreviewHandle {
  host.innerHTML = `<div class="preview-scroll"><div class="preview-pages" id="pp"></div><pre class="preview-error" id="pe" hidden></pre></div>`;
  const pages = host.querySelector<HTMLElement>("#pp")!;
  const err = host.querySelector<HTMLElement>("#pe")!;

  return {
    render(result) {
      err.hidden = true;
      err.textContent = "";
      // Diff in place: replace innerHTML only when pages count or content changes.
      const next = result.pages.map((svg) => `<div class="page">${svg}</div>`).join("");
      if (pages.innerHTML !== next) pages.innerHTML = next;
    },
    renderError(message) {
      err.hidden = false;
      err.textContent = message;
    },
  };
}
