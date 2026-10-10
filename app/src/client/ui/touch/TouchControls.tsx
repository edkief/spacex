/**
 * TouchControls (TASK-91, PRD §4.13 / SC-6) — the FLIGHT + ON-FOOT touch
 * layouts.
 *
 * Owns the on-screen arrangement of the TouchJoysticks + TouchButtons and
 * feeds every gesture into the SHARED TouchInputSource (main.tsx keeps
 * ownership of the ref; the source is a prop). The virtual keys the source
 * projects are merged into the pressed set the prediction loops already
 * read (TASK-89) — nothing downstream changes.
 *
 * FLIGHT mapping (up-positive y from TASK-90):
 * - LEFT stick: thrust (up/down) + yaw (left/right) — `thrust: y, yaw: x`.
 * - RIGHT stick: pitch (up/down) + roll (left/right) — `pitch: y, roll: x`.
 * - VTOL button: atmosphere ONLY (the ' ' channel — same key as jump).
 * - BOOST button: space ONLY (the 'Shift' channel — same key as run).
 *
 * TASK-92 adds the COMBAT cluster in the right-mid clear zone (above the
 * VTOL/BOOST slot, clear of the left-edge ship HUD and the centre reticle):
 * FIRE (one shot per press — the SAME fireWeapon path as the canvas LMB;
 * the held state is visual only, matching the one-shot-per-click LMB),
 * LASER / MISSILE select (the SAME path as the '1'/'2' keys — the active
 * weapon shows its pressed accent), and TARGET (the SAME toggle path as
 * the 'T' key). The callbacks are props: main.tsx owns the shared paths,
 * and the server stays authoritative (intent only). When a callback is not
 * provided the cluster renders nothing (the layout stays flight-only).
 *
 * ON-FOOT layout (TASK-93): visible on the SURFACE only while the player is
 * DISSEMBARDED (the `onFoot` prop). A single MOVE stick feeds the SAME
 * virtual keys the on-foot loop reads (up = 'w' forward, right = 'd' turn —
 * `thrust: y, yaw: x`), plus RUN ('Shift') and JUMP (' ') held buttons, a
 * one-shot DROP (the Q keydown path), and a press/RELEASE INTERACT (the E
 * keydown/keyup pair — a long hold keeps the mining channel open until
 * release, exactly like a held E). The discrete callbacks are props:
 * main.tsx owns the shared paths (the server stays authoritative). The
 * layout sits clear of the on-foot HUD (weight bar / exposure meter in the
 * bottom-right corner, the interaction line bottom-center).
 *
 * Regime gating mirrors the ControlScheme exactly: a regime flip unmounts
 * the outgoing layout mid-press (the removed element's onRelease never
 * fires), so the flip clears the channels it would otherwise leave held.
 *
 * TASK-97: the SURFACE regime splits by `onFoot`. IN the ship (a
 * pad-docked / landed wire regime 'surface'), the FLIGHT layout renders
 * with the atmosphere scheme (VTOL, not BOOST — the same mapping the
 * flight loop reads through dockedFlightScheme('surface')), so a
 * pad-docked ship can take off by touch; the held channels SURVIVE the
 * liftoff flip (onFoot stays false) and only the disembark flip clears
 * them. The on-foot layout (above) renders only while `onFoot` is true.
 *
 * When `enabled` is false (the feature is off — TASK-94's flag, resolved
 * from the persisted touchControls setting: 'auto' = a touch-capable
 * device, 'on'/'off' = the manual choice) the container renders nothing
 * and the channels stay empty: the merge in TASK-89 is a no-op.
 * TASK-97 exception: on a touch-CAPABLE device (the `touchCapable` prop,
 * main.tsx's maxTouchPoints > 0) a lone MENU button still renders, so the
 * ESC layer (→ SETTINGS → TOUCH CONTROLS) stays reachable by touch to
 * re-enable. Desktop (touchCapable false) renders nothing — the
 * byte-for-byte keyboard path is preserved.
 *
 * TASK-94 adds the MENU button in BOTH layouts (top-right, clear of every
 * stick + HUD): its onPress calls the SAME open/pop function the Esc key
 * uses (the shared menuKeyAction, main.tsx), so the ESC menu stack — and
 * from it the star chart / warp, ship panel, chat and settings — is
 * reachable by touch. No onMenu → the button renders nothing.
 */
import React from 'react';

import type { TouchInputSource } from '@client/input/touch';
import type { Regime } from '@shared/regime';
import type { WeaponId } from '@shared/weapons';

import { TouchButton } from './TouchButton';
import { TouchJoystick, type TouchVector } from './TouchJoystick';

export interface TouchControlsProps {
  /** The feature-enable state (false = render nothing, channels stay off). */
  enabled: boolean;
  /** The active flight regime — gates the per-regime button (and the surface). */
  regime: Regime;
  /** The shared touch source (main.tsx owns the ref). */
  source: TouchInputSource;
  // TASK-92: the COMBAT cluster (the right-mid clear zone). Each callback is
  // the SAME shared path the keyboard uses (fireWeapon / '1'+'2' / 'T'),
  // owned by main.tsx. Omit all three to render the flight-only layout.
  /** Fire once (the shared fireWeapon — the canvas LMB's path). */
  onFire?: () => void;
  /** Select a weapon (the shared '1'/'2' path). */
  onWeapon?: (w: WeaponId) => void;
  /** Toggle the target lock (the shared 'T' path). */
  onTarget?: () => void;
  /** The active weapon (drives the select buttons' pressed accent). */
  weapon?: WeaponId;
  // TASK-93: the ON-FOOT layout (surface + disembarded). The discrete
  // callbacks are the SAME shared paths the E/Q keys use (main.tsx owns
  // them); the held MOVE/RUN/JUMP channels feed the source like flight.
  /** The player is on foot (disembarded) — with regime 'surface' this renders the on-foot layout. */
  onFoot?: boolean;
  /** Interact press (the shared E-down path — dispatch, mine-start, enter-ship…). */
  onInteractPress?: () => void;
  /** Interact release (the shared E-up path — mine-stop; a no-op otherwise). */
  onInteractRelease?: () => void;
  /** Drop one unit of the held resource (the shared Q-down path, on foot only). */
  onDrop?: () => void;
  // TASK-94: the MENU button (visible in every in-game regime) — the SAME
  // open/pop function the Esc key calls (main.tsx's menuKeyAction).
  /** Open the ESC menu / pop the top surface (the shared Esc path). */
  onMenu?: () => void;
  // TASK-97: the lone-MENU branch when disabled. DEFAULT false, so existing
  // renderings (desktop, unit tests) keep rendering nothing.
  /** The device is touch-capable (maxTouchPoints > 0, main.tsx). */
  touchCapable?: boolean;
}

/** Corner inset from the screen edge (on top of the safe-area inset). */
const CORNER = 24;

const side: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
};

export function TouchControls({
  enabled,
  regime,
  source,
  onFire,
  onWeapon,
  onTarget,
  weapon,
  onFoot,
  onInteractPress,
  onInteractRelease,
  onDrop,
  onMenu,
  touchCapable = false,
}: TouchControlsProps): React.ReactElement | null {
  // TASK-92: the FIRE button's controlled held state (visual only — the
  // press is one-shot, matching the one-shot-per-click canvas LMB).
  // TASK-93: the INTERACT button's held state (like a held E: press starts
  // the channel, release ends it). Rules of hooks: both declared before
  // the early return below.
  const [fireHeld, setFireHeld] = React.useState(false);
  const [interactHeld, setInteractHeld] = React.useState(false);
  const interactHeldRef = React.useRef(false);
  interactHeldRef.current = interactHeld;
  // Rules of hooks: these run before the early return below, so the
  // unmount / disabled cleanups always fire.
  // Disabled (or an unmount while enabled) clears every channel — a stale
  // held channel would keep flying the ship with no visible control.
  React.useEffect(() => {
    if (!enabled) {
      source.clear();
      return;
    }
    return () => source.clear();
  }, [enabled, source]);
  // A regime flip unmounts the outgoing layout's buttons mid-press (the
  // removed element's onRelease never fires) — clear the channels they
  // would leave held so the deliberate key collision can't leak across
  // regimes (the cross-flips: the per-regime flight button). The initial
  // mount writes nothing (no channel is held yet).
  // TASK-95.1 / TASK-97: the in-ship EXCEPTION — a touchdown
  // (atmosphere/space → surface while IN the ship, `onFoot` false) keeps
  // the held VTOL, and LIFTOFF (surface → atmosphere/space while `onFoot`
  // stays false) keeps the held thrust + VTOL too: the flight loop reads
  // both through dockedFlightScheme('surface') = the atmosphere scheme,
  // and the keyboard's held keys survive the flip, so the finger that is
  // still on the stick must as well (cutting the lift kills exactly the
  // take-off / landing the flip is about). DISSEMBARKING (the onFoot
  // flip) still clears, so the ' ' collision can't leak into the
  // on-foot JUMP.
  const prevRegimeRef = React.useRef<Regime | null>(null);
  const prevOnFootRef = React.useRef(false);
  React.useEffect(() => {
    const prev = prevRegimeRef.current;
    const prevOnFoot = prevOnFootRef.current;
    prevRegimeRef.current = regime;
    prevOnFootRef.current = !!onFoot;
    if (prev === null) return;
    if (prev === 'surface') {
      // The on-foot layout unmounted (disembark: onFoot now true, or
      // re-entry: onFoot was true) — clear its held channels.
      if (prevOnFoot || onFoot) source.clear();
      // liftoff (in ship → in ship): the held channels take the ship off — keep
    } else if (regime === 'atmosphere') source.setChannel({ boost: false });
    else if (regime === 'space') source.setChannel({ vtol: false });
    else if (onFoot) source.clear(); // disembark from flight: the on-foot layout owns the input
  }, [regime, source, onFoot]);
  // TASK-93: an INTERACT held when the on-foot layout unmounts (regime flip,
  // re-entry, disable) must end its channel — the removed button's
  // onRelease never fires, and the server must not award into a key nobody
  // holds (the same rule as the keyboard's window-blur release).
  const onFootActive = regime === 'surface' && !!onFoot;
  React.useEffect(() => {
    if (!onFootActive) return;
    return () => {
      if (interactHeldRef.current) onInteractRelease?.();
    };
  }, [onFootActive, onInteractRelease]);

  /**
   * TASK-94: the MENU button — top-right, clear of the sticks (bottom
   * corners), the ship HUD / player list (left edge) and the on-foot HUD
   * (bottom-right). The SAME open/pop the Esc key calls. Hoisted above the
   * disabled early return (TASK-97): the lone-MENU branch reuses it.
   */
  const menuButton = onMenu ? (
    <div
      id="touch-btn-menu"
      style={{
        ...side,
        right: `calc(${CORNER}px + env(safe-area-inset-right, 0px))`,
        top: `calc(${CORNER}px + env(safe-area-inset-top, 0px))`,
      }}
    >
      <TouchButton label="MENU" onPress={() => onMenu()} onRelease={() => {}} />
    </div>
  ) : null;
  if (!enabled) {
    // TASK-97: touch OFF on a touch-CAPABLE device — a lone MENU button
    // keeps the ESC layer (→ SETTINGS → TOUCH CONTROLS) reachable so the
    // player can re-enable by touch. Desktop (touchCapable false) renders
    // nothing: the keyboard path stays byte-for-byte. Channels are empty
    // (the effect above cleared them).
    if (!touchCapable) return null;
    if (!onMenu) return null;
    return (
      <div
        id="touch-controls"
        aria-label="Touch controls"
        style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 80 }}
      >
        {menuButton}
      </div>
    );
  }
  if (regime === 'surface' && onFoot) {
    const onMove = (v: TouchVector): void => source.setChannel({ thrust: v.y, yaw: v.x });
    return (
      <div
        id="touch-controls"
        aria-label="Touch controls"
        style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 80 }}
      >
        {menuButton}
        {/* MOVE stick — forward/back (thrust) + turn (yaw), bottom-left,
            the SAME virtual keys the on-foot loop reads. */}
        <div
          id="touch-stick-move"
          style={{
            ...side,
            left: `calc(${CORNER}px + env(safe-area-inset-left, 0px))`,
            bottom: `calc(${CORNER}px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <TouchJoystick label="move stick" onChange={onMove} />
        </div>
        {/* The action cluster — right-mid clear zone ABOVE the on-foot HUD
            (the weight bar + exposure meter sit in the bottom-right corner,
            the interaction line is bottom-center):
              [DROP 48]  [JUMP 64]
              [RUN 48]   [INTERACT 64] */}
        <div
          id="touch-btn-interact"
          style={{
            ...side,
            right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
            bottom: `calc(${CORNER + 152}px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <TouchButton
            label="INTERACT"
            pressed={interactHeld}
            onPress={() => {
              setInteractHeld(true);
              onInteractPress?.();
            }}
            onRelease={() => {
              setInteractHeld(false);
              onInteractRelease?.();
            }}
          />
        </div>
        <div
          id="touch-btn-run"
          style={{
            ...side,
            right: `calc(${CORNER + 32 + 64 + 12}px + env(safe-area-inset-right, 0px))`,
            bottom: `calc(${CORNER + 152}px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <TouchButton
            label="RUN"
            size={48}
            onPress={() => source.setChannel({ run: true })}
            onRelease={() => source.setChannel({ run: false })}
          />
        </div>
        <div
          id="touch-btn-jump"
          style={{
            ...side,
            right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
            bottom: `calc(${CORNER + 152 + 64 + 12}px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <TouchButton
            label="JUMP"
            onPress={() => source.setChannel({ jump: true })}
            onRelease={() => source.setChannel({ jump: false })}
          />
        </div>
        <div
          id="touch-btn-drop"
          style={{
            ...side,
            right: `calc(${CORNER + 32 + 64 + 12}px + env(safe-area-inset-right, 0px))`,
            bottom: `calc(${CORNER + 152 + 64 + 12}px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          {/* One-shot (the Q keydown): a release never drops a second unit. */}
          <TouchButton label="DROP" size={48} onPress={() => onDrop?.()} onRelease={() => {}} />
        </div>
      </div>
    );
  }
  // TASK-97: the surface-in-ship case (pad-docked / landed) renders this
  // layout with the ATMOSPHERE scheme — the same mapping the flight loop
  // reads through dockedFlightScheme('surface') (VTOL = the ' ' lift, NOT
  // BOOST), so the pad-docked ship takes off by touch.
  const atmosphere = regime === 'atmosphere' || (regime === 'surface' && !onFoot);

  const onLeft = (v: TouchVector): void => source.setChannel({ thrust: v.y, yaw: v.x });
  const onRight = (v: TouchVector): void => source.setChannel({ pitch: v.y, roll: v.x });

  return (
    <div
      id="touch-controls"
      aria-label="Touch controls"
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 80 }}
    >
      {menuButton}
      {/* LEFT stick — thrust + yaw (the throttle). */}
      <div
        id="touch-stick-left"
        style={{
          ...side,
          left: `calc(${CORNER}px + env(safe-area-inset-left, 0px))`,
          bottom: `calc(${CORNER}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <TouchJoystick label="thrust and yaw stick" onChange={onLeft} />
      </div>
      {/* The per-regime button above the RIGHT stick (VTOL in atmosphere,
          BOOST in space — the same physical slot, the regime decides).
          Right side by design: the left edge carries the ship HUD +
          player list, and the right mid-screen is the clear zone. */}
      <div
        id={atmosphere ? 'touch-btn-vtol' : 'touch-btn-boost'}
        style={{
          ...side,
          right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
          bottom: `calc(${CORNER + 152}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        {atmosphere ? (
          <TouchButton
            label="VTOL"
            onPress={() => source.setChannel({ vtol: true })}
            onRelease={() => source.setChannel({ vtol: false })}
          />
        ) : (
          <TouchButton
            label="BOOST"
            onPress={() => source.setChannel({ boost: true })}
            onRelease={() => source.setChannel({ boost: false })}
          />
        )}
      </div>
      {/* TASK-92: the COMBAT cluster — the right-mid clear zone above the
          VTOL/BOOST slot (clear of the left-edge ship HUD + the centre
          reticle). Only when the combat callbacks are wired (main.tsx).
          FIRE is one-shot per press (the shared fireWeapon); the accent
          border is the visual held state. LASER / MISSILE share the '1'/'2'
          path and show the active weapon's accent; TARGET shares the 'T'
          toggle path. All intents only — the server re-derives. */}
      {onFire && onWeapon && onTarget && (
        <>
          <div
            id="touch-btn-fire"
            style={{
              ...side,
              right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
              bottom: `calc(${CORNER + 248}px + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <TouchButton
              label="FIRE"
              size={72}
              pressed={fireHeld}
              onPress={() => {
                setFireHeld(true);
                onFire();
              }}
              onRelease={() => setFireHeld(false)}
            />
          </div>
          <div
            id="touch-btn-weapon-laser"
            style={{
              ...side,
              right: `calc(${CORNER + 32 + 72 + 12}px + env(safe-area-inset-right, 0px))`,
              bottom: `calc(${CORNER + 248}px + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <TouchButton
              label="LASER"
              size={48}
              pressed={weapon === 'laser'}
              onPress={() => onWeapon('laser')}
              onRelease={() => {}}
            />
          </div>
          <div
            id="touch-btn-weapon-missile"
            style={{
              ...side,
              right: `calc(${CORNER + 32 + 72 + 12 + 48 + 12}px + env(safe-area-inset-right, 0px))`,
              bottom: `calc(${CORNER + 248}px + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <TouchButton
              label="MISSILE"
              size={48}
              pressed={weapon === 'missile'}
              onPress={() => onWeapon('missile')}
              onRelease={() => {}}
            />
          </div>
          <div
            id="touch-btn-target"
            style={{
              ...side,
              right: `calc(${CORNER + 32}px + env(safe-area-inset-right, 0px))`,
              bottom: `calc(${CORNER + 248 + 72 + 12}px + env(safe-area-inset-bottom, 0px))`,
            }}
          >
            <TouchButton label="TARGET" size={56} onPress={() => onTarget()} onRelease={() => {}} />
          </div>
        </>
      )}
      {/* RIGHT stick — pitch + roll (the attitude). */}
      <div
        id="touch-stick-right"
        style={{
          ...side,
          right: `calc(${CORNER}px + env(safe-area-inset-right, 0px))`,
          bottom: `calc(${CORNER}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <TouchJoystick label="pitch and roll stick" onChange={onRight} />
      </div>
    </div>
  );
}
