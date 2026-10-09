/**
 * TASK-91: dev-only touch debug hook (no-op in production builds) — exposes
 * the ACTIVE touch channels on `window.__TOUCH__` plus a `setChannel`
 * passthrough, so the e2e drives the channels DETERMINISTICALLY (synthetic
 * pointer-capture gestures on the joysticks are flaky in headless — the dev
 * hook is the reliable input-adjacent path, same pattern as interact-debug).
 *
 * `channels` is a live getter: it always reads the source's current state
 * (a joystick move made by a real finger shows up here too), and
 * `setChannel` / `clear` delegate to the bound source.
 *
 * TASK-92 adds the COMBAT half on the same hook: `fire()` / `setWeapon()` /
 * `toggleTarget()` delegate to the SAME shared paths the keyboard uses
 * (fireWeapon / the '1'+'2' select / the 'T' toggle — main.tsx binds a
 * bridge over its refs), and the `state` getter snapshots the live
 * { weapon, locked } so the e2e can assert deterministically.
 *
 * TASK-93 adds the ON-FOOT half: `move({ thrust, yaw })` / `run(on)` /
 * `jump(on)` delegate straight to the bound source (the same channels the
 * MOVE stick + RUN/JUMP buttons write), and `interactPress()` /
 * `interactRelease()` / `drop()` delegate to the SAME shared discrete paths
 * the E/Q keys use (main.tsx binds a second bridge over its refs).
 */

import type { TouchChannels, TouchInputSource } from '@client/input/touch';
import type { WeaponId } from '@shared/weapons';

export interface TouchDebugState {
  /** Snapshot of the source's ACTIVE channels (live). */
  readonly channels: TouchChannels;
  /** Delegate to the source (the e2e drives the flight channels this way). */
  setChannel: (channels: Partial<TouchChannels>) => void;
  /** Reset every channel off (delegates to the source). */
  clear: () => void;
  /** TASK-92: fire once via the shared fireWeapon (no-op before binding). */
  fire: () => void;
  /** TASK-92: select a weapon (the '1'/'2' path; no-op before binding). */
  setWeapon: (w: WeaponId) => void;
  /** TASK-92: toggle the target lock (the 'T' path; no-op before binding). */
  toggleTarget: () => void;
  /** TASK-92: live { weapon, locked } snapshot (null before binding). */
  readonly state: { weapon: WeaponId; locked: boolean } | null;
  /** TASK-93: set the MOVE stick's channels (the same path as the stick). */
  move: (c: { thrust?: number; yaw?: number }) => void;
  /** TASK-93: set the RUN channel on/off (the same path as the RUN button). */
  run: (on: boolean) => void;
  /** TASK-93: set the JUMP channel on/off (the same path as the JUMP button). */
  jump: (on: boolean) => void;
  /** TASK-93: interact press (the E-down path; no-op before binding). */
  interactPress: () => void;
  /** TASK-93: interact release (the E-up path; no-op before binding). */
  interactRelease: () => void;
  /** TASK-93: drop one unit of the held resource (the Q path; no-op before binding). */
  drop: () => void;
  /** TASK-94: the MENU button's action (the shared Esc open/pop; no-op before binding). */
  openMenu: () => void;
}

/** The combat bridge main.tsx binds (the shared fire/select/lock paths). */
interface TouchCombatBridge {
  fire: () => void;
  setWeapon: (w: WeaponId) => void;
  toggleTarget: () => void;
  snapshot: () => { weapon: WeaponId; locked: boolean };
}

/** The on-foot bridge main.tsx binds (the shared E/Q discrete paths). */
export interface TouchOnFootBridge {
  interactPress: () => void;
  interactRelease: () => void;
  drop: () => void;
}

/**
 * The live menu action main.tsx binds (TASK-94: the SAME open/pop the Esc
 * key calls — main.tsx's menuKeyActionRef).
 */
type TouchMenuAction = () => void;

declare global {
  interface Window {
    __TOUCH__?: TouchDebugState;
  }
}

/** The live source (bound by main.tsx once the ref exists). */
let boundSource: (() => TouchInputSource | null) | null = null;
/** The live combat bridge (bound by main.tsx once the refs exist). */
let boundCombat: (() => TouchCombatBridge) | null = null;
/** The live on-foot bridge (bound by main.tsx once the refs exist). */
let boundOnFoot: (() => TouchOnFootBridge) | null = null;
/** The live menu action (bound by main.tsx once the ref exists). */
let boundMenu: TouchMenuAction | null = null;

/** Install the hook (DEV builds only); returns the live record to use. */
export function installTouchDebug(): TouchDebugState | null {
  if (!import.meta.env.DEV) return null;
  const state: TouchDebugState = {
    get channels() {
      return boundSource?.()?.snapshot() ?? {};
    },
    setChannel: (channels) => boundSource?.()?.setChannel(channels),
    clear: () => boundSource?.()?.clear(),
    fire: () => boundCombat?.().fire(),
    setWeapon: (w) => boundCombat?.().setWeapon(w),
    toggleTarget: () => boundCombat?.().toggleTarget(),
    get state() {
      return boundCombat ? boundCombat().snapshot() : null;
    },
    move: (c) => boundSource?.()?.setChannel(c),
    run: (on) => boundSource?.()?.setChannel({ run: on }),
    jump: (on) => boundSource?.()?.setChannel({ jump: on }),
    interactPress: () => boundOnFoot?.().interactPress(),
    interactRelease: () => boundOnFoot?.().interactRelease(),
    drop: () => boundOnFoot?.().drop(),
    openMenu: () => boundMenu?.(),
  };
  window.__TOUCH__ = state;
  return state;
}

/** Bind the live source (main.tsx passes a lazy getter over its ref). */
export function bindTouchDebug(
  state: TouchDebugState | null,
  getSource: () => TouchInputSource | null,
): void {
  if (!state) return; // production build — nothing to bind
  boundSource = getSource;
}

/** Bind the live combat bridge (main.tsx passes a lazy getter over its refs). */
export function bindTouchCombat(
  state: TouchDebugState | null,
  getCombat: () => TouchCombatBridge,
): void {
  if (!state) return; // production build — nothing to bind
  boundCombat = getCombat;
}

/** Bind the live on-foot bridge (main.tsx passes a lazy getter over its refs). */
export function bindTouchOnFoot(
  state: TouchDebugState | null,
  getOnFoot: () => TouchOnFootBridge,
): void {
  if (!state) return; // production build — nothing to bind
  boundOnFoot = getOnFoot;
}

/** Bind the live menu action (main.tsx passes its menuKeyActionRef getter). */
export function bindTouchMenu(state: TouchDebugState | null, getMenu: TouchMenuAction): void {
  if (!state) return; // production build — nothing to bind
  boundMenu = getMenu;
}
