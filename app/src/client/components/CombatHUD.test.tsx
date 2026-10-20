/**
 * CombatHUD component test — TASK-50 acceptance.
 *
 * Renders the assembled HUD (renderToStaticMarkup, the project
 * convention — no testing-library in the tree) and asserts:
 *
 *   - every combat region renders in its layout slot, and those
 *     slots are disjoint from the prompt line / player list / chat
 *     / debug overlay (the spec's "layout test"),
 *   - the target box shows callsign, distance, hull + shield bars,
 *     the `AI` tag for AI contacts and the weapon-locked badge,
 *   - the weapon readout renders the selector, the energy band and
 *     the missile count,
 *   - the kill feed honours its 5-entry / 10 s TTL contract.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { KillFeedStore, KILL_FEED_MAX_ENTRIES, KILL_FEED_TTL_MS } from "../combat/killFeed.js";
import { TargetingStore } from "../combat/targeting.js";
import { HUD_DISJOINT_SLOTS, hudSlots, rectsOverlap } from "../combat/hud/layout.js";
import { CombatHUD, type CombatHUDProps } from "./CombatHUD.js";
import type { WeaponStateSnapshot } from "./WeaponHud.js";

const WEAPON: WeaponStateSnapshot = {
  activeWeapon: "laser",
  energy: 100,
  locked: false,
  lockedUntilMs: 0,
};

const SAMPLE = {
  camPos: { x: 0, y: 0, z: 0 },
  camForward: { x: 0, y: 0, z: 1 },
  targetPos: { x: 0, y: 0, z: 120 },
  viewportW: 1280,
  viewportH: 720,
  lockedByTarget: false,
};

/** Build props with a locked target + a seeded kill feed. */
function makeProps(over: Partial<CombatHUDProps> = {}): CombatHUDProps {
  const targeting = over.targeting ?? new TargetingStore();
  if (over.targeting === undefined) {
    targeting.applyLocked({
      targetId: "AI-1",
      callsign: null,
      range: 120,
      bearing: 4,
      lockedAt: 1_000,
    });
    targeting.applyTargetUpdate({
      targetId: "AI-1",
      callsign: null,
      classId: "interceptor",
      hull: 80,
      shields: 25,
      range: 120,
      bearing: 4,
    } as never);
  }
  const killFeed = over.killFeed ?? new KillFeedStore();
  if (over.killFeed === undefined) {
    killFeed.applyKillEvent({ kind: "kill", attacker: "a", target: "b" } as never, {
      resolver: (id) => id.toUpperCase(),
      isPlayerId: () => true,
      nowMs: 1_000,
    });
  }
  return {
    targeting,
    killFeed,
    weaponState: WEAPON,
    targetSource: () => SAMPLE,
    ...over,
  };
}

describe("CombatHUD assembly (TASK-50)", () => {
  it("renders the four combat regions", () => {
    const html = renderToStaticMarkup(<CombatHUD {...makeProps()} />);
    expect(html).toContain('data-testid="drift-combat-hud"');
    expect(html).toContain('data-testid="drift-target-box"');
    expect(html).toContain('data-testid="drift-weapon-readout"');
    expect(html).toContain('data-testid="drift-kill-feed"');
  });

  it("renders only the three regions when nothing is locked or pinged", () => {
    const html = renderToStaticMarkup(
      <CombatHUD
        {...makeProps({ targeting: new TargetingStore(), killFeed: new KillFeedStore() })}
      />,
    );
    expect(html).not.toContain('data-testid="drift-target-box"');
    expect(html).not.toContain('data-testid="drift-kill-feed"');
    expect(html).toContain('data-testid="drift-weapon-readout"');
  });

  it("places the kill feed + weapon readout on their layout slots", () => {
    const html = renderToStaticMarkup(<CombatHUD {...makeProps()} />);
    const slots = hudSlots();
    expect(html).toContain(`left:${slots.killFeed.left}px`);
    expect(html).toContain(`top:${slots.weaponReadout.top}px`);
    expect(html).toContain(`data-slot="weaponReadout"`);
  });

  it("keeps every combat region disjoint from the reserved regions", () => {
    const layout = hudSlots();
    for (let i = 0; i < HUD_DISJOINT_SLOTS.length; i++) {
      for (let j = i + 1; j < HUD_DISJOINT_SLOTS.length; j++) {
        expect(rectsOverlap(layout[HUD_DISJOINT_SLOTS[i]!], layout[HUD_DISJOINT_SLOTS[j]!])).toBe(
          false,
        );
      }
    }
  });
});

describe("TargetBox readout (TASK-50)", () => {
  it("shows the AI tag, distance and hull / shield bars", () => {
    const html = renderToStaticMarkup(<CombatHUD {...makeProps()} />);
    expect(html).toContain('data-testid="drift-target-box-ai-tag"');
    expect(html).toContain('data-testid="drift-target-box-distance"');
    expect(html).toContain("120 m");
    expect(html).toContain('data-testid="drift-target-box-hull"');
    expect(html).toContain('data-testid="drift-target-box-shield"');
    // interceptor hull 80 → 80 hull reads 100 %; shield 40 → 25 reads 62.5 %.
    expect(html).toContain("width:100.0%");
    expect(html).toContain("width:62.5%");
  });

  it("shows the weapon-locked badge when the target has locked us", () => {
    const html = renderToStaticMarkup(
      <CombatHUD {...makeProps({ targetSource: () => ({ ...SAMPLE, lockedByTarget: true }) })} />,
    );
    expect(html).toContain('data-testid="drift-target-box-locked"');
    expect(html).toContain("WEAPON LOCKED");
  });

  it("omits the weapon-locked badge otherwise", () => {
    const html = renderToStaticMarkup(<CombatHUD {...makeProps()} />);
    expect(html).not.toContain('data-testid="drift-target-box-locked"');
  });
});

describe("WeaponReadout readout (TASK-50)", () => {
  it("renders the 1/2 selector with loadout counts", () => {
    const html = renderToStaticMarkup(<CombatHUD {...makeProps({ classId: "interceptor" })} />);
    expect(html).toContain("LASER");
    expect(html).toContain("MISSILE");
    expect(html).toContain("2x");
    expect(html).toContain(">4<");
  });

  it("shows the missile count only for the missile weapon", () => {
    const laser = renderToStaticMarkup(<CombatHUD {...makeProps({ missilesLeft: 3 })} />);
    expect(laser).not.toContain('data-testid="drift-missile-count"');
    const missile = renderToStaticMarkup(
      <CombatHUD
        {...makeProps({ missilesLeft: 3, weaponState: { ...WEAPON, activeWeapon: "missile" } })}
      />,
    );
    expect(missile).toContain('data-testid="drift-missile-count"');
    expect(missile).toContain("MISSILES 3");
  });

  it("renders the LOW ENERGY badge below 10 %", () => {
    const html = renderToStaticMarkup(
      <CombatHUD {...makeProps({ weaponState: { ...WEAPON, energy: 8 } })} />,
    );
    expect(html).toContain('data-testid="drift-low-energy"');
    expect(html).toContain("LOW ENERGY");
    expect(html).toContain('data-level="red"');
    const ok = renderToStaticMarkup(<CombatHUD {...makeProps()} />);
    expect(ok).not.toContain('data-testid="drift-low-energy"');
  });
});

describe("Kill feed TTL (TASK-50)", () => {
  it("caps the feed at 5 entries and expires them after 10 s", () => {
    const store = new KillFeedStore();
    for (let i = 0; i < 7; i++) {
      store.applyKillEvent({ kind: "kill", attacker: `a${i}`, target: `b${i}` } as never, {
        resolver: (id) => id,
        isPlayerId: () => true,
        nowMs: 1_000 + i * 100,
      });
    }
    expect(store.getEntries().length).toBe(KILL_FEED_MAX_ENTRIES);
    const html = renderToStaticMarkup(<CombatHUD {...makeProps({ killFeed: store })} />);
    expect(html.match(/drift-kill-feed-row/g)?.length).toBe(KILL_FEED_MAX_ENTRIES);
    // Everything pushed more than the TTL ago is gone.
    store.reapExpired(1_000 + 7 * 100 + KILL_FEED_TTL_MS + 1);
    const reaped = renderToStaticMarkup(<CombatHUD {...makeProps({ killFeed: store })} />);
    expect(reaped).not.toContain("drift-kill-feed-row");
  });
});
