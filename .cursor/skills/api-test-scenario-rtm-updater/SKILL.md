---
name: api-test-scenario-rtm-updater
description: >-
  Review, sync, and update API Test Scenario RTM files. Use when
  scenarios are outdated after tests changed, boundary values need updating,
  resolved warnings should be removed, E2E Test Names need syncing after
  Playwright tests are renamed, or an RTM needs to be brought up
  to the current coverage standard (OWASP, REST semantics, BVA). Invoke
  whenever the user mentions reviewing or updating an RTM, scenario
  corrections, boundary values, test synchronization, coverage gaps, or says
  things like "update the scenarios for X", "tests changed in Y.spec.ts",
  "I now know the min/max length", "the bug is fixed", or "are we missing OWASP cases?".
---

# API Test Scenario Updater

This skill reviews an existing **API Test Scenario RTM** (Requirements Traceability Matrix) file in `requirements/`, compares it against both the Playwright test files it references and the current coverage standard, and proposes a focused list of updates. It only applies changes after you confirm which ones to apply.

Think of this skill as the companion to `api-test-scenario-rtm-generator`: the generator creates scenarios from scratch; this skill keeps them current, accurate, and aligned with the latest standard over time.

The coverage standard is defined in:
- `.github/skills/api-test-scenario-rtm-generator/references/coverage-checklist.md` — canonical checklist for all scenario categories
- `.github/skills/api-test-scenario-rtm-generator/config/validation-rules.json` — HTTP semantics, status codes, OWASP scenarios, REST semantics, BVA types
- `.github/skills/api-test-scenario-rtm-generator/config/test-types.json` — canonical test type list: `Happy Path`, `Boundary`, `Negative`, `Security`

---

## How to invoke

Provide the path to the RTM file you want to review. Optionally, provide endpoint clarifications, new constraints, or a spec/model source.

```
/api-test-scenario-rtm-updater requirements/resource_tools/organizations-resources.md

/api-test-scenario-rtm-updater requirements/resource_tools/organizations-resources.md
I now know the displayName min length is 3 and max is 128.

/api-test-scenario-rtm-updater requirements/resource_tools/organizations-resources.md
The 404 bug on GET non-existent org is now fixed and the test is unskipped.

/api-test-scenario-rtm-updater requirements/resource_tools/organizations-resources.md
Bring this file up to the current coverage standard.

/api-test-scenario-rtm-updater requirements/users/users.md
(paste OpenAPI schema or DTO here)
```

You can also mention specific things inline without a formal path if the context is obvious from the conversation.

---

## Step 1 — Review and propose

When this skill is invoked, read the target RTM file and each test file linked from its **Test files** or **Test file** fields. Those links are the authoritative source of test reality — do not require the user to list them separately.

Then build a **proposal** grouped by method section, covering all applicable check categories below.

---

### Check: Coverage gap (new standard)

Open `.github/skills/api-test-scenario-rtm-generator/references/coverage-checklist.md` and walk every applicable section for the endpoint's HTTP method. Compare each checklist item against the existing RTM rows.

For each checklist item that is **not covered** by any existing row, propose adding a new scenario row. Group the proposals by checklist section:

**Sections to check:**
1. Happy Path — collection vs. single resource, pagination, `Location` header on POST
2. Boundary Value Analysis — per-field: string, numeric, enum, date, array, UUID
3. Negative / Validation — malformed JSON, missing required fields, wrong Content-Type (→ 415), invalid query params
4. REST Semantics — idempotency (PUT/DELETE), optimistic concurrency (ETag/412/428), 405 method-not-allowed, 406 not-acceptable, 413 payload-too-large, body/path ID mismatch (PUT), PATCH null-vs-omit, duplicate POST (→ 409), delete-with-dependents (→ 409), soft vs hard delete
5. Authentication & Authorization — no token (401), expired token (401), invalid token (401), insufficient role/scope (403), read-only scope on mutation (403)
6. OWASP API Top 10:
   - **API1 BOLA/IDOR**: user A accessing user B's resource → 403
   - **API3 Excessive Data Exposure**: sensitive fields absent from response
   - **API5 BFLA**: low-privilege user calling admin-only action → 403
   - **API6 Mass Assignment**: privileged fields in body silently ignored
   - **API8 Injection**: SQL injection / XSS payload in string fields → sanitized

For each missing item, propose a complete row with all 8 columns populated (Scenario, Test Type, Description, Expected Result, HTTP Status, Recommended Test Level, empty E2E Test Name, Comment). Use the test type and level defaults from the generator's `config/test-types.json`:
- `Happy Path` → Integration
- `Boundary` / `Negative` → Unit
- `Security` (auth, OWASP) → Integration

Also add a corresponding ⚠️ warning if any constraint remains unknown (e.g., whether an endpoint actually enforces BOLA).

Skip checklist items that are provably inapplicable (e.g., body/path ID mismatch does not apply to GET or DELETE). Note the skip reason inline.

---

### Check: Test-type normalization

Scan all Test Type cells in the RTM. Valid values are exactly: `Happy Path`, `Boundary`, `Negative`, `Security`.

For any cell containing a non-canonical value, propose a replacement:

| Non-canonical value | Normalize to | Notes |
|---|---|---|
| `Performance` | `Negative` | If the row is about rate-limiting (429), keep at Unit level. If it's a load/concurrent test, flag for removal and suggest it belongs in a dedicated load-test suite instead |
| `Validation` | `Negative` or `Boundary` | Use `Boundary` if the row tests a limit value; `Negative` if it tests a missing/invalid input |
| `Integration` (as Test Type) | `Happy Path` or `Negative` | Use `Happy Path` if the row tests a successful cross-service call; `Negative` if it tests a failure |
| `E2E` (as Test Type) | Varies | Clarify: `E2E` is a **Recommended Test Level**, not a Test Type — propose the correct Test Type and adjust the level column |

When proposing a normalization, preserve all other cell content. Never alter the Scenario, Description, Expected Result, or HTTP Status columns as part of normalization.

---

### Check: E2E Test Name sync

For every row where "E2E Test Name" is filled in, verify the exact string exists in the corresponding spec file as a `test("...")` or `test.skip("...")` call.

- If the test was **renamed** → propose updating the cell to the new name.
- If the test was **deleted** → propose clearing the cell.
- If a `test(...)` exists in the spec that has **no matching row** in the RTM → propose adding a new scenario row.

---

### Check: Skipped tests

If a test is `test.skip(...)` in the spec, the row's Comment should note this. If it does not, propose adding a note such as `⚠️ Test skipped: <reason if available>`.

Conversely, if a row's Comment contains a skip note (e.g., `⚠️ Test skipped: …`) but the corresponding test in the spec is a regular `test(...)` (not `test.skip(...)`), propose **removing** the skip note from the Comment — the bug or blocker has been resolved.

---

### Check: Outdated scenarios

A scenario may be described in a way that no longer matches the test (e.g., the Description still says "Pre: DB seeding required" but the test now uses API setup). Highlight these discrepancies as observations — do not auto-propose rewriting prose unless you are confident the change is purely factual (e.g., a status code that was wrong).

---

### Check: Assertion alignment

For every row where "E2E Test Name" is filled and the test is not skipped, read the test's `expect(...)` assertions and compare them against the RTM:

- `expect(response.status).toBe(N)` vs the row's **HTTP Status** column. If they differ, propose updating HTTP Status to match the assertion. Use the `commonErrorCodes` map in `config/validation-rules.json` to confirm the semantic meaning of the code (e.g., 412 = "Precondition Failed — ETag/If-Match mismatch").
- Response body or text assertions (e.g., `expect(response.text).toBe("...")`) vs the **Expected Result** column. If Expected Result is ambiguous (e.g., `X or Y — clarify…`) but the test already asserts a specific concrete value, propose updating Expected Result to reflect the confirmed behavior.

This check also acts as a secondary trigger for warning resolution: if an open ⚠️ warning states that a business rule is unclear, but the implemented test already asserts a specific outcome, flag the warning for removal and cite the assertion as the source.

---

### Check: Warning resolution

If the user provided new endpoint information (boundary values, confirmed status codes, confirmed business rules, bug fixes), match it against the open ⚠️ warnings in the file. For each warning that the provided information resolves:

- Propose **removing** that entire warning line.
- Briefly explain what new information resolves it.

**OpenAPI / DTO / controller source**: If the user attached or referenced a spec, model class, or controller, use it to resolve field-constraint warnings and optionally propose concrete boundary rows to replace generic ones:
- Extract field names, types, required/optional, enum values, and min/max constraints.
- For each known constraint, propose replacing a generic boundary row (e.g., "Maximum field lengths") with concrete rows (e.g., `displayName maxLength+1 (129 chars) → 422`).
- Propose removing the ⚠️ warning that stated the constraint was unknown.
- Add a brief Comment citing the spec source, e.g. `(from OpenAPI: CreateUserRequest.displayName maxLength=128)`.

Warnings that are not addressed by the provided information must remain untouched in your proposal — do not suggest removing them.

---

### Check: Status suggestion

Evaluate each method section on **two dimensions** before suggesting a status promotion:

**Dimension 1 — E2E Test Name fill ratio**
- Count rows where a Recommended Test Level of `E2E` or `Integration` has an E2E Test Name filled in.

**Dimension 2 — Coverage completeness**
- Check whether the following critical categories have at least one row each: auth (401 no-token), auth (401 expired/invalid), authorization (403 insufficient role), BOLA/IDOR, and at least one happy path.
- If any critical category is **absent** (not just un-linked), the section cannot be promoted above `🟡 In test design` regardless of fill ratio.

**Decision rules:**
- All E2E/Integration rows linked + no `test.skip` + all critical categories present + no critical open ⚠️ warnings → suggest `🟢 Automated`
- ≥ half of E2E/Integration rows linked + all critical categories present + no critical open ⚠️ warnings → suggest `🔵 Ready`
- Any critical category missing OR fewer than half filled OR critical ⚠️ warnings open → leave as `🟡 In test design`, note which gap is blocking

A **critical ⚠️ warning** is one that concerns auth requirements, BOLA/IDOR behavior, delete behavior (soft vs hard), or an unconfirmed status code on a happy-path scenario.

Status promotions are suggestions only; the user decides.

---

## Step 2 — Present proposal

Present all findings in a compact, scannable format grouped by method section. Use this structure:

```
## Proposal: <filename>

### <METHOD> `<endpoint path>`

**Coverage gaps — new standard (N)**
- Missing: BOLA/IDOR — propose new row: "User A accesses User B's resource | Security | ... | 403 | Integration"
- Missing: Mass assignment — propose new row: "Privileged fields in body | Security | ... | 200/201 with fields ignored | Integration"
- Missing: 415 Unsupported Media Type — propose new row: "Wrong Content-Type | Negative | ... | 415 | Unit"
- Missing: Duplicate POST (409) — propose new row: "Create resource with duplicate unique field | Negative | ... | 409 | Unit"
- ⚠️ (new) BOLA: Confirm server returns 403 (not 404) when accessing another user's resource.

**Test-type normalization (N)**
- Row "Rate limiting": Test Type `Performance` → `Negative` (rate-limit is a negative/error scenario)
- Row "Email format": Test Type `Validation` → `Boundary` (tests a format constraint)

**E2E Test Name changes (N)**
- Row "<Scenario>": rename to "<new test title>"
- Row "<Scenario>": clear (test deleted)
- New row needed: "<test title>" (found in spec, not in RTM)

**Skipped test notes (N)**
- Row "<Scenario>": add comment "⚠️ Test skipped: known bug — ..."
- Row "<Scenario>": remove skip note (test is no longer skipped)

**Assertion alignment (N)**
- Row "<Scenario>": HTTP Status `X or Y` → `Z` (test asserts `expect(response.status).toBe(Z)`)
- Row "<Scenario>": Expected Result updated to confirmed behavior (test asserts `expect(response.text).toBe("...")`)
- ⚠️ "<Warning text>" → Resolved by assertion in spec. Propose removal.

**Warning resolutions (N)**
- ⚠️ "Business rule unclear: non-existing org returns 404 or 200"
  → Resolved by: user confirmed 404. Propose removal.
- ⚠️ "displayName min/max length not confirmed"
  → Resolved by: OpenAPI spec (CreateUserRequest.displayName minLength=3, maxLength=128). Propose removal + 2 concrete boundary rows.

**Status suggestion**
- Current: 🟡 In test design → Suggested: 🔵 Ready (6/7 scenarios linked, all critical categories present)
- Blocking gaps (if any): "No BOLA/IDOR row — cannot promote above 🟡"

---
(repeat per section)

**Nothing to update** for sections with no findings.
```

End the proposal with:

> Which of these would you like me to apply? You can say "apply all", list specific items, or describe what to skip.

---

## Step 3 — Apply selected updates

After the user responds, apply only the updates they approved. Work section by section and make targeted edits — never reorder rows, never alter content in cells the user did not select, and never modify the H1 header or the shared "Test files" block at the top of the file.

Specific guardrails:

- **E2E Test Name cells**: safe to update automatically once approved.
- **Comment cells**: only update the skipped-test note portion or add a spec-source note; preserve any existing manual comments already in the cell.
- **⚠️ warning lines**: remove the entire line when approved; do not replace with a resolved marker.
- **Status field**: update only when the user explicitly approves the suggestion.
- **Scenario rows (new)**: add new rows at the end of the relevant method's table, maintaining the strict 8-column format. New rows from coverage gaps go after existing rows, grouped by checklist section order (happy path → boundary → negative/REST semantics → security/OWASP).
- **Test Type normalization**: update only the Test Type cell of the affected row; never touch other cells in that row.
- **Do not delete scenario rows**: even if a test was deleted; instead, clear the E2E Test Name cell and let the user decide whether the scenario is still valid.
- **Do not add ⚠️ warnings that the user did not approve**: if a proposed coverage-gap row also needs an associated warning, add both only when approved together.

After applying, output a brief change summary:

```
## Applied changes: <filename>

### GET `<path>`
- ✅ Added new scenario row: "BOLA — cross-user access" (Security / Integration)
- ✅ Added new scenario row: "No token" (Security / Integration)
- ✅ Updated E2E Test Name for "Non-existing organizationId"
- ✅ Removed warning: "Business rule unclear: non-existing org..."
- ⏭️ Skipped status promotion (not selected)

### POST `<path>`
- ✅ Added 3 coverage-gap rows: 415, 409 duplicate, mass assignment
- ✅ Test Type normalized: "Rate limiting" Performance → Negative
- ✅ Added new scenario row: "valid data with PlantPipeline type..."
```

---

## Reference: RTM format rules

These rules come from `requirements/README.md` and must be respected in every update:

- One RTM file per resource group; all HTTP methods are H2 sections inside it.
- The file is located at `requirements/<endpoint-group>/<resource-name>.md` (kebab-case).
- Every method section uses the strict 8-column table: Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment.
- Valid **Test Type** values: `Happy Path`, `Boundary`, `Negative`, `Security` — no others.
- Valid **Recommended Test Level** values: `Unit`, `Integration`, `E2E`.
- All ⚠️ warnings go **after** the scenario table, at the end of that method section.
- Status levels: `🟡 In test design` | `🔵 Ready` | `🟢 Automated`.
- Test file links use relative paths like `../../tests/api/gateway_api/<group>/<file>.spec.ts`.

---

## Finding the test files

The RTM file itself declares which spec files to look at, in two places:

1. The **"Test files"** block near the top of the document (shared list for the whole resource group).
2. The **"Test file"** field inside each method's H2 section (method-specific link).

Read all linked spec files. If a link is broken or the file does not exist, report it as a finding in the proposal rather than silently skipping it.
