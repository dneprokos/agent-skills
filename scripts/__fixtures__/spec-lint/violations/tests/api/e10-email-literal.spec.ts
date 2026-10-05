import { test, expect } from "@fixtures/api-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";

test.describe("POST /api/admin/users", () => {
  // SCN-111
  test("Create admin - Should reject a duplicate e-mail", async ({ api, ownerToken }) => {
    // Arrange
    const email = "new.admin+qa@example.com";

    // Act
    const result = await api.admin.createAdmin(ownerToken, AdminTestData.createAdminPayload(email));

    // Assert - FR-11.2
    expect(result.status).toBe(409);
  });
});
