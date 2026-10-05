---
name: api-test-scenario-rtm-backfill
description: >-
  Bootstrap an API Test Scenario RTM from EXISTING tests when
  no RTM file exists yet. Use when a repo already has API tests
  (Playwright, Jest, NUnit/xUnit, pytest) but there is no requirements/ RTM
  describing them. The skill discovers the existing tests and the endpoints they
  cover, generates the canonical scenario set using the api-test-scenario-rtm-generator
  standard, maps each existing test onto a scenario row (filling E2E Test Name and
  aligning status/expected result from assertions), and writes a new RTM file with
  a realistic per-method status. Invoke when the user says things like "we already
  have tests but no scenarios file", "backfill scenarios from these tests",
  "reverse-engineer the RTM from the spec files", "generate requirements from
  existing tests", "create a scenario file for tests/api/...", or "map our existing
  tests to scenarios". If an RTM file already exists for the resource group, this
  skill defers to api-test-scenario-rtm-updater.
---

# API Test Scenario Backfill

This skill **bootstraps** an **API Test Scenario RTM** (Requirements Traceability Matrix) file in
`requirements/` from **existing tests** — the case where a repo already has API
test coverage but no RTM was ever written.

It is the third member of the API test scenario family:

| Skill | Starting point | Produces |
|---|---|---|
| `api-test-scenario-rtm-generator` | A prompt / OpenAPI spec (no tests yet) | A new API Test Scenario RTM from scratch |
| **`api-test-scenario-rtm-backfill`** | **Existing tests, no RTM file** | **A new API Test Scenario RTM mapped to those tests** |
| `api-test-scenario-rtm-updater` | An existing RTM + tests | The RTM kept in sync |

The coverage standard it generates against is owned by the generator and **reused, not duplicated**:
- `.github/skills/api-test-scenario-rtm-generator/references/coverage-checklist.md` — canonical checklist for all scenario categories
- `.github/skills/api-test-scenario-rtm-generator/config/validation-rules.json` — HTTP semantics, status codes, OWASP scenarios, REST semantics, BVA types
- `.github/skills/api-test-scenario-rtm-generator/config/test-types.json` — canonical test types and pyramid levels

---

## How to invoke

Provide the location of the existing tests: a repo-relative test folder, a single
spec/test file, or a resource group. Optionally pass the test framework to skip
auto-detection.

```
/api-test-scenario-rtm-backfill tests/api/gateway_api/resource_tools/

/api-test-scenario-rtm-backfill tests/api/gateway_api/users/get-users.spec.ts

/api-test-scenario-rtm-backfill tests/api/gateway_api/users/ --framework playwright
```

**Optional `--framework` parameter**: one of `playwright`, `jest`, `nunit`, `xunit`,
`pytest`. When supplied, the skill uses that framework's parsing rules directly and
does **not** read `references/test-frameworks.md`. When omitted, the skill detects
the framework from file extensions and imports (see that reference file).

---

## Step 0 — Guard: does an RTM already exist?

Determine the target resource group and its RTM path
(`requirements/<endpoint-group>/<resource-name>.md`) using the same naming rules as
the generator (kebab-case resource path name, folder matches the test directory name).

- **If that RTM file already exists** → **stop**. Do not append or overwrite.
  Tell the user:
  > An RTM already exists at `<path>`. Backfill only creates new files.
  > Use `/api-test-scenario-rtm-updater <path>` to sync it with the current tests.
- **If no RTM file exists** → continue to Step 1.

---

## Step 1 — Detect framework and discover tests

### 1a — Resolve framework

- If `--framework` was supplied, use its parsing rules directly (skip the reference file).
- Otherwise, read `references/test-frameworks.md` and auto-detect from:
  - file extension (`.spec.ts`, `.test.ts`, `.test.js`, `.spec.py`, `Test.cs`, etc.),
  - imports / usings in the first few lines (`@playwright/test`, `jest`, `NUnit.Framework`, `pytest`).
- If the framework cannot be determined, ask the user which one to use before proceeding.

### 1b — Enumerate test files

Use the framework's file glob (from the reference file or the supplied parameter) on
the given scope. List every matching test file.

### 1c — Extract per-test data

For every test case found in each file, extract using the framework-specific patterns
from `references/test-frameworks.md`:

| Field | What to capture |
|---|---|
| **endpoint** | HTTP method + path — from the request call, `describe`/`[TestFixture]`/class/function name, or the file name. Mark as `⚠️ inferred` if derived from context rather than an explicit call. |
| **test title** | The exact string — becomes the **E2E Test Name** verbatim. |
| **asserted HTTP status** | e.g. `expect(res.status()).toBe(404)`, `Assert.AreEqual(404, ...)`, `assert resp.status_code == 404`. |
| **body/text assertions** | Any assertions on response body fields or text — used to tighten Expected Result. |
| **skip status** | Whether the test is skipped (`test.skip`, `it.skip`, `[Ignore]`, `@pytest.mark.skip`, `test.todo`, `xit`). |

### 1d — Group by resource

Group all discovered tests by **endpoint** (method + path), then by **resource group**
(maps to one RTM file). Report the grouping before continuing so the user can
confirm or correct it.

---

## Step 2 — Generate the canonical scenario set per endpoint

For each discovered endpoint, generate scenarios exactly as
`api-test-scenario-rtm-generator` would:

1. Walk `coverage-checklist.md` for the method:
   - Happy Path (collection vs. single resource, pagination, `Location` header on POST)
   - Boundary Value Analysis (per-field: string, numeric, enum, date, array, UUID)
   - Negative / Validation (missing required fields, malformed JSON, wrong Content-Type, invalid query params)
   - REST Semantics (idempotency, optimistic concurrency, 405/406/413/415, body/path ID mismatch, PATCH null-vs-omit, duplicate POST, delete-with-dependents)
   - Authentication & Authorization (no token 401, expired 401, invalid 401, insufficient role 403)
   - OWASP API Top 10 (BOLA/IDOR, excessive data exposure, BFLA, mass assignment, injection)
2. Apply the generator's **test-type / level defaults**:
   - `Happy Path` → Integration
   - `Boundary` / `Negative` → Unit
   - `Security` (auth, OWASP) → Integration
3. Apply the generator's **minimum scenario counts** (GET collection 8, GET single 6, POST 12, PUT 12, PATCH 10, DELETE 7). Re-walk the checklist if below the minimum.
4. Emit a ⚠️ warning for every unknown constraint. A warning is **dropped** in Step 3 if an existing test's assertion already confirms it.

If the user attached an OpenAPI spec / DTO / controller, use it for field-level
precision (concrete boundary rows, drop matching ⚠️ warnings) exactly as the generator does.

---

## Step 3 — Map existing tests onto generated scenarios

Follow `references/mapping-heuristics.md`. For each discovered test, find the single
best-matching generated scenario row and bind them.

### Match key (in priority order)

1. Asserted HTTP status — exact match against **HTTP Status** in the generated row.
2. Inferred test type — derived from the title using keyword buckets:

   | Keywords in test title | Inferred type |
   |---|---|
   | `not found`, `404`, `non-existent`, `missing` | Negative |
   | `unauthorized`, `401`, `no token`, `no auth`, `expired token` | Security |
   | `forbidden`, `403`, `insufficient`, `BOLA`, `cross-user`, `cross_user` | Security |
   | `invalid`, `missing required`, `bad request`, `malformed`, `400` | Negative |
   | `too long`, `too short`, `max`, `min`, `boundary`, `exceed` | Boundary |
   | `injection`, `XSS`, `SQL`, `mass assign` | Security |
   | `valid`, `success`, `happy`, `returns`, `200`, `201` | Happy Path |

3. Title / description keyword overlap — word similarity between the test title and
   the scenario **Scenario** / **Description** cells.

### On a match

- Fill the **E2E Test Name** cell with the **exact** test title (never paraphrase).
- If the test asserts a concrete HTTP status → update **HTTP Status** to that value.
- If the test asserts a concrete body/text → tighten **Expected Result** to it.
- If the test is skipped → add `⚠️ Test skipped: <reason if available>` to **Comment**.
- Drop any ⚠️ warning on that row whose uncertainty the assertion now confirms.

A test maps to **at most one** row. On ties, pick the closest description match.

### Unmapped tests

If a test matches no generated scenario:
1. Add a **new scenario row** derived from the test:
   - Scenario: clean title (strip framework boilerplate),
   - Test Type: inferred from keyword table above,
   - Description: pre-condition inferred from test setup + the test title,
   - Expected Result: from assertions,
   - HTTP Status: from assertion or `⚠️ Unknown`,
   - Recommended Test Level: use defaults (Security/Happy Path → Integration; others → Unit),
   - E2E Test Name: exact test title,
   - Comment: `(backfilled from test — verify scenario description)`.
2. Record it in the backfill report under **"Unmapped tests — added as new rows"**.

### Coverage gaps (uncovered scenarios)

Generated rows with no matching test keep an empty E2E Test Name. List them in the
report under **"Coverage gaps (no test yet)"**.

---

## Step 4 — Decide per-method Status

Use the same two-dimension rule as `api-test-scenario-rtm-updater`:

**Dimension 1 — fill ratio**: fraction of `E2E`/`Integration` rows that have an E2E Test Name filled.

**Dimension 2 — critical categories present** (all five must exist as rows):
- auth 401 no-token
- auth 401 expired/invalid
- authorization 403 insufficient role
- BOLA/IDOR
- ≥ 1 happy path

| Condition | Status |
|---|---|
| All E2E/Integration rows linked + no skipped tests + all critical categories present + no critical ⚠️ | `🟢 Automated` |
| ≥ half of E2E/Integration rows linked + all critical categories present + no critical ⚠️ | `🔵 Ready` |
| Otherwise | `🟡 In test design` — note the blocking gap |

A **critical ⚠️** concerns auth requirements, BOLA/IDOR, delete semantics (soft vs hard),
or an unconfirmed status code on a happy-path scenario.

---

## Step 5 — Write the RTM file

Create `requirements/<endpoint-group>/<resource-name>.md`. Follow the generator's document structure:

```
# {ResourceGroup} — {Resource Name}

**Base path**: `{base-path}`

**Test files**:
- [spec-file.spec.ts](../../tests/api/...)

---

## {HTTP_METHOD} `{full-path}`

**Status**: {🟡|🔵|🟢 ...}

**Test file**: [spec-file.spec.ts](../../tests/api/...)

{8-column scenario table}

⚠️ warnings (only those not resolved by assertions)

---
```

**Row order**: happy path → boundary → negative/REST semantics → security/OWASP → unmapped-derived rows at the end of their section.

**File placement rules** (same as generator):
- One file per resource group; every HTTP method is an H2 section.
- Strict 8-column table: Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment.
- Test Type ∈ {`Happy Path`, `Boundary`, `Negative`, `Security`}; Level ∈ {`Unit`, `Integration`, `E2E`}.
- All ⚠️ warnings go **after** the table for that method.
- Test file links use relative paths like `../../tests/api/gateway_api/<group>/<file>.spec.ts`.

---

## Step 6 — Print the backfill report

After writing the file, output a summary using the structure in `templates/backfill-report.md`.

End the report by pointing the user to the updater:

> Bootstrapped `<path>` from \<N\> tests. Use `/api-test-scenario-rtm-updater <path>` to keep
> it in sync as tests change.

---

## Guardrails

- **Never** modify or append to an existing RTM file — Step 0 prevents it.
- **Never** invent an E2E Test Name — copy the exact test title; leave blank if no test matched.
- **Never** discard a discovered test — map it or add it as a new row.
- Do not drop a ⚠️ warning unless an assertion or provided spec actually confirms it.
- Keep the canonical coverage standard (coverage-checklist, validation-rules, test-types) authoritative; do not re-define it here.
- Do not add a `⚠️ Test skipped` note without confirming the test is actually `test.skip` / `[Ignore]` / equivalent.

---

## Configuration & reference files

| File | Purpose |
|---|---|
| `references/test-frameworks.md` | Per-framework discovery + parsing patterns (Playwright, Jest, NUnit/xUnit, pytest). Skipped when `--framework` is supplied. |
| `references/mapping-heuristics.md` | How to match a discovered test to a generated scenario row. |
| `templates/backfill-report.md` | Backfill summary report format. |
| `../api-test-scenario-rtm-generator/references/coverage-checklist.md` | Canonical coverage checklist (reused, not duplicated). |
| `../api-test-scenario-rtm-generator/config/validation-rules.json` | HTTP semantics, status codes, OWASP, REST semantics, BVA types (reused). |
| `../api-test-scenario-rtm-generator/config/test-types.json` | Test types and pyramid levels (reused). |
