import { Locator, Page } from "@playwright/test";

export class GameDetailPage {
  readonly genreCell: Locator;

  constructor(public readonly page: Page) {
    // LOCATOR-FALLBACK: tier 2 - the cell carries no role name, no label and no
    // data-testid; #game-genre is written in the template, not generated.
    this.genreCell = page.locator("#game-genre");
  }
}
