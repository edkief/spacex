import type { Page } from '@playwright/test';

/** Parent for all e2e pages (TASK-70): owns navigation against the fixture's base URL. */
export class BasePage {
  constructor(
    protected readonly page: Page,
    protected readonly base: string,
  ) {}

  async goto(path = '/'): Promise<void> {
    await this.page.goto(this.base + path, { waitUntil: 'domcontentloaded' });
  }
}
