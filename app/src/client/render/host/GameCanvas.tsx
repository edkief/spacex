/**
 * GameCanvas — TASK-73 + TASK-74.
 *
 * The single React component that owns the `RenderHost`. Replaces
 * the legacy `<CanvasStage>` starfield stub with a real three.js
 * mount: `<canvas id="drift-canvas" data-testid="drift-canvas"
 * role="img" aria-label={...}>` is the same DOM node the e2e
 * harness + the a11y spec already pin, so the visual contract
 * doesn't change.
 *
 * TASK-74 additions on top of TASK-73:
 *
 *   1. **Own-ship mesh.** `buildShipObject` produces a
 *      `THREE.Group` from the paint-zone material registry. The
 *      group is parented once; per-frame writes copy the
 *      predictor's pos / quat onto it.
 *
 *   2. **Keyboard state.** `installKeyboardState` mounts in the
 *      pump effect; the pump reads its held-set every render
 *      frame.
 *
 *   3. **Input pump.** One pump lives for the duration of the
 *      `props.client !== null` window. Every render frame the
 *      pump calls `predictor.step()` and forwards the same input
 *      to `client.sendInput` on the 50 ms tick boundary. The
 *      pump is constructed in a SEPARATE effect from the host —
 *      this way the renderer mounts immediately (so the canvas
 *      isn't black during claims / boot) and the pump attaches
 *      as soon as a live client lands.
 *
 *   4. **Chase camera.** `setShip()` is called every fixed step
 *      from the predictor's post-reconciliation state; the rig
 *      does its existing 100 ms smoothing.
 *
 *   5. **Debug seam.** `window.__driftOwnShipMeshCount` reports
 *      the number of own-ship meshes the canvas currently owns.
 *
 * Lifecycle: StrictMode-safe (host is idempotent; second
 * `startFrameLoop` is a no-op).
 */
import type { Group as ThreeGroup } from "three";
import { MeshStandardMaterial } from "three";
import * as React from "react";
import { useEffect, useRef } from "react";

import { type FrameMonitor } from "@client/perf/frameMonitor.js";
import { InputPump, INPUT_SEND_INTERVAL_MS } from "@client/input/inputPump.js";
import { gameKeysForScheme, installKeyboardState } from "@client/input/keyboardState.js";
import { ShipPaintRegistry } from "@client/ships/ShipMeshBuilder.js";
import { createThreeMaterialAdapter } from "@client/ships/threeAdapter.js";
import { settingsBridge } from "@client/world/settingsBridge.js";

import { RenderHost } from "./RenderHost.js";
import { LOOP_GUARD_KEY, startFrameLoop, type FrameLoopHandle } from "./loop.js";

import { buildShipObject, writeShipStateToObject } from "../ship/buildShipObject.js";

import type { ShipClassId } from "@shared/ships.js";
import type { ShipLivery } from "@server/db/types.js";
import type { LocalInput } from "@client/net/prediction.js";

/** Property shape for {@link GameCanvas}. */
export interface GameCanvasProps {
  /**
   * TASK-54: the accessible name for the canvas.
   */
  label?: string;
  /**
   * TASK-74: the owning `DriftClient`. Optional — when omitted
   * (e.g. canvas-only unit tests) the ship layer renders with
   * the placeholder identity + zero velocity.
   */
  client?: GameCanvasClient | null;
}

/**
 * Narrow view of the DriftClient the canvas depends on. Decoupled
 * from the full `DriftClient` class so unit tests can supply a
 * stub without dragging in the WS layer.
 */
export interface GameCanvasClient {
  controlsManager: {
    scheme(): {
      id: string;
      regime: string;
      keyBindings: ReadonlyArray<{ action: string; key: string }>;
    };
  };
  predictor: {
    step(args: {
      now: number;
      thrust: number;
      turn: number;
      pitch: number;
      yaw: number;
      dt: number;
    }): { seq: number };
    state(): {
      pos: { x: number; y: number; z: number };
      vel: { x: number; y: number; z: number };
      quat: { x: number; y: number; z: number; w: number };
      regime: "space" | "orbit" | "atmosphere" | "surface";
      hull: number;
      shields: number;
      onPad?: string | null;
    };
  };
  sendInput(args: { seq: number; thrust: number; turn: number; pitch: number; yaw: number }): void;
}

/**
 * Default `FrameMonitor` accessor. Reads from
 * `window.__driftFrameMonitor` if installed (production installs
 * it via `useClientWiring`). Returns `null` in non-browser
 * environments so unit tests don't blow up.
 */
function readFrameMonitor(): FrameMonitor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __driftFrameMonitor?: FrameMonitor };
  return w.__driftFrameMonitor ?? null;
}

/** Default livery used until the predictor carries a paint frame. */
const DEFAULT_LIVERY: ShipLivery = {
  primary: "#3aa9ff",
  secondary: "#0d3a66",
  accent: "#ffffff",
};
const DEFAULT_CLASS: ShipClassId = "scout";

/**
 * The Drift main canvas — TASK-73 + TASK-74 mount.
 *
 * One `<canvas>` per game session. React only manages the DOM
 * node and the lifecycle `useEffect`; every per-frame concern
 * (camera, scene, render, ship mesh, input pump) is owned by
 * the `RenderHost` + `InputPump` instances the effect creates.
 */
export function GameCanvas(props: GameCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<RenderHost | null>(null);
  const loopRef = useRef<FrameLoopHandle | null>(null);
  const shipObjectRef = useRef<ThreeGroup | null>(null);

  // ----- Effect 1: render host + ship mesh + frame loop.
  // This effect mounts ONCE and survives even when
  // `props.client === null` (canvas-only boot phase). The
  // separate effect below attaches the input pump + keyboard
  // once a live DriftClient lands.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const hostInternal = RenderHost.prototype as unknown as Record<symbol, boolean>;
    hostInternal[LOOP_GUARD_KEY] = false;

    const initialWidth = canvas.clientWidth || window.innerWidth || 1;
    const initialHeight = canvas.clientHeight || window.innerHeight || 1;
    const host = new RenderHost({
      canvas,
      aspect: initialWidth / initialHeight,
      quality: settingsBridge.quality(),
    });
    hostRef.current = host;
    (globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost = host;

    const registry = new ShipPaintRegistry(createThreeMaterialAdapter(MeshStandardMaterial));
    (globalThis as { __driftPaintRegistry?: ShipPaintRegistry }).__driftPaintRegistry = registry;
    const ship = buildShipObject({
      classId: DEFAULT_CLASS,
      livery: DEFAULT_LIVERY,
      paintRegistry: registry,
    });
    host.scene.add(ship.object);
    shipObjectRef.current = ship.object;
    (globalThis as { __driftOwnShipMeshCount?: number }).__driftOwnShipMeshCount = 1;

    const fit = (): void => {
      const rect = canvas.getBoundingClientRect();
      host.setSize(rect.width, rect.height);
    };
    fit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(canvas);
    window.addEventListener("resize", fit);

    // TASK-74: default flight mode is `'external'` (chase
    // camera) so the player can actually see their ship. The
    // rig's own constructor defaults to `'cockpit'` for test
    // ergonomics; the production mount flips it once on
    // construction.
    if (host.cameraRig.mode !== "external") {
      host.cameraRig.setMode("external");
    }

    // e2e seam — the inputPump effect writes to this.
    (globalThis as { __driftInputSendCount?: number }).__driftInputSendCount = 0;
    (globalThis as { __driftLastInputSeq?: number }).__driftLastInputSeq = 0;

    const loop = startFrameLoop({
      host,
      fixedStepSeconds: 1 / 60,
      maxSubSteps: 5,
      onFixedStep: (dt) => {
        host.cameraRig.update(dt);
        // Push the live predictor state into the camera rig +
        // ship object. We do this from `onFixedStep` so the rig
        // smoothing and the predictor integration see identical
        // inputs. When the pump hasn't attached yet (no client),
        // we skip — the chase pose falls back to the rig's
        // smoothed zero-state which is acceptable for the
        // canvas-only phase.
        const w = globalThis as {
          __driftPumpClient?: GameCanvasClient | null;
        };
        const liveClient = w.__driftPumpClient ?? null;
        if (liveClient !== null && liveClient !== undefined) {
          const state = liveClient.predictor.state();
          host.cameraRig.setShip({ pos: state.pos, quat: state.quat });
          if (shipObjectRef.current !== null) {
            writeShipStateToObject(shipObjectRef.current, state.pos, state.quat);
          }
        }
        void dt;
      },
      onFrame: (dt) => {
        const w = globalThis as {
          __driftPump?: InputPump | null;
        };
        const pump = w.__driftPump ?? null;
        const stamped = pump?.tick(dt);
        if (stamped !== undefined) {
          (globalThis as { __driftLastInputSeq?: number }).__driftLastInputSeq = stamped.seq;
          (globalThis as { __driftInputSendCount?: number }).__driftInputSendCount =
            ((globalThis as { __driftInputSendCount?: number }).__driftInputSendCount ?? 0) + 1;
        }
        host.render();
      },
      frameMonitor: readFrameMonitor(),
    });
    loopRef.current = loop;

    return (): void => {
      loopRef.current?.stop();
      loopRef.current = null;
      ro?.disconnect();
      window.removeEventListener("resize", fit);
      hostRef.current?.dispose();
      hostRef.current = null;
      shipObjectRef.current = null;
      if ((globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost === host) {
        (globalThis as { __driftRenderHost?: RenderHost }).__driftRenderHost = undefined;
      }
      if (
        (globalThis as { __driftPaintRegistry?: ShipPaintRegistry }).__driftPaintRegistry ===
        registry
      ) {
        (globalThis as { __driftPaintRegistry?: ShipPaintRegistry }).__driftPaintRegistry =
          undefined;
      }
      (globalThis as { __driftOwnShipMeshCount?: number }).__driftOwnShipMeshCount = 0;
      hostInternal[LOOP_GUARD_KEY] = false;
    };
    // The host loop + scene-graph resource lifetime is bound to
    // the canvas mount, not to the client status. A status flip
    // (offline → online) is handled by the second effect below.
  }, []);

  // ----- Effect 2: input pump + keyboard (reactive on `props.client`).
  // Mounts when `props.client !== null` (production → status === "online");
  // teardown the moment the client goes back to null. The keyboard +
  // pump live on `globalThis.__driftPump` / `__driftPumpClient` so the
  // Effect 1 frame loop can read them without closing over a stale
  // reference.
  useEffect(() => {
    const client = props.client ?? null;
    if (client === null) {
      (globalThis as { __driftPump?: InputPump | null }).__driftPump = null;
      (globalThis as { __driftPumpClient?: GameCanvasClient | null }).__driftPumpClient = null;
      return;
    }
    const scheme = client.controlsManager.scheme();
    const gameKeys = gameKeysForScheme(scheme);
    const keyboard = installKeyboardState({ gameKeys });
    const pump = new InputPump({
      held: keyboard.state,
      getScheme: () => client.controlsManager.scheme().keyBindings,
      predictorStep: (args) => client.predictor.step(args) as unknown as LocalInput,
      sendInput: (input) => {
        try {
          client.sendInput({
            seq: input.seq,
            thrust: input.thrust,
            turn: input.turn,
            pitch: input.pitch,
            yaw: input.yaw,
          });
        } catch {
          // swallow — the WS layer may be closed during teardown.
        }
      },
      intervalMs: INPUT_SEND_INTERVAL_MS,
    });
    (globalThis as { __driftPump?: InputPump | null }).__driftPump = pump;
    (globalThis as { __driftPumpClient?: GameCanvasClient | null }).__driftPumpClient = client;
    return (): void => {
      keyboard.dispose();
      (globalThis as { __driftPump?: InputPump | null }).__driftPump = null;
      (globalThis as { __driftPumpClient?: GameCanvasClient | null }).__driftPumpClient = null;
    };
  }, [props.client]);

  return (
    <canvas
      ref={canvasRef}
      id="drift-canvas"
      data-testid="drift-canvas"
      role="img"
      aria-label={props.label ?? "3D view: flying in space"}
      style={{ display: "block", width: "100vw", height: "100vh" }}
    />
  );
}
