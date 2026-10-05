# Browser Exploration Protocol

How an agent opens the application under test (AUT), reads its real DOM, and reports selectors.

Read this file **before** your first `playwright-cli` command. Every rule below is enforced by the
agent body, not by the tool grant — `Bash` alone does not tell you what you are allowed to look at.

**The commands, in full.** Every `playwright-cli` invocation an exploration needs is below; there is no
other reference to open, and a command absent from this list is one you do not run. `-s=<name>` names the
session and is required on every call (§2).

```bash
playwright-cli -s=<name> open <url>          # start the session on a page
playwright-cli -s=<name> goto <url>          # navigate an open session
playwright-cli -s=<name> snapshot            # the accessibility tree, with e-refs
playwright-cli -s=<name> eval "<expr>"       # evaluate against the page
playwright-cli -s=<name> eval "el => el.getAttribute('data-testid')" e5
playwright-cli -s=<name> click e5
playwright-cli -s=<name> fill e3 "<value>"
playwright-cli -s=<name> press <Key>         # Enter, ArrowDown, Escape
playwright-cli -s=<name> hover e4
playwright-cli -s=<name> select e9 "<value>"
playwright-cli -s=<name> check e12           # and uncheck
playwright-cli -s=<name> dialog-accept       # and dialog-dismiss
playwright-cli -s=<name> network             # requests the last action fired
playwright-cli -s=<name> console             # console output, for a silent failure
playwright-cli -s=<name> screenshot          # only when a snapshot cannot show it
playwright-cli -s=<name> close               # always, on every exit path
playwright-cli list                          # sessions still open — should be empty afterwards
```

---

## 1. Preflight

The AUT must be running at `Config.BASE_URL` — see `framework/configuration/config.ts`, sourced from
`BASE_URL` in `.env`. `http://localhost:9000/` is the documented local default, not a constant: read the
value, then preflight the value you read.

```bash
curl -s -o /dev/null -w "%{http_code}" <BASE_URL>
```

Anything other than a 2xx/3xx means **stop**. Report the run as blocked with the status code you got.
Never guess a selector, a route, or an error string because the app was unreachable — an invented
`data-testid` produces a test that fails on the first real run and looks like an app bug.

Every command in §2 and §3 opens that same `BASE_URL`. Preflighting one host and exploring another is
how a run produces confident selectors for an application nobody checked was up.

## 2. Session protocol

Always a **named** session. Always closed.

```bash
playwright-cli -s=<agent-name> open <BASE_URL>/login
playwright-cli -s=<agent-name> snapshot
playwright-cli -s=<agent-name> close
```

Use your own agent slug as the session name (`-s=<your own agent slug>`, or a purpose name like
`-s=env-explorer`). The API and UI streams
run in parallel; an unnamed session is shared state and the two runs will overwrite each other's page.

`close` is not optional, and it is not deferred to the end of your run. Close the session the moment
exploration ends — before you write code, before you run a suite, and **before you return on any path**,
including an abort, a block or a failure. An unclosed session leaves a browser process alive between runs
and collides with the other stream. Check for strays with `playwright-cli list` — it should print
`(no browsers)` once you are done.

Each command writes its snapshot and console log to `.playwright-cli/` in the repo root and prints the
path. That directory is gitignored; read from it freely, never commit it, never clean it up by hand.

## 3. Discovery loop

`snapshot` returns a YAML accessibility tree with a `ref` per element (`e5`, `e12`, …). Use the ref to
pull the real attribute you intend to commit:

```bash
playwright-cli -s=env-explorer snapshot
playwright-cli -s=env-explorer eval "el => el.getAttribute('data-testid')" e5
```

**Refs are snapshot-local.** They change on every navigation and re-render. A ref must never appear in
committed test code, in a page object, or in a selector map — it is a handle for the current
conversation only.

To reach an authenticated page, drive the login form the same way a test would, then continue
exploring:

```bash
playwright-cli -s=env-explorer fill e3 "$OWNER_EMAIL"
playwright-cli -s=env-explorer fill e4 "$OWNER_PASSWORD"
playwright-cli -s=env-explorer click e5
playwright-cli -s=env-explorer snapshot
```

Credentials come from `.env` (`OWNER_EMAIL` / `OWNER_PASSWORD` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`,
typed in `framework/configuration/config.ts`). Never paste a literal password into a command you
report, and never copy one into a document.

## 4. Translating findings into locators

A locator comes from the **highest tier the application makes possible**. See `pages/login-page.ts`
and `pages/home-page.ts` for the house style — both are tier 1 throughout.

| Tier | Locator | Status |
|---|---|---|
| 1 | `getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId` | preferred |
| 2 | `#id` — an author-written, stable id | allowed with justification |
| 3 | `[data-*]` — a stable attribute other than the testid | allowed with justification |
| 4 | structural CSS (`table > tbody > tr`) | last resort, with justification |
| — | XPath; a generated or hashed class name (`.css-1a2b3c`, a CSS-module class); a text match on copy product can reword; `nth()` on a **data** row | **banned at every tier** |

| Snapshot shows | Confirm with | Write as | Tier |
|---|---|---|---|
| element with `data-testid` | `eval "el => el.getAttribute('data-testid')" e5` | `page.getByTestId("email-input")` | 1 |
| `button "Logout"` | role + accessible name are in the snapshot already | `page.getByRole("button", { name: "Logout" })` | 1 |
| `status` / `alert` live region | role is in the snapshot | `page.getByRole("status")` | 1 |
| no testid, no role name, but an id in the markup | `eval "el => el.id" e5` | `page.locator("#game-genre")` | 2 |
| no testid, no role name, no id, but a stable `data-*` | `eval "el => el.dataset" e5` | `page.locator("[data-column='genre']")` | 3 |
| none of the above, but a stable structural position | `eval "el => el.outerHTML" e5` | a structural CSS selector | 4 |
| nothing stable at any tier | — | report it as a gap; **never** invent a hook |

Every tier below 1 has to earn it. `eval` the higher tiers first and record what you found — the
justification comment says what was actually tried, so "no role" means you looked. Three things travel
with a tier drop:

1. `// LOCATOR-FALLBACK: tier <n> — <why every higher tier is impossible>` on the locator field,
2. a `LOCATOR_GAPS` entry in the receipt,
3. the `Tier` column of the selector map below.

The ladder is not a licence to guess. An element with no stable hook **at any tier** is still a finding
to escalate, not a problem to solve with a selector you hope holds. Say so in the report so the app team
can add a `data-testid`.

## 4b. Reading mechanics

A locator says *where* an observable is. It does not say **how the page gets there**, and a test that
locates perfectly still races if it waits on the wrong thing. Those are the **mechanics**, and they are
the second thing an exploration run reads.

Only five questions are mechanics. The list is closed — anything not on it is either a locator (§4) or a
value, and a value is not yours to take from the app:

| # | Question | What it decides in the test |
|---|---|---|
| 1 | Does this action fire a network request, and which method and route? | whether the action is wrapped in `Promise.all([page.waitForResponse(...), action])`, and what the pattern matches |
| 2 | If it fires none, what proves the re-render finished? | a client-side render has no response to wait on, so the wait is the locator API — `await previousElement.waitFor({ state: "detached" })` |
| 3 | What **shape** is the empty or error state — a live region, an inline element, an empty table body? | which locator the absence assertion is written against, and whether a positive pairing is even reachable |
| 4 | What actually triggers the action — a submit, an `Enter`, a debounce on typing? | whether `fill` alone is the act, or `fill` + `press`, and whether the wait starts before or after the delay |
| 5 | Does the action raise a native dialog? | a `window.confirm` handler must be registered **before** the click, or Playwright auto-dismisses and the request never fires |

Read them by doing the thing and looking at what happened:

```bash
playwright-cli -s=<agent-name> fill e7 "mario"
playwright-cli -s=<agent-name> network
playwright-cli -s=<agent-name> snapshot
```

`network` lists the requests the page made; `console` catches the client-side error that explains a
request that never went out. Both are read-only and neither commits anything.

**Mechanics answer how to reach and wait for an observable. They never answer what it says.** A rendered
string, a count, a status message you read off the screen is an invented value the moment it reaches an
assertion, whatever this map records — expected values come from the test design's `Expected:` and from
nowhere else. So the map records a *shape* (`role=status` live region) and a *route*
(`GET /api/games`), never the text inside the region and never the number of rows that came back.

`# API Surface` in the requirements document and this map answer different halves of the same question
and neither is an assertion source: the surface says the route exists and what it answers, the map says
whether **this control calls it**. A route documented in one and never observed in the other is a route
this UI may not touch at all.

## 5. Output contract

An exploration run ends with a **selector map**, not prose:

```markdown
### /login
| Element | Role | data-testid | Tier | Locator |
|---|---|---|---|---|
| Email field | textbox | email-input | 1 | page.getByTestId("email-input") |
| Password field | textbox | password-input | 1 | page.getByTestId("password-input") |
| Submit button | button | login-button | 1 | page.getByTestId("login-button") |
| Error banner | status | — | 1 | page.getByRole("status") |
| Genre cell | — | — | 2 | page.locator("#game-genre") |
```

One table per page or route. Every row must trace to something you actually observed in a snapshot, and
every row whose `Tier` is not 1 must also appear under `LOCATOR_GAPS`.

A run that read mechanics ends with a second map beside it — the **mechanics map**, one row per action a
scenario performs:

```markdown
### /games
| Action | Request | Trigger | Result shape | Dialog |
|---|---|---|---|---|
| Type into search field | GET /api/games?search=&lt;term&gt; | on value change; no submit control exists | card grid re-renders in place | — |
| Search matching nothing | GET /api/games?search=&lt;term&gt; | on value change | empty-state block (`data-testid="no-results"`) replaces the grid: heading + message inside it | — |

### /owner
| Action | Request | Trigger | Result shape | Dialog |
|---|---|---|---|---|
| Click "Delete Admin" | DELETE /api/admin/users/:id | on confirm accept | row detaches from the rowgroup | `window.confirm` |
```

Every row traces to an action you performed in this session and a `network` or `snapshot` output you
read afterwards. `Request` is `none` when the action fired nothing and `—` when the row describes a
state rather than an action. A mechanic you needed and could not observe is reported as unobserved, not
filled in from what seems likely — the wait written on a guess is the flake this map exists to prevent.

**No cell of this map holds a rendered string, a count, or any other value a test could assert.** A
`Result shape` of `role=status live region` is a mechanic; the words inside it are not.

The rows above are the mechanics actually observed on `/` for this repository, and the two of them
decide the whole shape of `tests/ui/search-games.spec.ts`: the act is `fill` alone because nothing else
triggers the request, the wait matches the `search` parameter's *value* because the same route fires on
mount with an empty one, and the absence assertion is written against the empty-state block rather than
against the card grid. Read that spec and `pages/home-page.ts` next to this table to see a mechanics map
spent.

## 6. Must not

- Report a selector that did not appear in a snapshot you ran in this session.
- Report a mechanic you did not observe — a request you did not see in `network`, a trigger you did not
  perform, a dialog you did not raise. An unobserved mechanic is reported as unobserved.
- Put a rendered string, a count or any other assertable value into the mechanics map. It records how an
  observable is reached and waited for, never what the observable says.
- Drop below tier 1 without having `eval`ed the higher tiers, or without the three receipts in §4.
- Use an XPath, a generated class name, or a text match on product copy at any tier. Those are not
  tier 4; they are outside the ladder.
- Leave a session open, or use the default unnamed session.
- Put a `ref` (`e5`) into any committed file.
- Write to `tests/`, `pages/`, `fixtures/`, or `services/` during an exploration run — exploration
  produces a map; implementing from it is a separate step with a separate tool grant.
- Hardcode credentials into a command you report or into a document.
- Derive a *requirement* from the UI. What the app currently does is not evidence of what it should
  do. Requirements, error strings, status codes, and limits come from
  `requirements/<TICKET-ID>-requirements.md` only.
