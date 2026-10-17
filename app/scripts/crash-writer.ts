/**
 * Crash-test writer (TASK-63 AC3).
 *
 * Standalone helper invoked by `src/server/persist.crash.test.ts`. Opens
 * a SQLite database at the path passed via `process.argv[2]`, writes a
 * ship + cargo, then SIGKILLs itself. The parent test verifies that the
 * stored state survives a hard crash via `loadSystemState`.
 *
 * Run manually with:
 *   npx tsx scripts/crash-writer.ts /tmp/drift.db
 *
 * Not part of any automated path outside the crash test.
 */
import { loadConfig } from "../src/server/config.js";
import { createDbClient } from "../src/server/db/client.js";
import { createSqliteRepository } from "../src/server/db/repo.sqlite.js";
import { PersistService, materialiseShip } from "../src/server/persist.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("[crash-writer] usage: crash-writer.ts <dbPath>");
  process.exit(2);
}

// Force the config to point at the requested DB path before constructing
// the client. We mutate process.env because `createDbClient` reads via
// `loadConfig()` from the env.
process.env.DB_DRIVER = "sqlite";
process.env.DB_PATH = dbPath;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createDbClient(config);
  if (client.driver !== "sqlite") {
    throw new Error("crash-writer only runs against the SQLite driver");
  }
  client.migrate();
  const repo = createSqliteRepository(client.db);
  const svc = new PersistService(repo);

  // Spawn a known player + ship, write a deterministic position + cargo.
  const player = await repo.createPlayer({
    callsign: "CRASH-PILOT",
    homeSystemId: "system-CRASH",
  });
  const ship = await repo.getOrCreateStarterShip(player.id, "scout");
  await svc.saveShip(
    materialiseShip({
      id: ship.id,
      ownerId: player.id,
      classId: ship.classId,
      livery: ship.livery,
      hull: 80,
      shields: 90,
      position: { systemId: "system-CRASH", x: 12.5, y: -3.5, z: 0.25 },
      velocity: { x: 0.1, y: 0, z: -0.05 },
      state: "flying",
    }),
  );
  await svc.saveCargo(ship.id, [
    { resourceType: "iron", quantity: 7 },
    { resourceType: "water", quantity: 3 },
  ]);
  // Hand off a footer line on stdout so test runners can correlate child exits.
  process.stdout.write(`crash-writer: committed ship=${ship.id} cargo=iron:7,water:3\n`);

  // SIGKILL self — best-effort flush to disk before the kernel tears the
  // process down. better-sqlite3's auto-commit-on-statement-default plus
  // WAL durability means each INSERT/UPDATE above is already on disk.
  process.kill(process.pid, "SIGKILL");
}

main().catch((err: unknown) => {
  console.error("[crash-writer] unexpected error:", err);
  process.exit(1);
});
