/**
 * Drift client entry point.
 *
 * Mounts the React DOM tree inside `#root` and renders a minimal shell
 * with a stable `<canvas>` placeholder. The three.js renderer (TASK-26)
 * will own the canvas directly; React only manages HUD/menus around it
 * per the architecture constraints in the project PRD.
 *
 * StrictMode is intentionally OFF in v1: the DriftClient owns a
 * WebSocket lifecycle that does not tolerate a duplicate mount/unmount
 * cycle (the second mount would open a fresh socket, double-claim a
 * callsign, and produce two phantom player rows in the server's
 * roster). The double-invocation semantics are still exercised by the
 * `wsClient.test.ts` unit suite, which calls `start()` + `start()` in
 * the same tick to verify the idempotency guards.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { MenuShellProvider } from "./ui/menu/MenuShell.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root container in index.html");
}

// TASK-53: the menu shell wraps the whole tree so every surface
// (ESC menu, star chart, ship / dock panel) shares one stack — and
// one input gate.
createRoot(container).render(
  <MenuShellProvider>
    <App />
  </MenuShellProvider>,
);
