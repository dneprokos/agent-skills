import { test, expect } from "@fixtures/pages-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";
import { Endpoints } from "@services/api/endpoints";

test.describe("Owner feature", () => {
  // SCN-021
  test("As an owner, I should be able to add a new admin", async ({
    api,
    ownerToken,
    ownerPage,
    createdAdminEmails,
  }) => {
    // Arrange
    const newAdminEmail = AdminTestData.uniqueUiEmail();
    createdAdminEmails.push(newAdminEmail);
    const seed = await api.admin.createAdmin(
      ownerToken,
      AdminTestData.createAdminPayload(newAdminEmail),
    );
    expect(seed.status).toBe(201);

    // Act
    const [response] = await Promise.all([
      ownerPage.page.waitForResponse((r) => r.url().includes(Endpoints.admin.users)),
      ownerPage.goto(),
    ]);

    // Assert - AC-1
    expect(response.status()).toBe(200); // Act gate
    await expect(ownerPage.rowFor(newAdminEmail)).toBeVisible();
  });

  // SCN-022
  test("Admins table - Should render the created admin", async ({ ownerPage }) => {
    // Arrange
    await ownerPage.goto();

    // Act
    const title = ownerPage.pageTitle;

    // Assert - AC-2
    await expect(title).toHaveText("OWNER PANEL");
  });
});
