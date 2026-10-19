/**
 * Client kill-feed tests — TASK-47.
 *
 * Verifies the kill-feed store's pure semantics:
 *
 *   - `applyKillEvent` records an entry with the right
 *     attacker / target / weapon / PvP flag.
 *   - Entries are capped at `KILL_FEED_MAX_ENTRIES`.
 *   - Entries expire after `KILL_FEED_TTL_MS` (reaped on read).
 *   - PvP detection uses the caller-supplied `isPlayerId`
 *     predicate; `false` defaults to player-vs-AI (grey).
 *   - `formatKillLine` produces the spec line
 *     `"A ▸ LASER ▸ B"` / `"A ▸ MISSILE ▸ B"`.
 *
 * The wire-level round-trip (a real `combat_event` frame →
 * store → renderer) is covered by the WS round-trip tests in
 * `ws.task47-pvp.test.ts`; the renderer itself is verified
 * via a static-render test against `KillFeed.tsx`.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import {
  KillFeedStore,
  KILL_FEED_MAX_ENTRIES,
  KILL_FEED_TTL_MS,
  formatKillLine,
} from "./killFeed.js";
import { KillFeed } from "../components/KillFeed.js";
import type { PayloadFor } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("formatKillLine", () => {
  it("renders laser kills with the LASER label", () => {
    const line = formatKillLine({
      id: 1,
      attackerName: "ALPHA",
      targetName: "BRAVO",
      weapon: "laser",
      isPvP: true,
      pushedAt: 0,
      expiresAt: KILL_FEED_TTL_MS,
    });
    expect(line).toBe("ALPHA \u25b8 LASER \u25b8 BRAVO");
  });

  it("renders missile kills with the MISSILE label", () => {
    const line = formatKillLine({
      id: 1,
      attackerName: "ALPHA",
      targetName: "BRAVO",
      weapon: "missile",
      isPvP: false,
      pushedAt: 0,
      expiresAt: KILL_FEED_TTL_MS,
    });
    expect(line).toBe("ALPHA \u25b8 MISSILE \u25b8 BRAVO");
  });
});

// ---------------------------------------------------------------------------
// KillFeedStore
// ---------------------------------------------------------------------------

function killEvent(args: { attacker: string; target: string }): PayloadFor<"combat_event"> & {
  kind: "kill";
} {
  return {
    kind: "kill",
    attacker: args.attacker,
    target: args.target,
    tick: 1,
  };
}

describe("KillFeedStore", () => {
  it("records an entry with the right isPvP flag for player-vs-player", () => {
    const store = new KillFeedStore();
    const resolver = (id: string): string | null => {
      if (id === "alpha-id") return "ALPHA";
      if (id === "bravo-id") return "BRAVO";
      return null;
    };
    store.applyKillEvent(killEvent({ attacker: "alpha-id", target: "bravo-id" }), {
      resolver,
      isPlayerId: (id) => id === "alpha-id" || id === "bravo-id",
    });
    const entries = store.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attackerName).toBe("ALPHA");
    expect(entries[0]?.targetName).toBe("BRAVO");
    expect(entries[0]?.isPvP).toBe(true);
  });

  it("flags player-vs-AI kills as non-PvP (grey)", () => {
    const store = new KillFeedStore();
    store.applyKillEvent(killEvent({ attacker: "alpha-id", target: "ai:rogue-1" }), {
      resolver: (id) => (id === "alpha-id" ? "ALPHA" : id === "ai:rogue-1" ? "ROGUE-1" : null),
      isPlayerId: (id) => id === "alpha-id",
    });
    const entries = store.snapshot();
    expect(entries[0]?.isPvP).toBe(false);
    expect(entries[0]?.attackerName).toBe("ALPHA");
    expect(entries[0]?.targetName).toBe("ROGUE-1");
  });

  it("caps the feed at KILL_FEED_MAX_ENTRIES (5 entries)", () => {
    const store = new KillFeedStore();
    const resolver = (id: string): string | null => id.toUpperCase();
    const isPlayerId = (): boolean => true;
    for (let i = 0; i < 8; i++) {
      store.applyKillEvent(killEvent({ attacker: `a${i}`, target: `b${i}` }), {
        resolver,
        isPlayerId,
      });
    }
    const entries = store.snapshot();
    expect(entries).toHaveLength(KILL_FEED_MAX_ENTRIES);
    // The oldest entries have dropped; the last 5 survive.
    expect(entries[entries.length - 1]?.attackerName).toBe("A7");
    expect(entries[0]?.attackerName).toBe("A3");
  });

  it("expires entries past KILL_FEED_TTL_MS on the next snapshot read", () => {
    const store = new KillFeedStore();
    store.applyKillEvent(killEvent({ attacker: "a", target: "b" }), {
      resolver: (id) => id.toUpperCase(),
      isPlayerId: () => true,
      nowMs: 1_000,
    });
    expect(store.snapshot(now(1_000))).toHaveLength(1);
    // Just before expiry → still alive.
    expect(store.snapshot(now(1_000 + KILL_FEED_TTL_MS - 1))).toHaveLength(1);
    // At expiry → dropped (reap happens on snapshot read).
    expect(store.snapshot(now(1_000 + KILL_FEED_TTL_MS + 1))).toHaveLength(0);
  });

  it("resolves unknown ids through the resolver fallback (raw id)", () => {
    const store = new KillFeedStore();
    store.applyKillEvent(killEvent({ attacker: "x", target: "y" }), {
      resolver: () => null, // resolver has no data
      isPlayerId: () => true,
    });
    const entries = store.snapshot();
    expect(entries[0]?.attackerName).toBe("x");
    expect(entries[0]?.targetName).toBe("y");
  });

  it("notify listeners on every event + reap", () => {
    const store = new KillFeedStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.applyKillEvent(killEvent({ attacker: "a", target: "b" }), {
      resolver: (id) => id.toUpperCase(),
      isPlayerId: () => true,
    });
    expect(calls).toBe(1);
    store.snapshot(Date.now() + KILL_FEED_TTL_MS + 1);
    expect(calls).toBe(2);
  });
});

// Helper — `Date.now()` is shimmed by accepting an explicit
// timestamp in the API; this helper makes the call sites read
// like wall-clock math.
function now(ms: number): number {
  return ms;
}

// ---------------------------------------------------------------------------
// React renderer — minimal static snapshot
// ---------------------------------------------------------------------------

describe("KillFeed (React)", () => {
  it("returns null when the store has no entries (no-flicker boot)", () => {
    const store = new KillFeedStore();
    expect(renderToStaticMarkup(React.createElement(KillFeed, { store }))).toBe("");
  });

  it("renders one row per entry with the spec line shape", () => {
    const store = new KillFeedStore();
    store.applyKillEvent(killEvent({ attacker: "alpha-id", target: "bravo-id" }), {
      resolver: (id) => (id === "alpha-id" ? "ALPHA" : "BRAVO"),
      isPlayerId: () => true,
    });
    const markup = renderToStaticMarkup(React.createElement(KillFeed, { store }));
    // The spec line is "ALPHA ▸ LASER ▸ BRAVO".
    expect(markup).toContain("ALPHA");
    expect(markup).toContain("LASER");
    expect(markup).toContain("BRAVO");
    expect(markup).toContain('data-pvp="true"');
  });

  it("uses grey styling (data-pvp=false) for player-vs-AI", () => {
    const store = new KillFeedStore();
    store.applyKillEvent(killEvent({ attacker: "alpha-id", target: "ai:rogue-x" }), {
      resolver: (id) => (id === "alpha-id" ? "ALPHA" : "ROGUE-X"),
      isPlayerId: (id) => id === "alpha-id",
    });
    const markup = renderToStaticMarkup(React.createElement(KillFeed, { store }));
    expect(markup).toContain('data-pvp="false"');
    expect(markup).toContain("ROGUE-X");
  });
});
