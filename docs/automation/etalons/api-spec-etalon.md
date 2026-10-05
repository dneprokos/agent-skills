# API Spec Etalon

The house form for a Playwright API spec under `tests/api/`. One document, two readers: whoever writes
a new spec copies this shape, and whoever reviews one calibrates against it. A style finding is a
departure from *this*, never from a preference formed on the spot.

**The files on disk outrank this sketch.** `tests/api/admin-api.spec.ts` and
`tests/api/login-api.spec.ts` are the canonical in-repo references for file layout, titles and
assertion style, and `tests/api/games-search-api.spec.ts` for a query-parameter filter over a shared
collection — self-seeded match data, the response's own metadata as the count oracle, and a defect
asserted against the specification; where the repository and this document disagree, the repository is
right and the difference is not a finding.

One rule survives that precedence, because it post-dates the specs on disk: **the `// Act` is always
the builder, one `with*()` call per field sent.** An older spec that acts through a controller method
or through `withMatchingPassword` predates the rule. New code follows the rule; the old specs are not
retrofitted to match, and they are not evidence against it.

---

# Core — read this on every run that writes a spec

Everything from here to the appendix is the house form itself: the layers, which layer a phase uses,
the response shapes, setup and cleanup, a full compliant spec, and the counter-example. A run that
writes or changes a single line under `tests/api/` reads all of it.

---

## The layers

```
fixtures/api-fixture.ts          test, expect, and the fixtures `api`, `ownerToken`, `createdAdminEmails`
  └─ ApiFacade                   api.auth, api.admin
       └─ AuthApi / AdminApi     controller — one method per common call
            └─ *RequestBuilder   fluent with*() → send*(), the escape hatch
                 └─ toApiResult  { response, status, ok, body }

utils/test-data/*                AdminTestData, AuthTestData — every value a spec sends
utils/response-patterns.ts       ResponsePatterns — every regex a spec asserts
@framework/configuration/config  Config — every credential, from .env
```

`toApiResult` never assumes JSON: an empty body becomes `undefined`, a non-JSON body stays raw text.
That is why a negative test can assert `result.status` without dying in a parse error — and why a spec
asserts `result.status` / `result.ok` / `result.body`, never the raw `APIResponse`.

## Which layer a scenario needs

The rule is the phase, not the payload: **the builder performs the Act, the controller performs the
preconditions and the postconditions.** A reader of the `// Act` block must be able to see every field
the request carries without opening another file, and that is only true when each field has its own
`with*` call.

| Phase | Layer | Call |
|---|---|---|
| `// Arrange` — data must exist before the Act | controller | `api.admin.createAdmin(ownerToken, AdminTestData.createAdminPayload(email))` |
| `// Arrange` — a token, a seeded record, an id to act on | controller | `api.auth.login({ email, password })`, `api.admin.listAdmins(ownerToken)` |
| **`// Act` — the request under test, happy path or negative, always** | **builder** | `api.admin.adminBuilder().withBearerToken(ownerToken).withEmail(e).withPassword(p).withConfirmPassword(p).sendCreateAdmin()` |
| `// Assert` — the cross-check that the record does or does not exist | controller | `api.admin.listAdmins(ownerToken)` |
| cleanup outside `createdAdminEmails` | controller | `api.admin.deleteAdmin(ownerToken, id)` |

Inside the Act, spell the request out field by field:

| The Act sends | Write |
|---|---|
| every field of a well-formed body | `.withEmail(e).withPassword(p).withConfirmPassword(p)` — one call per field, in body order |
| a mismatched confirmation, or any two fields set apart | ``.withPassword(p).withConfirmPassword(`${p}x`)`` |
| a field the scenario omits | leave its `with*` call out, and say so in the `// Arrange` comment |
| a body no type allows — a string, a number, `{}`, `null` | `.withRawBody({})`, `.withRawBody("not-json")` |
| missing or invalid auth | omit `withBearerToken`, or `.withBearerToken(AuthTestData.MALFORMED_TOKEN)` |
| a call no controller or builder exposes yet | add the method to `services/api/controllers/` or `services/api/builders/` and the route to `services/api/endpoints.ts` — never a raw `request.post(...)` in a spec |

Two shortcuts are **banned in an `// Act` block**, because both hide a sent value from the reader:

- `withMatchingPassword(p)` — it sets two fields under one name. Write
  `.withPassword(p).withConfirmPassword(p)`.
- `withBody(payload)` / `AdminTestData.createAdminPayload(email)` as the Act body — the fields live in
  another file. Both stay legal in `// Arrange`, where the call is a precondition and its exact shape
  is not what the test is about.

`withRawBody` is the one exception: a body that is deliberately not an object has no fields to spell
out, and the literal in the call already shows what was sent.

`Config` (`@framework/configuration/config`) is the only source of credentials — `Config.OWNER_EMAIL`,
`Config.OWNER_PASSWORD` — and `api.auth.loginAsOwner()` already wraps the owner login the `ownerToken`
fixture uses.

## Two response shapes, and one environment limit

- `GET /api/admin/users` returns Mongoose documents: `AdminUser._id`, plus `updatedAt` and an optional
  `lastLogin`.
- `POST /api/admin/users` returns `CreateAdminResponse.admin.id` — `id`, not `_id`, and no `lastLogin`.
  Asserting `_id` on a create response fails for a reason that has nothing to do with the scenario.
- `.env` currently points `ADMIN_EMAIL` at the same address as `OWNER_EMAIL`, so a token obtained "as
  admin" is an owner token. A scenario that needs a **non-owner role rejected with 403** cannot be
  honestly automated here: it would pass for the wrong reason. Skip it, name this as the reason, and
  record it under `Known Limitations` — `tests/api/admin-api.spec.ts` carries exactly that comment at
  the top of the file.

## Setup and cleanup over the API — always

| Situation | Do |
|---|---|
| the test needs an admin that already exists | seed it with `api.admin.createAdmin` in `// Arrange`, assert the seed status, push the e-mail to `createdAdminEmails` |
| the create call *is* the Act | push the e-mail to `createdAdminEmails` **before** the call, so cleanup runs even when the assertion fails |
| the delete call is the Act | still push it — `findAdminIdsByEmail` returns nothing afterwards and cleanup becomes a no-op |
| an entity `createdAdminEmails` does not cover | seed it through that entity's **seeding fixture** — `seedGame` for a game — which registers the removal before it returns |
| a seeding fixture does not exist for the entity | register the removal on `cleanupTasks` at the moment the record exists, before any assertion |
| the request under test must fail before anything is created | no registration needed, and say so in a comment |

Never arrange through a second HTTP client, a database call, or a UI flow. `createdAdminEmails` cleanup
runs through the owner token the fixture already holds.

### A seeded record is one line, and the fixture owns the rest

`createdAdminEmails` is a *fixture*, not a pattern to hand-write per entity. The equivalent for any
other resource is a seeding fixture in `fixtures/api-fixture.ts` — `seedGame` is the worked example —
which creates the record, registers its removal **before returning**, and **throws** when the seed
produced nothing usable:

```ts
// Arrange - two games, so the removed one is not the catalogue's only entry
const keptGame = await seedGame(GameTestData.uniqueGamePayload());
const removedGame = await seedGame(GameTestData.uniqueGamePayload());
```

It throws for the same reason `ownerToken` throws on a failed login: **a seed that produced no usable
record is a broken precondition, not a finding about the behaviour under test.** That is what keeps the
branch, the status assertion and the `as string` cast out of every `// Arrange` block — and there is no
information lost, because the returned object carries `id`, `name` and `status` for a scenario whose
`Expected:` names one of them.

Two failure modes, reported differently, once, inside the fixture:

| The seed | The fixture does |
|---|---|
| did not succeed | throws. Nothing was created, so there is nothing to clean up **and nothing to report as uncleanable** |
| succeeded, id unreadable | pushes the label to `uncleanableResources`, **then** throws — a record exists that this run cannot remove |

Collapsing those two into one `if (id)` branch is how a rejected `400` came to print
`NOT CLEANED UP: game "..." - created (status 400)` for a record that never existed.

**Adding a seeding fixture is inside this stream's write boundary** — `fixtures/api-fixture.ts` is
otherwise closed to the UI stream, so a UI run that needs one reports it as a shared change rather than
writing it. Prefer extending an existing fixture over repeating its body in a spec.

## Reading the API surface

**`Read` `docs/automation/references/api-surface-reading.md`.** The `# API Surface` section of a requirements
document — what it answers, what it never answers, how `## Spec Gaps` and an inherited `Auth:` line are
read, what `Source:` means, and what to do when the section is missing — lives there, because both
streams read the same section and a second copy of those rules would drift from the first.

One line of it decides every question this stream asks of the surface: **a value you assert must appear
in the test design's `Expected:`.** The surface supplies the route, the verb, the parameter names and the
bearer requirement; the design supplies everything the test claims.

## A folded scenario — one test, two scenario ids

Most tests map one to one onto a scenario. The exception is a scenario whose block carries a third
classification line:

```
Assigned Level: E2E API
Level Rationale: … folded into SCN-012 by the minimum-set pass — same actor, same operation, a second value over the one request SCN-012 already makes.
Folds Into: SCN-012
```

That scenario gets no test of its own. It is asserted inside SCN-012's test, which is the only place it
is asserted at all — so an unimplemented fold is a scenario lost silently, with no missing test anywhere
to notice. Three things change in the covering test and nothing else does:

1. **The id comment names both** — `// SCN-012 (folds SCN-018)`.
2. **The arrange block seeds whatever satisfies both preconditions.** The folded scenario asks for more
   or different data than the covering one; you seed the union. The covering scenario's own assertions
   have to stay truthful against it — that is what made the fold legal in the first place.
3. **The folded scenario's `Expected:` becomes assertions in the same `// Assert` block**, carrying the
   folded scenario's own `FR-`/`AC-` ids, not the covering scenario's.

```ts
// SCN-012 (folds SCN-018)
test("List games - Should return the requested page with its pagination metadata", async ({
  api,
  ownerToken,
  cleanupTasks,
}) => {
  // Arrange - SCN-012 needs a populated catalogue; SCN-018 needs one large enough
  // that page 2 is non-empty. One seed satisfies both, which is why SCN-018 folds
  // here rather than repeating the same GET as a second test.
  const seeded = await seedGames(api, ownerToken, cleanupTasks, GameTestData.PAGED_BATCH_SIZE);

  // Act - one with*() per parameter the request sends
  const result = await api.games.builder().withLimit(10).withPage(2).sendListGames();

  // Assert - FR-10.2 (SCN-012): the page is returned with its metadata
  expect(result.status).toBe(200);
  const body = result.body as ListGamesResponse;
  expect(body.games).toHaveLength(10);
  expect(body.pagination.page).toBe(2);

  // Assert - FR-10.4 (SCN-018): totalGames counts the whole catalogue, not the page.
  // Folded scenario, so this carries its own requirement id.
  expect(body.pagination.totalGames).toBeGreaterThanOrEqual(seeded.length);
  expect(body.pagination.totalPages).toBe(Math.ceil(body.pagination.totalGames / 10));
});
```

What a fold is **not**: a licence to merge two tests you find similar. Only a `Folds Into:` line
authorises one test to carry two ids, and it is written by the step that assigns levels, never here. Two
scenarios sharing a test without one is a Critical review finding. So is a covering test that grew a
**second `// Act`** to fit the fold — one test sends one request under test, and a folded scenario that
needs a request of its own was folded wrongly: implement the covering scenario, and record the folded
one under `Skipped Scenarios` with that reason rather than bending the phase structure around it.

## Compliant — the shape a new spec is expected to have

Every line below is the real shape of `tests/api/admin-api.spec.ts`. Copy the shape, not the scenarios.

```ts
import { test, expect } from "@fixtures/api-fixture";
import {
  AdminErrorResponse,
  CreateAdminResponse,
  ListAdminsResponse,
} from "@services/api/types/admin";
import { ResponsePatterns } from "@utils/response-patterns";
import { AdminTestData } from "@utils/test-data/admin-test-data";
import { AuthTestData } from "@utils/test-data/auth-test-data";

/** Flattens the express-validator messages of a 400 body. */
function errorMessages(body: AdminErrorResponse): string[] {
  return [body.message, ...(body.errors ?? []).map((e) => e.msg)].filter(
    (message): message is string => typeof message === "string",
  );
}

test.describe("POST /api/admin/users", () => {
  // SCN-012 — the Act is the builder, one with*() per field, so the whole request reads here
  test("Create admin - Should create an admin with a valid payload", async ({
    api,
    ownerToken,
    createdAdminEmails,
  }) => {
    // Arrange - registered before the call so cleanup runs even if it fails
    const newAdminEmail = AdminTestData.uniqueApiEmail();
    createdAdminEmails.push(newAdminEmail);

    // Act
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(newAdminEmail)
      .withPassword(AdminTestData.DEFAULT_PASSWORD)
      .withConfirmPassword(AdminTestData.DEFAULT_PASSWORD)
      .sendCreateAdmin();

    // Assert - FR-11.2
    await expect(result.response).toBeOK();
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      message: "Admin user created successfully",
      admin: {
        id: expect.any(String),
        email: newAdminEmail,
        role: "admin",
        createdAt: expect.any(String),
      },
    });

    const created = (result.body as CreateAdminResponse).admin;
    expect(created.id).toMatch(ResponsePatterns.OBJECT_ID);
    expect(created.createdAt).toMatch(ResponsePatterns.ISO_DATE);
    expect(created).not.toHaveProperty("password");

    // The record really exists, not just the response said so
    const listResult = await api.admin.listAdmins(ownerToken);
    expect(listResult.status).toBe(200);
    expect(
      (listResult.body as ListAdminsResponse).admins.map((a) => a.email),
    ).toContain(newAdminEmail);
  });

  // SCN-013 — precondition through the controller, Act through the builder
  test("Create admin - Should reject an e-mail that is already registered", async ({
    api,
    ownerToken,
    createdAdminEmails,
  }) => {
    // Arrange - a precondition, not the request under test, so the short form
    const duplicateEmail = AdminTestData.uniqueApiEmail();
    createdAdminEmails.push(duplicateEmail);

    const seedResult = await api.admin.createAdmin(
      ownerToken,
      AdminTestData.createAdminPayload(duplicateEmail),
    );
    expect(seedResult.status).toBe(201);

    // Act - the same fields again, spelled out: the duplicate e-mail is the point of the test
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(duplicateEmail)
      .withPassword(AdminTestData.DEFAULT_PASSWORD)
      .withConfirmPassword(AdminTestData.DEFAULT_PASSWORD)
      .sendCreateAdmin();

    // Assert - FR-11.4
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(errorMessages(result.body as AdminErrorResponse)).toContain(
      "User with this email already exists",
    );
  });

  // SCN-014 — the request itself is under test, so drop to the builder
  test("Create admin - Should reject a request without a bearer token", async ({
    api,
    ownerToken,
  }) => {
    // Arrange - no withBearerToken below, so nothing is created and nothing needs cleanup
    const newAdminEmail = AdminTestData.uniqueApiEmail();

    // Act
    const result = await api.admin
      .adminBuilder()
      .withEmail(newAdminEmail)
      .withPassword(AdminTestData.DEFAULT_PASSWORD)
      .withConfirmPassword(AdminTestData.DEFAULT_PASSWORD)
      .sendCreateAdmin();

    // Assert - AC-4, and the account must not exist afterwards
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);

    const listResult = await api.admin.listAdmins(ownerToken);
    expect(listResult.status).toBe(200);
    expect(
      (listResult.body as ListAdminsResponse).admins.map((a) => a.email),
    ).not.toContain(newAdminEmail);
  });

  // SCN-016 — a boundary case: the value lives in the test data class, not here
  test("Create admin - Should accept a password of exactly 6 characters", async ({
    api,
    ownerToken,
    createdAdminEmails,
  }) => {
    // Arrange - the minimum length is inclusive
    const newAdminEmail = AdminTestData.uniqueApiEmail();
    createdAdminEmails.push(newAdminEmail);

    // Act
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(newAdminEmail)
      .withPassword(AdminTestData.MIN_LENGTH_PASSWORD)
      .withConfirmPassword(AdminTestData.MIN_LENGTH_PASSWORD)
      .sendCreateAdmin();

    // Assert - FR-11.3
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      admin: { email: newAdminEmail, role: "admin" },
    });
  });

  // SCN-017 — an invalid credential value, also from the shared data class
  test("Create admin - Should reject a malformed e-mail", async ({
    api,
    ownerToken,
  }) => {
    // Arrange & Act
    const result = await api.admin
      .adminBuilder()
      .withBearerToken(ownerToken)
      .withEmail(AuthTestData.MALFORMED_EMAIL)
      .withPassword(AdminTestData.DEFAULT_PASSWORD)
      .withConfirmPassword(AdminTestData.DEFAULT_PASSWORD)
      .sendCreateAdmin();

    // Assert - FR-11.3. The test design leaves the exact message for this case
    // open, so only the status and the error shape are asserted.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect((result.body as AdminErrorResponse).errors ?? []).not.toHaveLength(0);
  });
});
```

## What the compliant example demonstrates, point by point

**The mechanical half of this list is enforced by `scripts/spec-lint.mjs`, and is therefore not
listed here.** The fixture import, the title form, the `// Arrange` / `// Act` / `// Assert`
comments, the `// SCN-` id, a URL or credential literal, a fixed wait, the e-mail helper — a script
finds every one of those or none, which is the point of moving them there. What is left is what a
script cannot reach: whether the example is *right*, not whether it is well formed.

| # | The etalon shows |
|---|---|
| E2 | fixtures destructured, not constructed: `api`, `ownerToken`, `createdAdminEmails` |
| E3 | builder for every `// Act`, one `with*` call per field sent, so the request reads in full at the point it is made — no `withMatchingPassword`, no payload object, no `withBody` |
| E4 | controller for every precondition and postcondition — the seed, the cross-check, the cleanup — where the short form keeps those steps out of the reader's way |
| E5 | cleanup registered **before** the call that creates the record; no `createdAdminEmails` at all when the call is expected to create nothing |
| E6 | every sent value from `AdminTestData` / `AuthTestData`, every contract regex from `ResponsePatterns`. The linter catches a literal e-mail or password; a literal ObjectId or an inline regex is this row |
| E7 | the one literal that does belong here: the expected response message, next to its assertion |
| E8 | the `FR-`/`AC-` id on the assertion that carries it — **which** assertion is the judgement; that the id comment and the phase comments exist at all is the linter's |
| E9 | assertions on `result.status` / `result.ok` / `result.body` (and `await expect(result.response).toBeOK()` on a happy path), plus absence assertions and a cross-check against `listAdmins` |
| E10 | a file-local helper only for **reading** a response — `errorMessages` above. A helper that *produces* test data belongs in `utils/test-data/` |
| E11 | a comment stating why a case is asserted loosely, when the design left the value open |
| E14 | a seeded precondition is a single `await seedGame(...)` line — no `if (id)` branch, no `as string` cast, no per-call-site `uncleanableResources` push, and no status assertion the fixture already makes by throwing |

## Non-compliant — the same intent, and the defects it carries

```ts
import { test, expect } from "@playwright/test";              // (1)

const OWNER_PASSWORD = "Owner12345@";                          // (2)

test("should create admin", async ({ request }) => {           // (3)
  const login = await request.post(
    "http://localhost:9000/api/auth/login",                     // (4)
    { data: { email: "owner@example.com", password: OWNER_PASSWORD } },
  );
  const token = (await login.json()).token;

  const response = await request.post(
    "http://localhost:9000/api/admin/users",
    {
      data: {                                                   // (5)
        email: "new.admin+1@example.com",
        password: OWNER_PASSWORD,
        confirmPassword: OWNER_PASSWORD,
      },
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  expect(response.ok()).toBeTruthy();                           // (6)
});
```

| # | Defect | Severity |
|---|---|---|
| 1 | import from `@playwright/test`; the fixtures vanish and cleanup never runs | Major |
| 2 | credential literal in the spec instead of `Config` | Critical |
| 3 | title does not follow `"<Feature> - Should <behavior>"` | Minor |
| 4 | raw `request.post` and a URL literal, bypassing the controller, the builder and `Endpoints` | Major |
| 5 | a hard-coded e-mail containing a dot and a plus — `normalizeEmail()` rewrites it, and the record is never registered for cleanup, so the second run collides | Major |
| 6 | assertion on the raw `APIResponse` with no status and no body check; a 200 would pass as loudly as a 201 | Major |

The credential is the only Critical here. Everything else is Major or Minor — and none of the six is a
**coverage** finding, which is the separate and more valuable question: whether every scenario the test
design assigned to this stream actually got a test, and whether that test asserts what the scenario says.

### The hand-written seed block — a seventh defect, from a real spec

The example above does not carry this one, because it seeds an admin and `createdAdminEmails` already
covers that. It appeared the moment a spec needed a resource with no fixture of its own, and it appeared
**five times in two files** before anybody named it:

```ts
const seed = await api.games.createGameAndGetId(          // (7)
  ownerToken,
  GameTestData.createGamePayload(gameName),
);
if (seed.id) {                                            // (8)
  const id = seed.id;
  cleanupTasks.push({ label: `game ${id}`, run: async () => { await api.games.deleteGame(ownerToken, id); } });
} else {
  uncleanableResources.push(`game "${gameName}" - created but its id could not be read back`);
}
expect(seed.result.status).toBe(201);
const gameId = seed.id as string;                         // (9)
```

| # | Defect | Severity |
|---|---|---|
| 7 | twenty lines of arrange repeated per seeded record; the reader reaches the `// Act` four screens down | Major |
| 8 | branches on `id` rather than on whether the create succeeded, so a rejected request is reported as an unremovable leak — a false claim in the run output | Major |
| 9 | `as string` asserting away a case the line above proves is possible | Minor |

All three are one finding with one fix: **a seeding fixture**. A reviewer seeing this shape reports it
against E14 and points at `seedGame`; it is not a style preference, because (8) makes the cleanup report
untrue.


---

# Appendix — read a section only when its scenario shape comes up

Neither section below is part of the general form, and a run that does not meet the shape it
describes gains nothing by reading it. They are here rather than in Core because the Core is read on
every run and these two are not needed on most of them.

| Read | When |
|---|---|
| *Query parameters* | the scenario sends one — a `GET` over a collection with `search`, `limit` or `page` |
| *Filtering a shared collection* | the scenario asserts over a catalogue other tests also write to |

---

## Query parameters

`GET` collections take their filters and paging in the query string. The `// Act` rule does not change:
**one `with*()` per parameter the request sends**, so the whole request still reads at the point it is
made. A parameter set with a payload object, or spliced into the URL as a string, hides what was sent —
the same defect as `withBody` in an Act block.

The builder holds the query the way it already holds headers, and Playwright serialises it through
`params`:

```ts
export class GamesRequestBuilder {
  private query: Record<string, string | number | boolean> = {};
  private headers: Record<string, string> = {};

  constructor(private readonly request: APIRequestContext) {}

  // #region Query
  withQueryParam(name: string, value: string | number | boolean): this {
    this.query[name] = value;
    return this;
  }

  /** Named sugar for the parameters the API documents. */
  withLimit(limit: number): this {
    return this.withQueryParam("limit", limit);
  }

  withPage(page: number): this {
    return this.withQueryParam("page", page);
  }

  withSearch(search: string): this {
    return this.withQueryParam("search", search);
  }
  // #endregion

  async sendListGames(): Promise<ListGamesApiResult> {
    const response = await this.request.get(Endpoints.games.list, {
      params: this.query,
      headers: this.headers,
    });

    return toApiResult<ListGamesResponse | GamesErrorResponse>(response);
  }
}
```

and the Act reads as one line naming every parameter it sends:

```ts
// Act
const result = await api.games.builder().withLimit(10).withPage(2).sendListGames();
```

Rules for the sugar:

- Add a named `with*()` for a parameter the API surface documents, and use it. `withLimit(10)` says what the
  request means; `withQueryParam("limit", 10)` only says what it contains.
- Keep `withQueryParam` for a parameter no scenario names repeatedly, and for one the surface does not
  document — that case needs the escape hatch precisely because there is nothing to name it after.
- Never add a `with*()` for a parameter no scenario uses. A builder is grown by the tests that need it, not
  filled in from a route list.
- A parameter omitted from the chain is a parameter the request does not send. That is a meaningful test
  input — the default-paging case is `sendListGames()` with an empty chain, not `withPage(1)`.

## Filtering a shared collection

A filter parameter (`search`, and any `?field=` narrowing a collection) asks a question the rest of this
document does not: **the endpoint answers about records this test did not create.** The catalog is
shared, `fullyParallel` is on, and another spec is seeding and deleting rows in it while this one reads.
Four rules follow, all of them visible in `tests/api/games-search-api.spec.ts`.

**Search on a token the test seeded itself.** A term borrowed from the environment — the first row of
the collection, a shipped title — is data another spec may delete mid-test, and the failure reads as a
broken filter. Seed the matches, name them from a run-unique token, and the filtered set is closed:

```ts
// Arrange - two seeds under different tokens, so a term matching only one of
// them proves filtering rather than an empty catalog
const token = GameTestData.uniqueSearchToken();
const matchingGame = await seedGame(GameTestData.createSearchSeedPayload(token));
const otherGame = await seedGame(
  GameTestData.createSearchSeedPayload(GameTestData.uniqueSearchToken()),
);
```

The token belongs in `utils/test-data/`, like every other sent value, and it is **free of regex
metacharacters** — a term is a filter input, and a generator that emits `.` or `(` into one makes the
test's own data the variable under test.

**Read the count off the response, never off the environment.** A filtered page's `pagination` block
counts the whole match set, so it rules out a second match that landed off-page — which asserting on
`games.length` alone cannot:

```ts
expect(body.games.map((game) => game.name)).toEqual([matchingGame.name]);
expect(body.pagination.totalGames).toBe(1);
```

The same reasoning bars `expect(totalGames).toBe(21)`: a literal catalog size is a fact about one
machine at one moment. Where the scenario is paging, assert the metadata's internal consistency
(`totalPages`, `hasNextPage`, `currentPage`) and the union of the pages against the seeded ids.

**An empty result needs a positive control.** `games` coming back empty proves the filter excluded the
record *or* that the seed never landed, and those are opposite verdicts. Pair the empty assertion with a
second read that must return the same record — through the **controller**, since it is `// Assert`
plumbing and not the request under test:

```ts
// Act - the term is the description's token, which no name carries
const result = await api.games.gamesBuilder().withBearerToken(ownerToken)
  .withSearch(descriptionToken).withLimit(...).withPage(1).sendListGames();

// Assert
expect((result.body as ListGamesResponse).games).toEqual([]);

const byName = await api.games.listGames(ownerToken, { search: nameToken, ... });
expect((byName.body as ListGamesResponse).games.map((game) => game._id))
  .toEqual([seededGame.id]);
```

One `// Act` still means one request under test. A second *builder* chain in the same test is a second
Act and belongs in a second test — the genre and description cases are two tests for exactly that
reason.

**Choose absence-of-id over an empty page when a legitimate match could exist.** Searching for a genre
word must not reach the seed, but a shipped title carrying that word in its *name* is a correct match;
asserting an empty page would fail on somebody else's data. Assert what the scenario claims — that this
id is not in the result — and say in a comment why the stronger form would be wrong.

**A term that crashes the endpoint is asserted against the specification.** Where the filter is
interpolated into a pattern without escaping, a metacharacter term returns `500`. The test asserts the
outcomes the specification allows and lets the defect stand red, with a comment naming it:

```ts
// Assert - either outcome is defensible; a 500 is not one of them
expect([200, 400]).toContain(result.status);
```

Both defensible outcomes are named because the surface documents neither — inventing a single expected
status would be a guessed mechanic. Weakening this to `not.toBe(500)`, or to whatever the app currently
returns, deletes the report; the red test **is** the deliverable.
