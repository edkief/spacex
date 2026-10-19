/**
 * REST route for dock sell — TASK-40.
 *
 *   POST /api/ships/sell
 *     header: Authorization: Bearer <token>
 *     body:   { resourceId, amount, source: 'hold' | 'inv' }
 *     200:    { sold, earned, newBalance, resourceType, source }
 *     400:    { code: "unknown-resource", message } — bad resourceId.
 *     400:    { code: "invalid-amount", message } — non-positive integer.
 *     401:    { code: "unauthenticated", message } — bad / missing token.
 *     404:    { code: "not-found", message } — ship / player missing.
 *     409:    { code: "not-at-station", message } — not at a dock terminal.
 *     409:    { code: "not-docked", message } — in-ship selling while flying.
 *     422:    { code: "insufficient", message } — source stack < amount.
 *
 * The route layer shares the same `handleSell` shim as the WS
 * `sell` handler so the WS + REST paths run the same validation
 * + math. The REST path is the canonical "in-ship" flow (the
 * player is sitting in the dock at their ship's hold); the WS
 * path is the "on-foot terminal" flow (TASK-33's `ui_open` modal
 * fires the WS frame for on-foot selling).
 *
 * Spec contract (TASK-40 acceptance):
 *   - "POST /api/ships/sell {resourceId, amount, source: 'hold'|'inv'}
 *      (auth, must be at a station: docked at a station pad OR
 *      on foot within 10 m of a station terminal — server validates
 *      position against station entities): deducts from the source,
 *      credits += amount * basePrice (TASK-41 atomic, one transaction),
 *      returns {sold, earned, newBalance}"
 *
 * The "must be at a station" check requires the live shard's
 * connection state (we need to know the player's bound entity +
 * its docked status + position). The REST route is therefore
 * coupled to the same `shardFor` plumbing the WS layer uses —
 * the route handler accepts an optional `shardFor` callback in
 * `SellRouteDeps`. Tests can substitute a no-op resolver to
 * exercise the validation paths without a full shard.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import type { Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";
import { handleSell } from "../shard/sell.js";
import { isSellableResourceType } from "@shared/world/sellOps.js";
import type { ResourceId } from "@shared/resources.js";

/** Public deps shared by tests and the live server. */
export interface SellRouteDeps {
  repo: Repository;
  sessionSecret: string;
  /**
   * Resolve the shard for a player (looked up via the connection
   * registry, which the WS layer wires). Returns `null` for a
   * player who isn't currently in any system — in that case the
   * route rejects with `not-at-station`.
   */
  shardFor: (
    playerId: string,
  ) =>
    { send: never; connections: { record: never }; entities: { record: never } } | unknown | null;
  /** Wall-clock override used by tests. */
  nowMs?: number;
  /**
   * Map playerId → live connId. The route layer needs the
   * connection id to drive the shard-side `handleSell`. Returns
   * `null` when the player isn't currently connected.
   */
  connIdForPlayer?: (playerId: string) => string | null;
}

/** Bearer-token extractor (case-insensitive, per RFC 7235). */
function readBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? req.headers.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^Bearer\s+/iu.test(trimmed)) return null;
  return trimmed.slice("Bearer ".length).trim();
}

/** Structured error body used for every failure response. */
function errBody(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/**
 * Register the sell route on the given Fastify instance.
 *
 * `buildApp()` is the only intended caller; tests wrap their own
 * Fastify + deps and call this directly so they can supply an
 * in-memory repo + a stub shard resolver.
 */
export function registerSellRoute(app: FastifyInstance, deps: SellRouteDeps): void {
  const SellRequestSchema = z
    .object({
      resourceId: z.string().min(1),
      amount: z.number().int().positive(),
      source: z.enum(["inv", "hold"]),
    })
    .strict();

  app.post("/api/ships/sell", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearer(req);
    if (token === null) {
      return reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (profile === null) {
      return reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
    }

    // Parse + validate the body. zod handles the shape; we
    // additionally validate the resource id against the catalog
    // BEFORE running the shard lookup so an unknown resource id
    // surfaces as `unknown-resource` (400) rather than the
    // shard-side `not-at-station` (409).
    const body = (req.body ?? {}) as { resourceId?: unknown; amount?: unknown; source?: unknown };
    if (typeof body.resourceId !== "string" || !isSellableResourceType(body.resourceId)) {
      return reply
        .code(400)
        .send(errBody("unknown-resource", `Unknown resource: ${String(body.resourceId)}`));
    }
    const parsed = SellRequestSchema.safeParse(body);
    if (!parsed.success) {
      if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount <= 0) {
        return reply.code(400).send(errBody("invalid-amount", "amount must be a positive integer"));
      }
      if (body.source !== "inv" && body.source !== "hold") {
        return reply.code(400).send(errBody("invalid-payload", "source must be 'inv' or 'hold'"));
      }
      return reply
        .code(400)
        .send(errBody("invalid-payload", "Body must be { resourceId, amount, source }"));
    }
    const { resourceId, amount, source } = parsed.data;

    // Look up the player's live connection (via the dep resolver)
    // and route through the shard-side `handleSell`. The REST path
    // is intentionally thin — the heavy lifting lives in
    // `shard/sell.ts` so the WS + REST paths share one source of
    // truth for the validation + math.
    const connId = deps.connIdForPlayer?.(profile.playerId) ?? null;
    if (connId === null) {
      return reply
        .code(409)
        .send(errBody("not-at-station", "Player has no active connection; cannot dock-sell"));
    }
    const shard = deps.shardFor(profile.playerId);
    if (!shard) {
      return reply
        .code(409)
        .send(errBody("not-at-station", "Player has no active shard; cannot dock-sell"));
    }

    // Run the shard-side handler. Errors are mapped to HTTP codes
    // by the same code → wire-code table the WS handler uses.
    const result = await handleSell(shard as never, deps.repo, {
      connId,
      resourceType: resourceId as ResourceId,
      amount,
      source,
    });

    if (!result.ok) {
      switch (result.code) {
        case "not-at-station":
          return reply.code(409).send(errBody("not-at-station", result.message));
        case "not-docked":
          return reply.code(409).send(errBody("not-docked", result.message));
        case "insufficient":
          return reply.code(422).send(errBody("insufficient", result.message));
        case "unknown-resource":
          return reply.code(400).send(errBody("unknown-resource", result.message));
        case "invalid-amount":
          return reply.code(400).send(errBody("invalid-amount", result.message));
        case "not-found":
          return reply.code(404).send(errBody("not-found", result.message));
        default:
          return reply
            .code(500)
            .send(errBody("internal", `Unhandled sale error: ${String(result.code)}`));
      }
    }

    return reply.code(200).send({
      sold: result.sold,
      earned: result.earned,
      newBalance: result.newBalance,
      resourceType: result.resourceType,
      source: result.source,
    });
  });
}
