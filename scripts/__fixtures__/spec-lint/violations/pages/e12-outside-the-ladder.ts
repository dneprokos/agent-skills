import { Locator, Page } from "@playwright/test";

export class AdminsTablePage {
  readonly deleteButton: Locator;
  readonly secondAdminRow: Locator;
  readonly panelHeading: Locator;

  constructor(public readonly page: Page) {
    this.deleteButton = page.locator(".css-1a2b3c");
    this.secondAdminRow = page.getByRole("row").nth(2);
    this.panelHeading = page.locator("xpath=//h1[1]");
  }
}
