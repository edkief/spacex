/**
 * Drift client entry point.
 *
 * Mounts the React DOM tree inside `#root` and renders a minimal shell
 * with a stable `<canvas>` placeholder. The three.js renderer (TASK-26)
 * will own the canvas directly; React only manages HUD/menus around it
 * per the architecture constraints in the project PRD.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root container in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
