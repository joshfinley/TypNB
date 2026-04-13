import { mountApp } from "./app.ts";
import { installClientLogger } from "./dev/client-log.ts";

installClientLogger();

const root = document.getElementById("app");
if (!root) throw new Error("missing #app root");
mountApp(root);
