/**
 * Stable `<canvas>` placeholder.
 *
 * Three.js will mount into this element once TASK-26 (streaming pipeline)
 * lands. Until then it sits empty so the page has the correct layout and
 * Playwright smoke tests can assert the canvas is present.
 */
import type * as React from "react";

export function CanvasStage(): React.JSX.Element {
  return (
    <canvas
      id="drift-canvas"
      data-testid="drift-canvas"
      style={{ display: "block", width: "100vw", height: "100vh" }}
    />
  );
}
