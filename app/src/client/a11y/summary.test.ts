/**
 * HUD summary + prompt text test — TASK-54.
 */
import { describe, expect, it } from "vitest";

import { formatHudSummary } from "./summary.js";
import { promptAnnouncementText } from "./promptText.js";

describe("formatHudSummary", () => {
  it("formats the spec's example sentence", () => {
    expect(formatHudSummary({ speedMps: 120, hull: 80 })).toBe(
      "Speed 120 meters per second. Hull 80 percent.",
    );
  });

  it("includes exposure and credits when known", () => {
    expect(
      formatHudSummary({ speedMps: 12.4, hull: 50, hullMax: 200, exposure: 25, credits: 500 }),
    ).toBe("Speed 12 meters per second. Hull 25 percent. Exposure 50 percent. Credits 500.");
  });

  it("omits unknown values", () => {
    expect(formatHudSummary({ speedMps: null, hull: null, credits: null })).toBe("");
  });

  it("returns an empty string when nothing is known", () => {
    expect(formatHudSummary({})).toBe("");
  });

  it("guards against a zero maximum", () => {
    expect(formatHudSummary({ hull: 10, hullMax: 0 })).toBe("Hull 0 percent.");
  });
});

describe("promptAnnouncementText", () => {
  it("spells a bracketed key badge as a spoken instruction", () => {
    expect(promptAnnouncementText("[E] Take iron")).toBe("E to take iron");
  });

  it("handles a multi-word prompt", () => {
    expect(promptAnnouncementText("[E] Dock terminal")).toBe("E to dock terminal");
  });

  it("lower-cases an unbadged prompt", () => {
    expect(promptAnnouncementText("Mine (hold)")).toBe("mine (hold)");
  });

  it("returns an empty string for an empty prompt", () => {
    expect(promptAnnouncementText("   ")).toBe("");
  });
});
