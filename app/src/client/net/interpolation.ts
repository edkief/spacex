/**
 * Remote-entity interpolation (TASK-14).
 *
 * Remote ships are rendered 200 ms in the past, linearly interpolated
 * between the two surrounding 10 Hz snapshots (lerp position, slerp
 * rotation). Deliberately NOT predicted — remote motion stays honest; the
 * delay buys smoothness over 10 Hz snapshots + network jitter.
 *
 * Underrun (buffer too young to cover render time, or starved): render the
 * newest sample as-is and mark `stale` — no extrapolation, no teleporting.
 * No sample for > 1 s: `dimmed` is set so the renderer can fade the entity
 * (client-side only, no protocol change).
 */

import { quatIdentity, quatSlerp, vecLerp, type Quat, type Vec3 } from '@shared/physics/vec';

/** How far in the past remote entities are rendered. */
export const INTERP_DELAY_MS = 200;
/** Samples older than this are pruned from the ring. */
export const PRUNE_AGE_MS = 2000;
/** No new sample for this long → stale (render latest, no extrapolation). */
export const STALE_MS = 1000;
/** Ring capacity (200 ms at 10 Hz needs ~3; this holds 1.6 s of samples). */
export const MAX_SAMPLES = 32;

export interface RemoteSample {
  /** Receive clock (ms). */
  t: number;
  pos: Vec3;
  quat: Quat;
}

export interface RemoteRenderState {
  pos: Vec3;
  quat: Quat;
  /** True when the buffer couldn't cover the render time (no extrapolation). */
  stale: boolean;
  /** True when the newest sample is older than STALE_MS (renderer dims). */
  dimmed: boolean;
}

/**
 * Interpolation buffer for ONE remote entity. Feed `add()` on every
 * snapshot arrival with the client's receive clock; ask for the render
 * state each frame with `renderAt(now)`.
 */
export class RemoteEntityBuffer {
  private samples: RemoteSample[] = [];

  /** Number of buffered samples (debug/tests). */
  get size(): number {
    return this.samples.length;
  }

  /**
   * Ingest one snapshot sample. Network jitter can reorder arrivals by a few
   * ms, so the sample is inserted in timestamp order (the ring must stay
   * sorted for the lerp between neighbors).
   */
  add(t: number, pos: Vec3, quat?: Quat): void {
    const sample: RemoteSample = {
      t,
      pos: { ...pos },
      quat: quat ? { ...quat } : quatIdentity(),
    };
    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1].t > t) i--;
    this.samples.splice(i, 0, sample);
    // Prune old samples, then the capacity overflow (keep the newest).
    const floor = t - PRUNE_AGE_MS;
    while (this.samples.length > 1 && this.samples[0].t < floor) this.samples.shift();
    while (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** True once any sample has been ingested. */
  get hasData(): boolean {
    return this.samples.length > 0;
  }

  /**
   * Render state at `now - INTERP_DELAY_MS`, lerped/slerped between the two
   * surrounding samples. Underrun (render time outside the buffered window)
   * returns the nearest sample marked `stale` — never a teleport.
   */
  renderAt(now: number): RemoteRenderState | null {
    const n = this.samples.length;
    if (n === 0) return null;
    const newest = this.samples[n - 1];
    const dimmed = now - newest.t > STALE_MS;
    const target = now - INTERP_DELAY_MS;

    if (n === 1 || target >= newest.t) {
      // Starved or too young: render the newest sample as-is.
      return { pos: { ...newest.pos }, quat: { ...newest.quat }, stale: true, dimmed };
    }
    if (target <= this.samples[0].t) {
      // Render time before the oldest sample: nearest (oldest), no rewind.
      const oldest = this.samples[0];
      return { pos: { ...oldest.pos }, quat: { ...oldest.quat }, stale: true, dimmed };
    }
    // Find the two surrounding samples.
    let i = n - 1;
    while (i > 1 && this.samples[i - 1].t > target) i--;
    const a = this.samples[i - 1];
    const b = this.samples[i];
    const span = b.t - a.t;
    const f = span > 0 ? (target - a.t) / span : 0;
    return {
      pos: vecLerp(a.pos, b.pos, f),
      quat: quatSlerp(a.quat, b.quat, f),
      stale: false,
      dimmed,
    };
  }

  /** Reset (entity left the system / re-joined after a long gap). */
  clear(): void {
    this.samples = [];
  }
}

/**
 * Manages one {@link RemoteEntityBuffer} per remote entity id, fed from
 * 10 Hz `entity_update` snapshots. The local player's entity must not be
 * fed here (the predictor owns it).
 */
export class RemoteEntityTracker {
  private buffers = new Map<string, RemoteEntityBuffer>();

  /** Ingest every entity in a snapshot (receive-ordered clock `now`). */
  addSnapshot(
    now: number,
    entities: Array<{ id: string; pos: Vec3; rot?: Quat }>,
    selfId?: string,
  ): void {
    for (const e of entities) {
      if (e.id === selfId) continue; // local ship belongs to the predictor
      let buf = this.buffers.get(e.id);
      if (!buf) {
        buf = new RemoteEntityBuffer();
        this.buffers.set(e.id, buf);
      }
      buf.add(now, e.pos, e.rot);
    }
    // Drop entities absent from the snapshot (left the system).
    const seen = new Set(entities.map((e) => e.id));
    for (const id of this.buffers.keys()) {
      if (!seen.has(id)) this.buffers.delete(id);
    }
  }

  getBuffer(id: string): RemoteEntityBuffer | undefined {
    return this.buffers.get(id);
  }

  /** Drop every buffer (system swap / resync boundary — TASK-36). */
  reset(): void {
    this.buffers.clear();
  }

  renderAll(now: number): Map<string, RemoteRenderState> {
    const out = new Map<string, RemoteRenderState>();
    for (const [id, buf] of this.buffers) {
      const s = buf.renderAt(now);
      if (s) out.set(id, s);
    }
    return out;
  }
}
