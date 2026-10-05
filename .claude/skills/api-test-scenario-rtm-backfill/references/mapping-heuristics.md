# Test-to-Scenario Mapping Heuristics

Used by `api-test-scenario-rtm-backfill` in **Step 3** to match each discovered test
to a generated scenario row.

---

## Overall match algorithm

For each discovered test, score every generated row for that endpoint and pick
the highest-scoring row. Use the three keys below in priority order:

| Priority | Key | Points awarded |
|---|---|---|
| 1 | HTTP status exact match | 10 |
| 2 | Inferred type matches generated row's Test Type | 5 |
| 3 | Title keyword overlap with Scenario + Description | 0–5 (1 per shared meaningful word, cap 5) |

**Minimum threshold to accept a match**: ≥ 10 points (i.e., HTTP status must match).
Below the threshold → the test is **unmapped** and becomes a new row.

On a tie (same score for two rows) → pick the row whose **Scenario** cell shares
the most words with the test title. If still tied → pick the row with the lower
table index (preserves ordering stability).

---

## Keyword → Test Type inference

Use this table to infer a test's type from its title **before** comparing to rows:

| Keywords (case-insensitive) | Inferred Test Type |
|---|---|
| `not found`, `non-existent`, `nonexistent`, `missing`, `does not exist` | Negative |
| `unauthorized`, `unauthenticated`, `no token`, `no auth`, `without auth`, `no authorization`, `expired token`, `invalid token` | Security |
| `forbidden`, `insufficient`, `no permission`, `wrong role`, `BOLA`, `cross-user`, `cross_user`, `another user`, `other user` | Security |
| `injection`, `XSS`, `SQL inject`, `script inject`, `mass assign` | Security |
| `invalid`, `missing required`, `bad request`, `malformed`, `wrong type`, `wrong format`, `empty body` | Negative |
| `too long`, `too short`, `max length`, `min length`, `exceeds`, `boundary`, `edge case`, `overflow`, `exactly N` | Boundary |
| `valid`, `success`, `happy path`, `returns`, `created`, `updated`, `deleted`, `OK`, `accepted` | Happy Path |

If the title matches multiple rows → use the **first** match in table order (Security
takes precedence over Negative over Boundary over Happy Path).

---

## HTTP Status → Test Type defaults

When no title keyword applies, fall back to the asserted status code:

| Status code | Default Test Type | Notes |
|---|---|---|
| 200, 201, 202, 204 | Happy Path | |
| 400 | Negative | |
| 401 | Security | |
| 403 | Security | |
| 404 | Negative | |
| 405 | Negative | Method not allowed |
| 406 | Negative | Not acceptable |
| 409 | Negative | Conflict (duplicate) |
| 412 | Negative | Precondition failed (ETag) |
| 413 | Boundary | Payload too large |
| 415 | Negative | Unsupported media type |
| 422 | Boundary | Validation error with field constraints |
| 429 | Negative | Rate limiting |

---

## Scenario label cleaning rules (for new rows from unmapped tests)

When a test is unmapped and a **new row must be derived** from it:

1. Strip framework boilerplate from the title:
   - Playwright/Jest: remove surrounding quotes and description prefixes like `"GET /users >"`.
   - pytest: strip `test_` prefix and convert `snake_case` → `Title Case With Spaces`.
   - NUnit/xUnit: convert `PascalCase_Outcome_Code` → `Outcome Code` (remove method/verb prefix).
2. Capitalize the first letter.
3. Truncate to ≤ 60 characters; append `…` if truncated.
4. The cleaned string becomes the **Scenario** cell.
5. The **original unmodified** test title string (as it appears in source) becomes the **E2E Test Name** cell.

---

## Endpoint inference rules (when not explicit in the test)

If a test file does not have explicit request calls, infer the endpoint:

1. **From `describe` label** — parse `"METHOD /path/to/resource"` (e.g. `"GET /api/users/{id}"`).
2. **From class/fixture name** — e.g. `UsersControllerTests`, `GetUserByIdTests` → GET `/api/users/{id}`.
3. **From file name** — e.g. `get-users-by-id.spec.ts` → GET `/api/users/{id}`.
4. **From test title** — last resort; extract verb + noun (e.g. `create user - valid data` → POST `/api/users`).

Always mark inferred endpoints with `⚠️ inferred endpoint — verify path` in the
row's Comment cell.

---

## Skip note formatting

When a test is marked as skipped, add to the **Comment** cell:

```
⚠️ Test skipped: <reason string if present, else "no reason provided">
```

Examples:
- `⚠️ Test skipped: known bug — returns 200 instead of 404`
- `⚠️ Test skipped: no reason provided`

Do **not** add a skip note if the test is a regular (non-skipped) test.

---

## Multiple tests matching the same scenario row

It is possible for two or more tests to score equally against the same generated row.
In that case:

1. **Bind the best-scoring test** (highest score, or lowest file line number on tie) to the row.
2. The remaining tests become **unmapped** and each adds a new row as described in Step 3.
3. In the Comment cell of the original row add: `(also covered by: "<other test title>")`

---

## Test.todo handling

`test.todo(...)` in Playwright/Jest represents a placeholder with no implementation.
Treat it as:
- Skipped = true.
- E2E Test Name = the todo title.
- Comment = `⚠️ Test not implemented (todo)`.
- Still participates in mapping (a todo counts as "test exists but not passing").

---

## Framework-specific title normalisation before matching

Run this normalisation on the **raw** title before keyword scanning (do not store
the normalised version — use the raw title as E2E Test Name):

| Framework | Normalisation |
|---|---|
| Playwright / Jest | Strip leading/trailing whitespace; strip enclosing quotes. |
| pytest | Replace underscores with spaces; strip `test ` prefix (case-insensitive). |
| NUnit / xUnit | Split `PascalCase` at uppercase boundaries → space-separated words; strip common test verbs (`Should`, `Returns`, `Given`, `When`, `Then`) for keyword matching only. |
