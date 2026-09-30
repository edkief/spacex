import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../base-page';
import { canvasLuminanceVariance } from '../helpers';

/** In-system game screen (TASK-70 page object): canvas, player list, chat. */
export class GamePage extends BasePage {
  readonly canvas: Locator;
  readonly playerList: Locator;
  readonly chatLog: Locator;
  readonly chatInput: Locator;

  constructor(page: ConstructorParameters<typeof BasePage>[0], base: string) {
    super(page, base);
    this.canvas = page.locator('#game-canvas');
    this.playerList = page.locator('#player-list');
    this.chatLog = page.locator('#chat-log');
    this.chatInput = page.locator('#chat-input');
  }

  /**
   * Render smoke: sample 32x32 GL pixels on the canvas and return luminance
   * variance. > 0 proves WebGL drew something non-uniform (not black/flat).
   */
  async canvasPixelVariance(): Promise<number> {
    return canvasLuminanceVariance(this.page as Page);
  }

  /** Enter-toggled chat: open (Enter), type, send (Enter); the input closes. */
  async sendChat(text: string): Promise<void> {
    await this.page.keyboard.press('Enter');
    await expect(this.chatInput).toBeVisible();
    await this.chatInput.fill(text);
    await this.chatInput.press('Enter');
    await expect(this.chatInput).toBeHidden();
  }

  /** True once our own callsign shows "(you)" in the player list. */
  async isAboard(callsign: string): Promise<boolean> {
    const text = (await this.playerList.textContent()) ?? '';
    return text.includes(`${callsign} (you)`);
  }
}
