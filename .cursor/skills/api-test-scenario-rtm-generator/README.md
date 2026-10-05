# API Test Scenario Generator

A GitHub Copilot skill that generates a new **API Test Scenario RTM** (Requirements Traceability Matrix) file from HTTP method/endpoint descriptions, with support for OpenAPI/DTO-aware field-level precision.

## Quick Start

```
/api-test-scenario-rtm-generator POST /api/users
```

Optionally attach or paste an OpenAPI spec excerpt, DTO class, or controller signature to get concrete field-level boundary scenarios instead of generic ones.

## Features

### 🎯 Comprehensive Coverage (via `references/coverage-checklist.md`)

- ✅ Happy path scenarios (collection, single resource, pagination, filtering)
- ✅ Boundary value analysis — per-field for string, numeric, enum, date, array, UUID
- ✅ Negative test cases — malformed JSON, missing fields, wrong Content-Type
- ✅ REST semantics — idempotency, optimistic concurrency (ETag/412), 405/406/413/415, PATCH null-vs-omit, duplicate POST, delete-with-dependents
- ✅ Authentication & authorization — no token, expired, invalid, insufficient scope
- ✅ OWASP API Top 10 — BOLA/IDOR, excessive data exposure, BFLA, mass assignment, injection

### 📊 Testing Pyramid

- Unit (70%): validation, boundary, negative, REST semantics
- Integration (20%): happy paths, auth/security, OWASP
- E2E (10%): critical user journeys only

### 🔍 OpenAPI / DTO-Aware Generation

When a spec or model is provided, the skill uses exact field names, types, and constraints to produce concrete boundary/validation rows — and removes the corresponding ⚠️ warnings.

### 📏 Minimum Scenario Counts

| Method | Min rows |
|---|---|
| GET (collection) | 8 |
| GET (single resource) | 6 |
| POST | 12 |
| PUT | 12 |
| PATCH | 10 |
| DELETE | 7 |

## Example Usage

```
# Basic collection endpoint
/api-test-scenario-rtm-generator GET /api/users

# Single resource endpoint with path parameter
/api-test-scenario-rtm-generator PUT /api/users/{id}

# With OpenAPI context
/api-test-scenario-rtm-generator POST /api/flowsheets
(paste OpenAPI schema here)
```

## Generated Table Format

8-column table format:

| Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment |
| -------- | --------- | ----------- | --------------- | ----------- | ---------------------- | ------------- | ------- |
| Existing user | Happy Path | GET with valid UUID of existing user | User object returned | 200 | Integration | | |
| BOLA — cross-user | Security | User A requests User B's resource | 403 Forbidden | 403 | Integration | | ⚠️ Confirm 403 not 404 |
| No token | Security | Request without Authorization header | 401 Unauthorized | 401 | Integration | | |

**E2E Test Name** and **Comment** are left empty during design; fill them as tests are implemented.

## Output Location

One RTM file per resource group — all HTTP methods as H2 sections:

```
requirements/{endpoint-group}/{resource-name}.md
```

Examples:
- All methods for `/organizations/{id}/resources` → `requirements/resource_tools/organizations-resources.md`
- All methods for `/api/users/{id}` → `requirements/users/users.md`

If the file exists, new methods are **appended as H2 sections** — no new file is created.

See `requirements/README.md` for full naming conventions and status levels.

## Files Structure

```
.github/skills/api-test-scenario-rtm-generator/
├── SKILL.md                         # Main skill definition with generation process
├── README.md                        # This documentation
├── references/
│   └── coverage-checklist.md        # Authoritative coverage checklist (walk for every endpoint)
├── templates/
│   ├── scenario-table.md            # Table format template
│   └── full-report.md               # Full report template
└── config/
    ├── validation-rules.json        # HTTP semantics, status codes, BVA types, OWASP, REST semantics
    └── test-types.json              # Test type definitions and testing pyramid levels
```

## Companion Skills

Use **`api-test-scenario-rtm-backfill`** to create an RTM from existing tests when no RTM exists yet.

Use **`api-test-scenario-rtm-updater`** to keep RTM files current after tests are written or requirements change — it syncs E2E Test Names, resolves ⚠️ warnings, and updates status levels.
