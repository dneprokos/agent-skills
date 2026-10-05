import { test, expect } from "@fixtures/api-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";

test.describe("POST /api/admin/users", () => {
  // SCN-110
  test("Create admin - Should create an admin with a valid payload", async ({ api, ownerToken }) => {
    // Arrange - the UI stream's generator, whose prefix collides with nothing here
    const email = AdminTestData.uniqueUiEmail();

    // Act
    const result = await api.admin.createAdmin(ownerToken, AdminTestData.createAdminPayload(email));

    // Assert - FR-11.1
    expect(result.status).toBe(201);
  });
});
