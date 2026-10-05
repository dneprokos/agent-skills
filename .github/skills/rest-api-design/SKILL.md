---
name: rest-api-design
description: >-
  Apply REST API design and review best practices: resource-oriented URLs, HTTP methods and
  idempotency, status codes, query parameters, pagination and versioning strategies, JSON request
  and error shapes, OpenAPI/Swagger documentation, and production concerns (validation, rate
  limits, CORS, logging). Use when the user asks to design, review, or standardize REST endpoints,
  fix anti-patterns in paths or responses, choose pagination or API versioning, align error bodies
  with RFC 9457-style problem details, or improve API docs—even if they say only "REST API" or
  "review my API".
---

# REST API Design

Guide **design** and **review** of HTTP JSON APIs that follow REST-oriented conventions. Combine checklist-driven feedback with actionable recommendations.

If the user needs **test cases** for an existing endpoint, prefer the separate **api-test-scenario-rtm-generator** skill. This skill focuses on **shape, semantics, and documentation** of the API itself.

## When this skill applies

Use for requests such as:

- "Review our REST API" / "Is this endpoint RESTful?"
- "How should we version or paginate?"
- "What status code and error body should we return?"
- "Improve this OpenAPI/Swagger spec"
- "Naming for paths and query parameters"

## Out of scope

- **GraphQL** or **tRPC** design (different paradigms)
- Authoring a full **OpenAPI file from scratch** without user context (offer structure and sections instead)
- **WebSocket** or **SSE** real-time protocols as the primary topic
- Low-level **infrastructure** (load balancers, K8s) unless tied to API gateway or CORS

Optional: if the workspace has a **documentation MCP**, you may use it for framework-specific snippets; this skill does not require any MCP.

## Inputs and outputs

**Inputs (any combination):**

- OpenAPI/Swagger YAML or JSON (snippet or path)
- List of routes with methods
- Free-form description of resources and operations

**Outputs:**

- Prioritized findings: **must-fix** (wrong HTTP semantics, security footguns) vs **should-fix** vs **nice-to-have**
- Concrete suggestions: path shape, method, status code, query names, response envelope, error shape
- Assumptions called out explicitly when the user did not specify domain rules

## Review workflow

1. **Resources and paths** — Nouns, plural collection names, hierarchy with `/`, avoid verbs in URLs. Prefer shallow paths; use query filters instead of deep nesting when possible (`/nodes?flowsheetId=` vs four-level paths).
2. **Methods** — Map operations to GET/POST/PUT/PATCH/DELETE; know idempotency expectations.
3. **Status codes** — Use codes that match HTTP semantics; success vs client error vs server error.
4. **Query layer** — Filters, sort, sparse fieldsets, pagination parameters; consistent **camelCase** naming.
5. **Pagination** — Pick **one** documented strategy per API. Prefer **cursor-based** for very large or high-churn collections; use **page + pageSize** (or offset/limit) with clear response metadata when offset style is required. See [references/detail.md](references/detail.md).
6. **Versioning** — Prefer **integer path segments** (e.g. `/v1/`, `/v2/`). Avoid versioning only via query or ad-hoc headers as the sole mechanism.
7. **Request bodies** — JSON, clear field names, validation, PATCH for partial updates; avoid putting body fields in query for POST/PUT.
8. **Errors** — Meaningful messages, correct HTTP status; consider structured problem details (RFC 9457-style) with field-level errors for validation.
9. **Documentation** — OpenAPI: paths, operations, parameters, responses, auth, examples.

For anti-patterns, troubleshooting tables, production checklist, and Swagger/OpenAPI checklist detail, read [references/detail.md](references/detail.md) when producing a full review.

## Resource naming (quick reference)

```text
# Collections (plural nouns)
GET    /users
POST   /users
GET    /users/{id}
PUT    /users/{id}
PATCH  /users/{id}
DELETE /users/{id}

# Nested resources (keep shallow)
GET    /users/{id}/posts
POST   /users/{id}/posts

# Prefer not: /getUsers, /createUser, /user (singular collection)
```

## HTTP methods

| Method | Typical use            | Idempotent |
| ------ | ---------------------- | ---------- |
| GET    | Read                   | Yes        |
| POST   | Create, actions        | No         |
| PUT    | Replace full resource  | Yes        |
| PATCH  | Partial update         | Yes        |
| DELETE | Remove                 | Yes        |

## Common status codes

| Code | Meaning        | Typical use                          |
| ---- | -------------- | ------------------------------------ |
| 200  | OK             | Successful GET, PUT, PATCH         |
| 201  | Created        | Successful POST creating a resource  |
| 204  | No Content     | Successful DELETE or empty success   |
| 400  | Bad Request    | Malformed request, generic client error |
| 401  | Unauthorized   | Missing or invalid auth              |
| 403  | Forbidden      | Authenticated but not allowed        |
| 404  | Not Found      | Resource missing                     |
| 409  | Conflict       | State conflict, duplicate            |
| 422  | Unprocessable  | Validation / semantic error (common convention) |
| 429  | Too Many Requests | Rate limited                      |
| 500  | Server Error   | Unexpected server failure            |

Use **4xx** for client-fixable issues and **5xx** only for server-side failures. Do not return **200** with an error payload for failed operations.

## Response shape (JSON)

Prefer a consistent envelope so clients can parse predictably:

```json
{
  "data": { "id": 1, "name": "Example" },
  "meta": { "timestamp": "2024-01-15T10:00:00Z" }
}
```

For collections, include pagination metadata in `meta` (or a documented top-level object) consistent with your pagination strategy.

Errors (illustrative; align with your standard and RFC 9457 where applicable):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [{ "field": "email", "message": "Invalid format" }]
  }
}
```

## Query parameters (patterns)

```text
GET /users?status=active&sort=-createdAt&page=1&pageSize=20
GET /users?fields=id,name,email
GET /products?category=electronics&price_lt=100
```

Document filter operators if you use suffixes like `_lt`, `_gt`, etc.

## Pagination note (two valid styles)

- **Cursor-based** (often better at scale): `cursor`, `limit`, `nextCursor` / `hasMore` in response.
- **Offset / page** (common and simple): e.g. `page`, `pageSize` with `totalItems`, `totalPages` in the response.

Validate **page** ≥ 1 and **pageSize** within min/max; return clear error messages for out-of-range pagination (see detail reference).

## Hard rules for reviews

- Call out **verbs in URLs**, **GET for state changes**, and **wrong status codes** as high priority.
- Prefer **consistent naming** (e.g. camelCase) across query and JSON fields unless the API already standardizes on snake_case—then enforce consistency, not mixed styles.
- **Date/time** in JSON: prefer **ISO 8601** (e.g. `2024-09-15T08:00:00Z`).
- Never expose secrets in URLs or logs; redact tokens in examples.

## Related

- Deeper tables and checklists: [references/detail.md](references/detail.md)
