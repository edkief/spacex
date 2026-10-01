/**
 * TASK-27: dev-only camera handoff probe (the __CAMERA__ hook).
 *
 * The disembark/re-enter flows land in TASK-31/35, so this task's e2e
 * exercises the rig STANDALONE: a scripted fake ship + fake character,
 * an analytic mesa terrain, and a fixed 10 ms clock drive a real
 * CameraRig through a full cockpit → on-foot handoff. The probe reports
 * the whole story (start/end counts, input-lock window, the 5-sample
 * nudged path, pitch clamp, FOV) and renders the final on-foot view into
 * a small canvas in the DOM (preserved buffer) so the e2e screenshot
 * shows what the handoff actually looks like.
 *
 * Like __DRIFT__ / __STREAM__, installed only when import.meta.env.DEV —
 * production builds never ship it.
 */

import * as THREE from 'three';

import { CameraRig } from '@client/camera/CameraRig';
import {
  cockpitPose,
  HANDOFF_CLEARANCE_M,
  onFootPose,
  type CameraMode,
  type Vec3,
} from '@client/camera/pose-math';

/** Scripted scene: ship hovering 10 u up, character 20 u ahead on the ground. */
const SHIP_POS: Vec3 = { x: 0, y: 10, z: 0 };
const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };
const CHAR_POS: Vec3 = { x: 0, y: 0, z: 20 };
/** The straight cockpit→on-foot path crosses this mesa (center z = 8). */
const MESA_CENTER_Z = 8;
const MESA_RADIUS = 5;
const MESA_HEIGHT = 6;

const mesa = (x: number, z: number): number => {
  const d = Math.sqrt(x * x + (z - MESA_CENTER_Z) * (z - MESA_CENTER_Z));
  return d <= MESA_RADIUS ? MESA_HEIGHT : 0;
};

const STEP_MS = 10;

export interface CameraProbeResult {
  /** onHandoffStart callbacks — must be exactly 1. */
  starts: number;
  /** onHandoffEnd callbacks — must be exactly 1. */
  ends: number;
  /** Measured input-lock window in probe-clock ms (≈ 600). */
  lockWindowMs: { from: number; to: number };
  /** The 5 precomputed (nudged) path samples. */
  path: Vec3[];
  /** Every path sample sits above terrain + clearance. */
  terrainClear: boolean;
  /** How many samples the terrain nudge actually lifted. */
  nudges: number;
  /** applyLookDelta was rejected while in cockpit mode. */
  cockpitLookRejected: boolean;
  /** applyLookDelta was rejected mid-animation (~300 ms in). */
  midLookRejected: boolean;
  /** lookYaw drift during the lock (must stay 0). */
  midLookYawDrift: number;
  /** applyLookDelta was accepted after the animation finished. */
  unlockedAfter: boolean;
  /** Rig pitch in degrees after a +172° demand (clamped to +80). */
  pitchClampedDeg: number;
  /** The single camera kept its FOV 75 through everything. */
  fov: number;
  /** Cockpit pose after settling (where the handoff starts). */
  startPose: { position: Vec3; look: Vec3 };
  /** Pose after the handoff completes (on-foot). */
  endPose: { position: Vec3; look: Vec3 };
  /** True when the final on-foot view was rendered into #__camera-probe-canvas. */
  rendered: boolean;
}

/** Shape of the debug surface the e2e tests read. */
export interface CameraDebug {
  /** Run the scripted standalone handoff; report; render the final view. */
  handoffProbe(): CameraProbeResult;
}

declare global {
  interface Window {
    /** Dev-only (never present in production builds). */
    __CAMERA__?: CameraDebug;
  }
}

/** Install the hook on window. No-op in production builds. */
export function installCameraDebug(): void {
  if (!import.meta.env.DEV) return;
  window.__CAMERA__ = { handoffProbe: () => handoffProbe() };
}

function handoffProbe(): CameraProbeResult {
  let nowMs = 0;
  let starts = 0;
  let ends = 0;

  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 20_000);
  const rig = new CameraRig({
    camera,
    heightAt: mesa,
    now: () => nowMs,
    onHandoffStart: (to: CameraMode) => {
      if (to === 'onfoot') starts += 1;
    },
    onHandoffEnd: (to: CameraMode) => {
      if (to === 'onfoot') ends += 1;
    },
  });
  rig.setShip(SHIP_POS, IDENTITY_QUAT);
  rig.setCharacterPosition(CHAR_POS);

  // 1.2 s of cockpit frames: the k = 8/s chase has fully settled.
  // (Clock advances before the update, like a real rAF timestamp.)
  for (let i = 0; i < 120; i++) {
    nowMs += STEP_MS;
    rig.update(STEP_MS / 1000);
  }
  const startPose = rig.currentPose();
  const cockpitLookRejected = !rig.applyLookDelta(0.5, 0.5);

  // 2. The handoff itself — watch the input-lock window close.
  const t0 = nowMs;
  rig.handoff('onfoot');
  const lockFrom = nowMs;
  let lockTo = -1;
  let midLookRejected = false;
  let midYaw = 0;
  while (nowMs - t0 < 800) {
    nowMs += STEP_MS;
    rig.update(STEP_MS / 1000);
    if (!rig.inputLocked && lockTo < 0) lockTo = nowMs;
    if (nowMs - t0 === 300) {
      midLookRejected = !rig.applyLookDelta(1.5, 1.5);
      midYaw = rig.lookAngles.yaw;
    }
  }

  // 3. Unlocked: look works again, and a +172° pitch demand clamps to +80°.
  const unlockedAfter = rig.applyLookDelta(0.2, 0.1);
  rig.applyLookDelta(0, (172 * Math.PI) / 180);
  const pitchClampedDeg = (rig.lookAngles.pitch * 180) / Math.PI;

  // 4. The path: 5 samples, compared against the RAW straight lerp.
  const path = (rig.lastPath ?? []).map((p) => ({ ...p.position }));
  const rawFrom = cockpitPose({ pos: SHIP_POS, quat: IDENTITY_QUAT }).position;
  const rawTo = onFootPose({ pos: CHAR_POS, yaw: 0, pitch: 0 }).position;
  let nudges = 0;
  let terrainClear = true;
  path.forEach((p, i) => {
    const t = i / (path.length - 1);
    const rawY = rawFrom.y + (rawTo.y - rawFrom.y) * t;
    if (Math.abs(p.y - rawY) > 1e-9) nudges += 1;
    if (p.y < mesa(p.x, p.z) + HANDOFF_CLEARANCE_M - 1e-6) terrainClear = false;
  });

  const endPose = rig.currentPose();
  const rendered = renderFinalView(rig, path);

  return {
    starts,
    ends,
    lockWindowMs: { from: lockFrom, to: lockTo },
    path,
    terrainClear,
    nudges,
    cockpitLookRejected,
    midLookRejected,
    midLookYawDrift: midYaw,
    unlockedAfter,
    pitchClampedDeg,
    fov: camera.fov,
    startPose,
    endPose,
    rendered,
  };
}

/**
 * Render the final on-foot view (ship, character, the handoff path as a
 * line, flat ground) into a small preserved-buffer canvas in the DOM —
 * the artifact the e2e screenshot inspects.
 */
function renderFinalView(rig: CameraRig, path: Vec3[]): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.id = '__camera-probe-canvas';
    canvas.width = 480;
    canvas.height = 270;
    canvas.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:9999;border:2px solid #67e8f9;';
    document.body.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(480, 270, false);
    const scene = new THREE.Scene();
    try {
      scene.background = new THREE.Color('#0a0f1e');
      scene.add(new THREE.AmbientLight('#8899bb', 2));
      const sun = new THREE.DirectionalLight('#ffffff', 2);
      sun.position.set(30, 50, 10);
      scene.add(sun);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshLambertMaterial({ color: '#3a4a3f' }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.z = 10;
      scene.add(ground);

      const ship = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.8, 3),
        new THREE.MeshLambertMaterial({ color: '#c9d4e6' }),
      );
      ship.position.set(SHIP_POS.x, SHIP_POS.y, SHIP_POS.z);
      scene.add(ship);

      const char = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 1.6, 8),
        new THREE.MeshLambertMaterial({ color: '#ffd166' }),
      );
      char.position.set(CHAR_POS.x, CHAR_POS.y + 0.8, CHAR_POS.z);
      scene.add(char);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p.x, p.y, p.z))),
        new THREE.LineBasicMaterial({ color: '#67e8f9' }),
      );
      scene.add(line);

      renderer.render(scene, rig.camera);
      return true;
    } finally {
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
    }
  } catch {
    return false;
  }
}
