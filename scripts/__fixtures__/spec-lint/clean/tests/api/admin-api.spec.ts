import { test, expect } from "@fixtures/api-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";
import { AuthTestData } from "@utils/test-data/auth-test-data";

test.describe("POST /api/admin/users", () => {
  // SCN-012
  test("Create admin - Should create an admin with a valid payload", async ({
    api,
    ownerToken,
    createdAdminEmails,
  }) => {
    // Arrange
    const newAdminEmail = AdminTestData.uniqueApiEmail();
    createdAdminEmails.push(newAdminEmail);

    // Act
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(newAdminEmail)
      .withPassword(AdminTestData.DEFAULT_PASSWORD)
      .withConfirmPassword(AdminTestData.DEFAULT_PASSWORD)
      .sendCreateAdmin();

    // Assert - FR-11.1
    expect(result.status).toBe(201);
  });

  // SCN-013
  test("Create admin - Should reject a malformed bearer token", async ({ api }) => {
    // Arrange & Act
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(AuthTestData.MALFORMED_TOKEN)
      .sendListAdmins();

    // Assert - FR-11.2
    expect(result.status).toBe(401);
  });
});
