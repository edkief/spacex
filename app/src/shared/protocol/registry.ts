import type { z } from 'zod';
import { chatClientSchema, chatServerSchema } from './chat.ts';
import {
  combatEventSchema,
  entityUpdateSchema,
  inputSchema,
  presenceSchema,
  stateSnapshotSchema,
  targetUpdateClientSchema,
  targetUpdateServerSchema,
  warpSchema,
} from './world.ts';
import {
  buyShipSchema,
  enterShipSchema,
  exitShipSchema,
  interactSchema,
  mineSchema,
  repairSchema,
  sellSchema,
  setLiverySchema,
} from './economy.ts';
import {
  authOkSchema,
  authSchema,
  enterSystemSchema,
  errorSchema,
  helloSchema,
  joinSystemSchema,
  logoutSchema,
  pingSchema,
  pongSchema,
  welcomeSchema,
} from './session.ts';

/** Messages a client may send. The server parses ONLY this registry. */
export const CLIENT_MESSAGES = {
  hello: helloSchema,
  auth: authSchema,
  logout: logoutSchema,
  join_system: joinSystemSchema,
  chat: chatClientSchema,
  input: inputSchema,
  warp: warpSchema,
  interact: interactSchema,
  mine: mineSchema,
  sell: sellSchema,
  buy_ship: buyShipSchema,
  set_livery: setLiverySchema,
  exit_ship: exitShipSchema,
  enter_ship: enterShipSchema,
  repair: repairSchema,
  target_update: targetUpdateClientSchema,
  ping: pingSchema,
  pong: pongSchema,
} as const;

/** Messages the server may send. The client parses ONLY this registry. */
export const SERVER_MESSAGES = {
  welcome: welcomeSchema,
  auth_ok: authOkSchema,
  enter_system: enterSystemSchema,
  state_snapshot: stateSnapshotSchema,
  entity_update: entityUpdateSchema,
  chat: chatServerSchema,
  presence: presenceSchema,
  target_update: targetUpdateServerSchema,
  combat_event: combatEventSchema,
  error: errorSchema,
  ping: pingSchema,
  pong: pongSchema,
} as const;

export type ClientType = keyof typeof CLIENT_MESSAGES;
export type ServerType = keyof typeof SERVER_MESSAGES;
export type ClientPayload<K extends ClientType> = z.infer<(typeof CLIENT_MESSAGES)[K]>;
export type ServerPayload<K extends ServerType> = z.infer<(typeof SERVER_MESSAGES)[K]>;

/** Discriminated unions inferred from the schemas: switch on `type` for exhaustive handling. */
export type ClientMessage = {
  [K in ClientType]: { type: K; payload: ClientPayload<K> };
}[ClientType];
export type ServerMessage = {
  [K in ServerType]: { type: K; payload: ServerPayload<K> };
}[ServerType];

export const CLIENT_TYPES = Object.keys(CLIENT_MESSAGES) as ClientType[];
export const SERVER_TYPES = Object.keys(SERVER_MESSAGES) as ServerType[];

/** True when `type` is a client-to-server message type (own keys only, never prototype keys). */
export function isClientType(type: string): type is ClientType {
  return Object.prototype.hasOwnProperty.call(CLIENT_MESSAGES, type);
}

/** True when `type` is a server-to-client message type. */
export function isServerType(type: string): type is ServerType {
  return Object.prototype.hasOwnProperty.call(SERVER_MESSAGES, type);
}
