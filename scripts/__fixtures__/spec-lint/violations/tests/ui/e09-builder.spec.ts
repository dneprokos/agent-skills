import { test, expect } from "@fixtures/pages-fixture";
import { AdminTestData } from "@utils/test-data/admin-test-data";

test.describe("Owner feature", () => {
  // SCN-109
  test("As an owner, I should see the admin I seeded", async ({ api, ownerToken, ownerPage }) => {
    // Arrange - the seed is hand-shaped through the builder, which is the API stream's instrument
    const email = AdminTestData.uniqueUiEmail();
    const seed = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(email)
      .sendCreateAdmin();
    expect(seed.status).toBe(201);

    // Act
    await ownerPage.goto();

    // Assert - AC-1
    await expect(ownerPage.rowFor(email)).toBeVisible();
  });
});
