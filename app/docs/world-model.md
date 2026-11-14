# World model (as implemented)

Units: metres, seconds, kilograms, radians. Planets are 1:100 scale: sim radius = radiusKm x 10 m
(landable 20-80 km, gas giants 200-600 km). Nothing orbits or rotates.

## Layout (src/shared/galaxy/layout*.ts, generation rules apply)

- Star at origin, +y up. Innermost orbit 8,000 km (+0-2,000 km jitter), each next +6,000-20,000 km; planet direction seeded in the y=0 plane (disc rejection, no trig).
- Star radius by class: O 5000, B 4000, A 3200, F 2600, G 2000, K 1500, M 1000 km (sim).
- Docks: `dockCount` points at 1.6 R, >= ~26 deg apart, each with stable id and one pad id.
- Atmosphere: top 0.12 R when hasAtmosphere; density terran 1, ocean 1.2, rocky 0.5, ice 0.4, gas 3.
- New fields only; all old fields unchanged (verified over 800 systems / 3,192 planets).

## Surface frame (src/shared/physics/frames.ts)

Azimuthal-equidistant projection about the planet's +y pole: x = R*theta*cos(phi), z = R*theta*sin(phi), y = rho - R.
theta > 0.97 pi is out of range (south polar cap: shell at R + 400 m in the system frame, wall at flat radius 0.97 pi R in the surface frame).
Velocity/orientation rotate through (away-from-pole, azimuthal, up); the stretch theta/sin(theta) (1 at the pole, 1.57 at the equator, ~32 at the limit) is NOT applied.
Frame switch altitude = max(atmosphere top + 1 km, 3 km); exit above 1.1x. Only landable planets have a surface frame.

## Regimes (src/shared/regime.ts)

space/atmosphere/surface; 50 m hysteresis at the atmosphere top (airless: 3 km band); surface below terrain+2 m & <5 m/s, leaves above +5 m or >15 m/s; one step per call.

## Flight (src/shared/physics/*)

- Travel scale f(d) = min(1 + d/1000, 4000) on speed cap and acceleration (d = distance to nearest surface or dock); excess speed decays at 8/s; swept-sphere collision (no tunnelling at any speed).
- Surface: gravity 9.8 and quadratic drag (k = 0.074 * density * mass^-1/3) both ramped over 1 km below the atmosphere top; VTOL velocity-hold assist (idle sink 3 m/s, climb 20, descent 25; accel = 0.6 x class accel; authority fades 20-60 m/s horizontal); ground friction 15 m/s^2; substeps <= 2 m; pads: radius 12 m, <2 m/s vertical, <3 m/s horizontal.
- Docking: within 100 m and < 10 m/s with `dock`; `undock` pushes off at 5 m/s.
- Input: thrust, yaw, pitch, roll, up, brake, fire, lock, action(none|dock|undock) (`turn` removed). Axes: nose -z, up +y, right +x.
