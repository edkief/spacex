import type { Body } from '@shared/physics/bodies.ts';
import { SYSTEM_FRAME, convertKinematics } from '@shared/physics/frames.ts';
import { lerp, normalizeQuat, type Quat, type Vec3 } from '@shared/physics/vec.ts';
import type { ServerPayload } from '@shared/protocol/registry.ts';

export type EntityState = ServerPayload<'entity_update'>['entities'][number];

/** An entity's pose in the system frame at one instant (float64 metres). */
export interface Pose {
  pos: Vec3;
  quat: Quat;
}

interface Sample extends Pose {
  at: number;
}

interface Tracked {
  state: EntityState;
  previous: Sample;
  latest: Sample;
}

/** Remote state is rendered this far in the past so there are two samples to blend between. */
export const INTERPOLATION_DELAY_MS = 100;

/** Normalised linear blend of two quaternions along the shorter arc (ample for 100 ms gaps). */
export function nlerp(a: Quat, b: Quat, t: number): Quat {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return normalizeQuat({
    x: a.x + (sign * b.x - a.x) * t,
    y: a.y + (sign * b.y - a.y) * t,
    z: a.z + (sign * b.z - a.z) * t,
    w: a.w + (sign * b.w - a.w) * t,
  });
}

/** An entity's wire state expressed in the system frame. */
export function systemPose(state: EntityState, bodies: readonly Body[]): Pose {
  const { frame, x, y, z } = state.pos;
  if (frame === SYSTEM_FRAME) return { pos: { x, y, z }, quat: state.quat };
  const k = convertKinematics(
    { pos: { x, y, z }, vel: state.vel, quat: state.quat },
    frame,
    SYSTEM_FRAME,
    bodies,
  );
  return { pos: k.pos, quat: k.quat };
}

/**
 * The client's view of the entities in the current system. Server updates arrive at 10 Hz; each
 * entity keeps its two latest samples and is rendered slightly in the past, blended between
 * them, so motion is smooth at any frame rate and never extrapolated.
 */
export class EntityStore {
  private readonly tracked = new Map<string, Tracked>();
  private readonly bodies: readonly Body[];

  constructor(bodies: readonly Body[]) {
    this.bodies = bodies;
  }

  /** Replaces the entity set with a server update received at `now` (ms). */
  apply(entities: readonly EntityState[], now: number): void {
    const seen = new Set<string>();
    for (const state of entities) {
      seen.add(state.id);
      const sample: Sample = { ...systemPose(state, this.bodies), at: now };
      const existing = this.tracked.get(state.id);
      if (existing) {
        existing.previous = existing.latest;
        existing.latest = sample;
        existing.state = state;
      } else {
        this.tracked.set(state.id, { state, previous: sample, latest: sample });
      }
    }
    for (const id of [...this.tracked.keys()]) if (!seen.has(id)) this.tracked.delete(id);
  }

  get size(): number {
    return this.tracked.size;
  }

  ids(): string[] {
    return [...this.tracked.keys()];
  }

  /** The latest authoritative state of an entity. */
  state(id: string): EntityState | undefined {
    return this.tracked.get(id)?.state;
  }

  /** The entity's blended pose at render time `now` (ms), or undefined if unknown. */
  poseAt(id: string, now: number): Pose | undefined {
    const entry = this.tracked.get(id);
    if (!entry) return undefined;
    const { previous, latest } = entry;
    const span = latest.at - previous.at;
    if (span <= 0) return latest;
    const t = Math.max(0, Math.min(1, (now - INTERPOLATION_DELAY_MS - previous.at) / span));
    return { pos: lerp(previous.pos, latest.pos, t), quat: nlerp(previous.quat, latest.quat, t) };
  }
}
