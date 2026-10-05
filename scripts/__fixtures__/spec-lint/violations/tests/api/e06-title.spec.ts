import { test, expect } from "@fixtures/api-fixture";

test.describe("GET /api/admin/users", () => {
  // SCN-106
  test("should list admins", async ({ api, ownerToken }) => {
    // Arrange & Act
    const result = await api.admin.listAdmins(ownerToken);

    // Assert - FR-11.1
    expect(result.status).toBe(200);
  });
});
