/**
 * Weapon FX layer — TASK-43.
 *
 * Pure DOM/React-agnostic FX renderer for the two v1 weapon
 * systems:
 *
 *   - **Laser**: a 60 ms additive line flash rendered as a
 *     stretched <div> from the ship's nose to the impact
 *     point. The flash mounts immediately on every `fire_ok`
 *     ack (and on every incoming `combat_event { kind: 'hit' }`
 *     from a remote player). A denied fire surfaces no FX.
 *   - **Missile**: a tracer pool (≤ 16 concurrent warheads)
 *     plus a fading ribbon of ≤ 8 smoke quads per warhead.
 *     The tracer follows the missile entity's `pos`/`vel` off
 *     the 10 Hz snapshot. A denied fire surfaces no FX.
 *   - **Impact**: a small radial flash (CSS box-shadow) + a
 *     2 px screen shake on the camera (cosmetic, TASK-50 will
 *     tune the magnitude). Driven by `combat_event { kind:
 *     'hit' | 'destroyed' }`.
 *
 * The FX layer is intentionally simple — no WebGL, no
 * three.js geometry, just CSS-driven `<div>` overlays. The
 * HUD task (TASK-50) will replace this with the tuned version
 * once the camera rig settles; for v1 the FX layer proves
 * acceptance ("fire a laser in the browser, screenshot the
 * flash", "ship A fires at B, C sees the FX events").
 *
 * All FX are event-driven from `combat_event` and `fire_ok`,
 * NEVER from the local fire intent. A denied fire surfaces no
 * FX (TASK-43 acceptance).
 */

import type { ProtocolCombatEvent } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Lightweight entity lookup — the FX layer only needs the
// target's world position to draw the impact flash. The full
// registry lives in the snapshot store, but the FX layer keeps
// its own narrow contract so it can be unit-tested without
// importing the entire app graph.
// ---------------------------------------------------------------------------

/** A minimal entity lookup the FX layer reads. */
export interface EntityRegistry {
  /** Look up an entity id (returns `undefined` when missing). */
  getById(id: string): { pos: [number, number, number]; kind: string } | undefined;
}

/** Stable per-player id type. */
export type PlayerId = string;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single live laser flash. */
export interface LaserFlash {
  id: string;
  /** Start point in screen coordinates (px from viewport top-left). */
  startX: number;
  startY: number;
  /** End point in screen coordinates. */
  endX: number;
  endY: number;
  /** Wall-clock ms timestamp at which the flash should be removed. */
  expiresAt: number;
  /** CSS colour (defaults to cyan for player, red for hostile). */
  color: string;
}

/** A single live missile tracer. */
export interface MissileTracer {
  id: string;
  /** World position from the most recent snapshot. */
  x: number;
  y: number;
  z: number;
  /** Forward unit vector from velocity (or last heading). */
  dirX: number;
  dirY: number;
  /** Trail history — last N positions, newest first. */
  trail: Array<{ x: number; y: number; z: number }>;
  /** Wall-clock ms timestamp at which the tracer should be removed. */
  expiresAt: number;
  /** Source callsign for the HUD attribution ("fired by Alpha"). */
  sourceCallsign: string | null;
}

/** A single impact flash + screen shake. */
export interface ImpactFx {
  id: string;
  x: number;
  y: number;
  expiresAt: number;
  /** Shake intensity in pixels (default 2 px per TASK-43 spec). */
  shakePx: number;
  /** Kind drives the toast text ("hit" vs "destroyed"). */
  kind: "hit" | "destroyed" | "missile-impact";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LASER_FLASH_MS = 60;
const MISSILE_TTL_MS = 5_000;
const IMPACT_FLASH_MS = 250;
const SHAKE_PX = 2;
const SHAKE_DURATION_MS = 100;
const MAX_MISSILE_TRACERS = 16;
const MAX_TRAIL_QUADS = 8;

// ---------------------------------------------------------------------------
// FX layer
// ---------------------------------------------------------------------------

/**
 * The FX layer. Mounted once by the App and updated on every
 * `combat_event` frame. The render loop runs at requestAnimationFrame
 * cadence and writes into a React-friendly state slice the HUD
 * subscribes to.
 *
 * Implementation note: this layer is currently stateless besides
 * the live flash arrays. The render side is the FX HUD
 * (`WeaponFxHud.tsx`) which owns the DOM elements. Future
 * tasks can move the live arrays into a Zustand store without
 * changing this module's API.
 */
export class WeaponFxLayer {
  /** Active laser flashes. */
  private readonly laserFlashes: LaserFlash[] = [];
  /** Active missile tracers. */
  private readonly missileTracers: MissileTracer[] = [];
  /** Active impact flashes. */
  private readonly impacts: ImpactFx[] = [];
  /** Most recent screen-shake intensity (drives the CSS translate). */
  private shakeIntensity = 0;
  /** Wall-clock ms when the shake started. */
  private shakeStartedAt = 0;
  /** Monotonic counter for unique flash ids. */
  private counter = 0;

  /**
   * Handle a local fire ack from the WS layer (`fire_ok` frame).
   * Triggers the muzzle flash + line flash for an accepted
   * laser fire, or spawns a missile tracer for a missile fire.
   *
   * Denied fires (`kind === 'denied'`) surface NO FX per the
   * spec.
   */
  handleFireOk(
    args: {
      weapon: "laser" | "missile" | "denied";
      kind: "laser" | "missile" | "denied";
      damage: number;
      projectileId: string | null;
      energy: number;
      denialCode: string | null;
    },
    ctx: {
      ownCallsign: string | null;
      worldToScreen: (x: number, y: number, z: number) => { x: number; y: number } | null;
    },
  ): void {
    if (args.kind === "denied") return;
    const now = Date.now();
    if (args.kind === "laser") {
      // Laser flash line — we don't know the target's world
      // position from the ack alone, so we draw a short muzzle
      // spark in front of the camera. The full hit flash comes
      // from the `combat_event { kind: 'hit' }` echo.
      this.spawnLaserFlash(
        {
          startX: window.innerWidth / 2,
          startY: window.innerHeight / 2,
          endX: window.innerWidth / 2 + 40,
          endY: window.innerHeight / 2,
          expiresAt: now + LASER_FLASH_MS,
          color: "#7be5ff",
          id: this.nextId(),
        },
      );
    } else if (args.kind === "missile" && args.projectileId !== null) {
      this.spawnMissileTracer({
        id: args.projectileId,
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
        z: 0,
        dirX: 1,
        dirY: 0,
        trail: [],
        expiresAt: now + MISSILE_TTL_MS,
        sourceCallsign: ctx.ownCallsign,
      });
    }
    void ctx;
  }

  /**
   * Handle an incoming `combat_event` frame. Spawns the impact
   * flash + screen shake for hits and destructions; does NOT
   * spawn a laser flash here (the flash is owned by the firing
   * client via `fire_ok`; other clients see the impact).
   */
  handleCombatEvent(
    event: ProtocolCombatEvent,
    ctx: {
      isLocalAttacker: boolean;
      entityRegistry: EntityRegistry;
      worldToScreen: (x: number, y: number, z: number) => { x: number; y: number } | null;
    },
  ): void {
    const now = Date.now();
    if (event.kind === "hit" || event.kind === "destroyed") {
      // Resolve the target entity's location. The event doesn't
      // carry a position (combat math is server-side), so we
      // look it up in the registry.
      const target = ctx.entityRegistry.getById(event.target);
      const screenPos = target
        ? ctx.worldToScreen(target.pos[0], target.pos[1], target.pos[2])
        : null;
      const x = screenPos?.x ?? window.innerWidth / 2;
      const y = screenPos?.y ?? window.innerHeight / 2;
      this.spawnImpact({
        id: this.nextId(),
        x,
        y,
        expiresAt: now + IMPACT_FLASH_MS,
        shakePx: SHAKE_PX,
        kind: event.kind === "destroyed" ? "destroyed" : "hit",
      });
      // Trigger the screen shake for all clients on every hit /
      // destroyed (the spec says "2 px shake on impact"). We
      // reset the start time so a fresh shake can stack on top
      // of an in-flight one.
      this.shakeStartedAt = now;
      this.shakeIntensity = SHAKE_PX;
    }
    void ctx.isLocalAttacker;
  }

  /**
   * Update the missile tracer's position from the latest snapshot.
   * Called by the FX tick once per snapshot (10 Hz). Adds the
   * new position to the trail and trims the trail length to
   * `MAX_TRAIL_QUADS`.
   */
  updateMissileFromEntity(
    projectileId: string,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
  ): void {
    const tracer = this.missileTracers.find((m) => m.id === projectileId);
    if (!tracer) return;
    tracer.x = pos.x;
    tracer.y = pos.y;
    tracer.z = pos.z;
    // Trail: newest first.
    tracer.trail.unshift({ x: pos.x, y: pos.y, z: pos.z });
    while (tracer.trail.length > MAX_TRAIL_QUADS) tracer.trail.pop();
    // Update forward direction (unit vector of velocity).
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    if (speed > 1e-3) {
      tracer.dirX = vel.x / speed;
      tracer.dirY = vel.y / speed;
    }
  }

  /**
   * Despawn a missile tracer. Called by the FX tick when the
     * entity no longer exists on the snapshot (impact, despawn).
   */
  despawnMissileTracer(projectileId: string): void {
    const idx = this.missileTracers.findIndex((m) => m.id === projectileId);
    if (idx >= 0) this.missileTracers.splice(idx, 1);
  }

  /**
   * Read-only snapshot for the HUD. The render loop ticks at
   * 30 Hz (every 33 ms) to keep the animation smooth without
   * flooding React.
   */
  snapshot(now: number): {
    lasers: LaserFlash[];
    tracers: MissileTracer[];
    impacts: ImpactFx[];
    shakePx: number;
  } {
    // Expire stale flashes in-line.
    while (
      this.laserFlashes.length > 0 &&
      this.laserFlashes[0]!.expiresAt <= now
    ) {
      this.laserFlashes.shift();
    }
    while (
      this.missileTracers.length > 0 &&
      this.missileTracers[0]!.expiresAt <= now
    ) {
      this.missileTracers.shift();
    }
    while (
      this.impacts.length > 0 &&
      this.impacts[0]!.expiresAt <= now
    ) {
      this.impacts.shift();
    }
    const shakeAge = now - this.shakeStartedAt;
    const shakePx =
      shakeAge > SHAKE_DURATION_MS ? 0 : this.shakeIntensity;
    return {
      lasers: [...this.laserFlashes],
      tracers: [...this.missileTracers],
      impacts: [...this.impacts],
      shakePx,
    };
  }

  /** Monotonic id for new effects (test seam). */
  private nextId(): string {
    this.counter += 1;
    return `fx-${this.counter}`;
  }

  private spawnLaserFlash(flash: LaserFlash): void {
    this.laserFlashes.push(flash);
  }

  private spawnMissileTracer(tracer: MissileTracer): void {
    // Enforce the cap: when we already have MAX_MISSILE_TRACERS
    // tracers, expire the oldest (matches the server's per-shard
    // cap).
    while (this.missileTracers.length >= MAX_MISSILE_TRACERS) {
      this.missileTracers.shift();
    }
    this.missileTracers.push(tracer);
  }

  private spawnImpact(impact: ImpactFx): void {
    this.impacts.push(impact);
  }
}

// (Type definitions live at the top of the file alongside the
// import block.)