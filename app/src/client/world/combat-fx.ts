import * as THREE from 'three';
import type { EntityState } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';

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
/** Flash render order: on top of sky/planets/dome so glows are never occluded. */
export const FLASH_RENDER_ORDER = 20;
/** Muzzle-glow scale in dev slow-mo (screenshot) mode. */
export const SLOW_SPARK_SCALE = 6;

interface Flash {
  obj: THREE.Object3D;
  born: number;
  life: number;
  update?: (age: number, obj: THREE.Object3D) => void;
}

/**
 * The FX scene (a THREE.Group owned by the WorldManager's scene) + the
 * active effects. `attach` gives the class the scene + camera; `frame` is
 * called once per render frame to age effects and apply the shake nudge.
 */
export class CombatFx {
  private readonly group = new THREE.Group();
  private readonly attach: (scene: THREE.Object3D) => THREE.Camera;
  private readonly flashes: Flash[] = [];
  private readonly tracers = new Map<string, Tracer>();
  /** Dev-only (import.meta.env.DEV): stretch flash lifetimes for screenshots. */
  slow = false;
  private shakeMag = 0;
  private shakeUntil = 0;

  constructor(attach: (scene: THREE.Object3D) => THREE.Camera) {
    this.attach = attach;
    this.attach(this.group);
  }

  /** True while any flash/tracer is live (dev probe / e2e assertions). */
  get activeCount(): number {
    return this.flashes.length + this.tracers.size;
  }

  /** The current flash lifetimes (e2e screenshots want to know the window). */
  get laserFlashMs(): number {
    return this.slow ? 500 : LASER_FLASH_MS;
  }

  /** The stretched-lifetime switch (e2e: `document.body.dataset.fxSlow`). */
  private stretched(): boolean {
    return this.slow || document?.documentElement?.dataset.fxSlow === '1';
  }

  /** One laser shot: additive line nose→to (60 ms) + a muzzle spark. */
  addLaserFlash(from: Vec3, to: Vec3): void {
    const now = performance.now();
    const life = this.stretched() ? 500 : LASER_FLASH_MS;
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    // The flash is a GLOW, not world geometry: render it on top (no depth
    // test) so a beam fired toward a planet/star is never occluded into
    // invisibility (the e2e screenshots the flash from the far orbit view).
    const line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: 0xff5040,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        renderOrder: FLASH_RENDER_ORDER,
      }),
    );
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 8, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffb060,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        renderOrder: FLASH_RENDER_ORDER,
      }),
    );
    spark.position.set(from.x, from.y, from.z);
    // In the dev slow-mo (screenshot) mode the muzzle glow is scaled up so a
    // single frame clearly shows the flash from the far orbit vantage.
    if (this.stretched()) spark.scale.setScalar(SLOW_SPARK_SCALE);
    this.group.add(line, spark);
    this.flashes.push({
      obj: line,
      born: now,
      life,
      update: (age, obj) => {
        const m = (obj as THREE.Line).material as THREE.LineBasicMaterial;
        m.opacity = 1 - age;
        const s = (spark.material as THREE.MeshBasicMaterial);
        s.opacity = Math.max(0, 1 - age * 1.5);
      },
    });
    this.flashes.push({ obj: spark, born: now, life: life * 0.8 });
  }

  /** One impact: a small expanding flash at `point` (additive, ~120 ms). */
  addImpactFlash(point: Vec3): void {
    const now = performance.now();
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffa040,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        renderOrder: FLASH_RENDER_ORDER,
      }),
    );
    flash.position.set(point.x, point.y, point.z);
    this.group.add(flash);
    const life = this.stretched() ? 400 : IMPACT_FLASH_MS;
    this.flashes.push({
      obj: flash,
      born: now,
      life,
      update: (age, obj) => {
        obj.scale.setScalar(1 + age * 6);
        ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - age;
      },
    });
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
        if (this.tracers.size >= TRACER_CAP) {
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
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffc040 }),
    );
    // The cone points +Y by default; the tracer faces its velocity — pivot.
    const pivot = new THREE.Group();
    body.rotation.x = Math.PI / 2;
    pivot.add(body);
    const trailGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: TRAIL_MAX }, () => new THREE.Vector3()),
    );
    const trail = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({
        color: 0x909090,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
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
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const age = (nowMs - f.born) / f.life;
      if (age >= 1) {
        this.group.remove(f.obj);
        f.obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            const m = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else m.dispose();
          }
        });
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
      this.pivot.lookAt(
        new THREE.Vector3(pos.x + vel.x, pos.y + vel.y, pos.z + vel.z),
      );
    }
    this.trailPts.unshift(new THREE.Vector3(pos.x, pos.y, pos.z));
    if (this.trailPts.length > TRAIL_MAX) this.trailPts.pop();
    const geo = this.trail.geometry;
    geo.setFromPoints(this.trailPts);
    geo.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.trail.geometry.dispose();
    (this.trail.material as THREE.Material).dispose();
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
  }
}
