/**
 * Remote-entity interpolation tests (TASK-14, steps 3 + 4).
 *
 * Acceptance: 10 Hz snapshot cadence with ±20 ms jitter must produce no
 * visible jumps in a scripted render capture (max per-frame delta below the
 * threshold). Remote entities render 200 ms in the past; underrun renders
 * the newest sample marked stale (no teleporting); > 1 s without samples
 * marks the entity dimmed.
 */

import { describe, expect, it } from 'vitest';

import {
  quatFromAxisAngle,
  quatIdentity,
  vecLength,
  vecSub,
  type Quat,
  type Vec3,
} from '@shared/physics/vec';
import {
  INTERP_DELAY_MS,
  RemoteEntityBuffer,
  RemoteEntityTracker,
  STALE_MS,
} from './interpolation';

const FRAME_MS = 1000 / 60; // 60 fps render capture

/** Constant-velocity remote ship: 10 u/s along +X, yawing at 0.4 rad/s. */
function shipAt(tMs: number): { pos: Vec3; quat: Quat } {
  const t = tMs / 1000;
  return {
    pos: { x: 10 * t, y: 0, z: 0 },
    quat: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4 * t),
  };
}

describe('RemoteEntityBuffer: jitter tolerance (acceptance)', () => {
  it('10 Hz snapshots with ±20 ms jitter: max per-frame delta stays below threshold', () => {
    const buf = new RemoteEntityBuffer();
    // 10 Hz cadence with a deterministic ±20 ms jitter pattern (non-monotonic
    // arrivals — jitter can reorder snapshots by up to the jitter amount).
    const jitterPattern = [0, 20, -20, 10, -10, 20, -20, 5, -5, 15];
    const sampleTimes: number[] = [];
    for (let t = 0, k = 0; t <= 3000; t += 100, k++) {
      sampleTimes.push(t + jitterPattern[k % jitterPattern.length]);
    }

    // Scripted 60 fps render capture: snapshots arrive IN REAL TIME (fed at
    // their receive time) while the renderer captures every frame.
    let maxDelta = 0;
    let maxRotDelta = 0;
    let prevPos: Vec3 | undefined;
    let prevQuat: Quat | undefined;
    let staleFrames = 0;
    let lastStaleNow = -1;
    let frames = 0;
    let nextSample = 0;
    for (let f = 0; f * FRAME_MS <= 3000; f++) {
      const now = Math.round(f * FRAME_MS);
      while (nextSample < sampleTimes.length && sampleTimes[nextSample] <= now) {
        const s = shipAt(sampleTimes[nextSample]);
        buf.add(sampleTimes[nextSample], s.pos, s.quat);
        nextSample++;
      }
      const r = buf.renderAt(now);
      expect(r).not.toBeNull();
      if (!r) continue;
      if (prevPos) {
        const d = vecLength(vecSub(r.pos, prevPos));
        maxDelta = Math.max(maxDelta, d);
      }
      if (prevQuat) {
        // Per-frame rotation change (rad): angle between the ships' forward
        // axes (the quat→+Z mapping for a yaw-about-Y rotation).
        const fwd = (q: { x: number; y: number; z: number; w: number }) => ({
          x: 2 * (q.x * q.w - q.y * q.z),
          y: 2 * (q.y * q.w + q.x * q.z),
          z: 1 - 2 * (q.x * q.x + q.y * q.y),
        });
        const fa = fwd(r.quat);
        const fb = fwd(prevQuat);
        const dot = Math.min(1, Math.max(-1, fa.x * fb.x + fa.y * fb.y + fa.z * fb.z));
        maxRotDelta = Math.max(maxRotDelta, Math.acos(dot));
      }
      if (r.stale) {
        staleFrames++;
        lastStaleNow = now;
      }
      frames++;
      prevPos = r.pos;
      prevQuat = r.quat;
    }

    const nominalPerFrame = 10 * (FRAME_MS / 1000); // 10 u/s at 60 fps ≈ 0.1667 u
    // Jitter must not produce a jump: allow ~3× the nominal per-frame travel.
    expect(maxDelta).toBeLessThan(nominalPerFrame * 3);
    expect(maxDelta).toBeGreaterThan(0); // the ship actually moved
    // 0.4 rad/s at 60 fps ≈ 0.00667 rad/frame; allow 3× nominal.
    expect(maxRotDelta).toBeLessThan(0.4 * (FRAME_MS / 1000) * 3);
    // Stale ONLY while the buffer is younger than the 200 ms render delay
    // (render time before the first sample); mid-stream the jittered buffer
    // always covers the render time — no underrun from jitter alone.
    expect(staleFrames).toBeLessThan(Math.ceil((INTERP_DELAY_MS + 40) / FRAME_MS) + 1);
    expect(lastStaleNow).toBeLessThanOrEqual(INTERP_DELAY_MS + FRAME_MS);
    expect(frames).toBeGreaterThan(100);
  });

  it('constant velocity renders at constant per-frame speed (no jitter pumping)', () => {
    const buf = new RemoteEntityBuffer();
    for (let t = 0; t <= 2000; t += 100) {
      const s = shipAt(t);
      buf.add(t, s.pos, s.quat);
    }
    const deltas: number[] = [];
    let prev: { x: number; y: number; z: number } | undefined;
    for (let now = 300; now <= 2000; now += FRAME_MS) {
      const r = buf.renderAt(now)!;
      if (prev) deltas.push(vecLength(vecSub(r.pos, prev)));
      prev = r.pos;
    }
    // Interpolated motion is nearly perfectly uniform (lerp of linear motion).
    const min = Math.min(...deltas);
    const max = Math.max(...deltas);
    expect(max - min).toBeLessThan(0.02); // well under a perceptible hitch
  });
});

describe('RemoteEntityBuffer: underrun + staleness', () => {
  it('before the buffer covers the render time: newest sample, stale, no teleport', () => {
    const buf = new RemoteEntityBuffer();
    const s0 = shipAt(0);
    buf.add(0, s0.pos, s0.quat);
    // 100 ms in: render time (now-200) is before the only sample.
    const r = buf.renderAt(100);
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(true);
    expect(r!.pos).toEqual(s0.pos); // nearest sample as-is — no extrapolation
  });

  it('buffer starvation (no new samples): renders the newest, stale', () => {
    const buf = new RemoteEntityBuffer();
    for (let t = 0; t <= 500; t += 100) {
      const s = shipAt(t);
      buf.add(t, s.pos, s.quat);
    }
    const r = buf.renderAt(500 + INTERP_DELAY_MS + 100); // render time past newest
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(true);
    expect(r!.pos).toEqual(shipAt(500).pos); // the newest sample, not a guess
  });

  it('no sample for > 1 s → dimmed (freeze, client-side fade)', () => {
    const buf = new RemoteEntityBuffer();
    const s = shipAt(0);
    buf.add(0, s.pos, s.quat);
    expect(buf.renderAt(STALE_MS + 1000)!.dimmed).toBe(true);
    expect(buf.renderAt(STALE_MS - 100)!.dimmed).toBe(false);
  });

  it('empty buffer renders nothing', () => {
    expect(new RemoteEntityBuffer().renderAt(1000)).toBeNull();
  });

  it('missing quat defaults to identity (v1 back-compat samples)', () => {
    const buf = new RemoteEntityBuffer();
    buf.add(0, { x: 1, y: 0, z: 0 });
    buf.add(100, { x: 2, y: 0, z: 0 });
    const r = buf.renderAt(INTERP_DELAY_MS + 50);
    expect(r!.quat).toEqual(quatIdentity());
  });
});

describe('RemoteEntityTracker', () => {
  it('tracks one buffer per remote entity, skips the local ship, drops leavers', () => {
    const tracker = new RemoteEntityTracker();
    tracker.addSnapshot(
      0,
      [
        { id: 'me', pos: { x: 0, y: 0, z: 0 } },
        { id: 'remote-1', pos: { x: 1, y: 0, z: 0 } },
        { id: 'remote-2', pos: { x: 2, y: 0, z: 0 } },
      ],
      'me',
    );
    expect(tracker.getBuffer('me')).toBeUndefined();
    expect(tracker.getBuffer('remote-1')).toBeDefined();
    expect(tracker.getBuffer('remote-2')).toBeDefined();

    // remote-2 leaves: absent from the next snapshot → its buffer is dropped.
    tracker.addSnapshot(
      100,
      [
        { id: 'me', pos: { x: 0, y: 0, z: 0 } },
        { id: 'remote-1', pos: { x: 1.5, y: 0, z: 0 } },
      ],
      'me',
    );
    expect(tracker.getBuffer('remote-2')).toBeUndefined();
    expect(tracker.getBuffer('remote-1')!.size).toBe(2);

    const all = tracker.renderAll(INTERP_DELAY_MS + 50);
    expect([...all.keys()]).toEqual(['remote-1']);
  });
});
