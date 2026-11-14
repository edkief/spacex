import type { Connection } from './connection.ts';

/** Registry of open connections, indexed by system for room-style broadcasts (chat). */
export class Hub {
  private readonly all = new Set<Connection>();
  private readonly bySystem = new Map<string, Set<Connection>>();

  add(conn: Connection): void {
    this.all.add(conn);
  }

  remove(conn: Connection): void {
    this.all.delete(conn);
    this.leaveSystem(conn);
  }

  /** Files an in-system connection under its system. */
  enterSystem(conn: Connection, systemId: string): void {
    this.leaveSystem(conn);
    const here = this.bySystem.get(systemId) ?? new Set<Connection>();
    here.add(conn);
    this.bySystem.set(systemId, here);
  }

  leaveSystem(conn: Connection): void {
    if (conn.systemId) this.bySystem.get(conn.systemId)?.delete(conn);
  }

  connections(): Iterable<Connection> {
    return this.all;
  }

  inSystem(systemId: string): Iterable<Connection> {
    return this.bySystem.get(systemId) ?? [];
  }

  get size(): number {
    return this.all.size;
  }
}
