# Implementation Report Contract

The document an automation stream writes after implementing test scenarios, and the only thing a
reviewer is guaranteed to receive besides the changed files themselves.

Read this file before writing a report and before reviewing one. It is a machine contract: a reviewer
parses these headings, and a workflow orchestrator parses the receipt block at the end of the run.

---

## 1. Path

```text
.workflow/reports/<TICKET-ID>-api-implementation.md
.workflow/reports/<TICKET-ID>-ui-implementation.md
```

One file per ticket per stream. A later iteration of the same stream **overwrites** its own file — the
report describes the current state of the code, not a history of attempts. `iteration:` in the front
matter records which pass produced it.

`.workflow/` is workflow state, not source. It is not part of the pull request.

`Review Findings Addressed` (§2, last section) is required of every report, including a `first_run`,
where it reads `- None.`.

## 2. Structure

Every section below appears in every report, in this order, even when empty. An empty section reads
`- None.` — a missing section is a malformed report, and a reviewer treats it as `Blocked`.

Two sections are stream-specific: **`Explored Locators` and `Observed Mechanics` are required of the
`ui` stream and absent from the `api` stream.** An API run opens no browser, so both would always be
empty there; a UI report that omits either is malformed. They sit in that order between
`Reused Framework` and `Execution Result`.

They answer different questions and neither substitutes for the other. `Explored Locators` says **where**
an observable is, and is the evidence behind every locator committed to `pages/`. `Observed Mechanics`
says **how the page gets there** — whether an action fires a request, what proves a re-render finished,
what shape an empty state takes, what triggers the action, whether it raises a dialog — and is the
evidence behind every wait and every dialog handler committed to `tests/ui/`. A suite of perfectly
observed tier-1 locators can still be raced by one guessed wait, which is why the second map is not a
column of the first.

**The front matter carries every value a reviewer has to rule on but cannot see.** A reviewer receives
this report and the changed files; it never sees the receipt block the writing stream returned to its
caller. So the six lines that used to live only on the receipt — `api_surface`, `explored_app`,
`locator_gaps`, `mechanics_observed`, `cleanup_gaps`, `shared_additions` — are front-matter keys here,
carrying the same values in the same vocabulary. `cleanup_gaps` is written by both streams; the other
five are `ui` only, and an `api` report omits them rather than writing `n/a`. A rule that cites "the
receipt" as the reviewer's evidence is citing a document the reviewer does not hold.

````markdown
---
ticket: SCRUM-139
stream: api
generated_by: <your own agent slug>
generated_at: 2026-08-06T14:22:00Z
iteration: 1
test_design_source: test-design/SCRUM-139-test-design.md
scenarios_implemented: 2
cleanup_gaps: none
# ui stream only, in this order, after cleanup_gaps:
# api_surface: read | script | none (<reason>)
# explored_app: true | false
# locator_gaps: Owner Panel ships no data-testid; all locators are role-based
# mechanics_observed: yes | no | n/a
# shared_additions: none
---

# Implementation Report — SCRUM-139 (api)

## Implemented Scenarios

| Scenario | Test title | File |
|---|---|---|
| SCN-012 | Create admin - Should create an admin with a valid payload | tests/api/admin.spec.ts |
| SCN-014 | Create admin - Should reject a duplicate e-mail | tests/api/admin.spec.ts |

## Folded Scenarios

| Scenario | Covered in | Test title |
|---|---|---|
| SCN-018 | SCN-012 | Create admin - Should create an admin with a valid payload |

## Skipped Scenarios

- SCN-016 — the scenario's `Expected:` states no maximum password length, so the boundary is undefined.
  Recorded as a coverage gap; no test written rather than a guessed limit.

## Changed Files

- `tests/api/admin.spec.ts` — new, 2 tests
- `services/api/controllers/admin-api.ts` — modified, added `findAdminIdsByEmail`

## Reused Framework

- `fixtures/api-fixture.ts` — `api`, `ownerToken`, `createdAdminEmails`
- `services/api/controllers/admin-api.ts` — `createAdmin`, `listAdmins`
- `services/api/endpoints.ts` — `Endpoints.admin.users`

## Execution Result

```text
Command: npx playwright test tests/api --reporter=line
Passed: 2
Failed: 0
Skipped: 0
Type check: npx tsc --noEmit — pass
```

## Failing Tests

- None.

## Suspected Application Defects

- SCN-014 / FR-11.3 — the spec requires HTTP 409 for a duplicate e-mail; the application returns 400.
  The test asserts 409 and fails. Assertion deliberately not weakened.

## Shared Change Requested

- None.

## Cleanup Gaps

- None.

## Known Limitations

- Parallel-safe: every test creates its own admin with a unique e-mail and registers it for cleanup.

## Review Findings Addressed

| Finding | Verdict | Where |
|---|---|---|
| API-C1 | fixed | tests/api/admin.spec.ts:73 — now asserts 409 and the exact message |
| API-M1 | disputed | see Known Limitations |
````

The `ui` stream's two extra sections take this shape, between `Reused Framework` and `Execution Result`:

````markdown
## Explored Locators

### /owner
| Element | Role | data-testid | Tier | Locator |
|---|---|---|---|---|
| Admin table body | rowgroup | — | 1 | page.getByRole("table").getByRole("rowgroup").nth(1) |
| Delete button (per row) | button "Delete Admin" | — | 1 | rowFor(email).getByRole("button", { name: "Delete Admin" }) |
| Toast | status | — | 1 | page.getByRole("status") |

## Observed Mechanics

### /owner
| Action | Request | Trigger | Result shape | Dialog |
|---|---|---|---|---|
| Click "Delete Admin" | DELETE /api/admin/users/:id | on confirm accept | row detaches from the rowgroup | `window.confirm` |
| Submit the create form | POST /api/admin/users | on submit | new row appended, toast in the `status` region | — |
````

## 3. Section rules

| Section | Rule |
|---|---|
| Implemented Scenarios | One row per scenario id actually covered by a test that exists. The test title is the exact string passed to `test(...)`, not a paraphrase. |
| Folded Scenarios | One row per scenario the test design folded into one this report implements. The design's `Folds Into:` line is the authority — the writing stream never decides to fold or unfold anything. `Covered in` is the covering scenario id, and the title is that scenario's test. A folded scenario has no test of its own, so this table is the only record that it was covered at all: an id the design folded and this report names in neither table is a scenario the run dropped, and no coverage check downstream can see it, because there is no missing test to notice. `- None.` when the design folded nothing. |
| Skipped Scenarios | Every selected scenario that produced no test, with a reason. A selected scenario appearing in neither table is a contract violation. A folded scenario belongs here only when its `Expected:` could not be asserted, and then it appears in both tables — once for the fold, once for the reason. |
| Changed Files | Repo-relative paths with `new` or `modified` and a one-clause summary. Every path must exist on disk. |
| Reused Framework | What already existed and was used. An empty list on a repo that has fixtures is a reuse failure, not an empty section. |
| Explored Locators | **`ui` stream only.** The selector map from `docs/automation/references/browser-exploration.md` §5 — one table per route, including its `Tier` column, every row traceable to a snapshot taken in this run **or carried forward from a previous iteration's report for a locator still in `pages/`**. Every row whose tier is not 1 also appears in the front matter's `locator_gaps`. `- None.` only when the map is genuinely empty, with a clause saying why (`every locator already existed in pages/`). Never a snapshot ref (`e5`). |
| Observed Mechanics | **`ui` stream only.** The mechanics map from `docs/automation/references/browser-exploration.md` §5 — one row per action a test in this report performs, `Action \| Request \| Trigger \| Result shape \| Dialog`, every row traceable to an action performed and a `network` or `snapshot` output read in this run **or carried forward from a previous iteration for an action the specs still perform**. Every `waitForResponse` pattern and every dialog handler in the diff traces to a row here or to a `Known Limitations` entry saying the mechanic was not observed; the inverse also holds — a row recording a request with no wait in the code is the same defect from the other end. **No cell holds a rendered string, a count or any other assertable value**: this map records how an observable is reached, never what it says. `- None.` only when there was genuinely nothing to read, with a clause saying why. Never a snapshot ref (`e5`). |
| Execution Result | The real command and the real counts, copied from the run. Never estimated, never carried over from a previous iteration. |
| Failing Tests | Test title, `file:line`, expected vs actual, and why it still ships. |
| Suspected Application Defects | A failure believed to be the application's fault, tied to a scenario id, quoting the `Expected:` value the test asserts. |
| Shared Change Requested | A file outside the writing stream's ownership that the work needed, and why. The change itself is not made. |
| Cleanup Gaps | One entry per record a test creates and cannot remove, naming the resource and the missing route. `- None.` when every created record is registered for cleanup — which is the normal case, and the only case where the section is empty. A record that leaks with no entry here is a contract violation, not an empty section. See §3b. |
| Known Limitations | Anything a reviewer would otherwise have to discover — flakiness risk, environment coupling, data assumptions. |
| Review Findings Addressed | One row per finding id the writing stream was handed. `- None.` on a `first_run`. See §3a. |

### 3a. Review Findings Addressed

The durable record of a revision. A reviewer re-reviewing iteration *n* reads this table instead of
being told in prose what changed, and rules on every row.

| Verdict | Means | Also requires |
|---|---|---|
| `fixed` | the code now does what the finding asked | a `file:line` in the `Where` column pointing at the change |
| `disputed` | the finding is answered rather than applied | a matching entry under `Known Limitations` giving the reasoning. Never a silent omission |
| `not applicable` | the finding named code this stream does not own, or a scenario not assigned to it | the reason, in one clause |

Rules:

- **Every id handed to the stream appears here exactly once.** An id in neither this table nor the
  input is a dropped finding, and a reviewer treats that as Critical.
- Ids are the reviewer's, copied verbatim — `API-C1`, `UI-M2`. The stream never renumbers them and
  never invents one.
- The table is rewritten each iteration and lists **only the findings of the iteration being answered**,
  not the accumulated history. Iteration history lives in the reviewer's block, which carries every id
  forward.

This is the one section that describes the iteration rather than the code. Every other section — §1's
rule — describes the current state, so a revision rebuilds them in full rather than reducing them to
what it touched. The two exploration maps are the sharp edge: a revision that opened no browser still
carries `Explored Locators` forward for every locator still present in `pages/`, and
`Observed Mechanics` forward for every action the specs still perform, because those maps are the only
evidence anyone downstream has that a committed locator was ever observed and that a committed wait
matches a request somebody watched fire. Blanking either to `- None.` because this pass explored nothing
destroys the record and forces the next run to re-explore from zero.

### 3b. Cleanup Gaps

Every record a test causes to exist is removed after the test, through the cleanup fixtures — never
through a UI teardown chain, and never by a delete-all that would reach another test's data while
`fullyParallel` is on.

Registration happens **the instant the resource exists**, before any assertion. Fixture teardown already
runs whether the test passed or failed; what does not run is a registration the failing assertion jumped
over. In a UI create flow that means registering before the submit.

A gap is the one honest exception: the application offers no way to remove the record. It is reported
three times over, so it cannot be mistaken for an oversight —

1. in the run output, by pushing the label to the `uncleanableResources` fixture, which prints
   `[cleanup] NOT CLEANED UP: <label> - no delete endpoint`,
2. here, naming the resource and the missing route,
3. in the front matter's `cleanup_gaps` key, and on the `CLEANUP_GAPS:` line of the receipt.

A gap entry names the route that is missing, not just the fact of the leak:

```markdown
## Cleanup Gaps

- SCN-031 — a game created through the Add Game form. The API surface documents no
  `DELETE /api/games/{id}`; the record stays in the catalogue and every later run sees it.
```

## 4. Ownership boundary

Two automation streams run in parallel against one repository. Each writes only inside its own
boundary; a need outside it becomes a `Shared Change Requested` entry, never a silent edit.

| Owner | May create or modify |
|---|---|
| API stream | `tests/api/**`, `services/api/**`, `fixtures/api-fixture.ts` |
| UI stream | `tests/ui/**`, `pages/**`, `fixtures/pages-fixture.ts` |
| Both, additive only | `utils/**`; `services/api/**` for the UI stream — see below |
| Neither | `playwright.config.ts`, `framework/**`, `tsconfig.json`, `package.json`, `.env`, `requirements/**`, `test-design/**`, `docs/**` |

Both streams **read** everything. Only writing is partitioned.

**The additive-only carve-out.** A UI test cannot clean up a resource the facade has no method for, and
`Shared Change Requested` leaves the record behind. So the UI stream may *add* to `services/api/**` — a
new file under `controllers/`, `builders/` or `types/`, a new top-level key in `endpoints.ts`, and one
new `readonly` member on `ApiFacade` to register the controller. It may not modify, rename, retype or
delete anything already there, and `fixtures/api-fixture.ts` stays closed to it entirely.

Additive-only is what makes this safe with both streams running at once: every conflict is different
lines of the same file rather than the same line twice. If the API stream's report already lists the
controller, reuse it instead of adding a second, and list every addition on the receipt's
front matter's `shared_additions` key and on the receipt's `SHARED_ADDITIONS:` line, so the next
reader can see across the boundary.

## 5. A red test is a valid result

A test that asserts what its scenario's `Expected:` states, and fails because the application does
something else, is a correct test and a finished piece of work. It ships red, with a comment naming the defect, an entry
under `Failing Tests`, and an entry under `Suspected Application Defects`.

Weakening the assertion to match the application, deleting the test, or marking it `.skip` to make the
run green destroys the only signal the failure carries. A reviewer treats any of the three as Critical.

The inverse is also true: a failure caused by the test itself — a wrong fixture, a race, a bad locator —
is not a defect report. Fix it before returning.

## 6. Commands

Use these exactly:

```bash
npx playwright test tests/api --reporter=line    # API stream
npx playwright test tests/ui --reporter=line     # UI stream
npx tsc --noEmit                                 # type check, the only static analysis available
```

`package.json` does define scripts — `npm test`, `npm run test:api`, `npm run test:ui`,
`npm run typecheck` and others — and `npm run test:api` resolves to the same `testDir` through the
`api` project. Use the directory-scoped `npx` form above anyway: it names the boundary you are
allowed to run in the command itself, so a stream can never widen into its sibling's suite by
editing a project definition. `npm test` runs both projects and is out of bounds for either stream.

The application under test must already be running at `BASE_URL` — read it from `.env`;
`http://localhost:9000/` is the documented local default, not a constant. Preflight the value you read:

```bash
curl -s -o /dev/null -w "%{http_code}" <BASE_URL>
```

Anything other than 2xx/3xx means the run is blocked. Do not report execution results from a run that
never reached the application.
