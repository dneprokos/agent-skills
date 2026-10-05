# Reading the API Surface

Shared by both automation streams. The requirements document for a ticket may carry a `# API Surface`
section describing the HTTP operations the feature runs on: route, verb, documented parameters, request
body fields, auth requirement, documented status codes and response shapes.

It is the **only** section of `requirements/` either stream opens, and it answers exactly one kind of
question — *how is this system reached?*

| It tells you | It never tells you |
|---|---|
| the route and the verb | what a test should assert |
| the parameter and field names, and their types | which scenarios exist |
| whether the operation requires a bearer token | whether an assertion is correct |
| the documented response shape | what an error message says |

**The rule that keeps the two apart: a value you assert must appear in the test design's `Expected:`.** A
status code the surface documents but the design did not select is not assertable — the operation *can*
return it; only the design decides whether this test claims it does. Asserting one anyway is an invented
value, and the review checks every assertion against exactly this rule.

## What each stream uses it for

The two streams read the same section for different reasons, and the second one is the narrower.

| Stream | Reads the surface to | Never |
|---|---|---|
| API | build the request that **is** the test — route, verb, parameters, body fields, the bearer requirement | decide what the response should contain |
| UI | build **arrange and cleanup mechanics** — which route creates the resource a scenario needs, which route removes it afterwards | source an assertion of any kind |

For the UI stream the surface is plumbing, never subject matter. A UI test asserts what the browser
rendered, against the test design's `Expected:` and nothing else; the surface only tells it how to get
the fixture data in and out. A route the surface documents is not a reason to write a test for that
route — a scenario that genuinely needs a hand-shaped HTTP request is an API scenario.

## Two shapes that are read wrongly if read quickly

- **`## Spec Gaps`** is context, not a work list. A gap explains why a design left a value out. It is
  never a reason to put one back.
- **`Auth: <scheme> (inherited from the spec-wide default — the operation does not state it)`** means the
  document made no claim about *this* route. It is not evidence that the route is protected, and an
  authentication test written on that basis asserts the document's default rather than the application's
  behaviour. Only a scenario whose `Expected:` states the outcome authorises that test.

## Provenance

The section records where each operation came from. `Source: openapi` is the application describing
itself. `Source: user-supplied — <approver> — <date>` is a person who took responsibility for a fact the
document does not state. Both are usable as mechanics; neither is usable as an assertion.

## When the section is missing

The requirements front matter carries `api_surface: mapped | partial | none | ignored`. `none` and
`ignored` both mean there is no surface to read, and `# API Surface` then holds a stated reason rather
than operations.

In that case the surface can be produced directly:

```bash
node scripts/api-surface.mjs --match <comma-separated keys>
```

Match keys are entities, OpenAPI tags or routes — `games`, `Games`, `/api/games`, `GET /api/games`. Keep
them short; `games` matches better than `game catalogue browsing`. The script prints the finished
`# API Surface` block on stdout and a one-line summary on stderr, and its exit code says what happened:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | matched | use stdout as written; `status=` on stderr is `mapped` or `partial` |
| 2 | usage error | fix the invocation, retry once |
| 3 | no operation matched | stderr lists the available tags; retry once with keys from that list, then carry on without a surface |
| 4 | document unreachable | carry on without a surface |
| 5 | document unparseable | carry on without a surface |

**The surface never blocks a run.** No surface means arranging with what the facade already offers, and
recording the consequence — a resource that cannot be seeded, or one that cannot be cleaned up — under
`Known Limitations`. It does not mean guessing a route.

Nothing else in this repository fetches or parses the OpenAPI document. Do not re-fetch it by hand, do
not reformat the script's output, and do not add operations it did not return.
