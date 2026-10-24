import { integrateShip } from '../../shared/physics/flight';
import { EntityState } from '../../shared/protocol/schemas';
import { Vec3, Quat } from '../../shared/physics/types';

export interface PredictedInput {
  seq: number;
  input: any;
  dt: number;
}

export class ClientShipPredictor {
  private serverState: EntityState | null = null;
  private predictedState: EntityState | null = null;
  private inputQueue: PredictedInput[] = [];
  
  private readonly DRIFT_THRESHOLD_POS = 5;
  private readonly DRIFT_THRESHOLD_ROT = 0.2;

  /**
   * Processes a local input frame.
   * @param dt Frame delta time in seconds.
   * @param input The current input state.
   * @param seq The sequence number assigned to this input.
   */
  step(dt: number, input: any, seq: number) {
    if (!this.predictedState) return;

    // Store for potential reconciliation
    this.inputQueue.push({ seq, input, dt });

    // Map input to FlightInput (roll = turn)
    const flightInput = {
      thrust: input.thrust,
      pitch: input.pitch,
      yaw: input.yaw,
      roll: input.turn,
      up: false,
    };

    // Predict next state
    this.predictedState = integrateShip(
      this.predictedState,
      flightInput,
      dt,
      this.predictedState.regime,
      { id: 'default', name: 'Default', mass: 1000, acceleration: 10, maxVelocity: 100, turnRate: 1 },
      undefined
    );
  }

  /**
   * Reconciles the local prediction with a server snapshot.
   * @param serverState The authoritative state from the server.
   * @param ackedSeq The last input sequence number processed by the server.
   */
  reconcile(serverState: EntityState, ackedSeq: number) {
    this.serverState = serverState;

    // 1. Discard acked inputs
    this.inputQueue = this.inputQueue.filter(item => item.seq > ackedSeq);

    // 2. Check for drift
    if (this.predictedState) {
      const posDrift = this.dist(this.predictedState.pos, serverState.pos);
      const rotDrift = this.angleBetween(this.predictedState.vel, serverState.vel); // Simplified rotation check using velocity for now

      if (posDrift > this.DRIFT_THRESHOLD_POS || rotDrift > this.DRIFT_THRESHOLD_ROT) {
        // REWIND: Re-apply all unacked inputs from the server state
        let tempState = serverState;
        for (const item of this.inputQueue) {
          const flightInput = {
            thrust: item.input.thrust,
            pitch: item.input.pitch,
            yaw: item.input.yaw,
            roll: item.input.turn,
            up: false,
          };
          tempState = integrateShip(
            tempState,
            flightInput,
            item.dt,
            tempState.regime,
            { id: 'default', name: 'Default', mass: 1000, acceleration: 10, maxVelocity: 100, turnRate: 1 },
            undefined
          );
        }
        this.predictedState = tempState;
      } else {
        // BLEND: Small correction can be interpolated by the renderer (handled externally)
        // For now, just accept the server state as the new base
      }
    } else {
      this.predictedState = serverState;
    }
  }

  getState() {
    return this.predictedState;
  }

  private dist(a: Vec3, b: Vec3) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  private angleBetween(a: Vec3, b: Vec3) {
    // Very rough approximation for now
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    const magA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const magB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    if (magA === 0 || magB === 0) return 0;
    return Math.acos(Math.min(1, Math.max(-1, dot / (magA * magB))));
  }
}
