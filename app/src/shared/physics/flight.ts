import { vec3, quat } from './vec';
import { ShipState, FlightInput, FlightRegime, Planet, FlightOptions } from './types';
import { ShipClass } from '../ships';

/**
 * Deterministic ship physics integration.
 * used verbatim by server sim (authority) and client prediction.
 * 
 * Sim units: 1 u = 1 m; velocities in u/s.
 */
export function integrateShip(
  state: ShipState,
  input: FlightInput,
  dt: number,
  regime: FlightRegime,
  shipClass: ShipClass,
  planet?: Planet,
  options: FlightOptions = {}
): ShipState {
  if (!planet && regime === 'atmosphere') {
    throw new Error('Planet required for atmosphere regime');
  }

  let nextState = { ...state, regime };
  let currentVel = { ...state.vel };
  let currentPos = { ...state.pos };
  let currentQuat = { ...state.quat };

  // 1. Rotation (Common to all flight regimes unless docked)
  if (state.onPad) {
    // No rotation while docked
  } else {
    const dRot = quat.fromEuler(
      input.pitch * shipClass.turnRate * dt,
      input.yaw * shipClass.turnRate * dt,
      input.roll * shipClass.turnRate * dt
    );
    currentQuat = quat.multiply(currentQuat, dRot);
  }

  // 2. Forces / Acceleration
  let accel = { x: 0, y: 0, z: 0 };

  // Forward thrust
  const forward = quat.rotateVector(currentQuat, { x: 0, y: 0, z: 1 });
  const thrustForce = vec3.scale(forward, input.thrust * shipClass.acceleration);
  accel = vec3.add(accel, thrustForce);

  if (regime === 'space') {
    // Newtonian space: no drag, optional damping (0.0)
  } else if (regime === 'atmosphere') {
    if (!planet) throw new Error('Planet missing in atmosphere');

    // Boundary continuity: ramp drag across 1km boundary
    const altitude = vec3.len(currentPos) - (planet.radiusKm * 1000);
    const boundaryAlt = planet.atmosphereHeight * 1000;
    const rampHalfWidth = 500; // 1km total ramp
    
    let multiplier = 1.0;
    if (altitude > boundaryAlt - rampHalfWidth) {
      const t = (altitude - (boundaryAlt - rampHalfWidth)) / (2 * rampHalfWidth);
      multiplier = Math.max(0, Math.min(1, 1 - t));
    }

    // Quadratic Drag: F = -k * |v| * v
    const area = shipClass.mass * 0.05;
    const k = planet.atmosphereDensity * area * multiplier;
    const speed = vec3.len(currentVel);
    if (speed > 0) {
      const dragAccel = vec3.scale(currentVel, - (k * speed) / shipClass.mass);
      accel = vec3.add(accel, dragAccel);
    }

    // VTOL Lift
    const VTOL_SPEED_THRESHOLD = 5.0;
    const horizontalVel = { x: currentVel.x, y: 0, z: currentVel.z };
    if (input.up && vec3.len(horizontalVel) < VTOL_SPEED_THRESHOLD) {
      const vtolAccel = { x: 0, y: 9.81 * 1.2, z: 0 };
      accel = vec3.add(accel, vtolAccel);
    }
  } else if (regime === 'surface') {
    // Surface flight (like a hovercraft) - simplified
    const speed = vec3.len(currentVel);
    if (speed > 0) {
      const dragAccel = vec3.scale(currentVel, - (0.1 * speed)); // Simple surface drag
      accel = vec3.add(accel, dragAccel);
    }
  } else {
    throw new Error(`Unknown flight regime: ${regime}`);
  }

  // 3. Integration
  currentVel = vec3.add(currentVel, vec3.scale(accel, dt));

  // Soft speed cap
  const currentSpeed = vec3.len(currentVel);
  if (currentSpeed > shipClass.maxVelocity) {
    const unitVel = vec3.normalize(currentVel);
    const excess = currentSpeed - shipClass.maxVelocity;
    // Scale excess by 0.95 per step
    const cappedVel = vec3.add(
      vec3.scale(unitVel, shipClass.maxVelocity),
      vec3.scale(unitVel, excess * 0.95)
    );
    currentVel = cappedVel;
  }

  currentPos = vec3.add(currentPos, vec3.scale(currentVel, dt));

  // 4. Ground Collision & VTOL Pad
  if (regime === 'atmosphere' || regime === 'surface') {
    if (options.heightAt) {
      const terrainY = options.heightAt(currentPos.x, currentPos.z);
      
      // No tunneling: substep if |vel|*dt > 2m
      const moveDist = vec3.len(currentVel) * dt;
      if (currentPos.y < terrainY) {
        // Simple clamp for now; substeps would be more precise
        currentPos.y = terrainY;
        if (currentVel.y < 0) {
          currentVel.y = 0;
        }
      }

      // VTOL Pad Check
      if (currentPos.y <= terrainY + 0.1 && Math.abs(currentVel.y) < 0.5) {
        // Future TASK-29/31
      }
    }
  }

  return {
    pos: currentPos,
    vel: currentVel,
    quat: currentQuat,
    regime,
    onPad: state.onPad,
  };
}
