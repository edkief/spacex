import { ClientShipPredictor } from './prediction';
import { RemoteEntityBuffer } from './interpolation';
import { encodeMessage, decodeEnvelope } from '../../shared/protocol';
import { EntityState } from '../../shared/protocol/schemas';

export class NetworkManager {
  private ws: WebSocket | null = null;
  private predictor = new ClientShipPredictor();
  private remotes = new Map<string, RemoteEntityBuffer>();
  private localShipId: string | null = null;
  private seq = 0;

  constructor(private url: string) {}

  async connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws!.onopen = () => {
        this.send('hello', { v: 1 });
        resolve();
      };
      this.ws!.onmessage = (event) => this.onMessage(event.data);
      this.ws!.onerror = (err) => reject(err);
    });
  }

  private onMessage(data: string) {
    const result = decodeEnvelope(data);
    if (!result.success) return;

    const { type, payload } = result.data;

    if (type === 'version-ok') {
      // Send auth (dummy token)
      this.send('auth', { token: 'dummy-token' });
    } else if (type === 'auth_ok') {
      const authData = payload as any;
      this.localShipId = authData.playerId;
      // Join default system
      this.send('join_system', { systemId: 'sol' });
    } else if (type === 'enter_system') {
      const snapshot = payload as any;
      this.handleSnapshot(snapshot.snapshot);
    } else if (type === 'entity_update') {
      const update = payload as { entities: EntityState[] };
      this.handleSnapshot({ entities: update.entities } as any);
    }
  }

  private handleSnapshot(snapshot: any) {
    const entities = snapshot.entities || [];
    for (const entity of entities) {
      if (entity.id === this.localShipId) {
        this.predictor.reconcile(entity, entity.lastAppliedSeq || 0);
      } else {
        let buffer = this.remotes.get(entity.id);
        if (!buffer) {
          buffer = new RemoteEntityBuffer();
          this.remotes.set(entity.id, buffer);
        }
        buffer.addSnapshot(entity);
      }
    }
  }

  sendInput(input: any) {
    this.seq++;
    this.predictor.step(1 / 60, input, this.seq); // Assume 60fps for prediction
    this.send('input', { ...input, seq: this.seq });
  }

  getState(now: number) {
    const states: EntityState[] = [];

    // Local ship
    const local = this.predictor.getState();
    if (local) states.push(local);

    // Remotes
    for (const buffer of this.remotes.values()) {
      const state = buffer.getState(now);
      if (state) states.push(state);
    }

    return states;
  }

  private send(type: string, payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(type, payload));
    }
  }
}
