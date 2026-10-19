/**
 * Shared test harness for `ai-hydrate.test.ts`. Boots a minimal
 * in-memory SQLite + a live shard in the same process the test
 * runs in. Returns helpers for:
 *   - `loadSystem(systemId)` \u2014 spawn the shard through the same
 *     `hydrateAiRoster` path the router uses.
 *   - `broadcasts` \u2014 the recorded `entity_update` payloads so
 *     the wire-shape test can assert the AI ships surface.
 *   - `shutdown()` \u2014 teardown so afterEach can clean up.
 *
 * The harness is intentionally focused on the AI scope. The
 * companion `deposit-hydrate.test.ts` uses a similar shape; a
 * future factoring can hoist the boilerplate into a shared
 * helper without changing the tests.
 *
 * @see ./deposit-hydrate.test.ts for the deposit-scope analogue.
 * @see ./router.test.ts for the full integration variant.
 */

import { generateStars } from "@shared/galaxy/stars.js";

import { newRepoHarness } from "../db/repo.test.shared.js";
import { createShard, buildSnapshotEntities } from "../shard/index.js";
import { buildShardContext } from "./system-data.js";
import { hydrateAiRoster } from "./ai-hydrate.js";
import type { ProtocolEntityState } from "@shared/protocol/index.js";
import type { Shard } from "../shard/types.js";
import type { Repository } from "../db/repo.js";

export interface RouterHarnessOpts {
  /** Galaxy seed used by `loadSystem`. */
  readonly seed?: string;
  /** Star count (defaults to a small N for fast regeneration). */
  readonly starCount?: number;
}

/**
 * The harness exposes a single in-process shard (the test suite
 * typically loads one system per scenario so multi-shard is rare).
 * The shard uses the noop broadcaster so unit tests can read the
 * broadcast feed without a live WS server.
 */
export interface RouterHarness {
  /** The shared in-memory repo (sandbox + cleanup). */
  readonly repo: Repository;
  /** Load a system. Idempotent: a second call returns the same shard. */
  loadSystem(systemId: string): Promise<Shard>;
  /** The broadcasts the shard has produced so far. */
  readonly broadcasts: Array<{ tick: number; entities: ProtocolEntityState[] }>;
  /** Tear down the harness. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Boot a test harness. `installRepoHooks()` primes the in-memory
 * SQLite database; env-loaded defaults come from the import graph
 * (`@server/config` is side-effect loaded).
 *
 * The harness does NOT seed the callsign catalog \u2014 it's read
 * straight from `@shared/ai/names.ts` so no extra fixture wiring
 * is needed.
 */
export async function buildRouterWithShards(opts: RouterHarnessOpts = {}): Promise<RouterHarness> {
  const harness_db = newRepoHarness();
  const repo = harness_db.repo;
  const seed = opts.seed ?? "drift-ai-hydrate-seed";
  const starCount = opts.starCount ?? 8;

  const broadcasts: Array<{ tick: number; entities: ProtocolEntityState[] }> = [];
  const shardsBySystemId = new Map<string, Shard>();

  const harness: RouterHarness = {
    repo,
    broadcasts,
    async loadSystem(systemId) {
      const existing = shardsBySystemId.get(systemId);
      if (existing) return existing;
      // Translate `system-N` pseudo-ids into a real star id by
      // picking the Nth entry from the seeded galaxy. This
      // keeps the tests hermetic (no dependency on the
      // committed `stars-dev-seed.json`) while still
      // exercising the real `buildShardContext` +
      // `generateSystem` + `hydrateAiRoster` paths.
      const realSystemId = resolveRealSystemId(seed, starCount, systemId);
      const context = buildShardContext({
        seed,
        starCount,
        systemId: realSystemId,
      });
      const shard: Shard = createShard({
        systemId: realSystemId,
        context,
        send: () => undefined,
        broadcast: (tick, entities, _seq) => {
          broadcasts.push({ tick, entities });
        },
        autoStart: true,
        repo,
      });
      // Run the same hydrate sequence the router's
      // `loadAndRegister` runs.
      hydrateAiRoster(shard, { seed });
      shardsBySystemId.set(shard.systemId, shard);
      // Force a first snapshot so tests can read the AI roster
      // synchronously even though the helper is fire-and-forget.
      shard.broadcast(shard.sim.currentTick + 1, buildSnapshotEntities(shard), {});
      return shard;
    },
    async shutdown() {
      for (const shard of shardsBySystemId.values()) {
        shard.shutdown();
      }
      shardsBySystemId.clear();
      harness_db.close();
    },
  };
  return harness;
}

/**
 * Pick the Nth star id from the seeded galaxy. Accepts either a
 * real star id (returned as-is) or a `system-<index>` pseudo-id
 * (the test-side stand-in for a real system). Used so the test
 * code can stay readable (`system-A`, `system-B`, ...) while
 * `buildShardContext` still receives a real star id from
 * `generateStars`.
 */
function resolveRealSystemId(seed: string, starCount: number, systemIdOrPseudo: string): string {
  if (!systemIdOrPseudo.startsWith("system-")) return systemIdOrPseudo;
  const indexSuffix = systemIdOrPseudo.replace(/^system-/u, "");
  // Allow `system-N` integer-indexed lookups so tests can pick
  // an explicit star (e.g. `system-0` = first star).
  if (/^\d+$/u.test(indexSuffix)) {
    const idx = parseInt(indexSuffix, 10);
    const stars = generateStars(seed, Math.max(starCount, idx + 1));
    const star = stars[idx];
    if (!star) throw new Error(`resolveRealSystemId: no star at index ${idx}`);
    return star.id;
  }
  // Lettered pseudo-ids map to a deterministic offset (A=0,
  // B=1, ...). Lets the test author write `system-A` and have
  // it resolve to a real galaxy slot without knowing the hex
  // id.
  const letterIdx = indexSuffix.charCodeAt(0) - "A".charCodeAt(0);
  if (letterIdx < 0) return systemIdOrPseudo;
  const stars = generateStars(seed, Math.max(starCount, letterIdx + 1));
  const star = stars[letterIdx];
  if (!star) throw new Error(`resolveRealSystemId: no star at letter ${indexSuffix}`);
  return star.id;
}
