import { describe, expect, it } from 'vitest';

import { vec, vecLength, vecNormalize, vecSub } from '@shared/physics/vec';

import { PROXY_DISTANCE_M, PROXY_START_M, proxyTransform } from './scaled-proxy';

const CAM = vec(0, 0, 0);

describe('proxyTransform (TASK-83 scaled-proxy math)', () => {
  it('is the identity inside the threshold', () => {
    const world = vec(1_000, 400, -2_000); // |world| ≈ 2 354 < 3 000
    const r = proxyTransform(CAM, world);
    expect(r.scale).toBe(1);
    expect(r.pos).toEqual(world);
  });

  it('is the identity at exactly the threshold and continuous just past it', () => {
    const at = vec(0, 0, PROXY_START_M);
    const atR = proxyTransform(CAM, at);
    expect(atR.scale).toBe(1);
    expect(atR.pos).toEqual(at);

    const justPast = vec(0, 0, PROXY_START_M + 1);
    const past = proxyTransform(CAM, justPast);
    // scale → 1 and pos → worldPos at the threshold: no pop.
    expect(past.scale).toBeCloseTo(PROXY_DISTANCE_M / (PROXY_START_M + 1), 10);
    expect(past.scale).toBeGreaterThan(0.999);
    // The proxy sits (distance - PROXY_DISTANCE_M) = 1 m closer on the ray.
    expect(vecLength(vecSub(past.pos, justPast))).toBeCloseTo(1, 6);
  });

  it('preserves angular size and direction for a far object', () => {
    const world = vec(45_000, 300, 1_200);
    const r = proxyTransform(CAM, world);
    const distance = vecLength(world);
    // Angular size: a radius of 1 at the proxy reads the same as radius 1
    // at the true distance — scale / proxyDistance == 1 / distance.
    expect(r.scale).toBeCloseTo(PROXY_DISTANCE_M / distance, 10);
    expect(r.scale / PROXY_DISTANCE_M).toBeCloseTo(1 / distance, 10);
    // Direction: the proxy sits on the EXACT camera→object ray.
    const proxyDir = vecNormalize(vecSub(r.pos, CAM));
    const trueDir = vecNormalize(world);
    expect(proxyDir.x).toBeCloseTo(trueDir.x, 12);
    expect(proxyDir.y).toBeCloseTo(trueDir.y, 12);
    expect(proxyDir.z).toBeCloseTo(trueDir.z, 12);
    // And the proxy is drawn at the fixed distance, inside the far plane.
    expect(vecLength(r.pos)).toBeCloseTo(PROXY_DISTANCE_M, 10);
  });

  it('works for camera positions far from the origin (the e2e teleport case)', () => {
    const cam = vec(45_000, 300, 0);
    const world = vec(10_000, 0, 0); // behind the camera, 35 km away
    const r = proxyTransform(cam, world);
    const distance = Math.hypot(35_000, 300, 0);
    expect(r.scale).toBeCloseTo(PROXY_DISTANCE_M / distance, 10);
    const d = vecNormalize(vecSub(world, cam));
    const expectPos = {
      x: cam.x + d.x * PROXY_DISTANCE_M,
      y: cam.y + d.y * PROXY_DISTANCE_M,
      z: cam.z + d.z * PROXY_DISTANCE_M,
    };
    expect(r.pos.x).toBeCloseTo(expectPos.x, 8);
    expect(r.pos.y).toBeCloseTo(expectPos.y, 8);
    expect(r.pos.z).toBeCloseTo(expectPos.z, 8);
  });
});
