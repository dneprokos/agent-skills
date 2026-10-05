---
name: api-test-scenario-rtm-generator
description: Generate a new API Test Scenario RTM (Requirements Traceability Matrix) file from a prompt, OpenAPI spec, or controller source. Creates structured test cases with boundary analysis, validation testing, and testing pyramid principles for REST API endpoints and saves them as an RTM file in requirements/.
---

# API Test Scenario Generator

This skill generates a new **API Test Scenario RTM** (Requirements Traceability Matrix) file based on natural language descriptions, HTTP method/endpoint, and — when available — an OpenAPI spec, DTO, or controller source. It applies the coverage checklist in `references/coverage-checklist.md` to ensure no category is missed, and writes the output to `requirements/<group>/<resource>.md`.

## Usage

```
/api-test-scenario-rtm-generator {HTTP_METHOD} {ENDPOINT_PATH} [additional_context]
```

Optionally attach or paste an OpenAPI spec excerpt, DTO class, or controller signature for field-level precision.

### Examples

```
/api-test-scenario-rtm-generator POST /api/users
/api-test-scenario-rtm-generator GET /api/users/{id}
/api-test-scenario-rtm-generator PUT /api/orders/{id}/status
```

---

## Generation Process

Follow these steps every time:

### Step 1 — Parse input

Extract:
- HTTP method and endpoint path
- Path parameters (`{id}`, `{organizationId}`, etc.)
- Whether the endpoint targets a **collection** (no path param) or a **single resource** (has path param)
- Any additional context the user provided (field names, types, constraints, business rules)

### Step 2 — Check for OpenAPI / DTO / controller source

If the user attached or referenced an OpenAPI spec, DTO model, controller, or any schema:

1. Extract every **field name**, **type**, **required/optional**, **enum values**, and **min/max constraints** from it.
2. Use exact field names and constraint values in scenario **Description** and **Scenario** columns (e.g., `displayName maxLength+1 (256 chars)`).
3. For each known constraint, generate a concrete boundary row instead of a generic one, and **omit** the corresponding ⚠️ warning.
4. Add a brief note in the Comment column citing the source, e.g. `(from OpenAPI: CreateUserRequest.displayName maxLength=255)`.

If no spec is provided, generate scenarios based on REST patterns and document every unknown as a ⚠️ warning.

### Step 3 — Walk the coverage checklist

Open `references/coverage-checklist.md` and work through every applicable section for the given method and endpoint:

1. **Happy Path** — collection vs. single resource, all optional fields, `Location` header on POST, pagination/filtering
2. **Boundary Value Analysis** — per-field: string, numeric, enum, date, array, UUID
3. **Negative / Validation** — missing required fields, malformed JSON, wrong Content-Type, invalid query params
4. **REST Semantics** — idempotency, optimistic concurrency, 405/406/413/415, body/path ID mismatch, PATCH null-vs-omit, duplicate POST, delete-with-dependents
5. **Authentication & Authorization** — no token, expired token, invalid token, insufficient role/scope
6. **OWASP API Top 10** — BOLA/IDOR, excessive data exposure, BFLA, mass assignment, injection

Every checklist item that applies **must** produce at least one scenario row. Skip only items that are provably inapplicable (e.g., "body/path ID mismatch" does not apply to DELETE).

### Step 4 — Assign test level

| Scenario category | Default level |
|---|---|
| Happy path (collection, single resource) | Integration |
| Boundary, negative, validation, REST semantics | Unit |
| Auth / security (token, role, OWASP) | Integration |
| Rate limiting, large dataset, concurrent load | E2E |

Adjust when context makes a different level clearly more appropriate; document the reason in the Comment column.

### Step 5 — Check minimum scenario counts

| Method | Min rows |
|---|---|
| GET (collection) | 8 |
| GET (single resource) | 6 |
| POST | 12 |
| PUT | 12 |
| PATCH | 10 |
| DELETE | 7 |

If the count falls below the minimum, re-walk the checklist and add the missing rows.

### Step 6 — Collect warnings

After the table, emit one ⚠️ per unknown. Each warning must:
- Name the specific field, status code, or rule that is unclear.
- State what the tester must confirm.

Standard warnings to always check:
- Path parameter validation: confirm expected code for invalid UUID format (400 vs 404)
- Field constraints: min/max lengths not confirmed (POST/PUT/PATCH)
- Required vs optional fields: confirm which body fields are required
- Delete behaviour: confirm hard delete vs soft delete (DELETE)
- Authentication: confirm token type and scope required

### Step 7 — Write the output file

Follow the file generation rules in the **Output Requirements** section below.

---

## Generated Table Format

| Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment |
| -------- | --------- | ----------- | --------------- | ----------- | ---------------------- | ------------- | ------- |
| ...      | ...       | ...         | ...             | ...         | ...                    | ...           | ...     |

### Column Definitions

| Column | Description |
|---|---|
| **Scenario** | Short label for the use case |
| **Test Type** | `Happy Path`, `Negative`, `Boundary`, `Security` |
| **Description** | Pre-conditions, inputs, and steps |
| **Expected Result** | What a passing test should observe |
| **HTTP Status** | Expected response code(s) |
| **Recommended Test Level** | `Unit`, `Integration`, `E2E` |
| **E2E Test Name** | Playwright test name — leave empty during design; fill once test is implemented |
| **Comment** | Open questions, known issues, clarifications, or spec source reference |

---

## Test Classifications

| Type | When to use |
|---|---|
| **Happy Path** | Normal successful operations |
| **Boundary** | Edge cases and limit testing — min, max, empty, overflow |
| **Negative** | Error conditions, invalid inputs, missing fields |
| **Security** | Authentication, authorization, injection, OWASP scenarios |

---

## Testing Pyramid Guidelines

- **Unit Tests (70%)**: Validation, boundary cases, error conditions — fast isolated tests
- **Integration Tests (20%)**: API contracts, authentication, happy paths — moderate coverage
- **E2E Tests (10%)**: Critical user journeys only — minimal but essential coverage

---

## Output Requirements

### RTM File Generation

- **Format**: Always save output in `.md` format
- **Location**: `requirements/{endpoint-group}/{resource-name}.md`
  - **One RTM file per resource group** — all HTTP methods are H2 sections within the same file
  - Folder name matches the test folder under `tests/api/gateway_api/` (e.g., `resource_tools/`)
  - File name is the kebab-case resource path name (e.g., `organizations-resources.md`)
  - Example: all of GET/POST/PUT/DELETE for `/organizations/{id}/resources` → `requirements/resource_tools/organizations-resources.md`
- **Existing RTM check**: If the resource group RTM already exists, **append** the new method as an H2 section — do NOT create a separate file
- **New RTM**: If no RTM file exists for the resource group, create it with the full header (H1 title, base path, test file links block) then add the method as the first H2 section
- **Format conventions**: See `requirements/README.md` for the authoritative naming conventions and status levels

### Document Structure per File

Every resource group file must follow this structure:

```
# {ResourceGroup} — {Resource Name}

**Base path**: `{base-path}`

**Test files**:
- [spec-file.spec.ts](../../tests/api/...)

---

## {HTTP_METHOD} `{full-path}`

**Status**: 🟡 In test design

**Test file**: [spec-file.spec.ts](../../tests/api/...)

{8-column scenario table}

⚠️ warnings and open questions

---
```

### Warning Documentation

- **Location**: All warnings must appear **after** the scenario table, at the end of each method section
- **Format**: One `⚠️` per warning line
- **Content**: Specific field/rule that is unknown + what the tester must confirm
- **Resolution**: Remove warnings once information is confirmed (use the `api-test-scenario-rtm-updater` skill)

### Plan Mode Behavior

- **No Implementation Questions**: Do not ask about test implementation details in Plan mode
- **Focus**: Generate scenarios only; test code generation is handled by separate skills

---

## Example Output

**File**: `requirements/users/users.md`

```markdown
# Users

**Base path**: `api/users`

**Test files**:

- [get-users.spec.ts](../../tests/api/.../get-users.spec.ts)
- [post-users.spec.ts](../../tests/api/.../post-users.spec.ts)

---

## GET `api/users/{id}`

**Status**: 🟡 In test design

**Test file**: [get-users-by-id.spec.ts](../../tests/api/.../get-users-by-id.spec.ts)

| Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment |
| -------- | --------- | ----------- | --------------- | ----------- | ---------------------- | ------------- | ------- |
| Existing user | Happy Path | GET /users/{id} with valid UUID of an existing user | User object returned with all expected fields | 200 | Integration | existing user - should return user details | |
| Non-existent user | Negative | GET /users/{id} with valid UUID of a non-existent user | Not found error | 404 | Integration | | |
| Invalid UUID format | Negative | GET /users/{id} with a non-UUID string (e.g. "abc") | Bad request or not found | 400 | Unit | | ⚠️ Confirm 400 vs 404 for invalid UUID |
| No token | Security | GET /users/{id} with no Authorization header | 401 Unauthorized | 401 | Integration | | |
| Expired token | Security | GET /users/{id} with expired JWT | 401 Unauthorized | 401 | Integration | | |
| Insufficient role | Security | GET /users/{id} with valid token but no read permission | 403 Forbidden | 403 | Integration | | |
| BOLA — cross-user | Security | User A requests User B's resource with a valid but foreign ID | 403 Forbidden (not 200 or 404) | 403 | Integration | | ⚠️ Confirm server returns 403 not 404 |
| Excessive data exposure | Security | Verify response does not include password hash, tokens, or internal metadata | Sensitive fields absent | 200 | Integration | | |

⚠️ **Authentication**: Confirm JWT scope required to access this endpoint.
⚠️ **BOLA**: Confirm server returns 403 (not 404) when accessing another user's resource.

---
```

---

## Configuration Files

| File | Purpose |
|---|---|
| `references/coverage-checklist.md` | Authoritative checklist — walk this for every endpoint |
| `config/validation-rules.json` | HTTP method semantics, status codes, BVA types, OWASP scenarios, REST semantics |
| `config/test-types.json` | Test type definitions and testing pyramid levels |
| `templates/scenario-table.md` | Markdown table format |
| `templates/full-report.md` | Full output document structure |
