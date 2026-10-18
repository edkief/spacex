/**
 * TASK-70 — Page object for the Drift claim/join screen.
 *
 * The Drift client auto-claims a `Drift-<random>` callsign on
 * mount, so the "claim" UI surface is the auto-claim handshake
 * rather than a visible form. The page object exposes the
 * selectors + waits that future e2e tests need to drive the
 * flow without re-typing the magic test-ids everywhere.
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
   * Boot the app and wait for the auto-claim handshake to land.
   *
   * The DriftClient runs a `claim → hello → auth → join_system`
   * sequence on mount; the header pill flips to the player's
   * callsign once `auth_ok` arrives. We wait for that callsign
   * (`Drift-…` for an auto-claim) so the test sees a fully
   * connected client.
   */
  async bootAndWaitForOnline(timeoutMs = 15_000): Promise<void> {
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
