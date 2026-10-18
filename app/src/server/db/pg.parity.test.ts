/**
 * Postgres schema-compile parity tests (TASK-62 AC3).
 *
 * Verifies that the Postgres schema imports cleanly, exposes the same
 * logical table names as the SQLite twin, and round-trips through
 * `drizzle-kit generate` to a temporary `out/` directory without error.
 *
 * No live Postgres instance is required — the test uses `drizzle-kit`'s
 * generator, which only inspects the schema TypeScript types and emits
 * DDL SQL.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { pgSchema } from "./schema.pg.js";
import { sqliteSchema } from "./schema.sqlite.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const DRIZZLE_BIN = path.join(APP_ROOT, "node_modules/.bin/drizzle-kit");

interface DrizzleResult {
  tmp: string;
  configFile: string;
  outDir: string;
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Spin up an isolated `drizzle-kit generate --dialect postgresql` run for the
 * pg schema. Each call gets a brand-new tmp directory so `drizzle-kit`'s
 * journal/snapshot bookkeeping can't be carried over from a previous run.
 */
function runDrizzleGenerate(): DrizzleResult {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-pg-parity-"));
  const configFile = path.join(tmp, "drizzle.config.cjs");
  const outDir = path.join(tmp, "out");
  writeFileSync(
    configFile,
    `module.exports = {
  schema: ${JSON.stringify(path.join(APP_ROOT, "src/server/db/schema.pg.ts"))},
  out: ${JSON.stringify(outDir)},
  dialect: "postgresql",
};
`,
  );
  const result = spawnSync(DRIZZLE_BIN, ["generate", "--config", configFile], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    tmp,
    configFile,
    outDir,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("postgres schema parity", () => {
  it("exposes every logical table the SQLite twin does", () => {
    expect(Object.keys(pgSchema).sort()).toEqual(Object.keys(sqliteSchema).sort());
    expect(Object.keys(pgSchema).sort()).toEqual([
      "cargoItems",
      "deposits",
      "players",
      "resourceNodeState",
      "sessions",
      "ships",
      "systemRegistry",
    ]);
  });

  it("drizzle-kit generate emits CREATE TABLE statements for every required table", () => {
    let result: DrizzleResult | null = null;
    try {
      result = runDrizzleGenerate();
      if (result.status !== 0) {
        throw new Error(
          `drizzle-kit generate failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
        );
      }

      // Read every generated SQL file; concatenated, they must mention all
      // six table names plus the unique index on callsign.
      const files = listSqlFiles(result.outDir);
      expect(files.length).toBeGreaterThan(0);

      const combined = files.map((name) => readFileSync(name, "utf8")).join("\n");
      for (const tableName of [
        "players",
        "ships",
        "cargo_items",
        "sessions",
        "resource_node_state",
        "system_registry",
      ]) {
        expect(combined).toMatch(new RegExp(`CREATE TABLE[^;]*"${tableName}"`, "iu"));
      }
      // Sanity: the unique index on players.callsign is preserved.
      expect(combined).toMatch(/players_callsign_unique/iu);
    } finally {
      if (result) rmSync(result.tmp, { recursive: true, force: true });
    }
  });

  it("no live Postgres is required — the pg schema compiles in a sandboxed parse", () => {
    // This case asserts the schema module evaluates without errors when
    // imported. It exercises every column builder + table definition that
    // drizzle-kit will later inspect.
    expect(pgSchema.players).toBeDefined();
    expect(pgSchema.ships).toBeDefined();
    expect(pgSchema.cargoItems).toBeDefined();
    expect(pgSchema.sessions).toBeDefined();
    expect(pgSchema.resourceNodeState).toBeDefined();
    expect(pgSchema.systemRegistry).toBeDefined();
  });
});

/** Walk `outDir` for *.sql files (top-level only — drizzle-kit emits flat). */
function listSqlFiles(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => path.join(outDir, name));
}
