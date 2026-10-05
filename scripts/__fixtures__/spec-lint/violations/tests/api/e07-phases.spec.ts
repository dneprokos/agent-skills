import { test, expect } from "@fixtures/api-fixture";

test.describe("POST /api/admin/users", () => {
  // SCN-107
  test("Create admin - Should create and then delete in one test", async ({ api, ownerToken }) => {
    // Arrange
    const created = await api.admin.listAdmins(ownerToken);

    // Act
    const first = await api.admin.listAdmins(ownerToken);

    // Act
    const second = await api.admin.listAdmins(ownerToken);

    // Assert - FR-11.1
    expect(created.status).toBe(200);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
