import { test, expect } from "@fixtures/api-fixture";

test.describe("GET /api/admin/users", () => {
  // SCN-101
  test("List admins - Should wait for the record to settle", async ({ api, ownerToken, page }) => {
    // Arrange
    await page.waitForTimeout(3000);

    // Act
    const result = await api.admin.listAdmins(ownerToken);

    // Assert - FR-11.1
    expect(result.status).toBe(200);
  });
});
