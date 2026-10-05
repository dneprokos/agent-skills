# Revision Contract

The process every test-implementation stream in this repository follows when it runs more than once: how
a run resolves its mode, what a revision may touch, how each finding is ruled on, what stays full
regardless, and what the receipt has to account for.

It is shared across streams on purpose. The workflow that drives these runs counts iterations, feeds
findings back by id, and treats the two streams as independent — which only works if both interpret a
re-invocation the same way.

**What this document does not contain:** anything stream-specific. The ownership boundary, the framework
layers, the etalon, the commands, the receipt's own field names — those live in the stream's own
instructions, because they differ. Read both.

Throughout, `<STREAM>` is `API` or `UI` and `<stream>` is `api` or `ui`.

## 1. Mode — resolve it before writing anything

| Output exists | `review_findings` | `scenario_ids` | Mode |
|---|---|---|---|
| no | — | — | `first_run` — implement the whole selected scope |
| yes | no | no | **`EXISTS`** — stop. Change no file, and do not overwrite the report |
| yes | no | yes | `first_run` scoped to those ids — the next batch of a batched run |
| yes | yes | — | `revision` |

**The `EXISTS` row is the load-bearing one.** A caller may retry after a timeout, or re-enter a phase,
without meaning to ask for anything new. Redoing finished work would overwrite a report someone may be
reading right now, replace tests a review has already cited by line number, and spend a browser session
re-observing what is already on disk. When returning `EXISTS`, name the existing report and its
`iteration:` so the caller can see what it already has.

`iteration` is whatever the caller passed, or the existing report's `iteration:` + 1, or `1`. Never count
iterations yourself, and never infer one from how the work looks.

**There is no `regenerate` row, and that is deliberate.** The repository's writing agents resolve one of
four modes — `first_run`, `EXISTS`, `revision`, `regenerate` — but `regenerate` belongs to the agents
that own a whole document and can rewrite it from its source. A test-implementation stream owns test
code a review has already cited by file and line, so the only full rewrite available here is deleting
the report and running `first_run` again, which is the caller's decision and not a mode you resolve. A
caller asking for a regenerate is asking for something this contract does not define: return `EXISTS`,
name the report on disk, and say so in `NOTES`.

## 2. A revision is scoped by its findings

The work list is the set of findings handed in — every finding in `review_findings`, or only those
`finding_ids` names when the caller narrowed it. **Nothing else is in scope**, however much it would
improve the file you are already in.

### What may be touched

- A file a finding names.
- A file that must be created or extended to satisfy a coverage finding — a scenario reported missing has
  no `file:line` to point at, so implementing it is in scope by definition.
- The stream's own implementation report.

Everything else stays byte-identical. That includes **tests from the previous iteration that no finding
names** — not only tests written by someone else. A review cites findings by `file:line`, and a spec
reformatted or resorted invalidates every line number in the block being worked from.

`Edit`, never a wholesale rewrite. Rewriting a spec file to fix one assertion produces a diff nobody can
review, and the check that a revision was scoped becomes unfalsifiable.

Never renumber or re-map scenario ids. The findings cite them.

## 3. Ruling on each finding

Every id handed in gets exactly one verdict, recorded in the report's `Review Findings Addressed` table:

| Verdict | When | Also required |
|---|---|---|
| `fixed` | the code now does what the finding asked | the `file:line` of the change in the `Where` column |
| `disputed` | the finding is believed wrong | an entry under `Known Limitations` giving the reasoning. Never a silent omission, and never an argument made only in the receipt |
| `not applicable` | the finding names a file outside this stream's ownership boundary, or a scenario not assigned to this stream's level | the reason, in one clause |

A finding that cannot be fixed without a change outside the boundary is `disputed` **and** a
`Shared Change Requested` entry.

**Never drop an id.** An id handed in that appears in neither the table nor the input is the failure this
contract exists to prevent, and a review treats it as Critical.

## 4. Still full, every time

A revision is scoped in what it *changes*, never in what it *verifies*.

- **Re-run the whole stream suite and the type check before you report** — not only the tests touched. A
  revision that was not re-run is not a revision, and a fix in one spec that breaks another is exactly
  what a full run catches.
- **The fix loop is the one thing that narrows.** While you are still debugging a red test you may run
  just the specs you changed; that loop is a working step, not a result. The run that produces the counts
  you report is always the full one, on a revision exactly as on a first run. Never report a targeted
  run's counts as the suite's, and never let a green targeted run stand in for the full one.
- **Overwrite the report file** and set `iteration:` to the resolved value.
- **The report describes the current state of the code, not this iteration's diff.** Every section other
  than `Review Findings Addressed` is rebuilt in full, so `Implemented Scenarios` still lists every
  scenario the stream covers, not only the ones touched this round.

## 5. The receipt

Each stream emits its own receipt block with its own leading key. Three rules hold across both:

- The three `FINDINGS_` lines — addressed, disputed, not applicable — read `none` on a `first_run`.
  Together they account for **every** id the caller handed in, with no id appearing in two of them.
- The receipt is a receipt, not a diff. Never paste test code into the final message; it lives in the
  files, and the caller re-reads from disk.
- On `ABORT` or `BLOCKED`, emit the result key, the ticket, `REASON` and `NOTES` only. On `EXISTS`, emit
  the result key, the ticket, the report path, `ITERATION` and `NOTES` only.

**The caller decides what happens next.** Never name a next step, never recommend one, and never emit a
`NEXT:` field. Routing lives in one place and it is not here.

## 6. Boundaries that hold in every stream

- **Do not implement a scenario assigned to another level**, and do not write, move or modify a line
  inside the sibling stream's ownership. A parallel stream owns those files and an edit there collides
  with work in flight.
  **One carve-out, additive only:** a stream may *add* a file, an endpoint key or a facade member to the
  sibling's service layer when a scenario cannot otherwise be set up or cleaned up. Adding is safe with
  both streams in flight because a conflict lands on different lines; modifying is not. Nothing already
  there may be renamed, retyped, re-valued or deleted, the sibling's fixture file stays closed, and every
  addition is listed on the receipt so the boundary crossing is visible. If the sibling's report already
  lists what you need, reuse it rather than adding a second copy.
- **Do not modify `playwright.config.ts`, `framework/`, `tsconfig.json`, `package.json` or `.env`.** A
  scenario that cannot be automated without one of those is a `Shared Change Requested` entry and, if
  truly blocking, a skipped scenario.
- **Do not read `requirements/`**, or assert a value taken from it. The requirements were reviewed and
  closed in an earlier phase; the test design is the specification, and a value in one but not the other
  is a design question, not one to settle inside a spec.
  **One section is exempt: `# API Surface`.** It documents how the system is reached — route, verb,
  parameters, auth requirement, response shape — and a stream that must call an operation needs it. The
  exemption is for mechanics only, and it does not widen what may be asserted: **a value you assert must
  appear in the test design's `Expected:`**, whatever that section documents about the operation. Reading
  any other section of the file remains out of bounds. A stream whose subject is not the HTTP request
  narrows the exemption further — it reads the surface for arrange and cleanup mechanics and nothing
  else, and a route it documents is never a reason to write a test for that route. The section's own
  rules are in `docs/automation/references/api-surface-reading.md`, including what to do when it is absent.
- **Do not edit the test design.** It is an input, and it belongs to whoever produced it.
- **Do not report an execution result you did not observe**, and never carry counts over from a previous
  iteration.
- **Do not weaken, delete or `.skip` an assertion so a run turns green.** A test that asserts the
  specification and fails is finished work, and it is reported as a suspected application defect.
- **Do not invent a value the test design does not state** — a status code, message, field name, limit or
  rendered string. A value the design marks `unknown:` is not assertable at all. This holds against the
  running system as hard as against another document: what a stream observes while working out **how** to
  reach an observable — a route an action calls, the shape of a region, what triggers a re-render — is
  mechanics, and mechanics never become assertions. A stream that can see the app is one step from
  asserting what it saw, and an assertion sourced that way can only ever agree with the application.
- **Do not put a credential, token or secret literal in a spec.** Everything comes from `Config`.
- **Do not declare test data inside a spec.** It already exists under `utils/`, and a second copy drifts
  from the first without anything failing. A helper that drives or reads the system under test belongs in
  the layer that models it, not at a spec's module scope.
- **Do not rename, re-value or delete anything already in `utils/**`.** The sibling stream reads the same
  classes, and the change would land under it mid-run.
- **Do not leave a created record behind.** Every test cleans up what it created, registered the moment
  the record exists so a failing assertion cannot skip past the registration, and scoped to that test's
  own data — never a delete-all, with `fullyParallel` on. A record the application offers no route to
  remove is the one exception, and it is reported rather than ignored: in the run output, under
  `Cleanup Gaps`, and on the receipt.
- **Do not rewrite, reformat, resort or re-run a fix over a test no finding names.** An unrequested
  improvement invalidates the `file:line` of every finding handed in and buries the change the review is
  looking for.
- **Do not drop a finding id**, or answer one only in the receipt.
- **Do not overwrite the report, or change any file, when the mode resolved to `EXISTS`.**
- **Do not touch Jira.** No Atlassian tools are granted, deliberately.
