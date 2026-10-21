/**
 * Dev-only test hook for the camera rig (TASK-27).
 *
 * The spec acceptance criterion calls for an e2e smoke test that
 * "test[s] the rig standalone with a scripted ship/character pair
 * (Playwright + exposed test hook)". The hook is a thin facade
 * that lets Playwright drive a `CameraRig` from the page context
 * without a real three.js scene mounted.
 *
 * Why a `window.__driftCameraRig` global and not a React context?
 *   - The rig is owned by the renderer (a single `PerspectiveCamera`
 *     that the scene graph mounts). The renderer is the only
 *     thing that should expose it. A test-friendly global keeps
 *     the production code path clean.
 *   - The same pattern is used by `driftDebug.ts` (TASK-71) for
 *     the determinism surface; consistency matters.
 *
 * Why a class wrapper around the rig and not the rig itself?
 *   - The hook is dev-only; production builds tree-shake it
 *     entirely (the `import.meta.env.DEV` guard in `index.ts`).
 *     Wrapping in a small class makes the surface easier to
 *     describe and easier to swap (e.g. if a future test wants
 *     to compare two rigs in the same page).
 *
 * Why expose a `setShip` / `setCharacter` pair on the hook?
 *   - Tests need to script the rig with a "fake ship" or "fake
 *     character" — a real `THREE.Object3D` would require a
 *     scene mount + a real render loop. The rig's plain-object
 *     API (`ShipState` / `CharacterState`) is enough.
 */

import { Vector3 } from "three";

import { type CameraRig } from "./CameraRig.js";
import type { CharacterState, ShipState, Vec3Like } from "./types.js";

/**
 * The public shape of the dev-only `window.__driftCameraRig`
 * hook. Every method is a pass-through to the underlying rig;
 * the wrapper exists so tests don't reach into the rig's
 * private fields and so we can swap the rig without breaking
 * the test surface.
 */
export interface CameraRigTestHook {
  /** The rig's current mode. */
  mode(): "cockpit" | "external" | "onfoot";
  /** True while a handoff animation is in flight. */
  isHandoffInFlight(): boolean;
  /** Total handoffs completed since construction. */
  handoffCompletedCount(): number;
  /** Total handoffs started since construction. */
  handoffKickoffCount(): number;
  /** Current camera world position (copied). */
  cameraPosition(): Vec3Like;
  /** Current camera look-at point (copied). */
  cameraLookAt(): Vec3Like;
  /** Push a fake ship state (cockpit mode target). */
  setShip(ship: ShipState | null): void;
  /** Push a fake character state (on-foot mode target). */
  setCharacter(character: CharacterState | null): void;
  /** Switch the rig's mode (kicks off a handoff if the mode changes). */
  setMode(mode: "cockpit" | "external" | "onfoot"): void;
  /** Apply a mouse-look delta. No-op during a handoff. */
  applyMouseLook(deltaYaw: number, deltaPitch: number): void;
  /** Advance the rig by `dtSeconds` (test uses real wall-clock dt or a fake). */
  tick(dtSeconds: number): void;
  /** Snap the rig's pose (skip smoothing) — useful for the first frame. */
  snapPose(pos: Vec3Like, lookAt: Vec3Like): void;
  /** Read the rig's current pose (copied). */
  currentPose(): { pos: Vec3Like; lookAt: Vec3Like };
}

/**
 * Build a test hook around an existing rig. The hook never
 * mutates the rig's state — it only forwards calls.
 */
export function createCameraRigTestHook(rig: CameraRig): CameraRigTestHook {
  return {
    mode: () => rig.mode,
    isHandoffInFlight: () => rig.isHandoffInFlight,
    handoffCompletedCount: () => rig.handoffCompletedCount,
    handoffKickoffCount: () => rig.handoffKickoffCount,
    cameraPosition: () => ({ ...rig.perspectiveCamera.position }),
    cameraLookAt: () => {
      // The rig does not store the look-at on the camera —
      // it's the *target* of the last `lookAt()` call. We
      // reverse-derive it from the camera's current forward
      // vector (5 m in front of the camera). The test only
      // needs the *direction*, and the camera forward is
      // exactly that.
      const pos = rig.perspectiveCamera.position;
      const fwd = new Vector3();
      rig.perspectiveCamera.getWorldDirection(fwd);
      return { x: pos.x + fwd.x * 5, y: pos.y + fwd.y * 5, z: pos.z + fwd.z * 5 };
    },
    setShip: (ship) => rig.setShip(ship),
    setCharacter: (character) => rig.setCharacter(character),
    setMode: (mode) => rig.setMode(mode),
    applyMouseLook: (dy, dp) => rig.applyMouseLook(dy, dp),
    tick: (dt) => rig.update(dt),
    snapPose: (pos, lookAt) => rig.setPoseImmediate({ pos, lookAt }),
    currentPose: () => rig.getCurrentPose(),
  };
}

/**
 * Install the test hook on `window.__driftCameraRig`. Returns
 * the hook instance so the caller can keep a reference. The
 * caller is responsible for guarding the install with
 * `import.meta.env.DEV` (the `index.ts` barrel does this).
 */
export function installCameraRigTestHook(rig: CameraRig): CameraRigTestHook {
  const hook = createCameraRigTestHook(rig);
  (globalThis as unknown as { __driftCameraRig?: CameraRigTestHook }).__driftCameraRig = hook;
  return hook;
}

/** Remove the test hook from `window` (used in tests + dev hot-reload). */
export function uninstallCameraRigTestHook(): void {
  delete (globalThis as unknown as { __driftCameraRig?: CameraRigTestHook }).__driftCameraRig;
}
