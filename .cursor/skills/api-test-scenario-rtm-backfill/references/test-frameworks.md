# Test Framework Discovery & Parsing Patterns

This file is read by `api-test-scenario-rtm-backfill` during auto-detection (Step 1a).
It is **skipped** when the user supplies `--framework` explicitly.

To add support for a new framework, add a section following the same structure.

---

## Playwright (`--framework playwright`)

### File glob
```
**/*.spec.ts
**/*.spec.js
```

### Detection signals
- `import { test, expect } from '@playwright/test'`
- `import { test } from '@playwright/test'`

### Test case extraction

| Element | Pattern |
|---|---|
| Test title | `test('...')`, `test("...")`, `test(\`...\`)` — first argument |
| Skipped test | `test.skip('...')`, `test.todo('...')` |
| HTTP status assertion | `expect(response.status()).toBe(N)`, `expect(response.status()).toEqual(N)` |
| Body assertion | `expect(await response.json()).toMatchObject({...})`, `expect(await response.text()).toBe('...')` |
| Endpoint (from request) | `page.request.get('/path')`, `request.post('/path')`, `apiContext.put('/path')` |
| Endpoint (from describe) | `describe('GET /api/users', ...)` — parse method and path from describe label |

### Grouping
- Group tests by their parent `describe` block label when present.
- Fall back to file name (strip `.spec.ts`) as the resource name.

---

## Jest (`--framework jest`)

### File glob
```
**/*.test.ts
**/*.test.js
**/*.spec.ts
**/*.spec.js
```

### Detection signals
- `import ... from 'jest'`
- `const request = require('supertest')`
- `import request from 'supertest'`

### Test case extraction

| Element | Pattern |
|---|---|
| Test title | `test('...')`, `it('...')` — first argument |
| Skipped test | `test.skip('...')`, `it.skip('...')`, `xit('...')`, `xtest('...')` |
| HTTP status assertion | `expect(response.status).toBe(N)`, `expect(response.statusCode).toBe(N)` (supertest) |
| Body assertion | `expect(response.body).toMatchObject({...})`, `expect(response.text).toBe('...')` |
| Endpoint (from request) | `request(app).get('/path')`, `request(app).post('/path')` (supertest) |
| Endpoint (from describe) | `describe('GET /api/users', ...)` — parse method and path from describe label |

### Grouping
- Group by outer `describe` block.
- Nested `describe` blocks: concatenate parent + child as resource context.

---

## NUnit (`--framework nunit`)

### File glob
```
**/*Tests.cs
**/*Test.cs
**/*Spec.cs
```

### Detection signals
- `using NUnit.Framework;`
- `[TestFixture]`

### Test case extraction

| Element | Pattern |
|---|---|
| Test title | `[Test]` or `[TestCase]` method name — convert `PascalCase` to `spaced words` for display |
| Skipped test | `[Ignore("...")]` on the method — capture the reason string |
| HTTP status assertion | `Assert.AreEqual(404, response.StatusCode)`, `Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound))` |
| Body assertion | `Assert.That(content, Contains.Substring("..."))`, `Assert.AreEqual(expectedJson, body)` |
| Endpoint (from attribute) | `[TestCase("GET", "/api/users/{id}")]` parameter, or method-name convention `GetUser_ShouldReturn200` |
| Endpoint (from class) | `[TestFixture("GET", "/api/users")]`, or class name `UsersControllerTests` |

### Grouping
- Group by `[TestFixture]` class.
- Derive resource group from the class name (strip `Tests`, `Test`, `Spec` suffix; kebab-case).

---

## xUnit (`--framework xunit`)

### File glob
```
**/*Tests.cs
**/*Test.cs
**/*Facts.cs
```

### Detection signals
- `using Xunit;`
- `[Fact]` or `[Theory]`

### Test case extraction

| Element | Pattern |
|---|---|
| Test title | `[Fact]` or `[Theory]` method name — convert `PascalCase` to `spaced words` for display |
| Skipped test | `[Fact(Skip = "...")]` or `[Theory(Skip = "...")]` — capture the reason string |
| HTTP status assertion | `Assert.Equal(404, (int)response.StatusCode)`, `response.StatusCode.Should().Be(HttpStatusCode.NotFound)` (FluentAssertions) |
| Body assertion | `Assert.Contains("...", content)`, `content.Should().Contain("...")` |
| Endpoint (from class) | Constructor that sets a base route, or class name `UsersControllerTests` |
| Endpoint (from method name) | `GetUser_ValidId_Returns200`, `PostUser_MissingField_Returns400` — parse method, resource, outcome |

### Grouping
- Group by test class.
- Derive resource group from class name (strip `Tests`/`Test`/`Facts`; kebab-case).

---

## pytest (`--framework pytest`)

### File glob
```
**/test_*.py
**/*_test.py
```

### Detection signals
- `import pytest`
- `from fastapi.testclient import TestClient`
- `from httpx import AsyncClient`

### Test case extraction

| Element | Pattern |
|---|---|
| Test title | Function name prefixed with `test_` — strip prefix and convert `snake_case` to `spaced words` for display |
| Skipped test | `@pytest.mark.skip(reason="...")`, `@pytest.mark.skipif(...)` — capture the reason string |
| HTTP status assertion | `assert response.status_code == 404`, `assert resp.status_code == 200` |
| Body assertion | `assert response.json() == {...}`, `assert "field" in response.json()` |
| Endpoint (from request) | `client.get("/path")`, `client.post("/path")`, `async_client.put("/path")` |
| Endpoint (from class) | `class TestUsersEndpoint:` — derive resource from class name |

### Grouping
- Group by test class (`class Test...`) when present.
- Fall back to file name (strip `test_` prefix and `_test` suffix; kebab-case) as the resource name.

---

## Extending this file

To add a new framework:

1. Add a new `## FrameworkName (\`--framework frameworkname\`)` section.
2. Provide file glob, detection signals, and the extraction table.
3. Document the grouping strategy.
4. Update the quick-start example in `README.md` with the new `--framework` value.
