import { defineConfig, type Plugin } from "vite";

/**
 * Forwards errors/warnings from the browser to the dev server terminal.
 * Disabled in production builds.
 */
function clientLogPlugin(): Plugin {
  return {
    name: "client-log",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__client_log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const { level, message, stack, url } = JSON.parse(body) as {
              level: string;
              message: string;
              stack?: string;
              url?: string;
            };
            const tag =
              level === "error"
                ? "\x1b[31m[client error]\x1b[0m"
                : level === "warn"
                  ? "\x1b[33m[client warn]\x1b[0m"
                  : "\x1b[2m[client log]\x1b[0m";
            const where = url ? ` \x1b[2m(${url})\x1b[0m` : "";
            // eslint-disable-next-line no-console
            console.log(`${tag} ${message}${where}`);
            if (stack) console.log(`\x1b[2m${stack}\x1b[0m`);
          } catch (err) {
            console.log(`[client log] failed to parse payload: ${String(err)}`);
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [clientLogPlugin()],
  // GitHub Pages serves at /TypNB/; Vite asset URLs need that prefix in
  // the build output. Dev keeps its bare /. (clientLogPlugin's `apply:
  // "serve"` already handles its own dev-only scoping.)
  base: command === "build" ? "/TypNB/" : "/",
  server: {
    port: 5173,
    fs: { strict: true },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["pyodide"],
  },
  worker: {
    format: "es",
  },
}));
