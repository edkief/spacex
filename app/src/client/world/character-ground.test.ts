/**
 * CharacterGround tests (TASK-88) — the on-foot predictor's ground must be
 * the SAME expression the server sim uses, so predicted feet track the
 * ground the server collides with for arbitrarily long walks.
 *
 * The defect this pins: the old prediction ran on a FLAT pad plane. The
 * probe below (seeded pad at (10160, 256, 160), a 30 s straight walk at
 * walk speed) shows the flat prediction's feet stay at 256.00 while the
 * real terrain rises to 272+ by t = 8 s — the predicted character (and the
 * on-foot camera tracking it) is inside the terrain, the all-black screen.
 */
import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars';
import { generateSystem } from '@shared/galaxy/system';
import { padSurfaceHeight, padsForSystem, type PadInfo } from '@shared/world/pads';
import { TerrainContext } from '@server/shard/terrain';
import {
  integrateCharacter,
  restCharacterState,
  type CharacterInput,
} from '@shared/physics/character';
import type { Planet, SystemGen } from '@shared/galaxy/types';
import { CharacterGround } from './character-ground';

const SEED = 'DRIFT-SEED-0001'; // the e2e dev-server seed (env default)

/** The deterministic pad target: first star-order system with a landable
 * atmospheric planet + pad (same scan as GET /api/dev/pad-target). */
function padTarget(): { system: SystemGen; planet: Planet; pad: PadInfo } {
  for (const star of generateStars(SEED)) {
    const system = generateSystem(SEED, star.id);
    const planet = system.planets.find((p) => p.landable && p.hasAtmosphere);
    if (!planet) continue;
    const pad = padsForSystem(SEED, system).find((p) => p.planetId === planet.id);
    if (pad) return { system, planet, pad };
  }
  throw new Error('no pad target for the seed');
}

const WALK: CharacterInput = {
  forward: true,
  back: false,
  left: false,
  right: false,
  run: false,
  jump: false,
};

describe('CharacterGround (TASK-88): the on-foot ground', () => {
  const { system, planet, pad } = padTarget();
  // ONE cached context for the whole file (a fresh TerrainContext per call
  // regenerates 9 chunks and the walk sims would time out).
  const serverCtx = new TerrainContext(SEED, planet);
  const server = (x: number, z: number): number => {
    serverCtx.update(x, z);
    return padSurfaceHeight(x, z, serverCtx.heightAt(x, z), pad);
  };

  it('is byte-identical to the server expression (pad disc, blend ring, far field)', () => {
    const ground = new CharacterGround(SEED);
    ground.setPlanet(system, planet.id);
    // Pad centre (inside the flat disc), the blend ring, and 45/90/200 m out
    // in several directions.
    const samples: Array<[number, number]> = [
      [pad.pos.x, pad.pos.z],
      [pad.pos.x + 5, pad.pos.z - 5],
      [pad.pos.x, pad.pos.z + 25],
      [pad.pos.x, pad.pos.z + 45],
      [pad.pos.x, pad.pos.z + 90],
      [pad.pos.x - 60, pad.pos.z + 20],
      [pad.pos.x + 120, pad.pos.z - 40],
    ];
    for (const [x, z] of samples) {
      expect(ground.heightAt(x, z)).toBeCloseTo(server(x, z), 10);
    }
  });

  it('is deterministic across instances (same seed + planet → same ground)', () => {
    const a = new CharacterGround(SEED);
    a.setPlanet(system, planet.id);
    const b = new CharacterGround(SEED);
    b.setPlanet(system, planet.id);
    for (let i = 0; i < 20; i++) {
      const x = pad.pos.x + i * 7;
      const z = pad.pos.z + i * 3;
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    }
  });

  it('falls back to flat before a planet is set (defensive; on foot a planet exists)', () => {
    const ground = new CharacterGround(SEED);
    expect(ground.heightAt(100, 100)).toBe(0);
    ground.setPlanet(null, null);
    expect(ground.heightAt(100, 100)).toBe(0);
  });

  /**
   * THE DEFECT (the on-foot blackout): walking W in a straight line from
   * the disembark spot (2.5 m beside the docked ship, facing +Z — the
   * characterSpawnPos of an identity-quat ship at the pad centre), the
   * LEGACY flat-pad prediction's feet never leave pad height while the real
   * terrain rises — inside the reported 2-10 s window the terrain is already
   * metres above the feet: the character and the camera tracking it are
   * inside the terrain mesh (all-black canvas).
   */
  it('flat-pad prediction buries the character inside the terrain within 10 s of walking (defect)', () => {
    const start = { x: pad.pos.x + 2.5, y: pad.pos.y, z: pad.pos.z };
    let flat = restCharacterState(start);
    let truec = restCharacterState(start);
    let worstGap = 0;
    let gapAt8s = 0;
    for (let t = 1; t <= 30; t++) {
      for (let i = 0; i < 20; i++) {
        flat = integrateCharacter(flat, WALK, 1 / 20, () => pad.pos.y); // legacy client behavior
        truec = integrateCharacter(truec, WALK, 1 / 20, server); // server behavior
      }
      const gap = server(flat.pos.x, flat.pos.z) - flat.pos.y;
      if (gap > worstGap) worstGap = gap;
      if (t === 8) gapAt8s = gap;
    }
    expect(gapAt8s, 'terrain above the flat-predicted feet at t = 8 s').toBeGreaterThanOrEqual(8);
    expect(worstGap, 'the burial deepens as the walk continues').toBeGreaterThanOrEqual(40);
    // The true-ground character stays on the surface (the reference): it is
    // the flat feet that sink, not the terrain that drops.
    expect(server(truec.pos.x, truec.pos.z) - truec.pos.y).toBeLessThan(0.1);
  });

  it('CharacterGround keeps the predicted feet on the true ground for a 30 s walk (the fix)', () => {
    const ground = new CharacterGround(SEED);
    ground.setPlanet(system, planet.id);
    const heightAt = (x: number, z: number): number => ground.heightAt(x, z);
    const start = { x: pad.pos.x + 2.5, y: pad.pos.y, z: pad.pos.z };
    let s = restCharacterState(start);
    let maxDeviation = 0;
    for (let t = 1; t <= 30; t++) {
      for (let i = 0; i < 20; i++) {
        s = integrateCharacter(s, WALK, 1 / 20, heightAt);
      }
      const deviation = Math.abs(ground.heightAt(s.pos.x, s.pos.z) - s.pos.y);
      if (deviation > maxDeviation) maxDeviation = deviation;
    }
    // Feet on the surface for the WHOLE walk (the 20 u/s terrain lerp's
    // sub-metre tolerance on this slope) — never buried, never floating.
    expect(maxDeviation, 'feet stay on the ground for the full 30 s walk').toBeLessThanOrEqual(0.5);
  });
});
