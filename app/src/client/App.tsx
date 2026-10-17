/**
 * Top-level React shell.
 *
 * One concern: lay out the canvas placeholder (which the three.js renderer
 * will eventually adopt) and the HUD slot. Real HUD widgets land in
 * TASK-50/TASK-51/TASK-52/TASK-53; this scaffold intentionally renders
 * nothing fancier than a centered title so smoke screenshots stay clean.
 */
import type * as React from "react";
import { CanvasStage } from "./components/CanvasStage.js";

export function App(): React.JSX.Element {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#05060a",
        color: "#e6edf3",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <CanvasStage />
      <header
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "8px 12px",
          background: "rgba(0, 0, 0, 0.4)",
          borderRadius: 6,
          letterSpacing: "0.18em",
          fontSize: 12,
          textTransform: "uppercase",
        }}
      >
        Drift — scaffold
      </header>
    </div>
  );
}
