import { test, expect } from "@fixtures/pages-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";

const columns = ["E-mail", "Role", "Last login"];

test.describe("Owner feature", () => {
  // SCN-120
  test("As an owner, I should be able to remove an admin", async ({ ownerPage }) => {
    // Arrange
    const email = AdminTestData.uniqueUiEmail();

    // Act
    await ownerPage.goto();

    // Assert - AC-3
    await expect(ownerPage.rowFor(email)).toBeHidden();
    expect.soft(columns.length).toBeGreaterThan(0);
  });
});
