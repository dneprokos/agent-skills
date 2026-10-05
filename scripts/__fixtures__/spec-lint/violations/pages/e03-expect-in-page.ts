import { expect, Locator, Page } from "@playwright/test";

export class ToastPage {
  readonly toast: Locator;

  constructor(public readonly page: Page) {
    this.toast = page.getByRole("status");
  }

  async deleteAdmin(email: string): Promise<void> {
    await this.page.getByRole("row").filter({ hasText: email }).getByRole("button").click();
    await expect(this.toast).toBeVisible();
  }
}
