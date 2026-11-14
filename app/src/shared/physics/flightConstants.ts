/** Flight-model constants. Units: metres, seconds, kilograms, radians. */

/** Travel scaling: speed cap and acceleration both scale by f(d) = 1 + d / D, capped at F_MAX. */
export const TRAVEL_SCALE_DISTANCE_M = 1000;
export const TRAVEL_MAX_FACTOR = 4000;
/** Speed above the cap decays exponentially at this rate (per second). */
export const SOFT_CAP_DECAY_PER_S = 8;

/** Gravity along -y in a surface frame (arcade; the same on every planet). */
export const SURFACE_GRAVITY = 9.8;
/** Atmosphere drag ramps from 0 to full over this depth below the atmosphere top (TASK-28). */
export const ATMOSPHERE_RAMP_M = 1000;
/**
 * k = DRAG_COEFFICIENT * density * mass^(-1/3) (area/mass falls as mass^(-1/3)). Chosen so a
 * 20 t scout in density-1 air has a free-fall terminal velocity of about 60 m/s.
 */
export const DRAG_COEFFICIENT = 0.074;

/** VTOL: climb/descent rate demanded by full `up` input, and the idle sink rate (hover assist). */
export const VTOL_CLIMB_RATE = 20;
export const VTOL_DESCENT_RATE = 25;
export const VTOL_IDLE_SINK_RATE = 3;
/** Vertical thrust available as a fraction of the class acceleration (every class > 1.5 g). */
export const VTOL_ACCEL_FRACTION = 0.6;
/** Velocity-hold gain of the vertical controller (1/s). */
export const VTOL_GAIN = 2;
/** VTOL authority: full below this horizontal speed, fading linearly to zero at the second. */
export const VTOL_FULL_SPEED = 20;
export const VTOL_ZERO_SPEED = 60;

/** Terrain collision substeps so no step moves more than ~2 m. */
export const MAX_STEP_DISTANCE_M = 2;
export const MAX_SUBSTEPS = 256;
/** Horizontal deceleration while resting on the ground (m/s^2). */
export const GROUND_FRICTION = 15;
/** "On the ground" means within this height of the terrain. */
export const GROUND_EPSILON_M = 0.05;

/** Surface pad rule: within the radius, on the ground, and slow. */
export const PAD_RADIUS_M = 12;
export const PAD_MAX_VERTICAL_SPEED = 2;
export const PAD_MAX_HORIZONTAL_SPEED = 3;

/** Orbital docking: within range of a dock and slower than the limit; undocking pushes off. */
export const DOCK_RANGE_M = 100;
export const DOCK_MAX_SPEED = 10;
export const UNDOCK_SPEED = 5;

/** Pushes a clamped ship this far outside a solid sphere to avoid re-penetration. */
export const CONTACT_MARGIN_M = 0.001;
