/**
 * Three-step intro carousel for the claims screen (TASK-56).
 *
 * Auto-advances every 4 s, is skippable, and collapses to the last
 * slide when it runs out (rather than looping — the copy is a
 * one-shot onboarding beat, not a marquee). The dots double as a
 * progress indicator; `Skip intro` becomes `Replay` once the run
 * finishes so a curious player can re-read the copy.
 *
 * @see ./ClaimsScreen.tsx for the panel that owns this.
 */
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

/** The spec's three slides, in order. */
export const INTRO_SLIDES: readonly string[] = [
  "This is a living galaxy. Every system is real.",
  "Fly. Land. Go on foot. No loading screens.",
  "Mine. Haul. Sell. Survive.",
] as const;

/** Auto-advance cadence per slide (spec: 4 s). */
export const INTRO_SLIDE_MS = 4_000;

/**
 * The carousel. Renders the active slide, the dot row, and the
 * skip / replay toggle.
 */
export function IntroCarousel(): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const [active, setActive] = useState(true);
  const last = INTRO_SLIDES.length - 1;

  useEffect(() => {
    if (!active || idx >= last) return;
    const id = window.setTimeout(() => setIdx((i) => Math.min(i + 1, last)), INTRO_SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [idx, active, last]);

  const skip = useCallback(() => {
    setActive(false);
    setIdx(last);
  }, [last]);

  const replay = useCallback(() => {
    setIdx(0);
    setActive(true);
  }, []);

  const done = idx >= last;

  return (
    <div
      data-testid="drift-claims-intro"
      style={{
        minHeight: 56,
        padding: "10px 14px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.04)",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div
        data-testid="drift-claims-intro-slide"
        style={{ fontSize: 13, color: "#d8e2ec", letterSpacing: "0.02em" }}
      >
        {INTRO_SLIDES[idx]}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {INTRO_SLIDES.map((_, dot) => (
          <span
            key={dot}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: dot === idx ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.22)",
            }}
          />
        ))}
        <button
          type="button"
          data-testid="drift-claims-intro-skip"
          onClick={done ? replay : skip}
          style={{
            marginLeft: 6,
            background: "transparent",
            border: "none",
            color: "#9aa3ad",
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {done ? "Replay" : "Skip intro"}
        </button>
      </div>
    </div>
  );
}
