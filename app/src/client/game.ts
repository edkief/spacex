import type { Regime } from '@shared/regime.ts';
import type { ServerMessage } from '@shared/protocol/registry.ts';
import { length } from '@shared/physics/vec.ts';
import { InputPump } from './input/inputPump.ts';
import { KeyboardState } from './input/keyboardState.ts';
import type { ClientConfig, SessionInfo } from './net/session.ts';
import { GameSocket, socketUrl, type SocketLike, type SocketStatus } from './net/socket.ts';
import { chaseCameraPosition } from './render/relative.ts';
import { createRenderHost, type RenderHost } from './render/renderHost.ts';
import { ShipMeshes } from './render/shipMeshes.ts';
import { createSystemScene } from './render/systemScene.ts';
import { EntityStore } from './world/entityStore.ts';
import { deriveSystem } from './world/systemData.ts';

/** What the HUD shows; emitted a few times per second. */
export interface GameView {
  status: SocketStatus;
  detail: string | undefined;
  callsign: string;
  systemName: string;
  /** Own ship speed in m/s (latest server state). */
  speed: number;
  regime: Regime | undefined;
  docked: boolean;
  landed: boolean;
  players: number;
}

export interface Game {
  subscribe(listener: (view: GameView) => void): () => void;
  stop(): void;
}

/** Read-only handles for e2e tests and debugging (attached to window in dev builds only). */
export interface DriftDebug {
  readonly framesRendered: number;
  readonly shipMeshCount: number;
  readonly planetCount: number;
  readonly status: SocketStatus;
  readonly inputsSent: number;
  ownShip(): unknown;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  session: SessionInfo;
  config: ClientConfig;
  view?: Window;
  createSocket?: (url: string) => SocketLike;
  /** Replaces the WebGL host (tests without a GPU). */
  createHost?: (canvas: HTMLCanvasElement) => RenderHost;
}

const VIEW_INTERVAL_MS = 200;
const FALLBACK_INPUT_RATE = 20;

/**
 * Runs the game for a signed-in pilot: regenerates their home system from the seed, connects
 * and joins it, feeds keyboard input to the server at the tick rate, and renders the system and
 * every ship from the interpolated server state with a chase camera on the pilot's own ship.
 */
export function startGame(options: GameOptions): Game {
  const view = options.view ?? window;
  const { session, config } = options;
  const { system, bodies } = deriveSystem(config.galaxySeed, session.homeSystemId);
  const store = new EntityStore(bodies);
  const host = (options.createHost ?? createRenderHost)(options.canvas);
  const scene = createSystemScene(config.galaxySeed, system);
  const ships = new ShipMeshes();
  host.scene.add(scene.root, ships.root);

  const listeners = new Set<(view: GameView) => void>();
  let status: SocketStatus = 'connecting';
  let detail: string | undefined;
  let players = 0;
  let inputsSent = 0;
  let lastViewAt = -Infinity;

  const currentView = (): GameView => {
    const own = store.state(session.shipId);
    return {
      status,
      detail,
      callsign: session.callsign,
      systemName: system.name,
      speed: own ? length(own.vel) : 0,
      regime: own?.regime,
      docked: own?.dockedAt !== undefined,
      landed: own?.onPad !== undefined,
      players,
    };
  };
  const emit = (): void => {
    const snapshot = currentView();
    for (const listener of listeners) listener(snapshot);
  };

  const keyboard = new KeyboardState();
  const detachKeys = keyboard.attach(view);
  let pump: InputPump | undefined;

  const onMessage = (message: ServerMessage): void => {
    const now = view.performance.now();
    switch (message.type) {
      case 'enter_system':
        store.apply(message.payload.snapshot.entities, now);
        players = message.payload.snapshot.players.length;
        break;
      case 'entity_update':
        store.apply(message.payload.entities, now);
        break;
      case 'presence':
        players += message.payload.joined.length - message.payload.left.length;
        break;
      default:
        break;
    }
  };

  const socket = new GameSocket({
    url: socketUrl(config.wsPath, view.location),
    token: session.token,
    systemId: session.homeSystemId,
    onMessage,
    onStatus: (next, why) => {
      status = next;
      detail = why;
      if (next === 'online' && !pump) {
        pump = new InputPump({
          rate: socket.rates?.tickRate ?? FALLBACK_INPUT_RATE,
          sample: () => keyboard.sample(),
          send: (input) => {
            socket.send('input', input);
            inputsSent += 1;
          },
        });
        pump.start();
      }
      if (next === 'closed' || next === 'error') pump?.stop();
      emit();
    },
    ...(options.createSocket ? { createSocket: options.createSocket } : {}),
  });

  host.start((now) => {
    ships.sync(
      store.ids().map((id) => {
        const state = store.state(id);
        return { id, classId: state?.classId ?? null, livery: state?.livery };
      }),
    );
    const own = store.poseAt(session.shipId, now);
    const cameraWorld = own ? chaseCameraPosition(own.pos, own.quat) : { x: 0, y: 0, z: 0 };
    if (own) host.camera.quaternion.set(own.quat.x, own.quat.y, own.quat.z, own.quat.w);
    scene.update(cameraWorld);
    for (const id of store.ids()) {
      const pose = store.poseAt(id, now);
      if (pose) ships.place(id, pose.pos, pose.quat, cameraWorld);
    }
    if (now - lastViewAt >= VIEW_INTERVAL_MS) {
      lastViewAt = now;
      emit();
    }
  });

  if (import.meta.env.DEV) {
    const debug: DriftDebug = {
      get framesRendered() {
        return host.framesRendered;
      },
      get shipMeshCount() {
        return ships.count;
      },
      planetCount: scene.planetCount,
      get status() {
        return status;
      },
      get inputsSent() {
        return inputsSent;
      },
      ownShip: () => store.state(session.shipId),
    };
    (view as Window & { __DRIFT__?: DriftDebug }).__DRIFT__ = debug;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(currentView());
      return () => listeners.delete(listener);
    },
    stop() {
      pump?.stop();
      detachKeys();
      socket.close();
      host.dispose();
      scene.dispose();
    },
  };
}
