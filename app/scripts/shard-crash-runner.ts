/**
 * Crash-restart integration runner (TASK-24 AC3).
 *
 * Standalone helper invoked by `src/server/shard/persist.crash.test.ts`.
 * Opens a SQLite database at the path passed via `process.argv[2]`,
 * creates a player + ship, spawns a shard, starts the `ShardFlushService`
 * with a short flush interval (configurable via env), advances the
 * entity's position over ~2 s of wall clock, and then `process.exit(1)`
 * to simulate a kill -9 from the parent test.
 *
 * Why a child process: better-sqlite3 + WAL guarantee that committed
 * statements survive a `kill -9`, but writing + reading from the same
 * vitest worker doesn't actually exercise that — auto-commit happens
 * regardless. Spawning a real OS process and waiting for the kernel
 * to tear it down is the only honest crash test.
 *
 * Env vars:
 *   - DB_PATH (positional)  SQLite file path (required).
 *   - SHARD_FLUSH_INTERVAL_MS  interval between flushes (default 200).
 *   - SHIP_CLASS_ID            scout | freighter | interceptor (default scout).
 *   - TOTAL_RUN_MS             wall-clock to run before exiting (default 2000).
 *
 * Not part of any automated path outside the crash test.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createSqliteClient } from "../src/server/db/client.js";
import { createSqliteRepository } from "../src/server/db/repo.sqlite.js";
import { createShard, spawnShip, type Shard } from "../src/server/shard/index.js";
import { ShardFlushService } from "../src/server/shard/persist.js";
import { SHIP_CLASSES, type ShipClassId } from "../src/shared/ships.js";
import type { ShardSystemContext } from "../src/server/shard/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeContext(): ShardSystemContext {
  return {
    system: {
      systemId: "system-CRASH",
      name: "Crash Test System",
      star: {
        id: "star-crash",
        name: "Crash Star",
        class: "G",
        x: 0,
        y: 0,
        z: 0,
        systemCount: 1,
      },
      planets: [],
    },
    planetById: () => undefined,
    heightAtFor: () => undefined,
    tileSizeM: 64,
  };
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("[crash-runner] usage: shard-crash-runner.ts <dbPath>");
    process.exit(2);
  }
  // Force the SQLite client at the requested path. We avoid
  // `loadConfig()` so an existing .env.local doesn't redirect us.
  process.env.DB_DRIVER = "sqlite";
  process.env.DB_PATH = dbPath;

  const flushIntervalMs = readEnvNumber("SHARD_FLUSH_INTERVAL_MS", 200);
  const totalRunMs = readEnvNumber("TOTAL_RUN_MS", 2_000);
  const classId = (process.env.SHIP_CLASS_ID ?? "scout") as ShipClassId;

  const client = createSqliteClient({
    dbDriver: "sqlite",
    dbPath,
    port: 0,
    apiPort: 0,
    wsPath: "/ws",
    galaxySeed: "dev-seed",
    sessionSecret: "x".repeat(32),
    systemInstanceCount: 1,
    projectRoot: process.cwd(),
  });
  client.migrate();
  const repo = createSqliteRepository(client.db);
  const logger = {
    info: (...args: unknown[]) => console.info("[runner]", ...args),
    warn: (...args: unknown[]) => console.warn("[runner]", ...args),
    error: (...args: unknown[]) => console.error("[runner]", ...args),
  };

  // 1. Create the player + starter ship so the flush has something to UPDATE.
  const player = await repo.createPlayer({
    callsign: "CRASH-PILOT",
    homeSystemId: "system-CRASH",
  });
  const ship = await repo.getOrCreateStarterShip(player.id, classId);
  // Move the starter ship into the 'flying' state (the default is
  // 'docked', which the shard-load filter would skip).
  await repo.saveShipState(ship.id, {
    state: "flying",
    position: { systemId: "system-CRASH", x: 0, y: 0, z: 0 },
    quat: [0, 0, 0, 1],
  });

  // 2. Build a shard + spawn the in-memory entity at the saved position.
  const shard: Shard = createShard({
    systemId: "system-CRASH",
    context: makeContext(),
    send: () => {},
    broadcast: () => {},
    autoStart: false,
  });
  const shipCls = SHIP_CLASSES[classId];
  spawnShip(shard, {
    shipId: ship.id,
    playerId: player.id,
    callsign: player.callsign,
    classId,
    hull: shipCls.hull,
    shields: shipCls.shieldCapacity,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    originPlanetId: null,
    onPad: null,
    bindConnId: undefined,
  });

  // 3. Start the flush service — timer + first immediate flush.
  const flusher = new ShardFlushService(repo, { intervalMs: flushIntervalMs, logger });
  let lastFlush: { ships: number; durationMs: number } = { ships: 0, durationMs: 0 };
  flusher.start(async () => {
    lastFlush = await flusher.flushNow(shard);
  });
  // One immediate flush to seed the DB before any movement.
  await flusher.flushNow(shard);

  // 4. Advance the entity's position over the run window. We move
  //    on the +X axis at 250 u/s so the total displacement is ~500 u.
  const startedAt = Date.now();
  const speed = 250; // u/s
  let lastTick = Date.now();
  while (Date.now() - startedAt < totalRunMs) {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const entity = shard.entities.get(`entity:${ship.id}`);
    if (entity !== undefined) {
      entity.pos.x += speed * dt;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // 5. Final flush + exit. Capture the position before tearing down
  //    the shard (which clears the entity registry). We don't go
  //    through a graceful shutdown because the parent test will
  //    SIGKILL us anyway.
  const finalEntity = shard.entities.get(`entity:${ship.id}`);
  const finalPosX = finalEntity?.pos.x;
  await flusher.flushNow(shard);
  flusher.dispose();
  shard.shutdown();
  logger.info(
    `[crash-runner] ran for ${Date.now() - startedAt} ms; last flush=${lastFlush.ships} ships in ${lastFlush.durationMs.toFixed(2)} ms; final pos.x=${finalPosX}`,
  );
  if (client.driver === "sqlite") client.close();
  // Exit cleanly — the parent test treats exit-0 and SIGKILL the same
  // (it just needs the rows committed).
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[crash-runner] fatal:", err);
  process.exit(1);
});

void HERE;
