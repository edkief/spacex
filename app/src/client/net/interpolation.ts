import { EntityState } from '../../shared/protocol/schemas';
import { Vec3, Quat } from '../../shared/physics/types';

interface Snapshot {
  t: number;
  state: EntityState;
}

export class RemoteEntityBuffer {
  private buffer: Snapshot[] = [];
  private readonly INTERPOLATION_DELAY = 0.2; // 200ms

  addSnapshot(state: EntityState) {
    this.buffer.push({ t: Date.now(), state });
    // Keep buffer size manageable (last 2 seconds)
    if (this.buffer.length > 100) {
      this.buffer.shift();
    }
    this.buffer.sort((a, b) => a.t - b.t);
  }

  getState(now: number) {
    const renderTime = now - this.INTERPOLATION_DELAY * 1000;

    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) return this.buffer[0].state;

    // Find the two snapshots surrounding the renderTime
    let i = 0;
    while (i < this.buffer.length - 1 && this.buffer[i + 1].t < renderTime) {
      i++;
    }

    const s0 = this.buffer[i];
    const s1 = this.buffer[i + 1];

    if (!s1 || renderTime < s0.t) {
      return s0.state;
    }

    // Interpolate
    const alpha = (renderTime - s0.t) / (s1.t - s0.t);
    return this.interpolate(s0.state, s1.state, alpha);
  }

  private interpolate(s0: EntityState, s1: EntityState, alpha: number): EntityState {
    return {
      ...s1,
      pos: {
        x: s0.pos.x + (s1.pos.x - s0.pos.x) * alpha,
        y: s0.pos.y + (s1.pos.y - s0.pos.y) * alpha,
        z: s0.pos.z + (s1.pos.z - s0.pos.z) * alpha,
      },
      vel: {
        x: s0.vel.x + (s1.vel.x - s0.vel.x) * alpha,
        y: s0.vel.y + (s1.vel.y - s0.vel.y) * alpha,
        z: s0.vel.z + (s1.vel.z - s0.vel.z) * alpha,
      },
      // Rotation interpolation would use slerp, but for now we just use s1
    };
  }
}
