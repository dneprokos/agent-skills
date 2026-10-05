# API Test Scenario Coverage Checklist

This checklist is the authoritative guide for what the `api-test-scenario-rtm-generator` skill must cover for every endpoint. Walk through **all applicable sections** and generate at least one scenario row for each item that applies.

---

## 1. Happy Path Coverage (Test Type: `Happy Path`, Level: `Integration`)

- [ ] Successful operation with valid, minimal required inputs → correct 2xx status
- [ ] Successful operation with all optional fields populated
- [ ] Response body contains the expected fields (no missing, no extra sensitive data)
- [ ] `Location` header present on `201 Created` (POST only)
- [ ] Pagination: `page=1&limit=N` returns expected slice and metadata (GET collections)
- [ ] Filtering / sorting query parameters return correct subset (GET collections)

---

## 2. Boundary Value Analysis (Test Type: `Boundary`, Level: `Unit`)

For **every field** whose type is known, generate boundary scenarios:

### String fields
- [ ] Exactly `minLength` characters
- [ ] `minLength - 1` characters → reject
- [ ] Exactly `maxLength` characters → accept
- [ ] `maxLength + 1` characters → reject (400/422)
- [ ] Whitespace-only string → accept or reject per business rule
- [ ] Unicode / multibyte characters (emoji, accented chars)
- [ ] `null` (if field is nullable)

### Numeric fields
- [ ] Minimum allowed value → accept
- [ ] `minimum - 1` → reject
- [ ] Maximum allowed value → accept
- [ ] `maximum + 1` → reject
- [ ] `0` (if positive-only, expect rejection)
- [ ] Negative value (if non-negative only, expect rejection)
- [ ] `null` (if nullable)

### Enum fields
- [ ] Each documented valid value → accept
- [ ] Unknown / invalid string → reject (400/422)
- [ ] Empty string → reject
- [ ] `null` (if nullable)

### Date / timestamp fields
- [ ] Valid ISO 8601 format → accept
- [ ] Invalid format (e.g. `20-01-01`) → reject
- [ ] Past date (if future-only, expect rejection)
- [ ] Future date (if past-only, expect rejection)
- [ ] `null` (if nullable)

### Array fields
- [ ] Empty array `[]` → accept or reject per business rule
- [ ] Exactly `maxItems` elements → accept
- [ ] `maxItems + 1` elements → reject
- [ ] Duplicate items (if `uniqueItems: true`) → reject
- [ ] `null` (if nullable)

### UUID / identifier path params
- [ ] Valid UUID v4 for existing resource
- [ ] Valid UUID v4 for non-existent resource → 404
- [ ] Non-UUID string (e.g. `"abc"`) → 400 or 404 (confirm which)
- [ ] All-zeros UUID `00000000-0000-0000-0000-000000000000`
- [ ] Integer string instead of UUID

---

## 3. Negative / Validation Scenarios (Test Type: `Negative`, Level: `Unit`)

- [ ] Missing required field in request body → 400 or 422
- [ ] Extra unknown field (check for mass assignment, see Security § 6 below)
- [ ] Malformed JSON body → 400
- [ ] Wrong `Content-Type` header (e.g. `text/plain`) → 415 (mutation endpoints)
- [ ] Invalid query parameter value → 400
- [ ] Conflicting query parameters (if applicable)

---

## 4. REST Semantics (Test Type: `Negative`, Level: `Unit` / `Integration`)

### All methods
- [ ] Unsupported HTTP method on this endpoint → 405 Method Not Allowed

### GET
- [ ] Non-existent resource → 404
- [ ] Unsupported `Accept` type → 406

### POST
- [ ] Duplicate creation (unique constraint violation) → 409 Conflict
- [ ] Payload exceeds size limit → 413

### PUT
- [ ] Idempotency: repeat identical PUT → same 2xx result, not 409
- [ ] Body ID ≠ URL path ID → 400 or 422 (not a silent override)
- [ ] If ETag used: stale `If-Match` → 412 Precondition Failed
- [ ] If ETag used: missing `If-Match` when required → 428 Precondition Required

### PATCH
- [ ] `null` value on a field → field is cleared (explicit null)
- [ ] Field omitted from body → field is **unchanged**
- [ ] If ETag used: stale `If-Match` → 412

### DELETE
- [ ] Idempotency: repeat DELETE on already-deleted resource → 404 or 204 (confirm contract)
- [ ] Soft delete vs. hard delete — subsequent GET returns correct state
- [ ] Delete resource with dependent child records → 409 Conflict or cascaded delete (confirm contract)

---

## 5. Authentication & Authorization (Test Type: `Security`, Level: `Integration`)

- [ ] Request with **no token** → 401 Unauthorized
- [ ] Request with **expired token** → 401 Unauthorized
- [ ] Request with **malformed / invalid token** → 401 Unauthorized
- [ ] Request with **valid token but wrong scope / role** → 403 Forbidden
- [ ] Request with **read-only scope** on a mutation endpoint → 403 Forbidden

---

## 6. OWASP API Security Top 10 (Test Type: `Security`, Level: `Integration`)

These must be considered for **every endpoint**, not just write endpoints.

### API1 — Broken Object Level Authorization (BOLA / IDOR)
- [ ] Authenticated user A requests resource owned by user B using a valid but foreign ID → must return **403** (not 200 or 404 that reveals existence)
- [ ] User A attempts to modify or delete user B's resource → 403

### API3 — Excessive Data Exposure
- [ ] Response body does **not** expose sensitive internals: password hashes, internal DB IDs, private metadata, tokens, PII beyond what the caller is authorized to see
- [ ] List endpoints do not return more fields per item than the single-item endpoint

### API5 — Broken Function Level Authorization (BFLA)
- [ ] Low-privilege user calls an admin-only action (bulk delete, role change, status override) → 403

### API6 — Mass Assignment
- [ ] Body contains privileged write fields (`role`, `isAdmin`, `ownerId`, `createdAt`, `id`) → they are **silently ignored**, not applied
- [ ] Confirm response does not reflect the injected privileged values

### API8 — Security Misconfiguration / Injection
- [ ] SQL injection payload in string field → sanitized, not executed; 400/422 or safely stored as literal
- [ ] XSS payload (`<script>alert(1)</script>`) in string field → sanitized on return
- [ ] Path traversal in file-name/path field (if applicable)

---

## 7. OpenAPI / DTO-Aware Generation

When a spec, model class, or controller source is available, replace assumption-based rows with concrete ones:

- Enumerate **every field** declared in the request schema and generate boundary rows (§ 2) per field.
- Use exact field names from the schema in the **Description** and **Scenario** columns (e.g., `displayName maxLength+1`).
- Remove the corresponding ⚠️ warning when the constraint is now known.
- Note the source reference (e.g., `(from OpenAPI spec: POST /api/users → CreateUserRequest)`) in the Comment column.

If no spec is available, document each unknown constraint as a ⚠️ warning after the table.

---

## 8. Minimum Scenario Count Targets

| HTTP Method | Min scenarios |
|-------------|--------------|
| GET (collection) | 8 |
| GET (single resource) | 6 |
| POST | 12 |
| PUT | 12 |
| PATCH | 10 |
| DELETE | 7 |

If a generated table falls below these counts, re-walk the checklist and identify missing coverage.

---

## 9. Warning Discipline

Every ⚠️ warning must be:

- **Specific**: name the field, status code, or business rule that is unknown.
- **Actionable**: describe what the tester must confirm.
- **Removed** as soon as the information is known (use the updater skill).

Examples of good warnings:
- `⚠️ displayName min/max length not confirmed — adjust Boundary scenarios once known.`
- `⚠️ Confirm whether DELETE is soft (status flag) or hard (permanent) — subsequent GET behavior depends on this.`
- `⚠️ BOLA: confirm server returns 403 (not 404) for cross-user resource access.`
