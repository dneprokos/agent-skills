# E2E stream scope — what a stream implements, and what counts as a test

**Read this at the scenario-selection step of a stream that writes tests, and at the coverage pass of
the step that reviews them.** Both halves of a stream must agree on which scenarios were that stream's
work, or the reviewing half reports a scenario as dropped that the design never asked for, and misses one
that really is gone. The rules below are the same words for both halves and for both streams.

Read it, do not work from memory. The failure this file exists to prevent is a folded scenario silently
losing its coverage, and that failure looks exactly like a clean run from every side that has not read
the design's `Folds Into:` lines.

Throughout, **your stream's level line** means `Assigned Level: E2E API` in the API stream and
`Assigned Level: E2E UI` in the UI stream. Nothing here is stream-specific; where a stream needs a rule
of its own, that rule lives in the stream's own etalon, not here.

## 1. What selects a scenario

`Grep` the test design for your stream's level line and read every matching block in full. Of those, the
ones that get a test are the blocks carrying **no `Folds Into:` line**. The rest are covered inside those
tests — section 3.

A scenario at any other level is not yours. Neither is a `Assigned Level: Requirement Gap` scenario:
that is a requirement waiting to be specified, not a test at a level nobody runs.

## 2. Two aborts and one valid nothing

- **No `Assigned Level:` lines anywhere in the document** -> ABORT `LEVELS_NOT_ASSIGNED`. A test design
  whose levels were never finalized is not approved work, and `Suggested Level:` is not a substitute — it
  is the proposal, not the decision.
- **`scenario_ids` supplied** -> implement exactly those ids. One the document does not carry ->
  ABORT `SCENARIO_NOT_FOUND`. One carrying a different `Assigned Level:` is not yours: skip it with that
  reason rather than implementing it at the wrong level.
- **Zero scenarios at your stream's level** -> return `OK` with `IMPLEMENTED_SCENARIOS: none` and a
  `NOTES` line saying so. This is a valid outcome, not a failure. An earlier step normally settles such a
  stream before it is ever launched; arriving here anyway is not a reason to invent work.

## 3. Folding — one test, more than one id

A scenario block may carry a third classification line, after `Level Rationale:`:

```
Folds Into: SCN-012
```

It means an earlier step decided this scenario needs the deployed system but **not a traversal of its
own**: another scenario at the same level already acts as the same actor over the same route, and the two
differ only in the data sent or asserted. That decision is made. You do not re-open it, and you never fold
or unfold anything yourself.

What it changes:

- **A scenario carrying `Folds Into:` gets no test of its own.** It is never selected, never counted as a
  test, and never listed as skipped merely for being folded.
- **A scenario named as a fold target gets one test that covers both.** `Grep` the design for
  `Folds Into: <id>` for each scenario you selected, and read every block that names it. Its `Expected:`
  becomes additional assertions inside that one test, and its `Preconditions:` widen the arrange block —
  you set up whatever satisfies both. Setting up for the wider precondition is the point of the fold: the
  covering scenario's own assertions must stay truthful against it.
- **A fold never merges two `// Act` blocks.** One test has one Act, and the phase comments appear once
  each. A folded scenario that would need a second action as its Act was folded wrongly: implement the
  covering scenario, record the fold under `Known Limitations` naming both ids, and leave the folded
  scenario in `Skipped Scenarios` with that reason. Do not write a second Act to make the fold fit.
- **Every folded scenario's `Expected:` is asserted, or the scenario is a `Skipped Scenarios` entry
  naming which one and why.** A folded id has no other test to fall back on, so an unimplemented fold is
  a silently lost scenario — the one failure mode this mechanism has.
- **`scenario_ids` supplied**: an id in that list carrying `Folds Into:` is not a test of its own.
  Implement its covering scenario instead, cover it there, and say so in `NOTES`.
- **Every marker rule applies to a folded scenario exactly as to any other.** An `unknown:` in a folded
  scenario's `Notes:` is still never asserted, and a folded scenario left with nothing assertable is a
  `Skipped Scenarios` entry with that reason, not a silence.

The id comment names both: `// SCN-012 (folds SCN-018)`. The `FR-`/`AC-` id on each assertion is the one
**that assertion's own scenario** records — a folded scenario's assertion carries the folded scenario's
requirement ids, not the covering scenario's.

## 4. Selected, implemented, folded, skipped

Four different statements, and a report that blurs them is unreadable downstream:

| Term | What it counts |
|---|---|
| **Selected** | scenarios at your stream's level, minus the folded ones. The work list |
| **Implemented** | the selected scenarios that became a test. One test per unfolded scenario |
| **Folded** | `SCN-018 -> covered in SCN-012` per folded scenario, `none` when the design folded nothing |
| **Skipped** | a selected or folded scenario that got no assertion, each with the reason |

A folded id never appears under selected or implemented — those count tests, and a folded scenario is not
one. It does appear under skipped when it could not be asserted, and then under folded as well, with the
reason.

Two scenarios never share a test for any reason other than a `Folds Into:` line. Two scenarios that look
similar are still two tests.

## 5. The same rules, read from the reviewing side

| Claim | How it is checked |
|---|---|
| Every scenario at the stream's level was handled | `Grep` the design yourself. Each id is implemented as its own test, folded into one that is, or listed under `Skipped Scenarios` with a reason |
| A folded scenario is covered | the covering scenario's test asserts **that scenario's** `Expected:` too. A folded scenario's absence from the test files is not a defect; its absence from the covering test's assertions is |
| The report's folded list is right | every row's scenario carries `Folds Into:` naming that row's covering id **in the design**. The design is the authority: a fold the report claims and the design does not carry is two scenarios merged into one test |

**Read the design's `Folds Into:` lines yourself.** A folded id with no test of its own is correct, so a
coverage pass that takes the report's word for which ids those are cannot tell a fold from a scenario the
run dropped — and a dropped folded scenario has no test of its own to be noticed missing.
