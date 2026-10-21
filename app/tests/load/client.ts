/**
 * One load-test WebSocket client — TASK-18.
 *
 * A real `ws` socket against the real server: `hello` -> `auth` ->
 * `join_system`, then a scripted role (`flyer` | `foot` | `warper` |
 * `idle`) driven off a 100 ms timer. Every client measures the
 * metrics the acceptance criteria name:
 *
 *   - `entity_update` arrival rate + the longest silence (starvation),
 *   - inbound frame size (p95 / max bytes),
 *   - input -> snapshot-ack RTT, using the TASK-14 `lastAppliedSeq`
 *     echo: send `input { seq }`, then stop the clock when the next
 *     `entity_update` acks that seq for our player id,
 *   - entity-list consistency (no duplicate ids in a snapshot),
 *   - disconnect / reconnect timing for the reconnect wave.
 */
import { WebSocket as WsSocket } from "ws";

import { encodeEnvelope, PROTOCOL_VERSION } from "@shared/protocol/index.js";
import { percentile, type ClientReport } from "./report.js";

/** Scripted behaviours, mapped to roles by the harness. */
export type Role = "flyer" | "foot" | "warper" | "idle";

/** Construction parameters. */
export interface LoadClientOptions {
  url: string;
  token: string;
  callsign: string;
  systemId: string;
  role: Role;
  /** Second system — the `warper` role alternates to it every 60 s. */
  altSystemId?: string;
  /** Input cadence, ms. Defaults to 100 (10 Hz, one frame per snapshot). */
  driveIntervalMs?: number;
}

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

const now = (): number => performance.now();

/**
 * Scripted load client. Not a game client — it never predicts,
 * interpolates or renders; it only generates protocol traffic and
 * measures the server's response.
 */
export class LoadClient {
  public readonly callsign: string;
  public readonly role: Role;

  private ws: WsSocket | null = null;
  private driveTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private tickCount = 0;
  private playerId: string | null = null;
  private currentSystem: string;
  private readonly altSystemId: string | undefined;
  private readonly url: string;
  private readonly token: string;
  private readonly driveIntervalMs: number;

  // --- measurement state -------------------------------------------------
  private snapshots = 0;
  private firstSnapshotAt = 0;
  private lastSnapshotAt = 0;
  private maxGapMs = 0;
  private frameBytes: number[] = [];
  private rttSamples: number[] = [];
  private readonly pending = new Map<number, number>();
  private duplicateEntityIds = 0;
  private entityIds = new Set<string>();
  private readonly errorCodes: Record<string, number> = {};
  private kicked = false;
  private reconnects = 0;
  private rejoinMs: number | null = null;
  private entityCountAfterRejoin = 0;
  private miningUpdates = 0;
  private warpsOk = 0;
  private warpAttempts = 0;
  private depositId: string | null = null;
  private lastFireAt = 0;
  private lastMineAt = 0;
  private lastWarpAt = 0;
  private awaitRejoin = false;
  private readonly waiters: { type: string; resolve: (f: Frame) => void; timer: NodeJS.Timeout }[] =
    [];

  constructor(opts: LoadClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.callsign = opts.callsign;
    this.role = opts.role;
    this.currentSystem = opts.systemId;
    this.homeSystemId = opts.systemId;
    this.altSystemId = opts.altSystemId;
    this.driveIntervalMs = opts.driveIntervalMs ?? 100;
  }

  /** Open the socket and run the `hello` -> `auth` handshake. */
  async connect(): Promise<void> {
    const ws = new WsSocket(this.url, { perMessageDeflate: false });
    this.ws = ws;
    ws.on("message", (data: Buffer) => this.onMessage(data));
    ws.on("close", (code: number) => {
      if (code === 4001) this.kicked = true;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve({ type: "__closed__", payload: {} });
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    this.send("hello", { version: PROTOCOL_VERSION });
    await this.waitFor("hello");
    this.send("auth", { token: this.token });
    const authOk = await this.waitFor("auth_ok");
    this.playerId = String((authOk.payload as { playerId: string }).playerId);
  }

  /** Join the shard this client lives in. Resolves on `enter_system`. */
  async joinSystem(systemId: string, timeoutMs = 5000): Promise<Frame> {
    this.currentSystem = systemId;
    this.send("join_system", { systemId });
    const frame = await this.waitFor("enter_system", timeoutMs);
    this.absorbEntityList(frame);
    this.awaitRejoin = false;
    if (frame.type !== "enter_system") return frame;
    if (this.reconnects > 0) this.entityCountAfterRejoin = this.entityIds.size;
    return frame;
  }

  /** Start the scripted role loop. */
  startDriving(): void {
    if (this.driveTimer) return;
    this.driveTimer = setInterval(() => this.drive(), this.driveIntervalMs);
    this.lastFireAt = now();
    this.lastMineAt = now();
    this.lastWarpAt = now();
  }

  /**
   * Drop the socket and bring it back (same token + same system).
   * Resolves with the wall-clock ms the rejoin took.
   */
  async dropAndRejoin(): Promise<number> {
    const started = now();
    this.awaitRejoin = true;
    this.ws?.close();
    await new Promise<void>((resolve) => {
      this.ws?.once("close", () => resolve());
      setTimeout(resolve, 500);
    });
    await this.connect();
    await this.joinSystem(this.currentSystem);
    this.reconnects += 1;
    const elapsed = now() - started;
    this.rejoinMs = elapsed;
    return elapsed;
  }

  /** Close the socket for good. */
  close(): void {
    if (this.driveTimer) clearInterval(this.driveTimer);
    this.driveTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  /** Snapshot of everything measured so far. */
  report(): ClientReport {
    const activeSeconds =
      this.lastSnapshotAt > 0 && this.firstSnapshotAt > 0
        ? (this.lastSnapshotAt - this.firstSnapshotAt) / 1000
        : 0;
    return {
      callsign: this.callsign,
      role: this.role,
      snapshots: this.snapshots,
      activeSeconds,
      snapshotHz: activeSeconds > 0 ? this.snapshots / activeSeconds : 0,
      maxGapMs: this.maxGapMs,
      maxBytes: this.frameBytes.length > 0 ? Math.max(...this.frameBytes) : 0,
      p95Bytes: percentile(this.frameBytes, 0.95),
      rttSamples: this.rttSamples,
      rttP50Ms: percentile(this.rttSamples, 0.5),
      rttP95Ms: percentile(this.rttSamples, 0.95),
      entityIds: this.entityIds.size,
      duplicateEntityIds: this.duplicateEntityIds,
      errorCodes: { ...this.errorCodes },
      kicked: this.kicked,
      reconnects: this.reconnects,
      rejoinMs: this.rejoinMs,
      entityCountAfterRejoin: this.entityCountAfterRejoin > 0 ? this.entityCountAfterRejoin : null,
      miningUpdates: this.miningUpdates,
      warpsOk: this.warpsOk,
      warpAttempts: this.warpAttempts,
    };
  }

  /** The authenticated player id (undefined before `connect()` resolves). */
  get id(): string | undefined {
    return this.playerId ?? undefined;
  }

  /** Ids from the most recent entity list — the consistency checker reads it. */
  observedEntityIds(): ReadonlySet<string> {
    return this.entityIds;
  }

  // -------------------------------------------------------------------------

  private send(type: string, payload: unknown): void {
    if (this.ws && this.ws.readyState === WsSocket.OPEN) {
      this.ws.send(encodeEnvelope(type as never, payload as never));
    }
  }

  /**
   * Resolve on the next frame of `type`. Rejects (via a synthetic
   * `__closed__` frame) if the socket closes first, so callers never
   * hang past the handshake timeout.
   */
  private waitFor(type: string, timeoutMs = 5000): Promise<Frame> {
    return new Promise<Frame>((resolve) => {
      const timer = setTimeout(() => resolve({ type: "__timeout__", payload: {} }), timeoutMs);
      this.waiters.push({ type, resolve, timer });
    });
  }

  private onMessage(data: Buffer): void {
    let frame: Frame;
    try {
      frame = JSON.parse(data.toString("utf8")) as Frame;
    } catch {
      return;
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.type === frame.type) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
    switch (frame.type) {
      case "entity_update":
        this.onEntityUpdate(frame, data.byteLength);
        break;
      case "enter_system":
        this.absorbEntityList(frame);
        break;
      case "warp_arrived": {
        this.absorbEntityList(frame);
        this.warped = true;
        this.noteWarpArrived();
        const arrived = String((frame.payload as { systemId: string }).systemId);
        if (arrived.length > 0) this.currentSystem = arrived;
        break;
      }
      case "mining_update":
        this.miningUpdates += 1;
        break;
      case "error": {
        const code = String((frame.payload as { code: string }).code ?? "unknown");
        this.errorCodes[code] = (this.errorCodes[code] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  private onEntityUpdate(frame: Frame, bytes: number): void {
    const t = now();
    if (this.firstSnapshotAt === 0) this.firstSnapshotAt = t;
    if (this.lastSnapshotAt > 0) {
      this.maxGapMs = Math.max(this.maxGapMs, t - this.lastSnapshotAt);
    }
    this.lastSnapshotAt = t;
    this.snapshots += 1;
    this.frameBytes.push(bytes);
    const payload = frame.payload as {
      entities?: { id: string }[];
      lastAppliedSeq?: Record<string, number>;
    };
    // Entity consistency: duplicate ids inside one frame are corruption.
    const seen = new Set<string>();
    for (const entity of payload.entities ?? []) {
      if (seen.has(entity.id)) this.duplicateEntityIds += 1;
      seen.add(entity.id);
    }
    this.entityIds = seen;
    // RTT: match the server's `lastAppliedSeq` echo (TASK-14).
    const ack = this.playerId ? payload.lastAppliedSeq?.[this.playerId] : undefined;
    if (ack !== undefined) {
      for (const [seq, sentAt] of this.pending) {
        if (seq <= ack) {
          this.rttSamples.push(t - sentAt);
          this.pending.delete(seq);
        }
      }
    }
  }

  private absorbEntityList(frame: Frame): void {
    const payload = frame.payload as { entities?: { id: string }[]; nodes?: { id: string }[] };
    const seen = new Set<string>();
    for (const entity of payload.entities ?? []) seen.add(entity.id);
    this.entityIds = seen;
    const nodes = payload.nodes ?? [];
    if (this.depositId === null && nodes.length > 0) this.depositId = nodes[0]!.id;
  }

  /**
   * One tick of the role script. Deterministic per role: the flyer
   * flies a fixed pattern + fires, the on-foot character walks and
   * re-opens a mining channel, the warper alternates systems every
   * 60 s, the idler does nothing (pure snapshot consumer).
   */
  private drive(): void {
    this.tickCount += 1;
    const t = now();
    switch (this.role) {
      case "flyer": {
        this.sendInput(Math.sin(this.tickCount / 20), this.tickCount % 40 < 20 ? 0.4 : -0.2);
        if (t - this.lastFireAt >= 500) {
          this.lastFireAt = t;
          this.send("fire", { weapon: this.tickCount % 100 < 50 ? "laser" : "missile" });
        }
        break;
      }
      case "foot": {
        this.sendInput(Math.cos(this.tickCount / 25), 0.3);
        if (this.tickCount % 40 === 0) this.send("exit_ship", {});
        if (t - this.lastMineAt >= 2000) {
          this.lastMineAt = t;
          if (this.depositId !== null) {
            this.send("mine", { nodeId: this.depositId, duration: 1500 });
          }
        }
        break;
      }
      case "warper": {
        if (t - this.lastWarpAt >= 60_000 && this.altSystemId !== undefined) {
          this.lastWarpAt = t;
          this.warpAttempts += 1;
          this.send("warp", {
            targetSystemId: this.warped ? this.homeSystemId : this.altSystemId,
          });
        }
        break;
      }
      case "idle":
        break;
    }
  }

  /** True once a `warper` has crossed to `altSystemId`. */
  private warped = false;
  /** The system this client joined originally (its warp home). */
  private readonly homeSystemId: string;

  /**
   * Send one `input` frame with a monotonic seq and stamp it so the
   * snapshot ack can be turned into an RTT sample.
   */
  private sendInput(turn: number, thrust: number): void {
    this.seq += 1;
    this.pending.set(this.seq, now());
    if (this.pending.size > 64) {
      // Bounded: if acks stop arriving we drop the oldest rather than leak.
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.send("input", {
      seq: this.seq,
      thrust,
      turn,
      pitch: 0,
      yaw: 0,
      fire: false,
      lock: false,
      action: null,
    });
  }

  /** Called by the harness once a warp lands so the count stays honest. */
  noteWarpArrived(): void {
    this.warpsOk += 1;
  }

  /** True while the client is mid-rejoin (used by the harness). */
  get rejoining(): boolean {
    return this.awaitRejoin;
  }
}
