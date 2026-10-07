// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindSelfShipDebug,
  installSelfShipDebug,
  type SelfShipDebug,
  type SelfShipFrameSample,
} from './self-ship-debug';

/**
 * TASK-77 (unit): the __SELF_SHIP__ frame recorder + reconcile bookkeeping —
 * one sample per rendered frame ONLY while recording (zero cost otherwise),
 * stop returns + clears the buffer, re-start collects a fresh one.
 */

const SHIP = { x: 1, y: 2, z: 3 };
const CAM = { x: 4, y: 5, z: 6 };
const ROT = { x: 0, y: 0, z: 0, w: 1 };

function sample(i: number): SelfShipFrameSample {
  return {
    t: 1000 + i,
    shipPos: { ...SHIP },
    camPos: { ...CAM },
    screen: i % 2 === 0 ? { x: 10, y: 20 } : null,
  };
}

describe('self-ship debug probe + frame recorder (TASK-77)', () => {
  let debug: SelfShipDebug | null;

  beforeEach(() => {
    delete window.__SELF_SHIP__;
    debug = installSelfShipDebug();
  });
  afterEach(() => {
    delete window.__SELF_SHIP__;
  });

  it('installs on window in dev and reports the empty probe (incl. camera) until bound', () => {
    expect(debug).not.toBeNull();
    expect(window.__SELF_SHIP__).toBe(debug);
    expect(debug!.probe()).toEqual({
      classId: null,
      pos: null,
      rot: null,
      camera: null,
      screen: null,
      sunScreen: null,
    });
  });

  it('bindSelfShipDebug points the probe at the source; a null source reads empty', () => {
    bindSelfShipDebug(debug, () => ({
      classId: 'scout',
      pos: SHIP,
      rot: ROT,
      camera: { pos: CAM },
      screen: null,
      sunScreen: { x: 100, y: 120, dist: 380 },
    }));
    expect(debug!.probe().classId).toBe('scout');
    expect(debug!.probe().camera).toEqual({ pos: CAM });
    expect(debug!.probe().sunScreen).toEqual({ x: 100, y: 120, dist: 380 }); // TASK-82
    bindSelfShipDebug(debug, () => null);
    expect(debug!.probe().pos).toBeNull();
    // A null state is a no-op (production builds never install the hook).
    expect(() => bindSelfShipDebug(null, () => null)).not.toThrow();
  });

  it('records one sample per frame ONLY while recording; stop returns + clears', () => {
    expect(debug!.stopRecording()).toEqual([]); // nothing recorded yet
    debug!.sampleFrame(sample(0)); // before start: dropped (zero cost)
    debug!.startRecording();
    debug!.startRecording(); // idempotent — no buffer duplication
    debug!.sampleFrame(sample(0));
    debug!.sampleFrame(sample(1));
    const out = debug!.stopRecording();
    expect(out).toEqual([sample(0), sample(1)]);
    debug!.sampleFrame(sample(2)); // after stop: dropped
    expect(debug!.stopRecording()).toEqual([]);
  });

  it('a re-start after stop collects a fresh buffer', () => {
    debug!.startRecording();
    debug!.sampleFrame(sample(0));
    debug!.stopRecording();
    debug!.startRecording();
    debug!.sampleFrame(sample(1));
    expect(debug!.stopRecording()).toEqual([sample(1)]);
  });

  it('records reconcile blend/rewind/snap counts + the last correction distance', () => {
    expect(debug!.reconcile).toEqual({
      blend: 0,
      rewind: 0,
      snap: 0,
      lastCorrectionDistance: null,
    });
    debug!.recordReconcile('blend', 0.4);
    debug!.recordReconcile('rewind', 12.5);
    debug!.recordReconcile('snap', 0);
    expect(debug!.reconcile).toEqual({ blend: 1, rewind: 1, snap: 1, lastCorrectionDistance: 0 });
    debug!.recordReconcile('blend', 0.2);
    expect(debug!.reconcile).toEqual({ blend: 2, rewind: 1, snap: 1, lastCorrectionDistance: 0.2 });
  });
});
