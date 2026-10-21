/**
 * Per-player settings endpoints — TASK-55.
 *
 *   GET /api/players/settings
 *     header: Authorization: Bearer <token>
 *     200:  { settings: { quality, sensitivity, reducedMotion } }
 *     401:  { code: "unauthenticated", message }
 *
 *   PUT /api/players/settings
 *     header: Authorization: Bearer <token>
 *     body:  { quality, sensitivity, reducedMotion }   (any subset)
 *     200:  { settings: <stored record> }              (post-clamp)
 *     400:  { code: "invalid-settings", message }      (bad preset / non-numeric)
 *     401:  { code: "unauthenticated", message }
 *
 * Validation is zod-driven ({@link SettingsSchema}): an unknown
 * quality preset is a **400** (a contract violation), while an
 * out-of-range sensitivity is **clamped** into `[0.5, 2.0]` — the
 * spec asks for a clamped slider, not a rejected request. The
 * response echoes the *stored* record so the client never has to
 * re-derive what the server accepted.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Repository } from "../db/repo.js";
import { loadSessionProfile } from "../auth/resolver.js";
import {
  clampSensitivity,
  DEFAULT_SETTINGS,
  DEVICE_PROFILE_IDS,
  QUALITY_PRESET_IDS,
  type DeviceProfile,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";

/** Public deps shared by tests and the live server. */
export interface SettingsDeps {
  repo: Repository;
  sessionSecret: string;
  /** Override the wall clock for tests (epoch ms). */
  nowMs?: number;
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
 * Merge an incoming (partial) body onto the player's current record.
 *
 * Throws `InvalidSettingsError` when a field is present but of the
 * wrong type / an unknown preset. Absent fields keep the stored
 * value, so the slider can `PUT` just `{sensitivity}`.
 */
export class InvalidSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSettingsError";
  }
}

function mergeSettings(current: Settings, body: unknown): Settings {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidSettingsError("Body must be a settings object");
  }
  const raw = body as Record<string, unknown>;
  // The shared record is readonly; the merge works on a mutable local.
  const next = { ...current };

  if (raw.quality !== undefined) {
    if (
      typeof raw.quality !== "string" ||
      !QUALITY_PRESET_IDS.includes(raw.quality as QualityPreset)
    ) {
      throw new InvalidSettingsError(
        `quality must be one of ${QUALITY_PRESET_IDS.join(", ")}, got ${JSON.stringify(raw.quality)}`,
      );
    }
    next.quality = raw.quality as QualityPreset;
  }

  if (raw.sensitivity !== undefined) {
    const n = typeof raw.sensitivity === "number" ? raw.sensitivity : Number(raw.sensitivity);
    if (!Number.isFinite(n)) {
      throw new InvalidSettingsError("sensitivity must be a finite number");
    }
    // Out-of-range is clamped, not rejected (spec: "out-of-range
    // sensitivity clamped").
    next.sensitivity = clampSensitivity(n);
  }

  if (raw.reducedMotion !== undefined) {
    if (typeof raw.reducedMotion !== "boolean") {
      throw new InvalidSettingsError("reducedMotion must be a boolean");
    }
    next.reducedMotion = raw.reducedMotion;
  }

  // TASK-59: the device-profile override. An unknown value is a 400
  // (same contract as the quality preset) rather than a silent
  // fall-back to `auto`.
  if (raw.deviceProfile !== undefined) {
    if (
      typeof raw.deviceProfile !== "string" ||
      !DEVICE_PROFILE_IDS.includes(raw.deviceProfile as DeviceProfile)
    ) {
      throw new InvalidSettingsError(
        `deviceProfile must be one of ${DEVICE_PROFILE_IDS.join(", ")}, got ${JSON.stringify(raw.deviceProfile)}`,
      );
    }
    next.deviceProfile = raw.deviceProfile as DeviceProfile;
  }

  return next;
}

/**
 * Register `GET`/`PUT /api/players/settings` on the Fastify app.
 * `buildApp()` is the only intended production caller.
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  /** Resolve the caller's player id, or reply 401 and return null. */
  const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const token = readBearer(req);
    if (token === null) {
      void reply.code(401).send(errBody("unauthenticated", "Missing bearer token"));
      return null;
    }
    const profile = await loadSessionProfile(deps.repo, deps.sessionSecret, token, {
      nowMs: deps.nowMs,
    });
    if (profile === null) {
      void reply.code(401).send(errBody("unauthenticated", "Token invalid or expired"));
      return null;
    }
    return profile.playerId;
  };

  app.get("/api/players/settings", async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = await authenticate(req, reply);
    if (playerId === null) return reply;
    const settings = await deps.repo.getSettings(playerId);
    return reply.code(200).send({ settings });
  });

  app.put("/api/players/settings", async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = await authenticate(req, reply);
    if (playerId === null) return reply;
    try {
      const current = await deps.repo.getSettings(playerId);
      const next = mergeSettings(current, req.body ?? {});
      const stored = await deps.repo.saveSettings(playerId, next);
      return reply.code(200).send({ settings: stored });
    } catch (err) {
      if (err instanceof InvalidSettingsError) {
        return reply.code(400).send(errBody("invalid-settings", err.message));
      }
      throw err;
    }
  });
}

/** Re-exported for tests that assert the default record identity. */
export { DEFAULT_SETTINGS };
