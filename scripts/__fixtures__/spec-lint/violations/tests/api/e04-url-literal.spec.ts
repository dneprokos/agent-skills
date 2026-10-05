import { test, expect } from "@fixtures/api-fixture";

test.describe("GET /api/admin/users", () => {
  // SCN-104
  test("List admins - Should reach the admin route", async ({ request }) => {
    // Arrange & Act
    const response = await request.get("http://localhost:9000/api/admin/users");

    // Assert - FR-11.1
    expect(response.status()).toBe(200);
  });
});
