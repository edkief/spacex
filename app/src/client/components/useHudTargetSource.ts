/**
 * World-space source for the combat target box — TASK-50.
 *
 * The `TargetBox` needs four numbers per frame: the camera
 * position + forward (the cockpit pose), the locked target's world
 * position, and whether the target currently has us locked. This
 * hook assembles them from the Drift client's live entity buffers:
 *
 *   - **own ship** — the buffered entity whose callsign matches
 *     `client.currentCallsign`,
 *   - **target** — the buffered entity matching the targeting
 *     store's locked `targetId`,
 *   - **camera** — `cockpitPose(ship)` from `camera/cameraMath`,
 *     the same pose the cockpit camera renders from,
 *   - **lockedByTarget** — the target's `targetedBy` list contains
 *     our own id (TASK-44 lock-on).
 *
 * Every lookup is defensive: a missing ship, a missing target or a
 * re-sampled buffer returns `null`, which hides the box rather
 * than pinning it to a stale position.
 */

import { useMemo } from "react";

import { cockpitPose, FOV_DEG } from "../camera/cameraMath.js";
import { forwardVecFromQuat } from "@shared/targeting.js";
import type { TargetBoxSample, TargetBoxSource } from "./TargetBox.js";
import type { DriftClient } from "../net/wsClient.js";

/** Minimal shape we read off a sampled entity. */
interface SampledEntity {
  pos: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  callsign?: string | null;
  targetedBy?: string[];
}

/** Build the target-box source for a live client. */
export function useHudTargetSource(client: DriftClient): TargetBoxSource {
  return useMemo<TargetBoxSource>(() => {
    return () => {
      const locked = client.getTargeting().getLocked();
      if (locked === null) return null;
      const buffers = client.remoteEntityBuffers;
      const now = Date.now();
      const me = client.currentCallsign;
      let ship: SampledEntity | null = null;
      let target: SampledEntity | null = null;
      for (const [id, buffer] of buffers) {
        const sampled = buffer.sample(now).state as SampledEntity | null | undefined;
        if (!sampled) continue;
        if (id === locked.targetId) target = sampled;
        else if (me !== null && sampled.callsign === me) ship = sampled;
      }
      if (ship === null || target === null) return null;
      const pose = cockpitPose(ship);
      const forward = forwardVecFromQuat(ship.quat);
      const sample: TargetBoxSample = {
        camPos: pose.pos,
        camForward: forward,
        targetPos: target.pos,
        lockedByTarget:
          Array.isArray(target.targetedBy) &&
          (me !== null ? target.targetedBy.includes(me) : false),
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
      };
      return sample;
    };
  }, [client]);
}

/** Vertical FOV the HUD projection uses (matches the camera rig). */
export const HUD_PROJECTION_FOV_DEG = FOV_DEG;
