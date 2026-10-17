import { describe, it, expect } from "vitest";
import { makeHealth, FALLBACK_HEALTH, type HealthPayload } from "./health.js";

describe("shared/health", () => {
  it("builds a payload with ok=true and the supplied seed", () => {
    const payload: HealthPayload = makeHealth("TEST-SEED");
    expect(payload.ok).toBe(true);
    expect(payload.galaxySeed).toBe("TEST-SEED");
  });

  it("exposes a fallback with the default seed", () => {
    expect(FALLBACK_HEALTH.ok).toBe(true);
    expect(FALLBACK_HEALTH.galaxySeed).toMatch(/^DRIFT-SEED-/);
  });
});
