/**
 * Destruction presentation layer — TASK-49.
 *
 * Renders the three client-only moments of the death loop from the
 * `DestructionStore` snapshot:
 *
 *   1. **Explosion** — a 1 s white flash, an expanding shockwave
 *      quad, and 8 tumbling tetrahedron-ish debris shards that fade
 *      over 3 s. Screen-space (the v1 FX layer is CSS-driven, like
 *      TASK-43's weapon flashes) — the position is the viewport
 *      centre so the effect reads regardless of where the wreck is
 *      on the camera rig.
 *   2. **SHIP LOST** — a 2 s full-screen moment: the callsign, the
 *      killer, and "Respawning at <nearest dock>". The player is
 *      already back in a fresh scout server-side; this is the beat
 *      that sells the loss.
 *   3. **Wreck markers** — `▸ <callsign>` labels for wrecks within
 *      200 m, the same DOM-label family as the character labels.
 *
 * A single rAF loop drives `store.reap` so the effects retire on
 * their own timers without a React state churn per frame.
 *
 * @see ../fx/destruction.ts for the store + timing constants.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from "react";

import {
  debrisOffsets,
  type DestructionStore,
  explosionProgress,
  killerLabelFor,
  respawnLabelFor,
  DEBRIS_MS,
  EXPLOSION_FLASH_MS,
  SHIP_LOST_MS,
  SHOCKWAVE_MS,
} from "../fx/destruction.js";

const DEBRIS = debrisOffsets();

export interface DestructionFxProps {
  /** Store wired into the WS layer's `combat_event` pipeline. */
  store: DestructionStore;
}

/**
 * The destruction FX layer. Mount once near the root of the HUD
 * tree; it renders nothing until the store has live state.
 */
export function DestructionFx({ store }: DestructionFxProps): ReactElement | null {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  const rafRef = useRef<number | null>(null);

  // Single rAF loop: advance the store clock every frame. The
  // loop is always running (cheap — `reap` short-circuits when
  // nothing is live) so a late-arriving explosion is picked up.
  useEffect(() => {
    const loop = (): void => {
      store.reap(Date.now());
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [store]);

  const now = Date.now();
  const active = snapshot.explosions.filter((e) => now - e.startedAt < DEBRIS_MS);
  if (active.length === 0 && snapshot.shipLost === null && snapshot.markers.length === 0)
    return null;

  return (
    <div
      data-testid="destruction-fx"
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 60 }}
    >
      {active.map((boom) => {
        const age = now - boom.startedAt;
        const p = explosionProgress(boom, now);
        const flash = Math.max(0, 1 - age / EXPLOSION_FLASH_MS);
        const wave = Math.max(0, 1 - age / SHOCKWAVE_MS);
        return (
          <div
            key={boom.id}
            data-testid="explosion"
            style={{ position: "absolute", left: "50%", top: "50%" }}
          >
            <div
              data-testid="explosion-flash"
              style={{
                position: "absolute",
                left: -120,
                top: -120,
                width: 240,
                height: 240,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(255,244,214,0.95), rgba(255,138,42,0.55) 45%, rgba(0,0,0,0) 72%)",
                opacity: flash,
                transform: `scale(${0.6 + (1 - flash) * 0.6})`,
              }}
            />
            <div
              data-testid="explosion-shockwave"
              style={{
                position: "absolute",
                left: -150,
                top: -150,
                width: 300,
                height: 300,
                borderRadius: "50%",
                border: "3px solid rgba(255,196,120,0.85)",
                opacity: wave,
                transform: `scale(${0.2 + (1 - wave) * 1.8})`,
              }}
            />
            {DEBRIS.map((d, i) => (
              <div
                key={i}
                data-testid="explosion-debris"
                style={{
                  position: "absolute",
                  left: -4,
                  top: -4,
                  width: 8,
                  height: 8,
                  background: "rgba(255,208,150,0.9)",
                  clipPath: "polygon(50% 0, 100% 100%, 0 100%)",
                  transform: `translate(${d.dx * p * 150}px, ${d.dy * p * 150 - p * p * 40}px) rotate(${
                    d.spin * p
                  }deg)`,
                  opacity: 1 - p,
                }}
              />
            ))}
          </div>
        );
      })}

      {snapshot.shipLost !== null && now - snapshot.shipLost.startedAt < SHIP_LOST_MS ? (
        <div
          data-testid="ship-lost-overlay"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            background: "rgba(8, 6, 10, 0.72)",
            color: "#ff8a5c",
            font: "600 28px/1.3 ui-monospace, monospace",
            letterSpacing: "0.18em",
          }}
        >
          <div data-testid="ship-lost-title">SHIP LOST</div>
          <div style={{ font: "400 15px/1.4 ui-monospace, monospace", color: "#e8e2d8" }}>
            {snapshot.shipLost.callsign}
          </div>
          <div style={{ font: "400 14px/1.4 ui-monospace, monospace", color: "#c9bfb2" }}>
            {killerLabelFor(snapshot.shipLost)}
          </div>
          <div style={{ font: "400 14px/1.4 ui-monospace, monospace", color: "#8fd6c0" }}>
            {respawnLabelFor(snapshot.shipLost)}
          </div>
          {Object.keys(snapshot.shipLost.cargoLost).length > 0 ? (
            <div style={{ font: "400 13px/1.4 ui-monospace, monospace", color: "#a08f7a" }}>
              Cargo lost:{" "}
              {Object.entries(snapshot.shipLost.cargoLost)
                .map(([r, n]) => `${n} ${r}`)
                .join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {snapshot.markers.map((m) => (
        <div
          key={m.wreckId}
          data-testid="wreck-marker"
          style={{
            position: "absolute",
            left: 16,
            bottom: 120 + snapshot.markers.indexOf(m) * 20,
            color: "#c9bfb2",
            font: "400 12px/1.2 ui-monospace, monospace",
            background: "rgba(10, 10, 14, 0.55)",
            padding: "2px 6px",
            border: "1px solid rgba(201,191,178,0.35)",
          }}
        >
          ▸ {m.killerCallsign ?? "unknown"} · {Math.round(m.distanceM)} m
        </div>
      ))}
    </div>
  );
}

export default DestructionFx;
