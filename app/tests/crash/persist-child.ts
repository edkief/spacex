import { openDatabase } from '../../src/server/db/open.ts';
import { findAppDir } from '../../src/server/env.ts';
import { createPersistService, type LiveShip } from '../../src/server/persist.ts';

// Child process for the crash tests: writes state through the persistence service, reports what
// it has durably saved on stdout, then idles until the parent kills it with SIGKILL.
const [dbPath, mode] = process.argv.slice(2);
if (!dbPath || !mode) throw new Error('usage: persist-child <dbPath> <dock|interval|storm>');

const SYSTEM = 'sys-crash';
const say = (value: unknown): void => void console.log(JSON.stringify(value));

const { repo } = await openDatabase(
  { dbDriver: 'sqlite', dbPath, databaseUrl: undefined },
  { appDir: findAppDir(import.meta.dirname) },
);

/** Creates a player with a starter ship and returns its live view. */
async function spawnShip(callsign: string): Promise<{ playerId: string; live: LiveShip }> {
  const player = await repo.createPlayer({ callsign, homeSystemId: SYSTEM });
  const ship = await repo.getOrCreateStarterShip(player.id);
  const live: LiveShip = {
    shipId: ship.id,
    classId: 'scout',
    hull: ship.hull,
    shields: ship.shields,
    position: { ...ship.position },
    velocity: { ...ship.velocity },
    state: 'docked',
  };
  return { playerId: player.id, live };
}

if (mode === 'storm') {
  // 16 ships saved together every round; the parent kills us at a random moment mid-storm.
  const persist = createPersistService(repo, { intervalMs: 3_600_000 });
  const ships = await Promise.all(Array.from({ length: 16 }, (_, i) => spawnShip(`storm-${i}`)));
  say({ ready: true, shipIds: ships.map((s) => s.live.shipId) });
  for (let round = 1; ; round++) {
    for (const { live } of ships) {
      persist.markDirty({
        ...live,
        position: { ...live.position, x: round },
        cargo: [{ resourceType: 'iron', quantity: round }],
      });
    }
    say({ startingRound: round });
    await persist.flushDirty();
    say({ savedRound: round });
    await new Promise((resolve) => setImmediate(resolve));
  }
} else {
  const { playerId, live } = await spawnShip('crash-pilot');
  await repo.addCredits(playerId, 1234);
  const persist = createPersistService(repo, { intervalMs: mode === 'interval' ? 25 : 3_600_000 });
  await persist.saveNodeStates(SYSTEM, [
    { nodeId: 'crash-node-1', quantityRemaining: 0, respawnAt: new Date(Date.UTC(2040, 0, 1)) },
  ]);
  await persist.onDock({
    ...live,
    position: { systemId: SYSTEM, frame: 'system', x: 100.5, y: -20.25, z: 3 },
    cargo: [
      { resourceType: 'iron', quantity: 7 },
      { resourceType: 'water', quantity: 2 },
    ],
  });
  // Later the ship flies on; this newer state is only marked dirty.
  persist.markDirty({
    ...live,
    state: 'flying',
    position: { systemId: SYSTEM, frame: 'system', x: 5000.5, y: 0, z: 0 },
    cargo: [{ resourceType: 'iron', quantity: 9 }],
  });
  if (mode === 'interval') {
    persist.start();
    while (persist.isDirty(live.shipId)) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  say({ ready: true, playerId, shipId: live.shipId });
}

setInterval(() => undefined, 1000);
