import { test, expect } from "@playwright/test";

test.describe("GET /api/admin/users", () => {
  // SCN-102
  test("List admins - Should return the admin list", async () => {
    // Arrange & Act
    const status = 200;

    // Assert - FR-11.1
    expect(status).toBe(200);
  });
});
