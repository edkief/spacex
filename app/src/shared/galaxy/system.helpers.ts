/**
 * Shared helpers and constants for the `shared/galaxy/system` test
 * suite. Kept in its own (non-test) module so:
 *   - `system.test.ts` and `system.parity.test.ts` can share the same
 *     DEV_SEED, TEST_SEEDS, sample-star generator, etc. without
 *     duplicating imports.
 *   - the `noUnusedLocals` TypeScript check is happy (helpers are
 *     referenced from at least one test file each).
 *   - each individual test file stays below the 300-line ceiling
 *     mandated by AGENTS.md (file-size policy).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { generateStars } from "./stars.js";
import {
  PLANET_CLASSES,
  SHIP_CLASS_IDS,
  RESOURCE_TYPES,
  type PlanetClass,
  type ResourceType,
  type ShipClassId,
  type Star,
  type SystemGen,
} from "./types.js";

/** Canonical drift dev seed (matches every other fixture). */
export const DEV_SEED = "drift-dev-seed-001";

/** Five seeds: dev, prod placeholder, empty, "alpha", and a fifth arbitrary string. */
export const TEST_SEEDS: readonly string[] = [
  DEV_SEED,
  "DRIFT-SEED-0001",
  "",
  "alpha",
  "test-galaxy-seed-002",
];

/** Star index #0 of the dev-seed galaxy — the golden fixture target. */
export const STAR_INDEX = 0;

/** Allowed-value sets used across the test suite. */
export const VALID_PLANET_CLASSES: ReadonlySet<PlanetClass> = new Set(PLANET_CLASSES);
export const VALID_SHIP_CLASSES: ReadonlySet<ShipClassId> = new Set(SHIP_CLASS_IDS);
export const VALID_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set(RESOURCE_TYPES);

/**
 * Returns the parent `Star` for `TEST_SEEDS[0]` at `STAR_INDEX`.
 * Convenience for top-level `it()` blocks that don't want the boilerplate.
 */
export function sampleStar(): Star {
  const stars = generateStars(DEV_SEED);
  return stars[STAR_INDEX] as Star;
}

/** Format `value` as a zero-padded lowercase hex string of `width` chars. */
export function bigintToHex(value: bigint, width: number): string {
  const hex = value.toString(16);
  return hex.length >= width ? hex : "0".repeat(width - hex.length) + hex;
}

/** Golden-fixture shape for the system generator (TASK-4). */
export interface SystemFixture {
  seed: string;
  starIndex: number;
  starId: string;
  system: SystemGen;
}

/** Load the committed golden fixture from disk. */
export function loadSystemFixture(): SystemFixture {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "__fixtures__/system-dev-seed-star0.json");
  return JSON.parse(readFileSync(path, "utf8")) as SystemFixture;
}
