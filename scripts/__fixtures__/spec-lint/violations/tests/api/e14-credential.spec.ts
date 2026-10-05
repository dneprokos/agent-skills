import { test, expect } from "@fixtures/api-fixture";
import { Config } from "@framework/configuration/config";

test.describe("POST /api/auth/login", () => {
  // SCN-114
  test("Login as owner - Should reject invalid credentials", async ({ api }) => {
    // Arrange
    const password = "Test12345@";

    // Act
    const result = await api.auth.login({ email: Config.OWNER_EMAIL, password });

    // Assert - FR-01.1
    expect(result.status).toBe(401);
  });
});
