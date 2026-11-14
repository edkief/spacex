const TWO_POW_32 = 4294967296;

/** MurmurHash3 32-bit finalizer: a bijective avalanche mix using only exact int ops. */
function fmix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hashes a 32-bit seed and two integer lattice coordinates to an unsigned 32-bit value.
 * Pure 32-bit Number math (no BigInt), so it is cheap in per-sample loops.
 */
export function hash32(seed: number, ix: number, iz: number): number {
  const a = fmix32((seed | 0) ^ Math.imul(ix | 0, 0x9e3779b1));
  return fmix32(a ^ Math.imul(iz | 0, 0x85ebca77));
}

/**
 * 2D value noise in [0, 1) on a world-space lattice of `lattice` metres (must be a power of
 * two, so `x / lattice` and its fractional part are exact). Corner values are `hash32 / 2^32`
 * and are blended with smoothstep, so the result is identical in every JS engine and
 * continuous across any boundary.
 */
export function valueNoise2D(seed: number, x: number, z: number, lattice: number): number {
  const gx = x / lattice;
  const gz = z / lattice;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const tx = gx - ix;
  const tz = gz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const v00 = hash32(seed, ix, iz) / TWO_POW_32;
  const v10 = hash32(seed, ix + 1, iz) / TWO_POW_32;
  const v01 = hash32(seed, ix, iz + 1) / TWO_POW_32;
  const v11 = hash32(seed, ix + 1, iz + 1) / TWO_POW_32;
  const near = v00 + (v10 - v00) * sx;
  const far = v01 + (v11 - v01) * sx;
  return near + (far - near) * sz;
}

/**
 * Fractal Brownian motion: `octaves` layers of value noise, each with half the lattice size and
 * half the amplitude, normalised to [0, 1). `baseLattice` must be a power of two >= 2^octaves.
 */
export function fbm2D(
  seed: number,
  x: number,
  z: number,
  baseLattice: number,
  octaves: number,
): number {
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let lattice = baseLattice;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise2D(hash32(seed, octave, 0x5bd1), x, z, lattice);
    total += amplitude;
    amplitude *= 0.5;
    lattice /= 2;
  }
  return sum / total;
}

/** Hashes a 32-bit seed and three integer lattice coordinates to an unsigned 32-bit value. */
export function hash32x3(seed: number, ix: number, iy: number, iz: number): number {
  const a = fmix32((seed | 0) ^ Math.imul(ix | 0, 0x9e3779b1));
  const b = fmix32(a ^ Math.imul(iy | 0, 0x85ebca77));
  return fmix32(b ^ Math.imul(iz | 0, 0xc2b2ae3d));
}

/**
 * 3D value noise in [0, 1) on a lattice of `lattice` metres (a power of two): the trilinear,
 * smoothstep-blended counterpart of `valueNoise2D`. Sampling it at points of a sphere gives
 * terrain with no seam, pole or stretch. Exact operations only.
 */
export function valueNoise3D(
  seed: number,
  x: number,
  y: number,
  z: number,
  lattice: number,
): number {
  const gx = x / lattice;
  const gy = y / lattice;
  const gz = z / lattice;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const iz = Math.floor(gz);
  const tx = gx - ix;
  const ty = gy - iy;
  const tz = gz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);
  // Corner hashes share their x and (x, y) stages: 14 mixes instead of 24. Same values as
  // `hash32x3(seed, ix + dx, iy + dy, iz + dz)`.
  const ax0 = fmix32((seed | 0) ^ Math.imul(ix | 0, 0x9e3779b1));
  const ax1 = fmix32((seed | 0) ^ Math.imul((ix + 1) | 0, 0x9e3779b1));
  const my0 = Math.imul(iy | 0, 0x85ebca77);
  const my1 = Math.imul((iy + 1) | 0, 0x85ebca77);
  const mz0 = Math.imul(iz | 0, 0xc2b2ae3d);
  const mz1 = Math.imul((iz + 1) | 0, 0xc2b2ae3d);
  const b00 = fmix32(ax0 ^ my0);
  const b10 = fmix32(ax1 ^ my0);
  const b01 = fmix32(ax0 ^ my1);
  const b11 = fmix32(ax1 ^ my1);
  const c000 = fmix32(b00 ^ mz0) / TWO_POW_32;
  const c100 = fmix32(b10 ^ mz0) / TWO_POW_32;
  const c010 = fmix32(b01 ^ mz0) / TWO_POW_32;
  const c110 = fmix32(b11 ^ mz0) / TWO_POW_32;
  const c001 = fmix32(b00 ^ mz1) / TWO_POW_32;
  const c101 = fmix32(b10 ^ mz1) / TWO_POW_32;
  const c011 = fmix32(b01 ^ mz1) / TWO_POW_32;
  const c111 = fmix32(b11 ^ mz1) / TWO_POW_32;
  const e00 = c000 + (c100 - c000) * sx;
  const e10 = c010 + (c110 - c010) * sx;
  const e01 = c001 + (c101 - c001) * sx;
  const e11 = c011 + (c111 - c011) * sx;
  const front = e00 + (e10 - e00) * sy;
  const back = e01 + (e11 - e01) * sy;
  return front + (back - front) * sz;
}

/** Fractal Brownian motion over `valueNoise3D`; same octave rule as `fbm2D`. */
export function fbm3D(
  seed: number,
  x: number,
  y: number,
  z: number,
  baseLattice: number,
  octaves: number,
): number {
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let lattice = baseLattice;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise3D(hash32(seed, octave, 0x5bd1), x, y, z, lattice);
    total += amplitude;
    amplitude *= 0.5;
    lattice /= 2;
  }
  return sum / total;
}
