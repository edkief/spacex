/**
 * RadialMiningProgress — TASK-38 server-timed mining channel UI.
 *
 * A radial-progress conic-gradient that wraps the
 * `[E] Take <resource>` prompt when the player holds E on a
 * deposit. The radial value is server-timed: the server pushes a
 * `mining_update` echo every award + every snap to a Cadence
 * boundary, and the UI animates between echoes via
 * `requestAnimationFrame` so the gradient never goes stale.
 *
 * Acceptance criteria (mirrors TASK-38 spec):
 *
 *   - Radial progress 0→100% over 1.5 s (one channel unit).
 *   - "+1 iron" float text on every award (1 s fade).
 *   - "Depleted" toast when the deposit's `amount` hits 0.
 *   - "Backpack full" toast when the server pauses for cap.
 *   - Hidden when no mining is active (the component returns null).
 *
 * The component is intentionally framework-light (CSS-only
 * animation) so it doesn't fight the existing InteractionPrompt's
 * positioning. It mounts as an overlay directly above the prompt.
 */
import { useEffect, useRef, useState } from "react";
import type * as React from "react";

const MINE_TICK_MS = 1500;
const FLOAT_TEXT_TTL_MS = 1000;

export interface RadialMiningProgressProps {
  /**
   * The latest `mining_update` echo from the server. `null`
   * hides the radial entirely.
   */
  update: {
    depositId: string;
    resourceId: string;
    progressMs: number;
    unitsSoFar: number;
    amount: number;
    state: "mining" | "paused-full" | "depleted" | "cancelled";
  } | null;
  /**
   * Server timestamp (ms) at which the current echo arrived.
   * The radial animates from this anchor until the next echo
   * arrives or `MINE_TICK_MS` elapses.
   */
  receivedAtMs: number;
  /**
   * Set to `false` when the WS is offline. The radial hides
   * so the player doesn't see a stuck gradient.
   */
  enabled: boolean;
}

interface FloatText {
  id: number;
  text: string;
  spawnedAtMs: number;
}

/**
 * The radial + float overlay. Mounts only while `enabled` AND
 * `update` is non-null.
 */
export function RadialMiningProgress(props: RadialMiningProgressProps): React.JSX.Element | null {
  const { update, receivedAtMs, enabled } = props;
  const [radialPct, setRadialPct] = useState(0);
  const [floats, setFloats] = useState<FloatText[]>([]);
  const lastUnitsRef = useRef(0);
  const lastStateRef = useRef<string | null>(null);
  const lastDepositRef = useRef<string | null>(null);
  const floatIdRef = useRef(0);

  // Animate the radial between echoes. The server is the source
  // of truth on the echo events; the rAF loop just fills in the
  // interstitial time so the gradient sweeps smoothly.
  useEffect(() => {
    if (!update || !enabled) {
      setRadialPct(0);
      return;
    }
    if (update.state !== "mining") {
      // Pause / depleted / cancelled — show a static full or
      // empty circle depending on the state.
      setRadialPct(update.state === "paused-full" ? radialPct : 0);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const elapsed = performance.now() - receivedAtMs + update.progressMs;
      const pct = Math.max(0, Math.min(100, (elapsed / MINE_TICK_MS) * 100));
      setRadialPct(pct);
      if (pct < 100) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [update, receivedAtMs, enabled, radialPct]);

  // Spawn a "+1 <resource>" float on every unit awarded.
  useEffect(() => {
    if (!update || !enabled) return;
    // Only spawn on a "mining" echo (the server emits these on
    // every successful award); skip start (unitsSoFar=0) and
    // skip echoes that didn't actually add a unit.
    if (update.state !== "mining") return;
    if (lastDepositRef.current !== update.depositId) {
      // New channel — reset unit counter so the first echo
      // (unitsSoFar=0) doesn't spawn a stray float.
      lastDepositRef.current = update.depositId;
      lastUnitsRef.current = update.unitsSoFar;
      lastStateRef.current = update.state;
      return;
    }
    if (lastStateRef.current !== update.state) {
      lastStateRef.current = update.state;
    }
    if (update.unitsSoFar > lastUnitsRef.current) {
      const spawnedAtMs = performance.now();
      const id = (floatIdRef.current += 1);
      const text = `+${update.unitsSoFar - lastUnitsRef.current} ${resourceLabel(update.resourceId)}`;
      setFloats((prev) => [...prev, { id, text, spawnedAtMs }]);
      lastUnitsRef.current = update.unitsSoFar;
      // Schedule the float's removal after its TTL.
      window.setTimeout(() => {
        setFloats((prev) => prev.filter((f) => f.id !== id));
      }, FLOAT_TEXT_TTL_MS);
    }
  }, [update, enabled]);

  if (!enabled || !update) return null;
  // Only render the radial while the channel is open or has
  // recently finished (depleted/cancelled) so the toast fades.
  if (update.state === "depleted" || update.state === "cancelled") {
    // Render the float + final toast for one cycle, then the
    // parent should clear the update by passing `null`.
    return (
      <div
        data-testid="drift-mining-progress"
        data-state={update.state}
        style={{ position: "absolute", left: "50%", bottom: 156, transform: "translateX(-50%)" }}
      >
        <FinalToast state={update.state} unitsAwarded={update.unitsSoFar} />
        <FloatLayer floats={floats} />
      </div>
    );
  }
  if (update.state === "paused-full") {
    return (
      <div
        data-testid="drift-mining-progress"
        data-state="paused-full"
        style={{ position: "absolute", left: "50%", bottom: 156, transform: "translateX(-50%)" }}
      >
        <PauseToast />
        <FloatLayer floats={floats} />
      </div>
    );
  }
  return (
    <div
      data-testid="drift-mining-progress"
      data-state="mining"
      data-progress={Math.round(radialPct)}
      style={{ position: "absolute", left: "50%", bottom: 156, transform: "translateX(-50%)" }}
    >
      <RadialRing pct={radialPct} />
      <FloatLayer floats={floats} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — small enough to share the same file.
// ---------------------------------------------------------------------------

function RadialRing({ pct }: { pct: number }): React.JSX.Element {
  return (
    <div
      style={{
        position: "relative",
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: `conic-gradient(rgba(245, 185, 77, 0.95) ${pct}%, rgba(230, 237, 243, 0.18) ${pct}%)`,
        border: "1px solid rgba(230, 237, 243, 0.35)",
        boxShadow: "0 0 0 2px rgba(20, 24, 32, 0.85)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 12,
          borderRadius: "50%",
          background: "rgba(20, 24, 32, 0.92)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#e6edf3",
          fontSize: 11,
          fontFamily: "monospace",
          letterSpacing: "0.08em",
          pointerEvents: "none",
        }}
      >
        {Math.round(pct)}%
      </div>
    </div>
  );
}

function FloatLayer({ floats }: { floats: FloatText[] }): React.JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: -20,
        transform: "translateX(-50%)",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {floats.map((f) => (
        <span
          key={f.id}
          data-testid="drift-mining-float"
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: "rgba(245, 185, 77, 0.95)",
            textShadow: "0 1px 2px rgba(0,0,0,0.7)",
            animation: `drift-mining-float 1s ease-out forwards`,
          }}
        >
          {f.text}
        </span>
      ))}
    </div>
  );
}

function PauseToast(): React.JSX.Element {
  return (
    <div
      data-testid="drift-mining-paused"
      style={{
        padding: "6px 12px",
        background: "rgba(248, 81, 73, 0.85)",
        borderRadius: 4,
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      Backpack full
    </div>
  );
}

function FinalToast({
  state,
  unitsAwarded,
}: {
  state: "depleted" | "cancelled";
  unitsAwarded: number;
}): React.JSX.Element {
  const label = state === "depleted" ? "Deposit depleted" : `Stopped (+${unitsAwarded})`;
  return (
    <div
      data-testid="drift-mining-final"
      style={{
        padding: "6px 12px",
        background: state === "depleted" ? "rgba(46, 160, 67, 0.85)" : "rgba(230, 237, 243, 0.18)",
        borderRadius: 4,
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resourceLabel(resourceId: string): string {
  // Pretty-print the canonical resource ids so the float reads
  // "iron", "copper", "rare-earths", "crystal" — matches the
  // resource catalog on the server.
  switch (resourceId) {
    case "iron":
      return "iron";
    case "copper":
      return "copper";
    case "rare-earths":
      return "rare-earths";
    case "crystal":
      return "crystal";
    default:
      return resourceId;
  }
}
