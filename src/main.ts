import { mountApp } from "./app.ts";
import { installClientLogger } from "./dev/client-log.ts";

installClientLogger();

const root = document.getElementById("app");
if (!root) throw new Error("missing #app root");

// Fade out the inline-CSS loader (declared in index.html) once the app
// has mounted enough to be visually responsive — typst.ts WASM is up,
// editor and topbar are rendered. The kernel may still be coming up
// behind the kernel-loading status pill, but the chrome is interactive.
mountApp(root)
  .then(() => {
    const loader = document.getElementById("initial-loader");
    if (!loader) return;
    loader.classList.add("fade-out");
    // Remove from the DOM after the transition so it doesn't keep
    // intercepting nothing.
    setTimeout(() => loader.remove(), 250);
  })
  .catch((err) => {
    console.error("mountApp failed:", err);
    const loader = document.getElementById("initial-loader");
    if (loader) {
      loader.innerHTML = "<div>Failed to load. Check the console.</div>";
    }
  });
