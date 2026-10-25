import { Page, Locator } from '@playwright/test';

export class ClaimPage {
  readonly page: Page;
  readonly callsignInput: Locator;
  readonly claimButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.callsignInput = page.locator('input[placeholder="CALLSIGN"]');
    this.claimButton = page.locator('button:has-text("Claim and Enter System")');
    this.errorMessage = page.locator('p[style*="color: rgb(255, 68, 68)"]');
  }

  async claimCallsign(callsign: string) {
    await this.callsignInput.waitFor({ state: 'visible' });
    await this.callsignInput.fill(callsign);
    await this.claimButton.click();
  }

  async getErrorMessage(): Promise<string | null> {
    if (await this.errorMessage.isVisible()) {
      return await this.errorMessage.textContent();
    }
    return null;
  }
}
