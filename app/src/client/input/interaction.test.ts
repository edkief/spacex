/**
 * Interaction system tests — TASK-33.
 *
 * Covers the spec acceptance criteria for the prompt / cone math
 * and the dispatch-site lint. The actual WS round-trip coverage
 * lives in `server/shard/interact.test.ts` + `server/ws.interact.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  INTERACT_RANGE_M,
  INTERACT_CONE_HALF_ANGLE_DEG,
  INTERACT_CONE_COS,
  pickInteractable,
  promptForTarget,
  createInteractableRegistry,
  type Interactable,
  type Interactor,
} from "./interaction.js";

const FORWARD_X: Interactor = {
  pos: { x: 0, y: 0, z: 0 },
  forward: { x: 1, y: 0, z: 0 },
};

const FORWARD_Z: Interactor = {
  pos: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: 1 },
};

function t(kind: Interactable["kind"], id: string, x: number, y: number, z: number): Interactable {
  return { id, kind, pos: { x, y, z } };
}

describe("interaction: cone math (TASK-33)", () => {
  it("exposes the spec range + cone angle", () => {
    expect(INTERACT_RANGE_M).toBe(3);
    expect(INTERACT_CONE_HALF_ANGLE_DEG).toBe(30);
    expect(INTERACT_CONE_COS).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 10);
  });

  it("selects the in-cone target inside range", () => {
    const deposits = [t("deposit", "d-far", 2.9, 0, 0), t("deposit", "d-near", 1, 0, 0)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked?.id).toBe("d-near");
  });

  it("returns null when nothing is in range", () => {
    const deposits = [t("deposit", "d-out", 10, 0, 0)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked).toBeNull();
  });

  it("returns null when target is in range but behind the character", () => {
    const deposits = [t("deposit", "d-back", -1, 0, 0)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked).toBeNull();
  });

  it("includes target at exactly 3 m (boundary)", () => {
    // Spec range is "max 3 m" — inclusive. A target at exactly
    // 3 m from the character is in range.
    const deposits = [t("deposit", "d-edge", INTERACT_RANGE_M, 0, 0)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked?.id).toBe("d-edge");
  });

  it("accepts target just inside the range boundary", () => {
    const deposits = [t("deposit", "d-near-edge", INTERACT_RANGE_M - 0.01, 0, 0)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked?.id).toBe("d-near-edge");
  });

  it("returns null when target is at the cone edge (just outside 30°)", () => {
    // angle = 35° → dot = cos(35°) ≈ 0.819 < cos(30°) ≈ 0.866
    const a = (35 * Math.PI) / 180;
    const x = Math.cos(a) * 2;
    const y = 0;
    const z = Math.sin(a) * 2;
    const deposits = [t("deposit", "d-edge-cone", x, y, z)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked).toBeNull();
  });

  it("accepts target just inside the cone (just under 30°)", () => {
    const a = (29 * Math.PI) / 180;
    const x = Math.cos(a) * 2;
    const y = 0;
    const z = Math.sin(a) * 2;
    const deposits = [t("deposit", "d-in-cone", x, y, z)];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked?.id).toBe("d-in-cone");
  });

  it("selects nearest among several in-cone targets (nearest wins)", () => {
    const deposits = [
      t("deposit", "a", 2.5, 0, 0),
      t("deposit", "b", 0.5, 0, 0),
      t("deposit", "c", 1.5, 0, 0),
    ];
    const picked = pickInteractable(FORWARD_X, deposits);
    expect(picked?.id).toBe("b");
  });

  it("switches target atomically when a closer one enters the cone", () => {
    // Initially only d-far is in range.
    const before = pickInteractable(FORWARD_X, [t("deposit", "d-far", 2.5, 0, 0)]);
    expect(before?.id).toBe("d-far");
    // A nearer deposit appears between renders.
    const after = pickInteractable(FORWARD_X, [
      t("deposit", "d-far", 2.5, 0, 0),
      t("deposit", "d-near", 1.0, 0, 0),
    ]);
    expect(after?.id).toBe("d-near");
  });

  it("selects the nearest of any kind regardless of kind", () => {
    // The cone math is kind-agnostic — the registry then takes the
    // target's `kind` and dispatches. Two candidates at the same
    // position; whichever lands first in iteration is the pick
    // (deterministic by O(n) walk). For test determinism we
    // separate them: deposit at 0.5, ship at 0.1.
    const mixed: Interactable[] = [t("deposit", "d", 0.5, 0, 0), t("ship", "s", 0.1, 0, 0)];
    const picked = pickInteractable(FORWARD_X, mixed);
    expect(picked?.id).toBe("s"); // 0.1 m beats 0.5 m
  });

  it("respects the forward direction (Z forward ≠ X forward)", () => {
    // Target at (2, 0, 0) — in front of X-forward, behind Z-forward.
    const deposits = [t("deposit", "only-z", 2, 0, 0)];
    expect(pickInteractable(FORWARD_X, deposits)?.id).toBe("only-z");
    expect(pickInteractable(FORWARD_Z, deposits)).toBeNull();
  });
});

describe("interaction: registry (TASK-33)", () => {
  it("registers kinds and looks them up", () => {
    const r = createInteractableRegistry();
    r.register("deposit", { prompt: (tgt) => ({ targetId: tgt.id, prompt: "D", action: "use" }) });
    r.register("ship", { prompt: (tgt) => ({ targetId: tgt.id, prompt: "S", action: "enter" }) });
    expect(r.has("deposit")).toBe(true);
    expect(r.has("ship")).toBe(true);
    expect(r.has("dock-terminal")).toBe(false);
    expect(r.kinds.length).toBe(2);
  });

  it("returns null for unknown kinds", () => {
    const r = createInteractableRegistry();
    const out = r.promptFor(t("dock-terminal", "x", 0, 0, 0));
    expect(out).toBeNull();
  });

  it("lets a registered entry return null (inert interactable)", () => {
    const r = createInteractableRegistry();
    r.register("ship", { prompt: () => null });
    expect(r.promptFor(t("ship", "s", 0, 0, 0))).toBeNull();
  });

  it("default registry ships the three v1 entries", async () => {
    // Import lazily so the registry populate side-effects happen
    // after the test harness is wired up.
    const { defaultInteractableRegistry } = await import("./interaction.js");
    expect(defaultInteractableRegistry.has("deposit")).toBe(true);
    expect(defaultInteractableRegistry.has("dock-terminal")).toBe(true);
    expect(defaultInteractableRegistry.has("ship")).toBe(true);

    const depositPrompt = defaultInteractableRegistry.promptFor(t("deposit", "d", 0, 0, 0));
    expect(depositPrompt?.prompt).toBe("[E] Take ore");

    const labelPrompt = defaultInteractableRegistry.promptFor({
      id: "d2",
      kind: "deposit",
      pos: { x: 0, y: 0, z: 0 },
      label: "iron",
    });
    expect(labelPrompt?.prompt).toBe("[E] Take iron");

    const terminalPrompt = defaultInteractableRegistry.promptFor(t("dock-terminal", "t", 0, 0, 0));
    expect(terminalPrompt?.prompt).toBe("[E] Dock terminal");
    expect(terminalPrompt?.action).toBe("use");

    const shipPrompt = defaultInteractableRegistry.promptFor(t("ship", "s", 0, 0, 0));
    expect(shipPrompt?.prompt).toBe("[E] Enter ship");
    expect(shipPrompt?.action).toBe("enter");
  });
});

describe("interaction: prompt state machine (TASK-33)", () => {
  it("returns null when no candidate is in range", () => {
    const items = [t("deposit", "d", 10, 0, 0)];
    expect(promptForTarget(FORWARD_X, items)).toBeNull();
  });

  it("returns the prompt for the nearest candidate", () => {
    const items = [t("deposit", "d-far", 2.5, 0, 0), t("deposit", "d-near", 1, 0, 0)];
    const prompt = promptForTarget(FORWARD_X, items);
    expect(prompt).not.toBeNull();
    expect(prompt?.targetId).toBe("d-near");
    expect(prompt?.prompt).toBe("[E] Take ore");
    expect(prompt?.action).toBe("use");
  });

  it("switches targets atomically", () => {
    const before = promptForTarget(FORWARD_X, [t("deposit", "d-far", 2.5, 0, 0)]);
    expect(before?.targetId).toBe("d-far");

    const after = promptForTarget(FORWARD_X, [
      t("deposit", "d-far", 2.5, 0, 0),
      t("ship", "s", 0.5, 0, 0),
    ]);
    expect(after?.targetId).toBe("s");
    expect(after?.prompt).toBe("[E] Enter ship");
  });

  it("hides when the only target leaves the cone", () => {
    const before = promptForTarget(FORWARD_X, [t("deposit", "d", 1, 0, 0)]);
    expect(before).not.toBeNull();
    // The target walks off — distance > 3 m.
    const after = promptForTarget(FORWARD_X, [t("deposit", "d", 4, 0, 0)]);
    expect(after).toBeNull();
  });
});

describe("interaction: dispatch-site lint (TASK-33)", () => {
  it("only reads from the registry (no scattered if-chains)", async () => {
    // Read the source module and assert that the only dispatch
    // site that turns a target into a prompt + action is the
    // registry's `promptFor`. We allow any references in the
    // test file itself (the test imports the registry by name),
    // but the production module must use the registry exclusively.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const modulePath = url.fileURLToPath(import.meta.url);
    const clientRoot = path.resolve(path.dirname(modulePath), "..", "..", "..");
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          out.push(...walk(full));
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          out.push(full);
        }
      }
      return out;
    }
    const sources = walk(path.join(clientRoot, "src"));
    // Each file's content must either:
    //   - reference `InteractableRegistry` only for type-typing /
    //     construction in this module, OR
    //   - dispatch via `registry.promptFor(...)` / `promptForTarget`,
    //     never via a kind-local `if (kind === "deposit") …` chain.
    const violations: string[] = [];
    // Server-side entity.ts wires the `kind` discriminator into the
    // EntityStateSchema enum (legitimate mapping), and prediction.ts
    // projects wire entities into client-side interactables (mapping,
    // not dispatch). We allow inline `kind === "..."` checks in those
    // two modules only; everywhere else, dispatch must go through the
    // registry.
    const allowedKindRefs = new Set([
      "src/server/shard/entity.ts",
      "src/server/shard/deposit-pickup.ts",
      "src/server/galaxy/deposit-hydrate.ts",
      "src/server/shard/combat.resolve.ts",
      "src/server/shard/weapons.ts",
      "src/client/net/prediction.ts",
      // TASK-74: the WS layer's own-ship detector reads
      // `kind === "ship"` to pick the player's entity; the
      // interactive dispatch is the deposit / terminal /
      // ship registry (this file's reason for existing). The
      // detector runs once per inbound entity frame on the
      // local player's row only — it is not the same shape as
      // an interactive dispatch and is safe inline.
      "src/client/net/wsClient.ts",
    ]);
    for (const file of sources) {
      const rel = path.relative(clientRoot, file);
      const posixRel = rel.split(path.sep).join("/");
      if (posixRel.endsWith(".test.ts") || posixRel.endsWith(".test.tsx")) continue;
      if (allowedKindRefs.has(posixRel)) continue;
      const content = fs.readFileSync(file, "utf8");
      // Scan for kind-string literals that suggest inline dispatch.
      // The string pattern is `kind === "deposit"` / `kind === "ship"` /
      // `kind === "dock-terminal"` / `kind === "terminal"`. None of
      // these should appear outside the whitelisted modules.
      const suspect = /kind\s*===?\s*"(deposit|ship|dock-terminal|terminal)"/;
      if (suspect.test(content)) {
        violations.push(`${posixRel}: inline dispatch on kind — move to the registry.`);
      }
    }
    expect(violations).toEqual([]);
  });
});
