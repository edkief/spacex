import { expect, type Locator } from '@playwright/test';
import { BasePage } from '../base-page';

/**
 * Callsign-claim screen (TASK-70, reworked in TASK-56 into the centered
 * claims panel with the live availability check). The claim form is the
 * only entry point to a session: POST /api/callsigns → token → WS join,
 * all done by the app automatically after a successful claim.
 */
export class ClaimPage extends BasePage {
  readonly callsignInput: Locator;
  /** The Claim button (enabled once the debounced availability probe passes). */
  readonly joinButton: Locator;
  readonly playerList: Locator;

  constructor(page: ConstructorParameters<typeof BasePage>[0], base: string) {
    super(page, base);
    this.callsignInput = page.locator('#callsign-input');
    this.joinButton = page.getByRole('button', { name: /claim/i });
    this.playerList = page.locator('#player-list');
  }

  /**
   * Claim a callsign and wait until the session is in-system: the player
   * list shows our own "(you)" row and the system status line is up.
   * `sysId` overrides the join target (?sys= param) to meet a peer.
   */
  async claim(callsign: string, sysId?: string): Promise<void> {
    await this.goto(sysId ? `/?sys=${sysId}` : '/');
    await this.callsignInput.fill(callsign);
    await this.joinButton.click();
    await expect(this.playerList).toContainText(`${callsign} (you)`);
    await expect(this.page.locator('#sys-id')).toBeVisible();
  }

  /** The 16-hex system id from the status line ("sys <id> · N aboard"). */
  async systemId(): Promise<string> {
    const text = (await this.page.locator('#sys-id').textContent()) ?? '';
    const match = text.match(/sys ([0-9a-f]{16})/);
    if (!match) throw new Error(`no system id in status line: ${text}`);
    return match[1];
  }
}
