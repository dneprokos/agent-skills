# Level Assignment

How a scenario gets its `Assigned Level:`, its `Level Rationale:` and — where the minimum-set pass
folds it — its `Folds Into:` line.

Read this at the step that assigns levels, every run that assigns any. It is long because the
judgement is the expensive part of a test design and the failure modes are specific; it is a
conditional read for exactly that reason, and a run that only edits an `Expected:` line never loads it.

**Work from this file, never from memory of it.** The rubric below has been rewritten twice against
real designs that routed everything to E2E, and the version you half-remember is one of the ones that
did.

---

## Level, automation readiness and test packaging are three questions

Read this before anything else; every rule here depends on it.

- **`Assigned Level:` is the lowest technical layer at which the scenario has an assertable, truthful
  test oracle.** It is a statement about where the behaviour is decidable, and about nothing else.
- **`Automation Suitability:` is whether that test can be automated now.** It is a statement about
  tooling, data and environment, and about nothing else.
- **`Folds Into:` is which test executes the scenario.** A scenario that needs the real stack but whose
  traversal another E2E scenario already makes does not need a second one — it names that scenario and
  is asserted inside its test. It is written on E2E scenarios only, and it never changes the level.

The three are independent, and conflating the first two is the failure this whole rubric exists to
prevent. A scenario is **never** promoted to an E2E level because it is manual-only, because it is
vague, because it is high-risk, or because a user can see it. None of those is a statement about where
the assertion is decidable.

Two consequences, spelled out because both were once written the other way round:

- A scenario with a clear Component-level oracle that nobody can automate today is
  `Assigned Level: Component` with `Automation Suitability: Manual only`. That pairing is correct and
  the lint permits it.
- A scenario with no assertable outcome at all is not "E2E because it needs a human" — it is
  `Assigned Level: Requirement Gap`, and it is not coverage at any level.

And one about the third: a folded scenario keeps `Assigned Level: E2E UI` (or `E2E API`) because that
is still where its oracle is truthful. Folding is never a quieter way of demoting, and a scenario is
never folded to bring a level count down.

---

## 1. The candidate level

For every scenario, read `Category:`, `Technique:`, `Coverage Item:`, `Preconditions:`, `Action:`,
`Expected:` and `Requirement:`, then apply the rubric below. Work scenario by scenario — a level is
never assigned to a group of scenarios at once.

What this produces is a **candidate** level. §2 looks across the candidates that landed on E2E,
demotes the ones a lower level still covers, and folds the ones that need E2E but not a traversal of
their own. That is the only place scenarios are considered together, and it never moves a scenario
**up**: promotion to E2E stays a per-scenario judgement made here, on the scenario's own text.

### Level definitions

| Level | Assign when the scenario's assertion is about | Do not assign when |
|---|---|---|
| Unit | a self-contained rule inside one module — a format check, a comparator, a policy predicate, a mapping — decidable with no I/O | the outcome depends on persisted state, HTTP status, or another component |
| Component | one module plus its immediate collaborators with the collaborators doubled — a handler over a stubbed store | the point of the scenario is that the real collaborator behaves a certain way |
| Integration | two or more real components across a boundary — service and database, service and an external dependency — without the public surface | the assertion is purely about the public response shape or a browser rendering |
| E2E API | the deployed public API surface: status codes, response contracts, field exclusion, authentication and authorization, persistence observable on a later request | the same defect would be caught with equal precision one level down |
| E2E UI | a user-visible outcome that needs the real backend, the real session and the real browser **together** — a journey across routes, an authenticated or unauthenticated entry into the application, a value only the real server can produce | the same assertion would pass, and fail correctly, against a stubbed backend response — that is Component. Also when the assertion is only about a server response and never reaches the screen |
| Requirement Gap | nothing — the scenario's `Expected:` records a requirement gap, unknown behaviour, a missing oracle, or an outcome stated as not assertable. There is no layer at which it can be truthfully asserted | the outcome is clear and only the automation is impractical. That scenario takes the real level its `Expected:` is decidable at, with `Automation Suitability:` carrying the impracticality |

**`Requirement Gap` is not a test layer.** It means the scenario is traceability and work-discovery
only, and it must never be counted as executable Unit, Component, Integration, E2E API or E2E UI
coverage. It is not a milder way of saying "hard to test"; it says the requirement has to be specified
before any level applies.

The E2E UI row carries the whole weight of this rubric, because almost every scenario a design writes
about a screen *renders in a browser*, and a definition that stops there routes everything there. The
question is not "does a user see it" — it is **"would a stubbed backend still catch this bug?"** If a
hand-written list response makes the assertion decidable, the browser is scenery and the level is
Component.

### The eight decision factors

Weigh all eight for every scenario. When they conflict, the order below is the tiebreak order.

| # | Factor | Question |
|---|---|---|
| 1 | Where the logic lives | which component would contain the bug this scenario catches? |
| 2 | Required external dependencies | how many real dependencies must be up for a truthful result? |
| 3 | Required application layers | how many layers must be traversed before the assertion is decidable? |
| 4 | Diagnostic value | when it fails, does the failure point at one cause or at ten? |
| 5 | Stability | how much of the failure rate would be environment, not defect? |
| 6 | Execution speed | milliseconds, seconds, or tens of seconds? |
| 7 | Cost of execution | infrastructure and data setup needed per run |
| 8 | Business criticality | does a silent failure here reach a user or lose data? |

### Assignment rules

- **Read `Expected:` first, and branch on it.** If the scenario has an assertable `Expected:` outcome,
  assign exactly one lowest truthful level from `Unit`, `Component`, `Integration`, `E2E API`,
  `E2E UI`. If its `Expected:` instead records a requirement gap, unknown behaviour, a missing oracle
  or an outcome stated as not assertable, assign `Requirement Gap` — nothing else, and never a real
  level "in the meantime".
- **Lowest practical level wins.** Assign the lowest level at which the scenario's stated `Expected:`
  outcome is genuinely decidable. "Practical" means the assertion stays truthful there, not that it
  can be faked there.
- **E2E is reserved**, per factor 8, for critical journeys, cross-component behaviour, contract and
  authorization guarantees, and anything a user directly observes.
- **Multiple levels only for genuinely different aspects.** Permitted only when you can name a distinct
  assertion at each level — Unit verifies the password-length predicate, E2E API verifies the rejection
  status code and error string. If you cannot state both assertions in one line each, it is one level,
  not two. Never assign a scenario to every level as a hedge.
- **Every scenario gets exactly one assignment.** There is no `Unassigned` and no `TBD`. A scenario too
  vague to place does not become E2E by default — vagueness is the absence of an oracle, which is
  `Requirement Gap`, and the rationale says which part of the outcome is missing.
- **`Technique:` is a signal for factor 1, not a verdict.** `Equivalence Partitioning` or
  `Boundary Value Analysis` over a single self-contained parameter rule — a length, a format, a range —
  is the archetypal Unit candidate, because the bug it catches lives in one predicate.
  `Decision Table Testing` and `State Transition Testing` usually span components or persisted state,
  so they rarely settle below Integration. This sharpens factor 1; it never overrides the `Expected:`
  field, which remains what decides whether the assertion is decidable at a level.
- **`Automation Suitability: Manual only` is not level evidence.** A manual-only scenario may be `Unit`,
  `Component`, `Integration`, `E2E API` or `E2E UI` — whichever level its outcome is decidable at — and
  the rationale says why automation is impractical rather than treating the impracticality as a reason
  to move up. It becomes `Requirement Gap` only when the expected outcome itself is missing or not
  assertable, never merely because it is manual.

**Assign an E2E level only when the scenario's assertable outcome requires the real public surface,
real auth or session, real persistence, real routing, or real browser and backend interaction
together.** Do not assign E2E for:

- rendered presence of fields, buttons, rows, labels or columns;
- data formatting, truncation, empty or null values, boundary values, or display variants;
- failed-load UI states where the backend failure can be stubbed;
- vague or manual scenarios whose expected behaviour is not specified — that is `Requirement Gap`,
  not E2E;
- destructive actions whose post-action behaviour is not specified — likewise `Requirement Gap`.

### The four shapes that get wrongly routed to E2E UI

They are the same rule applied to recurring `Expected:` shapes, not a second list to weigh against it.
Each names a shape, not a feature, so apply them by reading the field:

- **Presence is not a journey.** An `Expected:` that a control, a column, a row action or a field is
  *rendered* is Component. A stubbed list response renders it identically, and the failure it catches
  lives in one template.
- **Rendering breadth is not E2E breadth.** "every row", "every field", "every item" over the real
  dataset is a Component assertion over a fixture — a fixture can carry the empty, null and long-value
  rows the real dataset happens not to have today. At most one E2E scenario is needed to prove real
  data reaches the screen at all, and iterating there proves nothing the fixture did not.
- **Two views of one source is Integration.** Parity, no-omission and no-duplicate assertions between
  two renderings of the same data are about the data boundary. The browser is how the scenario was
  written, not what it tests.
- **Pagination and page-size limits are Component** unless the `Expected:` names the real dataset's
  size. A page cap is arithmetic over a response; only a scenario asserting the cap against
  production-scale data needs the real stack.

None of the four is a veto — each is factor 1 applied to a recurring shape. A scenario matching one of
them still goes to E2E if its `Expected:` names something a stub cannot produce.

---

## 2. The E2E minimum-set pass

§1 judged every scenario alone, and a scenario judged alone almost always survives the test: it does
need a browser, it is user-visible, it is worth checking. Twenty scenarios each individually reasonable
become twenty E2E tests that traverse the same three screens, fail together, and take twenty times as
long to tell you one thing. This pass is where that is caught, and it is the reason §1's output is
called a candidate.

**The pass has two outcomes, not one.** Demotion answers "a lower level still catches this". Folding
answers "only the real stack catches this, but another E2E scenario already walks the same route to get
there". Both shrink the number of E2E *tests*; only demotion changes a level. A pass that knows only
how to demote deadlocks on the second case — the scenario cannot be demoted without making its
assertion untruthful, so it is kept, and the run grows a journey it did not need.

Run it over the scenarios in scope, once, before writing anything.

1. **Collect** every scenario whose candidate level contains `E2E API` or `E2E UI`. Keep the two
   streams separate — an API journey and a UI journey never cover each other. A `Requirement Gap`
   scenario is invisible to this pass: never collected, never grouped into a journey, never counted
   towards a journey's positive or negative, and never listed as kept, demoted or folded.

2. **Group by journey.** A journey is the traversal a scenario's `Action:` makes: the actor, the entry
   point, and the routes or endpoints reached along the way. Two scenarios share a journey when a
   single run of either already traverses everything the other does. Give each journey a short label —
   `J1 admin table -> game detail` — and use it in the summary.

   **Data is not traversal.** Read `Preconditions:` for the actor and the entry state, never for the
   size, shape or content of the data the scenario needs. Two scenarios that sign in as the same actor,
   open the same screen and hit the same routes are **one journey** however differently their data is
   described — a two-row catalogue and a catalogue past the page-size threshold are one traversal over
   two datasets, not two traversals. This is the single most common way a journey list doubles, and it
   doubles by construction: equivalence partitioning and boundary value analysis exist to produce N
   data cases over one behaviour, so a technique working correctly hands this pass N scenarios that
   look like N journeys and are one. They are grouped together here and separated by rule 6, never
   here.

   **For the API stream, group on the operation when the design names one.** A scenario's `Notes:`
   sometimes cites the HTTP operation its values were taken from. Two API candidates citing the same
   operation with the same actor are one journey, however differently their `Action:` lines read. Use
   only what a scenario actually names — never work out which endpoint a scenario "must" hit.
   `Action:` is written in behaviour terms on purpose, and a journey key built from your guess about
   the mechanics would group scenarios by your inference rather than by the design's.

   A second actor makes a second journey **only when the scenario's `Expected:` turns on that actor's
   authorization** — reaching a screen a different role cannot, or being refused. The same screen
   re-rendered for another role, with an assertion about what it *contains*, is the same journey: the
   authorization outcome is one fact, and the contents were already covered. Split the scenario in your
   head — the reaching is E2E and belongs to the journey's covering scenario; the contents are
   Component. If it was written as one scenario, keep it at E2E only when no other scenario on that
   journey already proves the role reaches the screen.

3. **Keep the minimum covering set per journey**: one positive scenario (the flow succeeding) and one
   negative (the flow refused, rejected or failing), where both exist. A journey with only positives
   keeps one. A journey with two genuinely different negatives keeps both — *different refusal
   mechanism*, not a different input value. Two malformed inputs rejected by the same validation path
   are one negative; an unauthenticated entry and an unauthorized role are two.

4. **Demote everything else in the group** to the highest level at which its `Expected:` stays truthful
   — usually Component or Integration, per the four shapes in §1. Try this before rule 6 on every
   scenario the group did not keep: a demoted scenario costs a lower-level test, a folded one still
   costs an assertion in an E2E test, so demotion is the cheaper outcome wherever it is honest. The
   `Level Rationale:` of a demoted scenario **names the kept scenario id** whose traversal already
   covers it:

   ```
   Level Rationale: Demoted from E2E UI by the minimum-set pass — SCN-006 already traverses this render, and the assertion holds against a stubbed list response.
   ```

5. **Never demote** a scenario whose `Expected:` names something only the real stack produces: an
   authentication or authorization refusal, a value persisted by one request and observed by a later
   one, a navigation that crosses routes, a session restored across a reload, a count or a limit taken
   over the real dataset. If demoting it would make the assertion untruthful, it is not redundant at a
   lower level — go to rule 6.

6. **Fold what cannot be demoted and does not need its own traversal.** A scenario in a group that rule
   3 did not keep and rule 5 forbids demoting is **folded** into that journey's kept scenario: it keeps
   its `Assigned Level:`, and gains a third line naming the covering scenario.

   ```
   Folds Into: SCN-001
   ```

   Fold it when all four hold. If any one fails, it is a separate journey and it is kept:

   - the covering scenario is in the **same journey and the same stream**, and it is kept, not itself
     folded;
   - the two differ **only in the data** the scenario needs or the value it asserts — a partition, a
     boundary, a volume, a variant — never in the actor's authorization, the entry point, or the routes
     reached;
   - the covering scenario's `Preconditions:` **could be satisfied in a way that satisfies both**,
     without making its own `Expected:` untruthful — a catalogue seeded past the page-size threshold
     still satisfies "two or more games". This is a feasibility test you run in your head. You do not
     edit that field; the fold line is what tells the implementing step to seed the wider precondition;
   - both `Expected:` outcomes are **observable in one run**. Two outcomes that require the same
     resource in two states — present and deleted — are sequential, not simultaneous, and folding them
     would make one of them assert against the wrong state.

   The `Level Rationale:` of a folded scenario says why it could not be demoted **and** why it needs no
   traversal of its own. Both halves, or the fold reads as a demotion nobody wrote down:

   ```
   Level Rationale: The exact-count claim past the real page-size threshold is decidable only against a real seeded catalogue, so no stub level holds it; folded into SCN-001 by the minimum-set pass — same actor, same entry, same route, a larger dataset over the one traversal SCN-001 already makes.
   ```

7. **This pass never promotes.** Nothing is moved up here, and no scenario outside the collected set is
   touched. A scenario §1 placed at Unit stays at Unit whatever journey it resembles, and is never
   folded — folding is an E2E-only outcome, because it is a statement about a traversal only E2E makes.

8. Record the journeys, the demotions and the folds. They are the summary's judgement lines and the
   receipt's, and nothing recomputes them from the document afterwards.

In a scoped or revision run this pass sees only the scenarios in scope. A scenario outside the scope is
never demoted or folded by it, however redundant it looks; that observation goes in `NOTES`. A scenario
in scope is never folded into one outside it either — the covering scenario has to be one this run has
looked at.

---

## 3. What gets written, and what a script writes instead

Each scenario block gains two lines directly under `Automation Suitability:`, and a folded one gains a
third:

```
Assigned Level: E2E UI
Level Rationale: <one or two sentences naming the deciding factor>
Folds Into: SCN-001
```

`Level Rationale:` is mandatory on every scenario and names the factor that decided it — not a
restatement of the level. A rationale that could be pasted onto any scenario at that level has not
been written.

**The arithmetic is not written by hand.** `scripts/test-design-lint.mjs --apply-levels` recomputes the
`Levels:` line and the whole `# Level Assignment Summary` section from the blocks and writes them in
place. The four **judgement** lines are carried through rather than recomputed, because no script can
derive them — `Levels:` and `Blocked by (top unknowns):` in `# Summary`, `E2E journeys:` and
`Demoted by the minimum-set pass:` in the level section. Write those from the pass above; let the
script write everything else.

**A clean lint is not evidence that the levels are right.** The script rules on structure and
arithmetic and on nothing else: whether a scenario's oracle really is decidable at the level it
carries is the judgement this file exists for, and no exit code speaks to it.
