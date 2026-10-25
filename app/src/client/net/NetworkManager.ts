import { ClientShipPredictor } from './prediction';
import { RemoteEntityBuffer } from './interpolation';
import { encodeMessage, decodeEnvelope } from '../../shared/protocol';
import { EntityState } from '../../shared/protocol/schemas';
import { presenceStore } from './presence';
import { chatStore, ChatMessage } from './chat';
import { connectionStore, ConnectionStatus } from './connection-store';
import { systemStore } from '../state/systemStore';

export class NetworkManager {
  private ws: WebSocket | null = null;
  private predictor = new ClientShipPredictor();
  private remotes = new Map<string, RemoteEntityBuffer>();
  private localShipId: string | null = null;
  private seq = 0;

  public onWarpArrived: ((data: any) => void) | null = null;

  private retryCount = 0;
  private retryTimer: any = null;
  private isExplicitlyClosed = false;

  constructor(private url: string) {}

  setUrl(url: string) {
    this.url = url;
  }

  async connect(token: string = 'dummy-token') {
    this.isExplicitlyClosed = false;
    return new Promise<void>((resolve, reject) => {
      connectionStore.setStatus('connecting');
      this.ws = new WebSocket(this.url);

      this.ws!.onopen = () => {
        this.retryCount = 0;
        connectionStore.setStatus('connected');
        this.send('hello', { v: 1 });
        resolve();
      };

      this.ws!.onmessage = (event) => this.onMessage(event.data, token);

      this.ws!.onerror = (err) => {
        console.error('WebSocket error:', err);
        reject(err);
      };

      this.ws!.onclose = () => {
        this.handleClose();
      };
    });
  }

  private handleClose() {
    if (this.isExplicitlyClosed) return;

    connectionStore.setStatus('reconnecting');

    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 5000);
    this.retryCount++;

    console.log(`WebSocket closed. Retrying in ${delay}ms... (attempt ${this.retryCount})`);

    this.retryTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (e) {
        // connect() already calls handleClose on error/close
      }
    }, delay);

    // If we've been retrying for too long (e.g., 30s), move to disconnected
    if (this.retryCount > 10) {
      // approx 30-50s depending on backoff
      connectionStore.setStatus('disconnected', 'Connection lost. Please check your network.');
    }
  }

  public disconnect() {
    this.isExplicitlyClosed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
    connectionStore.setStatus('disconnected');
  }

  private onMessage(data: string, token: string) {
    const result = decodeEnvelope(data);
    if (!result.success) return;

    const { type, payload } = result.data;

    if (type === 'version-ok') {
      this.send('auth', { token });
    } else if (type === 'auth_ok') {
      const authData = payload as any;
      this.localShipId = authData.playerId;
      presenceStore.setLocalPlayerId(authData.playerId);
      this.send('join_system', { systemId: 'sol' });
    } else if (type === 'enter_system') {
      const snapshot = payload as any;

      if (snapshot.systemId) {
        systemStore.setSystemId(snapshot.systemId);
      }

      // If this is a resync, reset prediction and remotes
      if (this.localShipId) {
        this.predictor.reset();
        this.remotes.clear();
      }

      presenceStore.leaveAll();
      if (snapshot.snapshot.players) {
        for (const p of snapshot.snapshot.players) {
          presenceStore.join(p.id, { callsign: p.callsign });
        }
      }

      this.handleSnapshot(snapshot.snapshot);
    } else if (type === 'entity_update') {
      const update = payload as { entities: EntityState[] };
      this.handleSnapshot({ entities: update.entities } as any);
    } else if (type === 'presence_join') {
      const p = payload as any;
      presenceStore.join(p.playerId, { callsign: p.callsign });
    } else if (type === 'presence_leave') {
      const p = payload as any;
      presenceStore.leave(p.playerId);
    } else if (type === 'chat') {
      const msg = payload as ChatMessage;
      chatStore.addMessage(msg);
    } else if (type === 'warp-arrived') {
      if (this.onWarpArrived) {
        this.onWarpArrived(payload as any);
      }
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
    this.predictor.step(1 / 60, input, this.seq);
    this.send('input', { ...input, seq: this.seq });
  }

  getState(now: number) {
    const states: EntityState[] = [];

    const local = this.predictor.getState();
    if (local) states.push(local);

    for (const buffer of this.remotes.values()) {
      const state = buffer.getState(now);
      if (state) states.push(state);
    }

    return states;
  }

  sendChat(text: string) {
    this.send('chat', { text });
  }

  sendWarp(destinationSystemId: string) {
    this.send('warp', { destinationSystemId });
  }

  private send(type: string, payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(type, payload));
    }
  }
}

const getWsUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

export const networkManager = new NetworkManager(getWsUrl());
