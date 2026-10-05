import { Locator, Page } from "@playwright/test";

/** The Owner Panel. It ships no data-testid, so every locator here is role-based. */
export class OwnerPage {
  readonly pageTitle: Locator;
  readonly adminsTable: Locator;
  readonly adminRows: Locator;

  constructor(public readonly page: Page) {
    this.pageTitle = page.getByRole("heading", { name: "OWNER PANEL" });
    this.adminsTable = page.getByRole("table");
    // nth(1) indexes the table's structural rowgroup - its body - not a data row.
    this.adminRows = this.adminsTable.getByRole("rowgroup").nth(1).getByRole("row");
  }

  rowFor(email: string): Locator {
    return this.adminRows.filter({ hasText: email });
  }

  async waitForRowToGo(previous: Locator): Promise<void> {
    await previous.waitFor({ state: "detached" });
  }
}
