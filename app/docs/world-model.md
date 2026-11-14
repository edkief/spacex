# World model (as implemented)

Units: metres, seconds, kilograms, radians. Planets are 1:100 scale: sim radius = radiusKm x 10 m
(landable 20-80 km, gas giants 200-600 km). Nothing orbits or rotates.

## Layout (src/shared/galaxy/layout*.ts, generation rules apply)

- Star at origin, +y up. Innermost orbit 8,000 km (+0-2,000 km jitter), each next +6,000-20,000 km; planet direction seeded in the y=0 plane (disc rejection, no trig).
- Star radius by class: O 5000, B 4000, A 3200, F 2600, G 2000, K 1500, M 1000 km (sim).
- Docks: `dockCount` points at 1.6 R, >= ~26 deg apart, each with stable id and one pad id.
- Atmosphere: top 0.12 R when hasAtmosphere; density terran 1, ocean 1.2, rocky 0.5, ice 0.4, gas 3.
- New fields only; all old fields unchanged (verified over 800 systems / 3,192 planets).

## Surface charts (src/shared/galaxy/chart.ts, src/shared/physics/frames.ts)

Each landable planet has two flat surface frames, `<planetId>:n` and `<planetId>:s`: the stereographic projection of the sphere about its +y and -y pole. For a unit direction n from the planet centre, north is (a, b) = (n.x, n.z) / (1 + n.y) and south is (n.x, -n.z) / (1 - n.y) (z negated so both charts are right-handed with altitude as +y). Flat metres are x = 2R*a, z = 2R*b; y is true altitude above the datum sphere.

- r^2 = a^2 + b^2 is 0 at the pole and 1 at the equator (flat radius 2R). A chart is authoritative for r <= 1.
- The projection is conformal: the local scale is the same in every direction, 1 / (1 + r^2) true metres per flat metre (1 at the pole, 0.5 at the equator). There is no singular point inside a hemisphere, no unlandable region and no anisotropic stretch.
- The inverse (chart -> sphere) is n = (2a, +/-(1 - a^2 - b^2), +/-2b) / (1 + a^2 + b^2): only + - * /, so terrain generation uses it and stays bit-identical across JS engines.
- Terrain is a function of the point on the sphere: 3D value noise sampled at R*n (src/shared/galaxy/noise.ts, terrain.ts). Both charts see the same terrain, so there is no seam at the equator. The two charts reach the same point by different arithmetic and agree to floating-point noise (< 1e-6 m in tests), which is why every discrete generation decision for a chunk (biome, flatness, node and pad placement) is evaluated through that chunk's own chart only.
- Chunks are a 256 flat-metre grid per chart (`generateSurfaceChunk(seed, planet, cx, cz, hemisphere)`); a chunk belongs to a chart while its centre has r <= 1. Chunk, node and pad coordinates are flat chart metres; placement clearances are true metres. North chunk (0,0) has the guaranteed pad.
- In a surface frame, positions are flat chart metres and velocities/orientations are TRUE m/s in the local orthonormal basis (flat x, up, flat z). Horizontal position integration divides by the chart scale; every horizontal distance comparison (pad radius, clearances) multiplies flat distances by it.
- A ship changes chart once it is a little past the equator (sine-latitude 0.0488, i.e. r = 1.05, arriving at r = 0.95 in the other chart): hysteresis. State converts through the system frame and is continuous.
- Frame switch altitude = max(atmosphere top + 1 km, 3 km); exit above 1.1x. Entering picks the chart of the hemisphere the ship is over. Only landable planets have surface frames; in the system frame they are solid to the datum sphere.

## Regimes (src/shared/regime.ts)

space/atmosphere/surface; 50 m hysteresis at the atmosphere top (airless: 3 km band); surface below terrain+2 m & <5 m/s, leaves above +5 m or >15 m/s; one step per call.

## Flight (src/shared/physics/*)

- Travel scale f(d) = min(1 + d/1000, 4000) on speed cap and acceleration (d = distance to nearest surface or dock); excess speed decays at 8/s; swept-sphere collision (no tunnelling at any speed).
- Surface: gravity 9.8 and quadratic drag (k = 0.074 * density * mass^-1/3) both ramped over 1 km below the atmosphere top; VTOL velocity-hold assist (idle sink 3 m/s, climb 20, descent 25; accel = 0.6 x class accel; authority fades 20-60 m/s horizontal); ground friction 15 m/s^2; substeps <= 2 m; pads: radius 12 m, <2 m/s vertical, <3 m/s horizontal.
- Docking: within 100 m and < 10 m/s with `dock`; `undock` pushes off at 5 m/s.
- Input: thrust, yaw, pitch, roll, up, brake, fire, lock, action(none|dock|undock) (`turn` removed). Axes: nose -z, up +y, right +x.
