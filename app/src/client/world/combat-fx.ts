import * as THREE from 'three';
import type { EntityState } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';
import { PERF_PROFILES, type FxCaps } from '@shared/perf';

/**
 * Combat FX (TASK-43 step 3): the client's purely cosmetic effect layer,
 * driven ONLY by server combat_events + snapshot projectiles (a denied
 * fire produces no event and therefore no FX — never by the local fire
 * intent). Lives scene-level (survives world swaps) and is cheap by
 * construction: a handful of additive lines/quads, one recycled tracer
 * pool (≤ 16), and a decaying camera nudge for the 2 px impact shake.
 *
 * - laser = a 60 ms additive line flash (nose → hit) + a muzzle spark;
 * - missile = a tracer mesh with a fading trail (≤ 8 points) per in-flight
 *   projectile, created/updated/removed from the 10 Hz snapshot batch;
 * - impact = a small expanding flash + a 2 px screen shake decaying 100 ms.
 */

/** Laser flash lifetime (spec: 60 ms line flash). */
export const LASER_FLASH_MS = 60;
/** Impact flash lifetime. */
export const IMPACT_FLASH_MS = 120;
/** Screen-shake decay (spec: 2 px nudge, decays 100 ms). */
export const SHAKE_DECAY_MS = 100;
/** Tracer pool cap (the server's 16-projectile shard budget). */
export const TRACER_CAP = 16;
/** Trail ribbon length (spec: ≤ 8 points). */
export const TRAIL_MAX = 8;
/** Explosion core flash lifetime (TASK-49 spec: a 1 s flash). */
export const EXPLOSION_FLASH_MS = 1000;
/** Shockwave quad lifetime (TASK-49 spec: expanding quad, 1 s). */
export const SHOCKWAVE_MS = 1000;
/** Debris fade lifetime (TASK-49 spec: 8 tumbling tetrahedrons, 3 s fade). */
export const DEBRIS_MS = 3000;
/** Debris count (TASK-49 spec: 8 tumbling tetrahedrons). */
export const DEBRIS_COUNT = 8;
/** Slow-mo window (TASK-49 spec: 1 s, client-only, cosmetic). */
export const SLOW_MO_MS = 1000;
/** Slow-mo timeScale (TASK-49 spec: 0.3 — prediction is unaffected). */
export const SLOW_MO_SCALE = 0.3;
/** Flash render order: on top of sky/planets/dome so glows are never occluded. */
export const FLASH_RENDER_ORDER = 20;
/** Muzzle-glow scale in dev slow-mo (screenshot) mode. */
export const SLOW_SPARK_SCALE = 6;

// ---------------------------------------------------------------------------
// TASK-58: the FX material pool + shared geometries. Pre-tuning, every flash
// ALLOCATED its own materials (and the debris their own tetrahedron
// geometries) and DISPOSED them on expiry — the allocation churn was a big
// slice of the worst combat frames. Now the per-type materials are recycled
// (a 60 ms laser flash lives ~3 frames; its material never leaves the pool)
// and the shape geometries are module-level singletons.
// ---------------------------------------------------------------------------

type FxMaterialType =
  | 'laserLine'
  | 'laserSpark'
  | 'impact'
  | 'core'
  | 'wave'
  | 'debrisA'
  | 'debrisB'
  | 'tracerBody'
  | 'tracerTrail';

/** The shared FX shape geometries (created once — never disposed). */
const FX_GEOMETRY = {
  spark: new THREE.SphereGeometry(1.2, 8, 8),
  impact: new THREE.SphereGeometry(1, 12, 12),
  core: new THREE.SphereGeometry(1, 16, 16),
  wave: new THREE.RingGeometry(0.7, 1, 32),
  debris: new THREE.TetrahedronGeometry(0.6),
  tracerBody: new THREE.ConeGeometry(0.35, 1.6, 6),
};

/** Fresh materials of each type (the factory the pool tops up from). */
const FX_MATERIAL_FACTORIES: Record<FxMaterialType, () => THREE.Material> = {
  laserLine: () =>
    new THREE.LineBasicMaterial({
      color: 0xff5040,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  laserSpark: () =>
    new THREE.MeshBasicMaterial({
      color: 0xffb060,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  impact: () =>
    new THREE.MeshBasicMaterial({
      color: 0xffa040,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  core: () =>
    new THREE.MeshBasicMaterial({
      color: 0xffd0a0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  wave: () =>
    new THREE.MeshBasicMaterial({
      color: 0xffb060,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  debrisA: () =>
    new THREE.MeshBasicMaterial({
      color: 0xff9040,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  debrisB: () =>
    new THREE.MeshBasicMaterial({
      color: 0x8a8f98,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  tracerBody: () => new THREE.MeshBasicMaterial({ color: 0xffc040 }),
  tracerTrail: () =>
    new THREE.LineBasicMaterial({
      color: 0x909090,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
};

/** One recycled material per live type (the pool). */
const fxMaterialPools = new Map<FxMaterialType, THREE.Material[]>();

/** Take a pooled material of a type (fresh allocation only when the pool is dry). */
function takeFxMaterial(type: FxMaterialType): THREE.Material {
  const pool = fxMaterialPools.get(type) ?? [];
  const m = pool.pop() ?? FX_MATERIAL_FACTORIES[type]();
  fxMaterialPools.set(type, pool);
  return m;
}

/** Return a material to its pool (never disposed while the app runs). */
function releaseFxMaterial(type: FxMaterialType, m: THREE.Material): void {
  let pool = fxMaterialPools.get(type);
  if (!pool) {
    pool = [];
    fxMaterialPools.set(type, pool);
  }
  pool.push(m);
}

interface Flash {
  obj: THREE.Object3D;
  born: number;
  life: number;
  /**
   * TASK-58 FX cap categories: 'laser' (one group = line + spark pair),
   * 'impact' (uncapped — the impact tail is tiny and always worth showing)
   * and 'explosion' (one group = the full debris SET: core + shockwave +
   * 8 tumbling pieces).
   */
  kind: 'laser' | 'impact' | 'explosion';
  /** Monotonic effect-group id (shared by the pieces of one shot/set). */
  groupId: number;
  update?: (age: number, obj: THREE.Object3D) => void;
  /** TASK-58: recycle this piece's pooled materials (shared geometries stay). */
  release?: (obj: THREE.Object3D) => void;
}

/**
 * The FX scene (a THREE.Group owned by the WorldManager's scene) + the
 * active effects. `attach` gives the class the scene + camera; `frame` is
 * called once per render frame to age effects and apply the shake nudge.
 */
export class CombatFx {
  private readonly group = new THREE.Group();
  private readonly attach: (scene: THREE.Object3D) => THREE.Camera;
  /** The scene camera (from `attach`) — the shockwave billboards toward it. */
  private boundCamera: THREE.Camera | null = null;
  private readonly flashes: Flash[] = [];
  private readonly tracers = new Map<string, Tracer>();
  /** TASK-58: monotonic effect-group counter (line+spark pair / debris set). */
  private nextGroup = 0;
  /**
   * TASK-58: the live FX caps (data in @shared/perf, re-applied by the
   * SettingsBridge on a preset switch). Oldest group beyond the cap is
   * expired immediately — the caps hold even under fire spam.
   */
  private caps: FxCaps = { ...PERF_PROFILES.high.fxCaps };
  /** Dev-only (import.meta.env.DEV): stretch flash lifetimes for screenshots. */
  slow = false;
  /**
   * TASK-59: missile trail ribbons (profile data — true for every desktop
   * preset, false for the mobile floor: a tracer then renders as a SINGLE
   * DOT, the body cone only, no trail line). Applied at world load.
   */
  private trailEnabled = true;
  private shakeMag = 0;
  private shakeUntil = 0;
  /** TASK-49: a VIRTUAL fx clock (ms) that ages effects. It advances at
   * `dt * timeScale` per frame, so a slow-mo window stretches every flash /
   * shockwave / debris without touching prediction (which runs on real time). */
  private fxTime = 0;
  private lastFrameNow = -1;
  /** Real-time end of the active slow-mo window (performance.now ms). */
  private slowMoUntil = 0;

  /** The FX timeScale for the current frame (0.3 during slow-mo, else 1). */
  get timeScale(): number {
    return performance.now() < this.slowMoUntil ? SLOW_MO_SCALE : 1;
  }

  /** Arm the 1 s client-only slow-mo (cosmetic — prediction keeps real time). */
  armSlowMo(): void {
    this.slowMoUntil = performance.now() + SLOW_MO_MS;
  }

  constructor(attach: (scene: THREE.Object3D) => THREE.Camera) {
    this.attach = attach;
    this.boundCamera = this.attach(this.group);
  }

  /** True while any flash/tracer is live (dev probe / e2e assertions). */
  get activeCount(): number {
    return this.flashes.length + this.tracers.size;
  }

  /** Re-apply the caps of another preset (SettingsBridge — no re-init). */
  setFxCaps(caps: FxCaps): void {
    this.caps = { ...caps };
  }

  /** The caps of the current profile (unit tests / dev probe). */
  getFxCaps(): FxCaps {
    return { ...this.caps };
  }

  /**
   * TASK-59: enable/disable the missile trail ribbons (the mobile floor
   * passes false — the tracer is a single dot). Affects NEW tracers
   * immediately and toggles every live trail the same call (no re-init).
   */
  setMissileTrails(enabled: boolean): void {
    this.trailEnabled = enabled;
    for (const t of this.tracers.values()) t.trail.visible = enabled;
  }

  /** True while missile trail ribbons are on (unit tests / dev probe). */
  get missileTrails(): boolean {
    return this.trailEnabled;
  }

  /** Active laser SHOTS (distinct shot groups — the line+spark is one). */
  get laserFlashCount(): number {
    return new Set(this.flashes.filter((f) => f.kind === 'laser').map((f) => f.groupId)).size;
  }

  /** Active explosion debris SETS (distinct set groups). */
  get debrisSetCount(): number {
    return new Set(this.flashes.filter((f) => f.kind === 'explosion').map((f) => f.groupId)).size;
  }

  /**
   * Expire the oldest group beyond a kind's cap (TASK-58: the registry
   * enforces, oldest expires). `kind` is 'laser' or 'explosion'.
   */
  private enforceCap(kind: 'laser' | 'explosion', cap: number): void {
    const byBorn = this.flashes
      .filter((f) => f.kind === kind)
      .sort((a, b) => a.born - b.born || a.groupId - b.groupId);
    const groups = new Map<number, number>(); // groupId → oldest-born index
    byBorn.forEach((f, i) => {
      if (!groups.has(f.groupId)) groups.set(f.groupId, i);
    });
    if (groups.size <= cap) return;
    const oldest = [...groups.entries()].sort((a, b) => a[1] - b[1])[0][0];
    this.removeGroup(oldest);
  }

  /** Remove every flash piece of one effect group + recycle its materials. */
  private removeGroup(groupId: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      if (f.groupId !== groupId) continue;
      this.group.remove(f.obj);
      f.release?.(f.obj);
      this.flashes.splice(i, 1);
    }
  }

  /** The current flash lifetimes (e2e screenshots want to know the window). */
  get laserFlashMs(): number {
    return this.slow ? 500 : LASER_FLASH_MS;
  }

  /** The stretched-lifetime switch (e2e: `documentElement.dataset.fxSlow`). */
  private stretched(): boolean {
    // `typeof` guard (not `?.`): `document` is UNDECLARED in Node bench runs.
    if (this.slow) return true;
    return typeof document !== 'undefined' && document.documentElement?.dataset?.fxSlow === '1';
  }

  /** One laser shot: additive line nose→to (60 ms) + a muzzle spark. */
  addLaserFlash(from: Vec3, to: Vec3): void {
    // TASK-58 cap (oldest expires): enforce BEFORE pushing this shot.
    this.enforceCap('laser', this.caps.laserFlashes);
    const groupId = this.nextGroup++;
    const now = this.fxTime;
    const slow = this.stretched();
    const life = slow ? 500 : LASER_FLASH_MS;
    // In the dev slow-mo (screenshot) mode the flash HOLDS full opacity for
    // most of the stretched window and only fades over its last 25 %: the
    // e2e capture lands ~200-400 ms after the event, which a whole-window
    // linear fade would already have dimmed to nothing.
    const fade = (age: number) => (slow ? Math.max(0, 1 - (age - 0.75) / 0.25) : 1 - age);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    // The flash is a GLOW, not world geometry: render it on top (no depth
    // test) so a beam fired toward a planet/star is never occluded into
    // invisibility (the e2e screenshots the flash from the far orbit view).
    const lineMaterial = takeFxMaterial('laserLine') as THREE.LineBasicMaterial;
    const line = new THREE.Line(lineGeo, lineMaterial);
    line.renderOrder = FLASH_RENDER_ORDER;
    const sparkMaterial = takeFxMaterial('laserSpark') as THREE.MeshBasicMaterial;
    const spark = new THREE.Mesh(FX_GEOMETRY.spark, sparkMaterial);
    spark.renderOrder = FLASH_RENDER_ORDER;
    spark.position.set(from.x, from.y, from.z);
    // In the dev slow-mo (screenshot) mode the muzzle glow is scaled up so a
    // single frame clearly shows the flash from the far orbit vantage.
    if (slow) spark.scale.setScalar(SLOW_SPARK_SCALE);
    this.group.add(line, spark);
    this.flashes.push({
      obj: line,
      born: now,
      life,
      kind: 'laser',
      groupId,
      release: (obj) => {
        // Only the beam geometry is unique per shot — dispose it; the
        // material goes back to the pool.
        (obj as THREE.Line).geometry.dispose();
        releaseFxMaterial('laserLine', (obj as THREE.Line).material as THREE.Material);
      },
      update: (age, obj) => {
        const m = (obj as THREE.Line).material as THREE.LineBasicMaterial;
        m.opacity = fade(age);
        const s = spark.material as THREE.MeshBasicMaterial;
        s.opacity = slow ? fade(age) : Math.max(0, 1 - age * 1.5);
      },
    });
    this.flashes.push({
      obj: spark,
      born: now,
      life: life * 0.8,
      kind: 'laser',
      groupId,
      release: () => releaseFxMaterial('laserSpark', sparkMaterial),
    });
  }

  /** One impact: a small expanding flash at `point` (additive, ~120 ms). */
  addImpactFlash(point: Vec3): void {
    const now = this.fxTime;
    const material = takeFxMaterial('impact');
    const flash = new THREE.Mesh(FX_GEOMETRY.impact, material);
    flash.renderOrder = FLASH_RENDER_ORDER;
    flash.position.set(point.x, point.y, point.z);
    this.group.add(flash);
    const life = this.stretched() ? 400 : IMPACT_FLASH_MS;
    this.flashes.push({
      obj: flash,
      born: now,
      life,
      kind: 'impact',
      groupId: this.nextGroup++,
      release: () => releaseFxMaterial('impact', material),
      update: (age, obj) => {
        obj.scale.setScalar(1 + age * 6);
        ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - age;
      },
    });
  }

  /**
   * One ship destruction (TASK-49): the 1 s flash + expanding shockwave quad
   * + 8 tumbling tetrahedrons (3 s fade). The 1 s client-only slow-mo is
   * armed (cosmetic — prediction keeps running at real time). All pieces are
   * additive glows that ignore depth (never occluded into invisibility).
   */
  addExplosion(point: Vec3): void {
    this.armSlowMo();
    // TASK-58 cap (oldest SET expires): enforce BEFORE adding this set.
    this.enforceCap('explosion', this.caps.debrisSets);
    const groupId = this.nextGroup++;
    const slow = this.stretched();
    const now = this.fxTime;
    const p = new THREE.Vector3(point.x, point.y, point.z);

    // (1) The 1 s core flash: a hot sphere that expands + fades.
    const coreMaterial = takeFxMaterial('core');
    const core = new THREE.Mesh(FX_GEOMETRY.core, coreMaterial);
    core.renderOrder = FLASH_RENDER_ORDER;
    core.position.copy(p);
    this.group.add(core);
    this.flashes.push({
      obj: core,
      born: now,
      life: slow ? 2000 : EXPLOSION_FLASH_MS,
      kind: 'explosion',
      groupId,
      release: () => releaseFxMaterial('core', coreMaterial),
      update: (age, obj) => {
        obj.scale.setScalar(1 + age * 8);
        ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - age;
      },
    });

    // (2) The shockwave: an expanding flat quad (ring) at the impact plane.
    const waveMaterial = takeFxMaterial('wave');
    const wave = new THREE.Mesh(FX_GEOMETRY.wave, waveMaterial);
    wave.renderOrder = FLASH_RENDER_ORDER;
    wave.position.copy(p);
    // Face the wave toward the camera (billboard) so it reads as a shockwave
    // from any vantage. The camera is known via attach at frame time.
    this.group.add(wave);
    this.flashes.push({
      obj: wave,
      born: now,
      life: slow ? 2000 : SHOCKWAVE_MS,
      kind: 'explosion',
      groupId,
      release: () => releaseFxMaterial('wave', waveMaterial),
      update: (age, obj) => {
        const w = obj as THREE.Mesh;
        w.scale.setScalar(1 + age * 30);
        const cam = this.boundCamera;
        if (cam) w.lookAt(cam.position);
        (w.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - age);
      },
    });

    // (3) 8 tumbling tetrahedrons: debris that fly out + fade over 3 s.
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const type: FxMaterialType = i % 2 === 0 ? 'debrisA' : 'debrisB';
      const debrisMaterial = takeFxMaterial(type);
      const debris = new THREE.Mesh(FX_GEOMETRY.debris, debrisMaterial);
      debris.renderOrder = FLASH_RENDER_ORDER;
      debris.position.copy(p);
      this.group.add(debris);
      // A per-debris tumble + outward velocity (deterministic by index).
      const dir = new THREE.Vector3(
        Math.cos((i / DEBRIS_COUNT) * Math.PI * 2),
        0.4 + (i % 3) * 0.3,
        Math.sin((i / DEBRIS_COUNT) * Math.PI * 2),
      ).normalize();
      const spin = new THREE.Vector3(i + 1, ((i * 7) % 5) + 1, ((i * 3) % 7) + 1).multiplyScalar(
        0.02,
      );
      this.flashes.push({
        obj: debris,
        born: now,
        life: slow ? 6000 : DEBRIS_MS,
        kind: 'explosion',
        groupId,
        release: () => releaseFxMaterial(type, debrisMaterial),
        update: (age, obj) => {
          const d = obj as THREE.Mesh;
          d.position.copy(p).addScaledVector(dir, age * 18);
          d.quaternion.setFromEuler(
            new THREE.Euler(spin.x * age * 60, spin.y * age * 60, spin.z * age * 60),
          );
          d.scale.setScalar(Math.max(0.05, 1 - age * 0.5));
          (d.material as THREE.MeshBasicMaterial).opacity = 1 - age;
        },
      });
    }
  }

  /** Screen shake: a `px`-pixel camera nudge decaying over 100 ms. */
  screenShake(px: number): void {
    this.shakeMag = Math.max(this.shakeMag, px);
    this.shakeUntil = performance.now() + SHAKE_DECAY_MS;
  }

  /**
   * Tracers from a snapshot batch: create a new tracer per unknown
   * projectile id (pool capped — the OLDEST is recycled), advance the
   * trail, and remove ids that left the batch (impact/expiry).
   */
  updateProjectiles(entities: EntityState[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      if (e.kind !== 'projectile') continue;
      seen.add(e.id);
      let t = this.tracers.get(e.id);
      if (!t) {
        // TASK-58: the cap is live data (default = the shard's 16 budget).
        if (this.tracers.size >= this.caps.missiles) {
          // Recycle the oldest (insertion order in the Map).
          const oldest = this.tracers.keys().next().value as string;
          this.removeTracer(oldest);
        }
        t = this.makeTracer();
        this.tracers.set(e.id, t);
      }
      t.update(e.pos, e.vel);
    }
    for (const id of [...this.tracers.keys()]) {
      if (!seen.has(id)) this.removeTracer(id);
    }
  }

  private makeTracer(): Tracer {
    const body = new THREE.Mesh(FX_GEOMETRY.tracerBody, takeFxMaterial('tracerBody'));
    // The cone points +Y by default; the tracer faces its velocity — pivot.
    const pivot = new THREE.Group();
    body.rotation.x = Math.PI / 2;
    pivot.add(body);
    const trailGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: TRAIL_MAX }, () => new THREE.Vector3()),
    );
    const trail = new THREE.Line(trailGeo, takeFxMaterial('tracerTrail'));
    // TASK-59 mobile floor: with trails off the trail line stays hidden —
    // the tracer renders as its single body dot only.
    trail.visible = this.trailEnabled;
    this.group.add(pivot, trail);
    return new Tracer(pivot, trail, body);
  }

  private removeTracer(id: string): void {
    const t = this.tracers.get(id);
    if (!t) return;
    this.tracers.delete(id);
    this.group.remove(t.pivot, t.trail);
    t.dispose();
  }

  /** Age the flashes, cull the dead, apply the decaying shake nudge. */
  frame(nowMs: number): THREE.Vector3 {
    // Advance the virtual fx clock at the current timeScale: a slow-mo window
    // stretches every effect's lifetime cosmetically (prediction is separate).
    if (this.lastFrameNow < 0) this.lastFrameNow = nowMs;
    this.fxTime += (nowMs - this.lastFrameNow) * this.timeScale;
    this.lastFrameNow = nowMs;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const age = (this.fxTime - f.born) / f.life;
      if (age >= 1) {
        this.group.remove(f.obj);
        f.release?.(f.obj);
        this.flashes.splice(i, 1);
        continue;
      }
      f.update?.(age, f.obj);
    }
    // Shake: a small random nudge scaled by the remaining fraction.
    const off = new THREE.Vector3();
    const remain = this.shakeUntil - nowMs;
    if (remain > 0) {
      const k = (this.shakeMag * remain) / SHAKE_DECAY_MS;
      off.set((Math.random() - 0.5) * 2 * k, (Math.random() - 0.5) * 2 * k, 0);
    } else {
      this.shakeMag = 0;
    }
    return off;
  }
}

/** One missile tracer: the pivot mesh + its fading trail ribbon. */
class Tracer {
  private readonly trailPts: THREE.Vector3[] = [];
  constructor(
    readonly pivot: THREE.Group,
    readonly trail: THREE.Line,
    private readonly body: THREE.Mesh,
  ) {}

  update(pos: Vec3, vel: Vec3): void {
    this.pivot.position.set(pos.x, pos.y, pos.z);
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed > 0.001) {
      // Face the velocity: lookAt points +Z at the target (the cone is
      // pre-rotated +X→+Y so its tip leads along +Z).
      this.pivot.lookAt(new THREE.Vector3(pos.x + vel.x, pos.y + vel.y, pos.z + vel.z));
    }
    // TASK-59 mobile floor: no per-frame trail work when ribbons are off
    // (the geometry stays stale — it is invisible and re-used on re-enable).
    if (!this.trail.visible) return;
    this.trailPts.unshift(new THREE.Vector3(pos.x, pos.y, pos.z));
    if (this.trailPts.length > TRAIL_MAX) this.trailPts.pop();
    const geo = this.trail.geometry;
    geo.setFromPoints(this.trailPts);
    geo.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    // Only the trail ribbon is unique per projectile. The cone geometry and
    // both materials are shared/pooled (TASK-58) — never disposed.
    this.trail.geometry.dispose();
    releaseFxMaterial('tracerTrail', this.trail.material as THREE.Material);
    releaseFxMaterial('tracerBody', this.body.material as THREE.Material);
  }
}
