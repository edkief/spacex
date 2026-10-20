/**
 * Threat-ping bearing → wedge rotation + TTL fade — TASK-50
 * acceptance. The wedge is screen-anchored: `rotation = 90° −
 * bearing`, fading linearly over `THREAT_PING_TTL_MS` (3 s).
 */
import { describe, expect, it } from "vitest";

import { THREAT_PING_TTL_MS } from "@shared/targeting.js";
import { THREAT_WEDGE_MAX_OPACITY, threatWedgeGradient, threatWedgeState } from "./threatPing.js";
import { selectStrongestPing, type ThreatPing } from "../targeting.js";

function ping(bearing: number, ts: number): ThreatPing {
  return { id: 1, sourceId: "AI-1", sourceCallsign: null, bearing, ts };
}

describe("threatWedgeState (TASK-50)", () => {
  it("points the wedge at the top of the screen for a dead-ahead attacker", () => {
    expect(threatWedgeState(0, 0).rotationDeg).toBe(90);
  });

  it("mirrors the wedge for a left-of-nose attacker", () => {
    expect(threatWedgeState(90, 0).rotationDeg).toBe(0);
    expect(threatWedgeState(-90, 0).rotationDeg).toBe(180);
    expect(threatWedgeState(45, 0).rotationDeg).toBe(45);
  });

  it("fades linearly to zero across the 3 s TTL", () => {
    expect(threatWedgeState(0, 0).opacity).toBeCloseTo(THREAT_WEDGE_MAX_OPACITY, 5);
    expect(threatWedgeState(0, THREAT_PING_TTL_MS / 2).opacity).toBeCloseTo(
      THREAT_WEDGE_MAX_OPACITY / 2,
      5,
    );
    const last = threatWedgeState(0, THREAT_PING_TTL_MS - 1);
    expect(last.live).toBe(true);
    expect(last.opacity).toBeGreaterThan(0);
    expect(last.opacity).toBeLessThan(0.01);
  });

  it("is dead at and past the TTL", () => {
    const dead = threatWedgeState(30, THREAT_PING_TTL_MS);
    expect(dead.live).toBe(false);
    expect(dead.opacity).toBe(0);
    expect(threatWedgeState(30, THREAT_PING_TTL_MS + 500).live).toBe(false);
  });

  it("keeps the rotation even when dead (no NaN style write)", () => {
    expect(threatWedgeState(Number.NaN, 0).rotationDeg).toBe(90);
    expect(threatWedgeState(Number.NaN, 9_999).rotationDeg).toBe(90);
  });

  it("emits a conic-gradient wedge", () => {
    const gradient = threatWedgeGradient(42, "#ff3b30", 0.8);
    expect(gradient.startsWith("conic-gradient(")).toBe(true);
    expect(gradient).toContain("rgba(255,59,48,0.800)");
  });
});

describe("selectStrongestPing (TASK-50 HUD contract)", () => {
  it("returns the most recent ping inside the 5 s window", () => {
    const now = 100_000;
    const pings = [ping(10, now - 4_000), ping(20, now - 200)];
    expect(selectStrongestPing(pings, now)?.bearing).toBe(20);
  });

  it("returns null when every ping has expired", () => {
    expect(selectStrongestPing([ping(10, 0)], 60_000)).toBeNull();
    expect(selectStrongestPing([], 0)).toBeNull();
  });
});
