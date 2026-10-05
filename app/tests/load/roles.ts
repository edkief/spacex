import type { LoadClient } from './client';

/**
 * TASK-18: the scripted client roles. One driver per client; the harness
 * steps every driver on a 100 ms cadence (10 Hz inputs — under the 20 msg/s
 * inbound bucket even with the fire/tick one-shots riding the same socket).
 * Deterministic patterns (phase = client id × golden angle): no two clients
 * hit the server on the same phase, so the worst-case tick cost comes from
 * the SUM of the roles, not from correlated bursts.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RoleDeps {
  /** The other load clients' callsigns (fire targets / consistency checks). */
  peerCallsigns: Set<string>;
  selfCallsign: string;
  /** foot only: deposit ids to cycle (pre-seeded a meter from the character). */
  deposits?: string[];
  /** foot: the pad terminal (the sell cycle walks there when the backpack fills). */
  terminalPos?: Vec3;
  /** foot: the character's mining spot (where the deposits are). */
  charHome?: Vec3;
  /** foot: hard-set the character's position (the e2e teleport hook). */
  teleportChar?: (pos: Vec3) => void;
}

export interface RoleDriver {
  /** 100 ms cadence step; `now` = performance.now(). */
  step(now: number): void;
  /** foot: re-open the mining channel after a rejoin (the old one died). */
  rejoin(): void;
}

const GOLDEN = 2.399963; // radians — spreads the 16 clients' phases

function flyingDriver(client: LoadClient, deps: RoleDeps): RoleDriver {
  let phase = client.id * GOLDEN;
  let targetId: string | null = null;
  let lastFire = 0;
  let lastTargetAt = 0;
  return {
    step(now: number): void {
      phase += 0.17;
      // Cruise + gentle figure-eight: full thrust, sinusoidal attitude.
      client.sendInput({
        thrust: 1,
        turn: Math.sin(phase) * 0.6,
        pitch: Math.sin(phase / 1.3) * 0.3,
        yaw: Math.cos(phase / 0.7) * 0.3,
      });
      // Re-aim every 5 s: nearest peer SHIP in the latest shared snapshot
      // (a destroyed ship drops out; the next frame re-targets).
      if (now - lastTargetAt > 5_000) {
        lastTargetAt = now;
        let next: string | null = null;
        const frame = client.lastFrame;
        if (frame) {
          for (const cs of deps.peerCallsigns) {
            if (cs === deps.selfCallsign) continue;
            const ships = frame.byCallsign.get(cs)?.filter((e) => e.kind === 'ship');
            if (ships && ships.length > 0) {
              next = ships[0].id;
              break;
            }
          }
        }
        if (next !== targetId) {
          targetId = next;
          if (next) client.send('target_lock', { targetId: next });
          else client.send('target_release', {});
        }
      }
      // Laser at ~3/s (the server's per-weapon fireRate is the real gate).
      if (now - lastFire > 340) {
        lastFire = now;
        client.send('fire', targetId ? { weapon: 'laser', targetId } : { weapon: 'laser' });
      }
    },
    rejoin(): void {
      targetId = null; // the lock state is per-connection: re-acquire
    },
  };
}

function footDriver(client: LoadClient, deps: RoleDeps): RoleDriver {
  const deposits = deps.deposits ?? [];
  let depositIdx = 0;
  let depositId: string | null = deposits[0] ?? null;
  let channelOpen = false;
  let lastTickSent = 0;
  let lastDropAt = 0;
  const openChannel = (): void => {
    if (!depositId) return;
    client.send('interact', { targetId: depositId, action: 'mine-start' });
    channelOpen = true;
  };
  client.on('mining', (payload) => {
    const frame = payload as {
      phase: 'active' | 'ended';
      reason?: 'stopped' | 'cancelled' | 'depleted';
      status?: 'mining' | 'full';
    };
    if (frame.phase === 'active') {
      // Backpack full (exactly 40 u of 1-u iron): walk the ore to the pad
      // terminal and SELL it (the real resource loop — no ground items pile
      // up, the entity count stays flat for the whole run). The teleport
      // hook stands the character at the terminal, the sell commits, the
      // character is put back at the deposit and the channel re-opens.
      if (frame.status === 'full' && performance.now() - lastDropAt > 1_500) {
        lastDropAt = performance.now();
        if (deps.terminalPos && deps.charHome && deps.teleportChar) {
          deps.teleportChar({ x: deps.terminalPos.x + 0.5, y: deps.terminalPos.y, z: deps.terminalPos.z });
          client.send('sell', { resourceId: 'iron', amount: 40, source: 'inv' });
          setTimeout(() => {
            deps.teleportChar?.(deps.charHome!);
            openChannel();
          }, 400);
        } else {
          // No terminal available (shouldn't happen in the seeded system):
          // drop the ore at the character's feet instead.
          client.send('drop', { resourceId: 'iron', amount: 25 });
        }
      }
      return;
    }
    channelOpen = false;
    if (frame.reason === 'depleted' && depositIdx + 1 < deposits.length) {
      depositIdx += 1;
      depositId = deposits[depositIdx];
      openChannel();
    }
  });
  return {
    step(now: number): void {
      // Stand and hold the channel: zero-demand frames keep the character
      // lane warm (walking > 3 m would cancel the channel — by design).
      client.sendInput({ thrust: 0, turn: 0, pitch: 0, yaw: 0 });
      if (channelOpen && depositId && now - lastTickSent > 1_000) {
        lastTickSent = now;
        client.send('interact', { targetId: depositId, action: 'mine-tick' });
      }
    },
    rejoin(): void {
      // The disconnect killed the channel (input lane dropped); re-open it
      // on the SAME deposit — the character never moved.
      openChannel();
    },
  };
}

function idleDriver(): RoleDriver {
  return { step(): void {}, rejoin(): void {} };
}

export function createRoleDriver(
  client: LoadClient,
  role: LoadClient['role'],
  deps: RoleDeps,
): RoleDriver {
  switch (role) {
    case 'flying':
      return flyingDriver(client, deps);
    case 'foot':
      return footDriver(client, deps);
    default:
      return idleDriver();
  }
}
