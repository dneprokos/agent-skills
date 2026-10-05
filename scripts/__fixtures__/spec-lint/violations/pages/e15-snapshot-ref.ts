import { Locator, Page } from "@playwright/test";

export class ExploredPage {
  readonly searchInput: Locator;

  constructor(public readonly page: Page) {
    this.searchInput = page.getByTestId(e7);
  }
}
