// Child helper for the TASK-63 crash-recovery test (step 3). Run via tsx:
//   tsx src/server/persist-crash-child.ts <dbPath> <payloadJson>
//
// It opens the sqlite file, writes a player + ship + cargo through the
// persist service, prints READY, and idles. The parent test then kills it
// with SIGKILL and reloads the file to prove the writes survived. Imports
// are relative (not @server/*) because tsx does not resolve tsconfig paths.

import fs from 'fs';
import path from 'path';

import { createDb } from './db/client';
import { createRepo } from './db/repo';
import { sqliteTables } from './db/schema';
import { createPersistService } from './persist';

const [dbPath, payloadJson] = process.argv.slice(2);
if (!dbPath || !payloadJson) {
  console.error('usage: persist-crash-child.ts <dbPath> <payloadJson>');
  process.exit(2);
}

interface Payload {
  callsign: string;
  credits: number;
  classId?: 'scout' | 'freighter' | 'interceptor';
  systemId: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  hull: number;
  shields: number;
  state: 'docked' | 'flying' | 'onfoot' | 'destroyed';
  cargo: { resourceType: string; quantity: number }[];
}

// async main (not top-level await): tsx compiles .ts as CJS here
void (async () => {
  const payload: Payload = JSON.parse(payloadJson);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = createDb({ driver: 'sqlite', dbPath });
  const repo = createRepo(handle.db, sqliteTables);
  const persist = createPersistService({ handle, repo });

  const player = await repo.createPlayer({
    callsign: payload.callsign,
    homeSystemId: payload.systemId,
    credits: payload.credits,
  });
  const ship = await repo.getOrCreateStarterShip(player.id, {
    classId: payload.classId ?? 'scout',
    position: { systemId: payload.systemId, ...payload.position },
  });

  // Persist through the real save-point path, then die ungracefully.
  await persist.saveShip({
    ...ship,
    hull: payload.hull,
    shields: payload.shields,
    position: { systemId: payload.systemId, ...payload.position },
    velocity: payload.velocity,
    state: payload.state,
  });
  await persist.saveCargo(ship.id, payload.cargo);

  console.log('READY');
  setInterval(() => {}, 1000); // stay alive; parent sends SIGKILL
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
