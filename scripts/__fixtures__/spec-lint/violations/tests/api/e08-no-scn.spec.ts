import { test, expect } from "@fixtures/api-fixture";

test.describe("GET /api/admin/users", () => {
  test("List admins - Should return the admin list", async ({ api, ownerToken }) => {
    // Arrange & Act
    const result = await api.admin.listAdmins(ownerToken);

    // Assert - FR-11.1
    expect(result.status).toBe(200);
  });
});
