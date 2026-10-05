# The Agentic QA Workflow — Concept

How one Jira ticket becomes a reviewed pull request full of Playwright tests, and why the machine
that does it is shaped the way it is.

This document is the **concept**: the roster, the phases, the design rules and the reasoning behind
them. It is deliberately not the contract — every operational detail it used to carry now lives in
the file that actually governs it, and *Where each contract lives* at the bottom says which.

| Question | Canonical answer lives in |
|---|---|
| who runs when, state, iteration control | `.claude/skills/qa-workflow/SKILL.md` and its `references/` |
| what each agent does, step by step | that agent's own `.claude/agents/<slug>.md` |
| the shared forms and process rules | `docs/automation/` — see below |
| the repository's working conventions | `CLAUDE.md` |

---

## The problem

A ticket says what a feature must do. Shipping tests for it means: reading the ticket, finding what
it forgot to say, deriving scenarios, deciding at which level each one is honestly testable,
implementing them in two different stacks, reviewing both, and getting the result onto a branch and
back onto the board.

That is not one task with one right answer — it is eight or nine, each with a different notion of
"good", several of which are **adversarial to each other on purpose**. A reviewer that shares the
writer's blind spot reports nothing. A generator that also decides its own scope always has enough
coverage. So the work is split into agents that cannot see each other, and the split is the design.

## The roster

Ten subagents, two phases of work, one orchestrator that is a skill rather than an agent.

| # | Agent | In → Out |
|---|---|---|
| 1 | `qa-requirements-collector` | ticket id → requirements document, ticket moved to `In Progress` |
| 2 | `qa-requirements-reviewer` | requirements document → five QA sections appended to it |
| 3 | `qa-scenario-generator` | requirements → test design, scenarios derived by ISTQB technique **and a testing level on every one of them** |
| 4 | `qa-scenario-reviewer` | test design → Pass / Needs Revision / Blocked, findings by id |
| 5 | `aqa-api-test-creator` | E2E API scenarios → specs under `tests/api/` + an implementation report |
| 6 | `aqa-api-test-reviewer` | that code + report → verdict, findings cited by file and line |
| 7 | `aqa-ui-test-creator` | E2E UI scenarios → specs under `tests/ui/` + page objects + report |
| 8 | `aqa-ui-test-reviewer` | that code + report → verdict, findings cited by file and line |
| 9 | `git-change-analyst` | working tree → proposed commit message and the file lists behind it (writes nothing) |
| 10 | `qa-jira-transition` | PR URL + target status → ticket commented and moved |

Around them:

- **8 skills** — `qa-workflow` (the orchestrator), `qa-ship-tests`, `git-workflow-orchestrator` and
  the four `git-*` skills it drives, plus `playwright-cli` for browser exploration.
- **5 scripts** — `api-surface.mjs` (slices the OpenAPI document out of the app's Swagger bootstrap),
  `test-design-lint.mjs` (structure and arithmetic of a test design), `spec-lint.mjs` (mechanical form
  of the test code, run by both halves of each stream), `workflow-state.mjs` (validates *and writes*
  the run's state file), `slack-triage-journal.mjs` (the bug-triage ledger and its skip filter).
- **1 hook on three events** — `agent-metrics.mjs`, plus `metrics-report.mjs` to read the log back.

## The two phases

```text
qa-workflow — the orchestrator (a skill, on the main thread)
│
├── Phase 1: Test Design
│   ├── Requirements Collector    read the ticket, map the API surface, write the document
│   ├── Requirements Reviewer     find what the ticket forgot to say — append, never fill in
│   ├── Scenario Generator        derive scenarios: EP, BVA, decision table, state transition,
│   │                             then assign every one a level and run the E2E minimum-set pass
│   ├── Scenario Reviewer         coverage, duplicates, level assignments, traceability
│   └── Checkpoint                accept · revise · escalate · which streams are in scope
│
├── Phase 2: Test Automation          (the two streams run in parallel)
│   ├── API SDET ──── API Review ──┐  implement, run the suite + type check, report; review re-runs both
│   ├── UI SDET  ──── UI Review  ──┤  same, plus browser exploration and page objects
│   └── Ship ──────────────────────┘  one branch, one commit, one pull request
│
└── Hand-back
    └── comment the PR on the ticket, move it to In Review
```

The run **ends on the ticket it started from**. A hand-back that fails does not fail the run — the
tests shipped; the status is bookkeeping.

## Why it is shaped this way

**The orchestrator is a skill, not an agent.** A subagent cannot spawn subagents and cannot see
skills. Anything that routes has to run on the main thread — so the one component that knows the
whole workflow is the one component that is not part of it.

**No agent names another agent.** Not in its description, body, receipt, or `Must not` list. Each is
a pure function of its parameters and the files on disk. This is not tidiness: an agent that ends
with `NEXT: aqa-api-test-creator` has hard-coded a routing decision it does not own, and it becomes
wrong the moment the workflow changes shape. Routing lives in exactly one file. Agents refer to
documents by path, and to other actors as "your caller" or "the step that reviews this".

**Reviewers hold no `Edit` or `Write`.** A reviewer that can fix what it finds returns `Pass`, and
the Needs-Revision signal disappears — the finding was real, and nothing downstream ever hears about
it. A read-only reviewer is safe to grant `Bash` for a lint script; it is the write grant that breaks
the loop.

**The return leg is its own agent.** The workflow could have ended at the pull request, which leaves
the ticket in `In Progress` with no link to the work — the one state a board cannot recover from on
its own. Burying a Jira call inside the git skill would reverse that skill's own "no Jira access"
rule, and doing it in the orchestrator would break "the orchestrator does none of the work". So the
return leg mirrors the intake leg, and its tool grant is the narrowest in the repository: five
Atlassian calls and **no filesystem tools at all**. It cannot read a report, so it cannot summarise
one; every claim in its comment is either a value from its prompt or a fact Jira just returned.

**The git row is split by *mutation*, not by topic.** Committing needs two human confirmations and
opening a PR a third; a subagent can ask for none of them — so the four `git-*` skills stay skills on
the main thread. But *reading* the working tree is the largest context cost in the ship phase and
needs no human at all, which is exactly what a subagent is for. Hence one read-only agent that
returns a proposed message and the PR facts, and never stages, commits or pushes. Same prefix,
opposite powers: **the tool grant is what tells them apart.**

**An installed skill is not automatically reusable.** The `requirements-reviewer` skill was written
for a human in a chat window: it asks the user for input, pauses for context questions, and emits a
standalone report. A subagent has no user to answer — it will stall or answer itself — and the
workflow needs sections *appended* to an existing file. The two rubrics turned out to be
complementary rather than competing (how a requirement is written, versus what testing detail is
missing), so the agent carries both and the skill stays installed for interactive use.

**Arithmetic goes in a script.** Counting rows is slow, in-context and unreliable in a model, and a
review round spent on lint-class defects buys nothing. So the structural and numeric contract of a
test design is enforced by `test-design-lint.mjs` — the writing step applies the counts it computes,
the reviewing step reads its output as pre-computed evidence, and is barred from the modes that
would let it repair the document before judging it. The same reasoning made the state file a
script's job: validation is containment, not a cure, so nothing hand-writes that YAML any more.

## The rules that hold it together

1. **No agent names another agent.** Routing lives in one skill.
2. **Reviewers hold no `Edit`.** One that can fix things returns Pass, and the signal disappears.
3. **`EXISTS`.** Re-invoked with nothing new, an agent changes nothing. Every agent runs more than
   once, and the second run is scoped: `first_run`, `EXISTS`, `revision`, `regenerate`.
4. **Findings carry stable ids.** `[API-C1]` survives every iteration, and each one is answered as
   `fixed`, `disputed` or `not applicable` — never silently.
5. **The red-test rule.** A known application defect is asserted against the *specification*, with a
   comment naming it. Weakening the assertion to go green is Critical. The failure is the report.
6. **A citation is not an assertion.** A scenario that traces a requirement but asserts nothing is
   counted apart from one that exercises it — or a design reports full coverage on the strength of
   tests that claim nothing.
7. **Scope the loop, never the gate.** Debug narrow; verify wide. The numbers anyone else reads
   always come from the full run.

## Shared references — the `docs/automation/` folder

Two agents that must agree on a rule cannot both hold their own copy of it, and they cannot share a
skill either: every agent file declares an explicit `tools:` list and **none of them includes
`Skill`**. Shared knowledge therefore lives as documents on disk, read by path at run time.

```
docs/automation/
  README.md                          what the folder is and who reads what
  etalons/                           a form to copy
    api-spec-etalon.md               the house form for an API spec
    ui-spec-etalon.md                the house form for a UI spec and its page object
  contracts/                         a process rule for a run
    revision-contract.md             mode resolution and revision scoping on a second run
    review-verdict-contract.md       narrowing, finding ids, severity, verdict
    implementation-report.md         the report shape the two streams hand over
  references/                        knowledge read on demand, at one named step
    api-surface-reading.md           how far each stream may use the `# API Surface` section
    browser-exploration.md           sessions, the locator tier ladder, observed mechanics
    test-basis-modelling.md          the four ISTQB black-box techniques
    test-design-document-shape.md    the test design document, section by section
```

**Why it exists at all**: the two etalons were extracted after the copies had already diverged — the
review step's calibration block used a request form the implementing step was forbidden to write.
The review was grading against a shape its counterpart could not produce, and neither file was wrong
on its own terms. *The rule a document is written against and the rule it is reviewed against must be
the same words.* Everything in `contracts/` is there for the same reason, one file per pair of
readers.

**Why the three folders**: an etalon is a form to copy, a contract is a process rule for a run, a
reference is knowledge fetched at one step. The distinction is not filing — it is **when the text
loads**. The two design references used to sit inline in a 725-line agent body, paid for on every
invocation including a revision that corrected one line. They are now read only by a run that
actually derives scenarios or rewrites the whole document, and each extraction ships with an anchored
`Read` **and** a `Must not` against working from memory: a reference an agent forgets to read is
worse than a long prompt, because the rule stops applying instead of merely being verbose.

**What it is not**: a token optimisation. A subagent starts cold and pays the same for a `Read` as
for an inline block. What extraction buys is agreement.

**One rule for the folder**: no file in it may name an agent. They speak in stream and step terms, or
the no-sibling-names rule leaks in through the back door.

## Where each contract lives

| Contract | File |
|---|---|
| routing, state, iteration caps, gates | `.claude/skills/qa-workflow/SKILL.md` + `references/` |
| the state file's schema | `.claude/skills/qa-workflow/references/state-schema.md` (generated by `workflow-state.mjs print-schema`) |
| run cost and the metrics hook | `.claude/skills/qa-workflow/references/run-cost.md` |
| requirements document shape | `.claude/agents/qa-requirements-collector.md`, Step 5 |
| test design document shape | `docs/automation/references/test-design-document-shape.md` |
| test design structure and arithmetic | `scripts/test-design-lint.mjs` (twenty-one `TD-E<nn>` checks) |
| mechanical form of a spec or page object | `scripts/spec-lint.mjs` (fifteen `SL-E<nn>` checks, plus four `SL-W<nn>` shapes it reports and refuses to rule on) |
| implementation report shape | `docs/automation/contracts/implementation-report.md` |
| re-run modes, revision scoping | `docs/automation/contracts/revision-contract.md` |
| review narrowing, severity, verdict | `docs/automation/contracts/review-verdict-contract.md` |
| spec style, per stream | `docs/automation/etalons/` |
| ship phase and hand-back | `.claude/skills/qa-ship-tests/SKILL.md`, `.claude/skills/qa-workflow/references/ship-and-handback.md` |
| suite conventions | `CLAUDE.md` |

Each row has a single owner. Where two files would disagree, one of them is not a contract.

## Where the speed came from

Not from running less. From running the *cheap* thing narrow and the *load-bearing* thing wide.

| Was | Now |
|---|---|
| The implementing step ran the whole suite on every fix cycle — up to 4 per pass | Changed specs while debugging, full suite once before the report |
| A revision re-ran everything to fix one line | Same split, on a revision too |
| One missing locator bought a whole exploration session | `Grep pages/` first, explore only what is missing |
| The level pass hand-counted a table, three totals and two id lists | A script emits them; the agent pastes them and keeps the judgement |
| The same gap restated under eight requirements | One finding, eight ids on it |
| Writing scenarios and levelling them were two agents, so the design was read twice and a mixed review round cost two sequential delegations | One step does both. The level pass needs the whole document anyway, and it now has it in context already |
| Approving a missing value meant regenerating the design to absorb the answer | The question is asked after the requirements review, before the design exists, and the unknown is never written |
| Reviewers re-ran the suite — looked like waste | **Unchanged.** It is the trust boundary, not duplication |

The load-bearing runs stayed wide on purpose: a page object is shared by every spec that uses it, so
only the full run sees a fix in one file break another, and a reviewer that trusted the counts it was
handed would not be an independent check at all.

## The shape, in numbers

| | |
|---|---|
| Subagents | 11 |
| Skills | 8 |
| Scripts | 3 |
| Hooks | 1 script on 3 events (+1 reporting script) |
| Agents that can write to Jira | 2 — one per end of the run |
| Agents that can write test code | 2 |
| Reviewers that can edit anything | 0 |
| Agents that can report their own cost | 0 — the harness measures it from outside |
| Full suite runs per implementing pass | 1 |
| Review iterations before escalation | 2 |
| Pull requests per ticket | 1 |
