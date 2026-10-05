import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@shared/protocol';

/**
 * TASK-18: one load-test client — a real WebSocket to the real server, with
 * the per-client metric state the acceptance criteria need:
 * - snapshot rate (entity_update count over ACTIVE time — the intentional
 *   reconnect gap is excluded, since the client is offline by choice, not
 *   starved by the server),
 * - starvation (max gap between consecutive entity_updates, excluding the
 *   reconnect window),
 * - inbound message sizes (p95 < 16 KB),
 * - input→ack RTT (send inputs with a monotonic seq; the server echoes the
 *   last APPLIED seq at 10 Hz snapshot cadence (TASK-14) — RTT for input n
 *   is the arrival of the first ack with seq ≥ n minus n's send time),
 * - entity-list consistency (no duplicate ids per frame; per-callsign
 *   membership so a rejoin can assert "no duplicates, no missing ships"),
 * - kick bookkeeping (server-initiated 4xxx/1011 closes fail the run).
 */

export type Role = 'flying' | 'foot' | 'warper' | 'idle';

export interface EntityFrame {
  ids: string[];
  /**
   * callsign → every entity carrying it (a disembarked player shows its DOCKED
   * ship AND its character under the same callsign, so the list, not one
   * entry).
   */
  byCallsign: Map<string, Array<{ id: string; kind: string }>>;
  at: number;
}

export interface RttWindow {
  p50: number;
  p95: number;
  max: number;
  n: number;
}

export class LoadClient {
  readonly wsUrl: string;
  readonly id: number;
  role: Role;
  ws: WebSocket | null = null;
  /** epoch ms the FIRST enter_system landed (the rate anchor for the run). */
  firstJoinedAt = 0;
  /** epoch ms the LAST enter_system landed (re-set on rejoin). */
  joinedAt = 0;
  /** ms spent intentionally offline (socket closed → enter_system), per rejoin. */
  rejoinGapsMs: number[] = [];
  rejoinDowntimeMs = 0;
  snapshotCount = 0;
  maxSnapshotGapMs = 0;
  private lastSnapshotAt = 0;
  private inReconnect = false;
  msgSizes: number[] = [];
  entityUpdates: number[] = [];
  rtts: number[] = [];
  private pendingInputs = new Map<number, number>();
  nextSeq = 1;
  lastFrame: EntityFrame | null = null;
  /**
   * 'error' envelopes received that are NOT expected. 'invalid-target' is
   * a legitimate gameplay denial (the combat role re-aims at ships that can
   * die between the snapshot read and the lock request) — not a failure.
   */
  unexpectedErrors: string[] = [];
  /** Last raw entity_update frame (diagnostics only — size/composition). */
  lastRawSnapshot: string | null = null;
  kickCodes: number[] = [];
  errCodes: Record<string, number> = {};
  private static readonly EXPECTED_ERRORS = new Set(['invalid-target']);
  closedCleanly = false;
  /** Latest per-player frame (mining channel state / dock sell / hazard…). */
  private listeners = new Map<string, Array<(payload: unknown) => void>>();

  constructor(wsUrl: string, id: number, role: Role) {
    this.wsUrl = wsUrl;
    this.id = id;
    this.role = role;
  }

  /** Open the socket and complete the hello → auth → join_system handshake. */
  async join(token: string, systemId: string, expectError = false): Promise<string | null> {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', () => reject(new Error(`client ${this.id}: socket error`)));
    });
    this.wire();
    const send = (type: string, payload: unknown): void =>
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
    send('hello', { v: PROTOCOL_VERSION });
    send('auth', { token });
    send('join_system', { systemId });
    if (expectError) {
      // The 17th client: the join is refused (system-full) and the socket
      // stays open — wait for the structured error.
      const code = await this.waitFor((e) => e.type === 'error', 'error', 5000);
      return (code.payload as { code?: string }).code ?? null;
    }
    await this.waitFor((e) => e.type === 'enter_system', 'enter_system', 10_000);
    const now = performance.now();
    if (this.firstJoinedAt === 0) this.firstJoinedAt = now;
    this.joinedAt = now;
    this.lastSnapshotAt = 0;
    this.inReconnect = false;
    return null;
  }

  /** Close + rejoin (the t=2 min reconnect wave). Records the gap. */
  async reconnect(token: string, systemId: string): Promise<number> {
    const closeAt = performance.now();
    this.inReconnect = true;
    this.ws?.close(1000, 'load-test drop');
    await this.join(token, systemId);
    const gapMs = performance.now() - closeAt;
    this.rejoinGapsMs.push(gapMs);
    this.rejoinDowntimeMs += gapMs;
    return gapMs;
  }

  send(type: string, payload: unknown): void {
    this.ws?.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
  }

  /** One input frame (10 Hz role cadence); stamps it for RTT. */
  sendInput(partial: {
    thrust: number;
    turn: number;
    pitch: number;
    yaw: number;
    fire?: boolean;
    lock?: boolean;
    action?: string;
  }): void {
    const seq = this.nextSeq++;
    const now = performance.now();
    this.pendingInputs.set(seq, now);
    this.send('input', { seq, fire: false, lock: false, ...partial });
  }

  close(): void {
    this.ws?.close(1000, 'load-test done');
  }

  /** Subscribe to every envelope of `type`; returns an unsubscribe fn. */
  on(type: string, cb: (payload: unknown) => void): () => void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    return () => this.off(type, cb);
  }

  /**
   * Resolve the payload of the NEXT envelope of `type` (or one already
   * seen-and-registered after this call — the role drivers poll per tick,
   * so one-shot delivery is what they need). Times out when the frame never
   * comes (the channel died / the warp was rejected).
   */
  when(type: string, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.off(type, cb);
        reject(new Error(`client ${this.id}: no ${type} within ${ms} ms`));
      }, ms);
      const cb = (payload: unknown): void => {
        clearTimeout(deadline);
        this.off(type, cb);
        resolve(payload);
      };
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    });
  }

  private off(type: string, cb: (payload: unknown) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((f) => f !== cb);
    if (list.length === 0) this.listeners.delete(type);
    else this.listeners.set(type, list);
  }

  private wire(): void {
    const ws = this.ws!;
    ws.on('message', (data) => {
      const size = Array.isArray(data)
        ? data.reduce((s, chunk) => s + chunk.byteLength, 0)
        : data.byteLength;
      this.msgSizes.push(size);
      let env: { type: string; payload: unknown };
      try {
        env = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (env.type) {
        case 'entity_update': {
          const entities = (env.payload as {
            entities: Array<{ id: string; kind?: string; callsign?: string }>;
          }).entities;
          const byCallsign = new Map<string, Array<{ id: string; kind: string }>>();
          for (const e of entities) {
            if (!e.callsign) continue;
            const list = byCallsign.get(e.callsign) ?? [];
            list.push({ id: e.id, kind: e.kind ?? 'ship' });
            byCallsign.set(e.callsign, list);
          }
          this.lastRawSnapshot = String(data);
          this.lastFrame = { ids: entities.map((e) => e.id), byCallsign, at: performance.now() };
          this.entityUpdates.push(entities.length);
          const now = performance.now();
          if (this.lastSnapshotAt > 0 && !this.inReconnect) {
            this.maxSnapshotGapMs = Math.max(this.maxSnapshotGapMs, now - this.lastSnapshotAt);
          }
          this.lastSnapshotAt = now;
          this.snapshotCount += 1;
          break;
        }
        case 'ack': {
          const ackSeq = (env.payload as { seq: number }).seq;
          const now = performance.now();
          for (const [seq, sentAt] of [...this.pendingInputs]) {
            if (seq <= ackSeq) {
              this.rtts.push(now - sentAt);
              this.pendingInputs.delete(seq);
            }
          }
          break;
        }
        case 'error': {
          const code = (env.payload as { code?: string }).code ?? 'unknown';
          this.errCodes[code] = (this.errCodes[code] ?? 0) + 1;
          // Expected denials (probe rejection, invalid-target re-aims) are
          // bookkeeping; everything else is a failure signal (rate-limit
          // kicks, invalid messages…).
          if (this.id <= 16 && !LoadClient.EXPECTED_ERRORS.has(code)) {
            this.unexpectedErrors.push(code);
          }
          break;
        }
        default:
          for (const cb of this.listeners.get(env.type) ?? []) cb(env.payload);
          break;
      }
    });
    ws.on('close', (code) => {
      // Server-initiated abnormal closes fail the run; client-side 1000s
      // (drops, teardown) are the load test's own doing.
      if (code >= 4000 || code === 1011) this.kickCodes.push(code);
    });
  }

  private waitFor(
    predicate: (e: { type: string; payload: unknown }) => boolean,
    what: string,
    ms: number,
  ): Promise<{ type: string; payload: unknown }> {
    const ws = this.ws!;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error(`client ${this.id}: timed out waiting for ${what}`));
      }, ms);
      const onMsg = (data: unknown): void => {
        const env = JSON.parse(String(data)) as { type: string; payload: unknown };
        if (predicate(env)) {
          cleanup();
          resolve(env);
        }
      };
      const cleanup = (): void => {
        clearTimeout(deadline);
        ws.off('message', onMsg);
      };
      ws.on('message', onMsg);
    });
  }

  /** entity_updates / active seconds (intentional rejoin gaps excluded). */
  snapshotRate(now: number): number {
    const anchor = this.firstJoinedAt > 0 ? this.firstJoinedAt : now;
    const activeMs = Math.max(1, now - anchor - this.rejoinDowntimeMs);
    return this.snapshotCount / (activeMs / 1000);
  }

  rttWindow(): RttWindow {
    if (this.rtts.length === 0) return { p50: 0, p95: 0, max: 0, n: 0 };
    const s = [...this.rtts].sort((a, b) => a - b);
    const q = (p: number): number => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], n: s.length };
  }

  /** Duplicate ids inside a single entity_update frame: 0 when consistent. */
  dupIdsInFrame(): number {
    const frame = this.lastFrame;
    if (!frame) return -1;
    return frame.ids.length - new Set(frame.ids).size;
  }
}

/** p-th percentile (0..1) of a numeric array; 0 when empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
