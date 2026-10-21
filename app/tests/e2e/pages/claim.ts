/**
 * TASK-70 — Page object for the Drift claim/join screen.
 *
 * Since TASK-56 the shell opens on the claims screen (no stored
 * token → `ClaimsScreen`). The page object keeps the pre-TASK-56
 * contract — `bootAndWaitForOnline()` returns with a live session —
 * by claiming a `Drift-<random>` callsign over the REST API and
 * seeding the resulting token into `localStorage` BEFORE the first
 * navigation. The app then takes the "returning player" branch
 * (`GET /api/session` → join) with no 500 ms probe debounce in the
 * way.
 *
 * The interactive claim path (typing a callsign, the availability
 * probe, the Claim button) is covered by `first-launch.spec.ts`.
 *
 * Repeated selectors live here so a UI rename only touches one
 * file. The page object pattern (per the e2e-tester skill) is
 * used because the harness tests share several assertions
 * (header pill, player list, canvas).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { DriftServer } from "../fixtures.js";

export class ClaimPage {
  readonly canvas: Locator;
  readonly header: Locator;
  readonly playerList: Locator;
  readonly playerListCount: Locator;
  readonly chatLog: Locator;
  readonly chatLogScroll: Locator;
  readonly toastStack: Locator;
  readonly server: DriftServer;

  constructor(
    public readonly page: Page,
    server: DriftServer,
  ) {
    this.canvas = page.getByTestId("drift-canvas");
    this.header = page.getByTestId("drift-header");
    this.playerList = page.getByTestId("drift-player-list");
    this.playerListCount = page.getByTestId("drift-player-list-count");
    this.chatLog = page.getByTestId("drift-chat-log");
    this.chatLogScroll = page.getByTestId("drift-chat-log-scroll");
    this.toastStack = page.getByTestId("drift-toast-stack");
    this.server = server;
  }

  /**
   * Claim a callsign over the REST API and seed the token into
   * `localStorage` before the first navigation. Skips when the
   * page already carries a token (repeat boots in the same test).
   */
  async seedSession(): Promise<string> {
    const existing = await this.page
      .evaluate(() => window.localStorage.getItem("drift.token"))
      .catch(() => null);
    if (typeof existing === "string" && existing.length > 0) return existing;

    const callsign = `Drift-${Math.random().toString(36).slice(2, 8)}`;
    const res = await this.page.request.post(`${this.server.baseURL}/api/callsigns`, {
      data: { callsign },
    });
    if (!res.ok()) {
      throw new Error(`seedSession: claim failed with ${res.status()}`);
    }
    const body = (await res.json()) as { token: string };
    await this.page.addInitScript(
      ([key, value]: [string, string]) => {
        window.localStorage.setItem(key, value);
      },
      ["drift.token", body.token],
    );
    return callsign;
  }

  /**
   * Boot the app and wait for the session handshake to land.
   *
   * The shell restores the seeded token via `GET /api/session`,
   * then runs `hello → auth → join_system`. The header pill flips
   * to the player's callsign once `auth_ok` arrives, so we wait
   * for that callsign (`Drift-…`) before handing control back.
   */
  async bootAndWaitForOnline(timeoutMs = 15_000): Promise<void> {
    await this.seedSession();
    await this.page.goto(`${this.server.baseURL}/`);
    await this.canvas.waitFor({ state: "visible", timeout: timeoutMs });
    await this.header.waitFor({ state: "visible", timeout: timeoutMs });
    // Wait for `auth_ok` — the header pill text includes the
    // callsign once the handshake completes.
    await expectHeaderOnline(this.header, timeoutMs);
  }

  /** Returns the callsign the DriftClient received from `auth_ok`. */
  async currentCallsign(): Promise<string | null> {
    return this.page.evaluate(() => {
      const w = window as unknown as { __driftClient?: { currentCallsign: string | null } };
      return w.__driftClient?.currentCallsign ?? null;
    });
  }

  /** Returns the current system id from the DriftClient (null until joined). */
  async currentSystemId(): Promise<string | null> {
    return this.page.evaluate(() => {
      const w = window as unknown as { __driftClient?: { currentSystemId: string | null } };
      return w.__driftClient?.currentSystemId ?? null;
    });
  }

  /**
   * Force the client into a specific system. Useful when the
   * auto-claim lands the player in a home system that another
   * test already populated; we drive both clients into a clean
   * one for deterministic 2-context assertions.
   */
  async joinSystem(systemId: string): Promise<void> {
    await this.page.evaluate((sysId) => {
      const w = window as unknown as { __driftClient?: { joinSystem(id: string): Promise<void> } };
      const client = w.__driftClient;
      if (!client) throw new Error("expected window.__driftClient to be wired up");
      return client.joinSystem(sysId);
    }, systemId);
  }

  /** Send a chat message via the debug seam. */
  async sendChat(text: string): Promise<void> {
    await this.page.evaluate((t) => {
      const w = window as unknown as { __driftClient?: { sendChat(text: string): void } };
      w.__driftClient?.sendChat(t);
    }, text);
  }

  /** Read the chat store snapshot. */
  async chatSnapshot(): Promise<Array<{ id: string; author: string; text: string; ts: number }>> {
    return this.page.evaluate(() => {
      const w = window as unknown as {
        __driftClient?: {
          chatStore: {
            snapshot(): Array<{ id: string; author: string; text: string; ts: number }>;
          };
        };
      };
      return w.__driftClient?.chatStore.snapshot() ?? [];
    });
  }
}

/**
 * Wait until the header pill text contains the online-state
 * callsign. Drift's header reads `Drift — <statusLabel>` where
 * `statusLabel` is the callsign when online (TASK-15).
 */
export async function expectHeaderOnline(header: Locator, timeoutMs = 15_000): Promise<void> {
  await expect(header).toContainText(/Drift-/, { timeout: timeoutMs });
}
