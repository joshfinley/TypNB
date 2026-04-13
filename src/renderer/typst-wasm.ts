/**
 * Typst renderer. Wraps @myriaddreamin/typst.ts so the rest of the app sees a
 * tiny stable surface: compile(source) -> SVG pages.
 *
 * v0 returns an array of inline SVG strings, one per page. Same shape we used
 * in the playground; the preview layer only needs to know how to splat them.
 */

import { $typst } from "@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs";

export interface CompileResult {
  readonly pages: readonly string[];
}

export interface TypstRenderer {
  compile(source: string): Promise<CompileResult>;
  /** Inject an extra source file into the compiler's virtual filesystem. */
  setExtraSource(path: string, content: string): Promise<void>;
}

let initialised: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (initialised) return initialised;
  initialised = (async () => {
    // Use the official mirror for now; later we self-host these assets.
    $typst.setCompilerInitOptions({
      getModule: () =>
        "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
    });
    $typst.setRendererInitOptions({
      getModule: () =>
        "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm",
    });
    // Fonts: the WASM compiler ships a default set; we wire in custom font
    // preloading once we self-host the assets.
  })();
  return initialised;
}

export async function createTypstRenderer(): Promise<TypstRenderer> {
  await ensureInit();
  return {
    async compile(source: string): Promise<CompileResult> {
      const svg = await $typst.svg({ mainContent: source });
      // typst.ts returns one big concatenated SVG; for v0 we just hand it back
      // as a single page. Splitting per-page comes when we need it.
      return { pages: [svg] };
    },
    async setExtraSource(path: string, content: string): Promise<void> {
      await $typst.addSource(path, content);
    },
  };
}
