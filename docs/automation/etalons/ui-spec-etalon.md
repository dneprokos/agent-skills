# UI Spec Etalon

The house form for a Playwright UI spec under `tests/ui/` and the page object it calls under `pages/`.
One document, two readers: whoever writes a new spec copies this shape, and whoever reviews one
calibrates against it. A style finding is a departure from *this*, never from a preference formed on
the spot.

**The files on disk outrank this sketch.** `tests/ui/owner.spec.ts` and `pages/owner-page.ts` are the
canonical in-repo references, and `tests/ui/search-games.spec.ts` with `pages/home-page.ts` for a
control that acts on value change and for an empty state; where the repository and this document
disagree, the repository is right and the difference is not a finding.

---

# Core — read this on every run that writes a spec or a page object

Everything from here to the appendix is the house form itself: the fixture chain, setup and cleanup,
the locator tier ladder, the assertion rules, the module-scope rule, a full compliant spec with the
page object it calls, and the counter-example. A run that writes or changes a single line under
`tests/ui/` or `pages/` reads all of it.

---

## The fixture chain

```
@playwright/test → fixtures/api-fixture.ts → fixtures/pages-fixture.ts → tests/ui/*.spec.ts
```

A UI spec imports from `@fixtures/pages-fixture`, which **extends** the API fixture — so one destructure
gives you the page objects and the whole API layer at once.

| Fixture | What it is | Use it for |
|---|---|---|
| `ownerPage` / `loginPage` / `homePage` | page objects | every UI action and every locator |
| `ownerSession` | the owner JWT seeded into `localStorage` via `addInitScript` before the first navigation | implied by `ownerPage` — you never log in through the UI to set up |
| `page` | the raw Playwright page | `page.waitForResponse` and dialogs only; locators belong in the page object |
| `api` | `ApiFacade` — `api.auth`, `api.admin` | arranging data and cross-checking the result |
| `ownerToken` | owner JWT obtained over the API | first argument to every `api.admin.*` call |
| `createdAdminEmails` | cleanup list, drained over the API after the test | push every e-mail the test causes to exist |
| `cleanupTasks` | removal steps for any **other** resource, drained in reverse after the test | push `{ label, run }` the instant the resource exists |
| `uncleanableResources` | labels warned about at teardown, never deleted | the last resort: a record the application offers no way to remove |

`ownerSession` uses `addInitScript` on purpose: `AuthContext` reads `localStorage` once on mount and
then calls `GET /api/auth/me`, so a token written after `goto` would not restore the session without a
reload. Never write the token by hand.

## Setup and cleanup over the API — always, and always in the short form

The UI is what the scenario is testing, not what gets it into position. A ten-step UI setup is ten ways
for an unrelated test to fail.

Every API call in a UI spec is a **helper**. It is never the thing under test, so it gets the shortest
form the facade offers — the controller method, with `AdminTestData.createAdminPayload(email)` as the
body:

| Want | Write | Not |
|---|---|---|
| seed an admin | `api.admin.createAdmin(ownerToken, AdminTestData.createAdminPayload(email))` | a builder chain of `with*()` calls |
| seed an admin with one field changed | `AdminTestData.createAdminPayload(email, { password: AdminTestData.MIN_LENGTH_PASSWORD })` | `.withEmail(…).withPassword(…).withConfirmPassword(…)` |
| cross-check the result | `api.admin.listAdmins(ownerToken)` | `api.admin.adminBuilder().withBearerToken(ownerToken).sendListAdmins()` |
| delete something `createdAdminEmails` does not cover | `api.admin.deleteAdmin(ownerToken, id)` | `.sendDeleteAdmin(id)` off a builder |

`api.admin.adminBuilder()` and `api.auth.loginBuilder()` exist for tests whose subject *is* the HTTP
request. That is never a UI test. A scenario that genuinely needs a hand-shaped request is an API
scenario, and it belongs to whoever implements `Assigned Level: E2E API`.

The one thing a helper call must still do is fail loudly — assert the seed status
(`expect(seedResult.status).toBe(201)`), so a broken precondition never reads as a UI defect.

| Situation | Do |
|---|---|
| the scenario needs an admin that already exists | seed it with `api.admin.createAdmin(ownerToken, …)` in `// Arrange`, assert the seed status, push the e-mail to `createdAdminEmails` |
| the scenario **is** the UI create flow | fill the form through the page object, but push the e-mail to `createdAdminEmails` **before** the submit |
| the scenario is the UI delete flow | still push it — `findAdminIdsByEmail` returns nothing afterwards and cleanup becomes a no-op |
| the test needs an authenticated owner | take `ownerPage`; that is all |
| the test needs a state the API cannot seed | record it under `Known Limitations`; do not build a UI setup chain to reach it |

Cleanup is the fixture's job — no manual UI deletion in a teardown, and never leave a record behind.

### Cleaning up a resource that is not an admin

`createdAdminEmails` covers one resource type. Anything else registers a removal step on
`cleanupTasks`, and the route it calls comes from the `# API Surface` section of the requirements
document — see `docs/automation/references/api-surface-reading.md`, which is the only part of `requirements/`
this stream opens and is read for **arrange and cleanup mechanics only, never for an assertion**.

**Reach for the entity's seeding fixture first.** Where one exists it does all of this already —
creates the record, registers its removal before returning, and throws when the seed produced nothing
usable, so the arrange is one line and carries no branch, no cast and no status assertion:

```ts
// Arrange - the game is a precondition, not the scenario
const game = await seedGame(GameTestData.uniqueGamePayload());
// ... later: game.id, game.name, game.status
```

The rules that fixture follows, and the two failure modes it separates, are written once in
`docs/automation/etalons/api-spec-etalon.md` — "A seeded record is one line, and the fixture owns the rest".
Both streams seed the same way, so both read the same words. **This stream may not add a seeding
fixture itself**: `fixtures/api-fixture.ts` is closed to it, so a scenario needing one reports a shared
change rather than hand-writing the block back into a spec.

Where no fixture exists for the entity, register the removal yourself, at creation:

```ts
// Arrange - the game is a precondition, not the scenario
const createResult = await api.games.createGame(ownerToken, GameTestData.createGamePayload(gameName));
expect(createResult.status).toBe(201); // a broken precondition must fail loudly

// Registered here, not after the assertions: fixture teardown runs whether the
// test passed or failed, so a task registered at creation time survives a red run.
const gameId = (createResult.body as CreateGameResponse).game._id;
cleanupTasks.push({
  label: `game ${gameId}`,
  run: async () => void (await api.games.deleteGame(ownerToken, gameId)),
});
```

Three rules govern that block:

- **Register at creation, never after the assertions.** This is the whole of "clean up even when the
  test fails" — the teardown already runs on a failure; what does not run is a registration the failing
  assertion jumped over. In a UI create flow the registration goes **before the submit**.
- **Remove only what this test created.** Never a delete-all, never "every record matching the prefix".
  `fullyParallel` is on, and another test's data is not yours to remove.
- **No delete route anywhere → say so out loud.** Push a label to `uncleanableResources`, which prints
  one `[cleanup] NOT CLEANED UP: <label> - no delete endpoint` line at teardown, and record the same
  fact under `Known Limitations`. A leak that is reported is a known cost; a silent one poisons every
  later run.

```ts
// The API documents no DELETE for this resource - see ## Spec Gaps in the API surface.
uncleanableResources.push(`game "${gameName}" created through the Add Game form`);
```

## Locators — the tier ladder

A locator is chosen from the highest tier the application makes possible. Tier 1 needs no justification;
every step down needs all three of the receipts below.

| Tier | Locator | Status |
|---|---|---|
| 1 | `getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId` | preferred |
| 2 | `#id` — an author-written, stable id | allowed with justification |
| 3 | `[data-*]` — a stable attribute other than the testid | allowed with justification |
| 4 | structural CSS (`table > tbody > tr`) | last resort, with justification |
| — | XPath; a generated or hashed class name (`.css-1a2b3c`, a CSS-module class); a text match on marketing copy; `nth()` on a **data** row | **banned at every tier** |

Descending below tier 1 requires:

1. a `// LOCATOR-FALLBACK: tier <n> — <why every higher tier is impossible>` comment on the locator field,
2. a `LOCATOR_GAPS` entry in the receipt,
3. an `Explored Locators` row recording the tier.

```ts
// Tier 1 — preferred, no comment needed
this.addGameButton = page.getByRole("button", { name: "Add Game", exact: true });

// LOCATOR-FALLBACK: tier 2 — the cell carries no role name, no label and no
// data-testid; #game-genre is written in the template, not generated.
this.genreCell = page.locator("#game-genre");
```

An undocumented tier drop is a defect, and so is a tier drop where a higher tier was available — the
comment has to say what was actually tried. What the ladder does **not** do is license a guess: a
control the application ships no hook for at any tier is still a gap to report and a scenario to skip.

`nth()` on a **structural** element — the second rowgroup of a table is its body — is tier 1 and not a
fallback; see the note under the page object below. `nth()` reaching a particular data row is banned,
because its position depends on which other tests are running in parallel.

## Assertions — soft where the observables are independent, never weak

### `expect.soft` for independent observables

A loop of hard assertions reports the first failure and hides the rest, so a table missing three columns
looks like a table missing one. Independent observables inside `// Assert` are soft:

```ts
// Assert - AC-1: every row shows name, genre, release year, platforms and multiplayer
for (const row of rows) {
  for (const column of gamesManagementPage.dataColumns) {
    await expect.soft(gamesManagementPage.cellFor(row, column)).not.toBeEmpty();
  }
}
```

Hard `expect` stays hard in four places, in every test:

| Keep hard | Why |
|---|---|
| anything in `// Arrange` | a failed precondition makes the rest of the test meaningless — `expect(seedResult.status).toBe(201)` |
| the `// Act` gate — the `waitForResponse` status | the assertions after it are about a response that arrived |
| any value a later line reads, navigates on, or passes to another call | soft does not stop execution, so the next line would run on garbage |
| the **presence** half of a presence/absence pairing | the pairing exists to prove the locator resolves at all |

Two mechanics worth stating: `expect.soft` does not short-circuit, so every line after one must be safe
to run against the failed state; and Playwright still fails the test at the end. A soft assertion is a
*better-reported* assertion, never a weakened one.

### Meaningful assertions

An assertion that a value merely exists cannot fail against a broken build. These are never the **only**
assertion on a value the scenario names:

| Weak | Use instead |
|---|---|
| `expect(rows.length).toBeGreaterThan(0)` | `toHaveCount(n)` against the number the design or an oracle gives |
| `expect((await cell.innerText()).trim().length).toBeGreaterThan(0)` | `toHaveText` / `toContainText` with the expected value, or `not.toBeEmpty()` **plus** a cross-check |
| `toBeTruthy()`, `not.toBeNull()`, `not.toBe("")` | the matcher for the actual value |
| a bare `toBeVisible()` where `Expected:` names a string | `toHaveText("…")` / `toContainText("…")` |

Where the design genuinely names no fixed value — a catalogue whose size varies between environments —
the assertion is tied to an **independent oracle** and a comment says which one:

```ts
// Assert - FR-10.1: the admin table is the same catalogue the public listing renders
expect(tableNames).toHaveLength(catalogueNames.length);
expect([...tableNames].sort()).toEqual([...catalogueNames].sort());
```

That is a real assertion: it fails when either view drifts. `toBeGreaterThan(0)` on the same data is not.

**One carve-out: the vacuity guard.** A `for` loop over an empty array asserts nothing and passes, so a
count check *before* a loop is doing real work — it stops an empty table from turning the loop green:

```ts
expect(rows.length).toBeGreaterThan(0); // guards the loop, not the behaviour
for (const row of rows) {
  await expect.soft(gamesManagementPage.editButtonFor(row)).toBeVisible();
}
```

That is legitimate because the loop behind it carries the actual assertions. The comment is what marks
it as a guard. The same line with no loop behind it, or standing in for a count the scenario names, is
the weak assertion the table above bans.

## Nothing lives at a spec's module scope

A spec file holds its imports and its `test.describe`. Nothing else. Every helper has a destination:

| What it is | Where it goes |
|---|---|
| traverses, reads or acts on the page | a page-object method |
| a value the test sends, or a domain constant | `utils/test-data/` |
| a column or field list | the page object that owns the table |
| shared by two specs | a page object or `utils/` — never an import from another spec |

One consequence catches everyone: **page objects hold no `expect`, so a page-object loop cannot use
`expect.poll`.** Waiting for a client-side re-render there uses the locator API instead — wait for the
element you are replacing to go away:

```ts
/** Every game name in the listing, collected by paging with Next until it is disabled. */
async allGameNames(): Promise<string[]> {
  const names: string[] = [];
  // The listing fetches its games after mount; wait for the first card before
  // reading any page, or an empty first read silently loses it.
  await this.gameNameHeadings.first().waitFor();

  for (;;) {
    names.push(
      ...(await this.gameNameHeadings.allInnerTexts()).map((h) => h.trim()),
    );

    if (await this.nextPageButton.isDisabled()) {
      return names;
    }

    // Pagination is client-side, so the next page has no request to wait on.
    // Waiting for the heading we just read to detach is what proves the
    // re-render finished - `expect.poll` cannot be used inside a page object.
    const previousFirst = this.headingByName(names[names.length - 1]);
    await this.nextPageButton.click();
    await previousFirst.waitFor({ state: "detached" });
  }
}
```

## A folded scenario — one test, two scenario ids

Most tests map one to one onto a scenario. The exception is a scenario whose block carries a third
classification line:

```
Assigned Level: E2E UI
Level Rationale: … folded into SCN-001 by the minimum-set pass — same actor, same entry, same route, a larger dataset over the one traversal SCN-001 already makes.
Folds Into: SCN-001
```

**What a fold is, and every rule about writing one, is `docs/automation/contracts/e2e-stream-scope.md`
§3** — both halves of the stream are held to that file and it is not restated here. What this section
adds is the only thing an etalon can: what the covering test looks like when those rules are followed.
Three things change in it and nothing else does — the id comment names both scenarios, the arrange
block seeds the wider precondition, and the folded scenario's `Expected:` becomes assertions in the
same `// Assert` block carrying its own `FR-`/`AC-` ids.

```ts
// SCN-001 (folds SCN-018)
test("Games management table - Should list every game returned by GET /api/games with all FR-10.1 fields rendered", async ({
  page,
  adminGamesManagementPage,
  seedGameBatch,
}) => {
  // Arrange - SCN-001 asks for two or more games; SCN-018 asks for a catalogue past
  // the public listing's page size. One seed satisfies both, which is why SCN-018 is
  // folded here rather than kept as a second traversal of the same screen.
  const seeded = await seedGameBatch(
    GameTestData.createGamePayloadBatch(GameTestData.LARGE_CATALOGUE_BATCH_SIZE),
  );

  // Act
  const [listResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(Endpoints.games.list) &&
        response.request().method() === "GET",
    ),
    adminGamesManagementPage.goto(),
  ]);

  // Assert - AC-1/FR-10.1 (SCN-001): the table lists every game GET /api/games returned
  expect(listResponse.status()).toBe(200); // Act gate
  const body = (await listResponse.json()) as ListGamesResponse;
  const uiNames = await adminGamesManagementPage.gameNames();
  expect([...uiNames].sort()).toEqual([...body.games.map((g) => g.name)].sort());

  // Assert - FR-10.2 (SCN-018): nothing was truncated at the public listing's page
  // size, on either side. Folded scenario, so this carries its own requirement id.
  expect(body.games.length).toBe(body.pagination.totalGames);
  await expect(adminGamesManagementPage.gameRows).toHaveCount(body.pagination.totalGames);
  expect(body.games.map((g) => g.name)).toEqual(expect.arrayContaining(seeded.names));
});
```

## Compliant — the spec

```ts
import { test, expect } from "@fixtures/pages-fixture";
import { Endpoints } from "@services/api/endpoints";
import { ListAdminsResponse } from "@services/api/types/admin";
import { AdminTestData } from "@utils/test-data/admin-test-data";

test.describe("Owner feature", () => {
  // SCN-021
  test("As an owner, I should be able to delete an admin", async ({
    page,
    ownerPage,
    api,
    ownerToken,
    createdAdminEmails,
  }) => {
    // Arrange - the existing admin is a precondition, not the scenario: seed it over the API
    const adminEmail = AdminTestData.uniqueUiEmail();
    createdAdminEmails.push(adminEmail);

    const seedResult = await api.admin.createAdmin(
      ownerToken,
      AdminTestData.createAdminPayload(adminEmail),
    );
    expect(seedResult.status).toBe(201); // a broken precondition must fail loudly, not silently

    await ownerPage.goto(); // ownerPage implies ownerSession — no UI login
    await expect(ownerPage.rowFor(adminEmail)).toBeVisible();

    // Act
    ownerPage.acceptNextConfirmDialog(); // before the click, or Playwright dismisses it
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(Endpoints.admin.users) &&
          response.request().method() === "DELETE",
      ),
      ownerPage.deleteButtonFor(adminEmail).click(),
    ]);

    // Assert - AC-3
    expect(deleteResponse.status()).toBe(200);
    await expect(ownerPage.toast).toContainText(
      "Admin user deleted successfully",
    );
    await expect(ownerPage.rowFor(adminEmail)).toBeHidden();

    // Cheap API cross-check: the UI reflected real state, not local component state
    const adminsResult = await api.admin.listAdmins(ownerToken);
    expect(adminsResult.status).toBe(200);
    expect(
      (adminsResult.body as ListAdminsResponse).admins.map((a) => a.email),
    ).not.toContain(adminEmail);
  });
});
```

## Compliant — the page object it calls

```ts
import { Locator, Page } from "@playwright/test";

export class OwnerPage {
  readonly toast: Locator;
  readonly adminRows: Locator;

  constructor(private readonly page: Page) {
    this.toast = page.getByRole("status");
    // The Owner Panel ships no data-testid; the second rowgroup is the table body,
    // the first one holds the headers.
    this.adminRows = page
      .getByRole("table")
      .getByRole("rowgroup")
      .nth(1)
      .getByRole("row");
  }

  async goto() {
    await this.page.goto("/owner", { waitUntil: "domcontentloaded" });
  }

  rowFor(email: string): Locator {
    return this.adminRows.filter({ hasText: email });
  }

  deleteButtonFor(email: string): Locator {
    return this.rowFor(email).getByRole("button", { name: "Delete Admin" });
  }

  /** Registered before the click: Playwright dismisses unhandled dialogs. */
  acceptNextConfirmDialog() {
    this.page.once("dialog", (dialog) => void dialog.accept());
  }
}
```

Note the `nth(1)` in the page object: it indexes a **structural** rowgroup, not a data row, and it is
documented in a comment. That is not a locator-stability defect. `adminRows.nth(2)` to reach a
particular admin would be — its position depends on which other tests are running in parallel.

## What the two compliant files demonstrate, point by point

**The mechanical half of this list is enforced by `scripts/spec-lint.mjs`, and is therefore not
listed here.** The fixture import, the title form, the `// Arrange` / `// Act` / `// Assert`
comments, the `// SCN-` id, a URL or credential literal, a fixed wait, the e-mail helper — a script
finds every one of those or none, which is the point of moving them there. What is left is what a
script cannot reach: whether the example is *right*, not whether it is well formed.

| # | The etalon shows |
|---|---|
| E2 | data arranged over the API, the seed status asserted, the e-mail registered for cleanup **before** the seed call |
| E3 | the API call in its shortest form — one controller method, one `createAdminPayload()` body. It is a helper, so it takes as little room as it can; the UI steps are what the reader came for. The linter fails a `with*()` chain here; a two-controller-call arrange that should have been one is this row |
| E4 | every sent value from `AdminTestData` — `uniqueUiEmail()` for the e-mail, `createAdminPayload()` for the body. No literal e-mail, password or locally written generator in the spec |
| E5 | the one literal that does belong here: the expected rendered string, next to its assertion |
| E6 | `ownerPage` used for the session — no UI login, no manual token write |
| E7 | tier-1 locators throughout, declared as `readonly Locator` fields in the constructor, with a documented missing-`data-testid` gap — no tier drop was needed, so no `LOCATOR-FALLBACK` comment appears |
| E9 | the network-triggering click wrapped in `Promise.all([page.waitForResponse(...), action])`, with both the response status and the rendered result asserted. **That the click triggers a request at all is an observation, not a deduction** — the route in the pattern comes from a mechanic somebody watched fire (`docs/automation/references/browser-exploration.md` §4b) and is reported alongside the code; a pattern written on an assumption is a race that stays green until it does not, and an action that quietly calls the server with no wait around it is the same defect with nothing on the page to notice |
| E10 | the `window.confirm` handler registered **before** the click |
| E11 | an absence assertion (`toBeHidden`) **paired with the `toBeVisible` on the same locator in `// Arrange`** — that pairing is what proves the locator resolves at all, since `toBeHidden` passes on a locator matching nothing — plus an API cross-check |
| E12 | the `FR-`/`AC-` id on the assertion that carries it — **which** assertion is the judgement; that the id comment, the phase comments and the title form exist at all is the linter's |
| E14 | hard assertions where they belong: the seed status in `// Arrange`, the response status in `// Act`. This test asserts three dependent facts about one record, so nothing here is soft — the soft form is for the independent-observable loop shown under *Assertions* above |
| E15 | every assertion carries the value the scenario states — `toContainText("Admin user deleted successfully")`, not `toBeVisible()`; the API cross-check names the e-mail, not a count |
| E16 | nothing at module scope but the import lines and the `test.describe`. The linter reports a declaration there as a shape to judge, never as a defect: a helper that only *reads* a response is the one blessed form |

## Non-compliant — the same intent, and the defects it carries

```ts
import { test, expect } from "@playwright/test";               // (1)

test("delete admin", async ({ page }) => {                     // (2)
  await page.goto("/owner");
  await page.waitForTimeout(3000);                             // (3)

  await page.locator(".css-1a2b3c").nth(2).click();            // (4)(5)

  await expect(page.getByText("Success")).toBeVisible();       // (6)(7)
});
```

```ts
// pages/owner-page.ts
async deleteAdmin(email: string) {
  await this.rowFor(email).getByRole("button").click();
  await expect(this.toast).toBeVisible();                      // (8)
}
```

| # | Defect | Severity |
|---|---|---|
| 1 | import from `@playwright/test`; the page objects and the seeded session vanish | Major |
| 2 | title follows neither accepted form, and no `// SCN-` id | Minor |
| 3 | `waitForTimeout(3000)` as synchronization — replace with a web-first assertion | Major |
| 4 | `.css-1a2b3c` is a generated class name — banned at every tier, not a tier-4 fallback — and `nth(2)` indexes a data row whose position depends on other tests running in parallel. Neither carries a `LOCATOR-FALLBACK` comment, and no tier was actually exhausted: the button has a role and an accessible name | Major |
| 5 | locator built inline in the spec instead of on the page object; no dialog handler registered, so `window.confirm` is auto-dismissed and the DELETE never fires | Major |
| 6 | the click is not wrapped in `waitForResponse`, so the test cannot tell a failed request from a slow one | Major |
| 7 | `toBeVisible()` on a generic text match, where the scenario names an exact toast string; it would pass on an unrelated success banner | Major |
| 8 | `expect` inside a page object — the assertion cannot be read from the test | Major |

No test data is created here at all, so the run also silently depends on an admin someone else left
behind — an isolation defect on top of the eight above. None of these is a **coverage** finding, which
is the separate and more valuable question: whether every scenario the test design assigned to this
stream actually got a test, and whether that test asserts what the scenario says.


---

# Appendix — read a section only when its scenario shape comes up

Neither section below is part of the general form, and a run that does not meet the shape it
describes gains nothing by reading it. They are here rather than in Core because the Core is read on
every run and these two are not needed on most of them.

| Read | When |
|---|---|
| *A control with no submit button, and the empty state it produces* | the act is a value change rather than a click, or the expected result is the absence of everything |
| *Two accepted title forms* | starting a new spec file, where which form the file uses is still open |

---

## A control with no submit button, and the empty state it produces

A filter or search control breaks two assumptions the delete flow above never tests: **the action is a
value change rather than a click**, and **the result of the action can be the absence of everything**.
`tests/ui/search-games.spec.ts` and the `searchFor` member of `pages/home-page.ts` are the in-repo
reference for both.

**Filling the box is the whole Act.** Whether the control needs a submit press, a debounce or neither is
a *mechanic* — §4b of `docs/automation/references/browser-exploration.md` — and it is observed, never assumed. Where
the listing re-requests on change, an `Enter` press or a click on a nearby button in the `// Act` is an
invented step, and a test that adds one passes for the wrong reason.

**Key the response matcher to the value, not to the route.** A listing that searches on change fires the
same route on mount with an empty term, so a matcher testing only the pathname resolves against the
*initial* load and the test asserts on the unfiltered page:

```ts
private static isGamesSearchResponse(response: Response, term: string): boolean {
  const url = new URL(response.url());

  return (
    url.pathname === Endpoints.games.list &&
    response.request().method() === "GET" &&
    url.searchParams.get("search") === term
  );
}

async searchFor(term: string): Promise<Response> {
  const [response] = await Promise.all([
    this.page.waitForResponse((response) =>
      HomePage.isGamesSearchResponse(response, term),
    ),
    this.searchInput.fill(term),
  ]);

  return response;
}
```

The page object returns the `Response` and asserts nothing on it, exactly as `gotoAndWaitForGames` does;
the status gate is a line in the spec.

**Where the environment supplies the data, the response is the oracle.** A catalog that varies by machine
has no fixed result set to name, so the rendered cards are compared against the names *that response*
carried — and the comparison is gated on a web-first count first, because `waitForResponse` resolves when
the response arrives, not when the page has rendered it:

```ts
await expect(homePage.gameNameHeadings).toHaveCount(matchedNames.length);
const renderedNames = await homePage.gameNamesOnCurrentPage();
expect([...renderedNames].sort()).toEqual([...matchedNames].sort());
```

Seed the record the scenario searches for. A term read off the catalog's first page is data another spec
may delete mid-test — the same isolation rule as everywhere else in this document, and the reason the
compliant spec calls `seedGame` before it navigates.

**An empty state is a presence/absence pairing.** `toHaveCount(0)` and `toBeHidden()` both pass on a page
that rendered nothing at all, so the presence half carries a hard assertion on the value:

```ts
// Presence half of the presence/absence pairing: hard, since the absence
// assertion below passes just as well on a page that rendered nothing.
await expect(homePage.noResultsHeading).toHaveText("No Games Found");
await expect.soft(homePage.noResultsMessage).toHaveText("Try adjusting your search or filters ...");
await expect.soft(homePage.gameNameHeadings).toHaveCount(0);
```

The empty-state locators are scoped to the block that owns them (`getByTestId("no-results")`, then the
heading and paragraph inside it), so neither can resolve against the page banner. Reading the block's
*shape* — that it is a heading plus a message — is a mechanic; the strings above are values the design
supplies, and lifting them off the running app instead is the invented-value defect, not a shortcut.

## Two accepted title forms

| Form | For | Example |
|---|---|---|
| `"As a <role>, I should be able to <action>"` | a role-centric flow — the scenario is somebody doing something | `"As an owner, I should be able to delete an admin"` |
| `"<Subject> - Should <behavior>"` | a rendering or state check, where the role is incidental | `"Games management table - Should list every game with all fields rendered"` |

Pick the one the scenario fits and keep a file consistent. `tests/ui/owner.spec.ts` uses the first,
`tests/ui/search-games.spec.ts` the second; both are the house form, and neither is a finding.
Anything that is neither — `"delete admin"` — is a Minor.
