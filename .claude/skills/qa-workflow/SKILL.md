---
name: qa-workflow
description: >-
  QA Lead orchestrator. Drives a Jira ticket end to end through requirements collection,
  requirements review, scenario generation, level classification, design review, parallel
  API and UI test implementation, both code reviews, the pull request, and the hand-back
  that links the pull request on the ticket and moves it to In Review — in manual mode
  (pause for a transition decision after every agent) or auto mode (verdict-driven routing
  with a capped review loop). Owns the workflow state file, every iteration counter and
  every routing decision. Use when asked to "run the QA workflow", "start the lead
  orchestrator", "automate <TICKET-ID> end to end", "run the QA lead", or
  "/qa-workflow <TICKET-ID>".
argument-hint: "<TICKET-ID> [--auto] [--max-review-iterations N] [--max-design-iterations N] [--allow-alternative-flow-gaps] [--resume] [--dry-run] | <TICKET-ID> --reset"
---

# QA Workflow — the lead orchestrator

The QA Lead. It turns one Jira ticket into one pull request — and then back into the same ticket, moved to
`In Review` with the pull request linked on it — by delegating every step to a subagent and deciding, after
each one, what happens next.

**It does none of the work itself.** No requirement is analysed here, no scenario written, no test
implemented, no code reviewed. This skill owns three things and only three: the workflow state file, the
iteration counters, and the routing decisions.

Run it on the main thread. Claude Code subagents cannot spawn subagents, so an orchestrator written as an
agent could call nothing it coordinates. It also invokes other skills, which a subagent cannot see.

**This is the only file in the repository that names one agent next to another.** Every agent under
`.claude/agents/` is written as a pure function of its parameters and refuses to name a sibling or emit a
`NEXT:` field, precisely so that all routing knowledge concentrates here. Adding a routing hint to an agent
file breaks that contract; add it to the step registry below instead.

`references/workflow-map.md` draws the whole run — steps, gates, review loops, the state write around each
delegation, and every terminal state — in step ids, never agent names. **Read it when the shape of the run
is the question**: explaining the workflow to a user, orienting after a resume that landed somewhere
unexpected, or checking that a routing change has somewhere to go. It is a picture and is canonical for
nothing: it carries no parameter and no receipt line, and where it disagrees with the step registry below,
the registry is right and the map is out of date. Do not read it before an ordinary delegation.

## Inputs

| Parameter | Required | Form | If absent |
|---|---|---|---|
| `ticket_id` | yes | `SCRUM-139`, or a `/browse/<KEY>` URL | stop and ask — never guess from the branch or the newest file |
| `mode` | no | `manual` \| `auto` (`--auto` sets `auto`) | `manual` |
| `max_review_iterations` | no | integer >= 1; alias `maxReviewIterations` | `2` — the two **code** review loops, 2.2a and 2.2b |
| `max_design_iterations` | no | integer >= 1 | `1` — the **design** review loop, 1.5. Separate because the two converge differently: a code finding is answered by editing the file it names, while a design finding is answered by regenerating a document whose next version invites new findings |
| `batch_threshold` | no | integer >= 1 | `15` — above this many in-scope requirements, step 1.3 runs in batches |
| `batch_size` | no | integer >= 1 | `10` — requirements per batch once the threshold is crossed |
| `review_requirements` | no | `true` \| `false` | `true` |
| `resume` | no | flag | auto-detected: a state file for this ticket means resume |
| `reset` | no | flag (`--reset`) | `false` — a state file is resumed, never reset. **`request` tier only**: never read from `state`, never inferred from drift, a decline, a failed step or a cap being reached. Confirmed with the user in both modes before anything moves. **It is the whole invocation**: the run ends when the reset is written, and starting the fresh run is a second command without the flag |
| `start_phase` | no | `design` \| `automation` \| `ship` | resolved from the state file |
| `skip_ship` | no | flag | `false` |
| `skip_jira_handback` | no | flag | `false` — a created pull request always goes back on the ticket |
| `jira_target_status` | no | a status name | `In Review` |
| `dry_run` | no | flag | `false`; passed through to the ship phase |
| `api_endpoints` | no | free text, one line per operation — `GET /api/games?limit&page — public` | absent; the API surface is mapped from the ticket alone. Passed to 1.1 as `endpoint_hints` |
| `api_endpoints_approver` | no | `@handle — YYYY-MM-DD` | required whenever `api_endpoints` is given; without it 1.1 aborts `HINTS_WITHOUT_APPROVER`. Never fill it in yourself |
| `api_surface` | no | `map` \| `ignore` | `map`. `ignore` skips the mapping for the whole run and prints the consequence |
| `on_missing_api_surface` | no | `escalate` \| `ignore` | `escalate`. Auto mode only; what Checkpoint B does when the design wants API coverage and no surface exists |
| `on_blocked_alternative_flow` | no | `escalate` \| `continue`; `--allow-alternative-flow-gaps` sets `continue` | `escalate`. Auto mode only; what the design gate does when an unapproved unknown leaves an in-scope requirement with no automatable coverage. `continue` relaxes it for **alternative-flow** requirements only — a main flow stops the run under either value. The test is in `references/phase-1-design.md` |
| `confirm_ui` | no | `true` \| `false` | pass-through to 1.3; its own default of `false` applies, so scenario generation opens no browser |
| `explore_app` | no | `auto` \| `always` \| `never` | pass-through to the UI stream; its own default applies |
| `run_tests` | no | `true` \| `false` | pass-through to both SDETs; their own default applies |
| `branch_name`, `base_branch` | no | git refs | pass-through to the ship phase |

`snake_case` is the convention across every agent in this repository; `maxReviewIterations` is accepted as
an alias for the one parameter that is commonly written the other way.

## Step 0 — Resolve and load

1. **Ticket id.** Uppercase project key, hyphen, digits. A `/browse/<KEY>` URL yields the key. No id, or two
   different ids in the request -> stop and ask. Do not guess.
2. **State.** Read `.workflow/<TICKET-ID>.yaml`.
   * Missing -> `node scripts/workflow-state.mjs init <TICKET-ID> --set mode=<mode> --set …` for each
     resolved configuration value. It writes the skeleton — `phase: test_design`, all counters `0` —
     and creates `.workflow/` itself. `EXISTS` on that command means this is a resume after all.
     **Write every `configuration.*` key the schema carries, including the ones left at their default**,
     rather than only the ones this invocation named: a gate-relaxing setting that exists in the first
     session and not in the file is a setting the resume silently loses, and the banner would go on
     reporting it as `state` on the strength of nothing.
   * Present -> this is a **resume**. Run `node scripts/workflow-state.mjs validate <TICKET-ID>` first and
     act on what it says, then announce the recorded phase, status and step and continue from there. Do not
     restart at Jira intake, and do not re-run a step whose artifact already exists.
   * Then run `node scripts/workflow-state.mjs check-artifacts <TICKET-ID>` — **on every resume, before
     choosing a phase.** `validate` rules on what the document says; this rules on whether the files it
     names are still there. Exit `0` means every recorded path is on disk; exit `4` means at least one is
     gone, and the row says which field named it and which stream it belongs to. See *Artifact drift* below.
   * Then run `node scripts/workflow-state.mjs normalize <TICKET-ID>` — **on every resume, before the
     banner.** A missing `configuration.*` key is not a validation error, so `validate` passes a document
     written before the key existed and the banner then reports the template default as though somebody
     chose it. `normalize` writes each absent key at the value `init` would have written, prints one line
     per key, and says `unchanged` when there is nothing to add. It touches no phase, no counter and no
     history entry. Announce anything it added, because a setting that appears on a resume is a setting
     this run is about to be governed by.
   * A non-empty `in_flight:` means the previous session was interrupted mid-delegation. Follow *Resuming
     an interrupted delegation* below before doing anything else.
2a. **`--reset`, and only when this invocation asked for it.** See *Dropping to the first stage* below.
   Missing state file -> there is nothing to reset; say so and fall through to `init`. Present -> run
   `validate` and `check-artifacts` **first**, because they are what say what is about to be thrown
   away, then the dry run, then the question, then the reset — **and then the invocation is over**.
   Steps 3 and 4 below do not run: there is no mode to resolve for a run that will not start, and the
   banner is defined as what precedes the first delegation. Return `OK` and stop.
3. **Mode.** `auto` only when explicitly asked (`--auto`, `mode: auto`, "run it automatically"). Anything
   else, including silence, is `manual`.
4. **Print the run parameters.** Before the first delegation, always.

### The run-parameters banner

Every parameter in the `## Inputs` table, its resolved value, and **where that value came from**. Print it
after the state file is loaded and before anything is delegated, in both modes, on a fresh run and on a
resume alike.

The source column is the half that earns the banner. A resolved value alone reads as a decision somebody
made; most of them are defaults nobody chose, and on a resume the ones that matter came out of a state file
written days ago by a command line nobody has in front of them any more. Three sources, and they are also
the precedence order — `request` beats `state`, `state` beats `default`:

| Source | Means |
|---|---|
| `request` | this invocation set it — a flag, or a named value in the prompt |
| `state` | read from `configuration:` in `.workflow/<TICKET-ID>.yaml`; a resume inherits it |
| `default` | nobody set it; the `If absent` column of `## Inputs` applies |

```
QA Workflow — SCRUM-140

  ticket_id                     SCRUM-140                 request
  mode                          auto                      request (--auto)
  max_review_iterations         2                         default
  max_design_iterations         1                         default
  batch_threshold               15                        default
  batch_size                    10                        default
  review_requirements           true                      default
  resume                        yes                       state (phase: test_automation, step 2.1b)
  start_phase                   test_automation           state
  skip_ship                     false                     default
  skip_jira_handback            false                     default
  jira_target_status            In Review                 default
  dry_run                       false                     default
  api_endpoints                 —                         default
  api_endpoints_approver        —                         default
  api_surface                   map                       default
  on_missing_api_surface        escalate                  default
  on_blocked_alternative_flow   continue                  request (--allow-alternative-flow-gaps)
  confirm_ui                    — (agent default)         default
  explore_app                   — (agent default)         default
  run_tests                     — (agent default)         default
  branch_name / base_branch     — / —                     default

  Non-default settings this run:
  - on_blocked_alternative_flow: continue — an unapproved unknown that leaves an
    alternative-flow requirement with no coverage will NOT stop this run. A main flow
    still stops it. See the design gate.
```

Rules for it:

* **Every row in `## Inputs` appears, including the ones nobody set.** A parameter absent from the banner
  reads as a parameter that does not exist, which is how a run acquires a setting its operator never knew
  was available. `—` is a value; a missing row is not.
* **A pass-through prints `— (agent default)`**, not the agent's actual default. This skill does not know
  it, and printing a number it did not resolve is a claim about a file it has not read.
* **The `Non-default settings this run` list is the point of the banner in auto mode.** One line per
  parameter not at its default, saying what it changes in behavioural terms rather than restating the
  value. Anything that relaxes a gate says so in the words a stop would have used. `- None.` when
  everything is at its default — which is itself worth printing, because it is the answer to "why did it
  stop?" as often as any setting is.
* **On a resume, `state` rows are the ones to look at**, so the banner is reprinted in full on every
  resume rather than assumed to be remembered from the session that started the run.
* It is printed, never stored. The state file already holds `configuration:`; a second copy would be one
  more thing that can disagree with it.

## Workflow state — `.workflow/<TICKET-ID>.yaml`

This is the only file whose contents are this skill's to decide, and it is the resume contract: every
delegation is parameterised out of it, so a field that quietly loses its value does not fail loudly —
it re-runs a reviewer in full-review mode, or hands an implementer an unscoped revision, at full cost
and with nothing in the transcript to say why. `.workflow/SCRUM-132.yaml` is the worked example: it
carried `test_design.last_findings` twice, once holding an 1800-character routing block and once
holding `null`. YAML keeps the last value. A whole review round ran without its findings.

**The field contract is `references/state-schema.md`. Read it before the first write of a session** —
every key, its type, whether it is required, and the twelve checks. Do not reproduce the schema here
and do not invent a key: a field the schema has no opinion on goes under a `notes:` map, at the top
level or inside a section.

**Never hand-write this file. Every change goes through `scripts/workflow-state.mjs`**, which
re-emits the whole document from a parsed model, atomically, and refuses a write whose result would
not validate. That is what makes the SCRUM-132 defect unreachable rather than merely reported: no
command inserts a line, so no command can produce a second copy of a key.

```bash
node scripts/workflow-state.mjs init  <TICKET-ID> [--set <path>=<value>]...   # step 0, once
node scripts/workflow-state.mjs set   <TICKET-ID> <path>=<value>...           # the ordinary persist
node scripts/workflow-state.mjs set-block <TICKET-ID> <path> --from-stdin     # a multi-line value
node scripts/workflow-state.mjs append <TICKET-ID> <path> --json '<json>' [--dedupe]
node scripts/workflow-state.mjs clear-in-flight <TICKET-ID> --agent <name>
node scripts/workflow-state.mjs get   <TICKET-ID> <dotted.path>               # a value, raw
node scripts/workflow-state.mjs validate <TICKET-ID>                          # belt and braces
node scripts/workflow-state.mjs check-artifacts <TICKET-ID>                   # step 0, every resume
node scripts/workflow-state.mjs normalize <TICKET-ID>                         # step 0, every resume
node scripts/workflow-state.mjs check-streams <TICKET-ID>                     # Checkpoint B, and the ship gate
node scripts/workflow-state.mjs normalize <TICKET-ID>                         # after a hand edit
node scripts/workflow-state.mjs reset <TICKET-ID> --reason "<why>" [--dry-run] # human-asked only
```

Vocabulary to read off these commands: `created` / `set` / `append` — it happened. `unchanged` — it
was already so, and mtime was not touched; that is a success, not a no-op to retry. `EXISTS` from
`init` normalizes as `already_done` like any other. A refusal names its code — `WS-E21` for a value
outside an enum, `WS-E01` for a document with a duplicated key, which `normalize` resolves. `reset`
prints its move list and then `created`, the same word `init` prints, so it normalizes the same way;
`dry-run` is never read as a write that happened.

Three habits the commands are shaped around:

* **Set the fields that only make sense together in one command.** `set <T> automation.api.status=not_applicable automation.api.not_applicable_reason="…"` writes; either half alone is refused. That is the point of validating before the write rather than after it.
* **A multi-line value never goes through the shell.** `last_findings` is written with
  `set-block … --from-stdin`, so an 1800-character block reaches the file without quoting eating it.
* **`--force` exists and is not for routine use.** It writes a document that does not validate. If
  you reach for it, say in `history` why.

`get` prints a value exactly as it is stored, so a multi-line `last_findings` can be lifted straight
into the next delegation's parameters rather than retyped through this conversation.

**Still run `validate` after a persist, and fix a non-zero exit before the next delegation.** The
write path is the guard now; validation is the second one, and it is what catches a file some other
session or a human hand-edited.

**Persist after every step, before the next delegation.** That one rule is what makes an interrupted
run resumable: kill the session mid-flight, re-invoke `/qa-workflow SCRUM-139`, and it picks up from
the recorded step instead of re-reading Jira.

`last_findings` matters as much as the counters. A reviewer switches to its cheaper `re_review` mode
only when handed `previous_findings`, and an implementer scopes its revision only when handed
`review_findings`. Both come out of this file, not out of the transcript.

### Artifact drift — what the file says exists, and what does

`check-artifacts` stats every path the document names — `artifacts.requirements`,
`artifacts.test_design`, each stream's `report`, and every entry of each stream's `created_tests`.
`artifacts.metrics` is deliberately not among them: the hooks own that file, and its absence before
the first agent run is normal rather than drift.

**This is not a validation failure, and exit `4` is not exit `1`.** The state file is not wrong about
what happened; it is wrong about what still exists, because something outside the run deleted,
renamed or reset an artifact between sessions. Three runs have now routed correctly on that false
premise and failed at the point of use — the last one nine delegations later, at the ship gate, on a
document that validated clean the whole way. Step 0's other existence check is scoped to
`in_flight:`, which is empty on a run that completed its delegations, so nothing else catches this.

A missing artifact is **a fact to announce and route on, exactly as a non-empty `in_flight:` is**.
The script decides nothing; this table does:

| What is gone | Do |
|---|---|
| An artifact of a step this run has not reached yet | Nothing to decide. Announce it and carry on |
| The artifact of a step recorded as done, which a later step reads | Announce it, then re-run the step that produces it — every agent is a pure function of its parameters. Reset that step's status to match, and say so in `history` |
| Every artifact of a whole phase | Do not silently rebuild it. Manual mode asks; auto mode escalates with `status: escalated` naming the paths. Where the human's answer to that question is *start over*, `reset` is the command — never a hand rename. The trigger stays human either way: drift never resets anything on its own, and auto mode escalates rather than offering the option |

A re-run forced by drift is a re-run, not a review round: it does not spend `iterations.*`.

### Dropping to the first stage

`--reset` archives this ticket's state file and every document a fresh run would otherwise refuse to
rewrite, then re-initialises. It is the answer to *throw this away and run it again from 1.1*, which
the workflow could not express: every writing step returns `EXISTS` when it finds its own output on
disk, and this skill may not hand out a regenerate token. The gap was being filled at a shell prompt
— `.workflow/SCRUM-132.yaml` carries a step-0 note describing three renames done by hand, and calls
itself the third occurrence.

**Human-triggered, in both modes.** `--reset` is a request somebody typed; nothing here infers one.
Auto mode still asks, the same deliberate exception the ship phase's git confirmations already are.

1. `validate` and `check-artifacts`, announced. **A non-zero `validate` does not stop this one thing**
   — a document that fails validation is a reason to reset, not a reason to refuse — so report the
   output and carry on. This is the only place in this skill where that is true.
2. `node scripts/workflow-state.mjs reset <TICKET-ID> --reason "<why>" --dry-run`. Print it verbatim.
   The plan comes from the same function the real run uses, so the question below is about the list
   the user is looking at.
3. Ask, with the Decline option *Terminal return and declining* requires:
   * **Reset** — archive the listed files and start at step 0.
   * **Reset, fresh configuration** — the same, without carrying `configuration:` forward. Offer this
     only when the archived configuration is non-default; otherwise it is a distinction with no
     difference.
   * **Resume instead** — change nothing, continue from the recorded phase and step. A reset asked
     for out of frustration with one drifted artifact is usually better served by *Artifact drift*.
   * **Decline** — stop here, change nothing.
4. On a confirming answer, run the command for real with `--reason` set to **the user's own words**.
   Never compose one for them; the script refuses an empty reason, which is the point of it.
5. `validate` the fresh document. Do **not** run `check-artifacts` — it records nothing yet, and the
   command would print "no artifact paths recorded yet", which is noise.
6. Apply this invocation's `request`-tier configuration with `set` on top of what was carried.
7. **Stop. Delegate nothing.** Return `OK` with the receipt block, the archive list under *Artifacts
   produced*, and `NEXT_ACTION: run /qa-workflow <TICKET-ID> to start the fresh run at 1.1`.

**`--reset` resets and ends the invocation. It never continues into 1.1.** The fresh document does
read as a run with nothing to resume, and routing it onward would need no special-casing anywhere —
which is exactly the trap. A person who typed `--reset` asked for one thing, and turning that into
nine unattended delegations spends their tokens on a decision they did not make. Starting the run is
a second invocation, without the flag, and a person who wants both types two commands. Do not print
the run-parameters banner either: it is defined as the thing printed *before the first delegation*,
and there is no delegation.

On **Decline**, write `status: declined`, `final_decision: decline` and `declined.*` with
`at_step: "0"` onto the document that was about to be archived — it is still there, because nothing
has moved — and return `DECLINED` with the full receipt block.

What a reset does **not** touch: `artifacts.metrics`, which the hooks own, and every `created_tests`
entry, which is live source. A spec renamed to `old_do_not_use_*.ts` still matches `testDir`, still
typechecks and is still imported by whatever imported it — so those files stay exactly where they
are and the receipt says that nothing owns them any more. Deciding whether to keep or drop them is a
git question and it is the user's.

The **next** invocation is the one that prints a banner, and it prints an ordinary one — a fresh run
at step 0, with the carried `configuration.*` reading source `state`, because that is the tier those
values have. Nothing needs to say a reset happened: the seeded `history` entry says it, in the user's
own words, and a banner line repeating it would be a second copy that can disagree.

### In flight — the write that goes *before* a delegation

Immediately before launching a step, append its entry to `in_flight:`; on the receipt, remove it.

```bash
# before the launch — one --json per entry, so a parallel pair is one write
node scripts/workflow-state.mjs append <TICKET-ID> in_flight \
  --json '{"step":"2.1a","agent":"aqa-api-test-creator","at":"2026-08-09T09:12:04Z"}' \
  --json '{"step":"2.1b","agent":"aqa-ui-test-creator","at":"2026-08-09T09:12:04Z"}'

# on each receipt, before the step summary
node scripts/workflow-state.mjs clear-in-flight <TICKET-ID> --agent aqa-ui-test-creator
```

`clear-in-flight` takes `--agent`, `--step`, or both, and refuses to run with neither — an
interrupted delegation losing its witness to a blanket clear is the failure this field exists to
prevent. Clearing an entry that is already gone prints `unchanged`, so a resume may run it blind.

This is the one field written ahead of the work rather than after it, and it is the only witness a
human reads when a session dies mid-agent. The metrics hook keeps its own launch record, so a resume
has two independent witnesses; **where they disagree, report the disagreement rather than picking
one** — the hook side can fail, and so can this one.

### Resuming an interrupted delegation

A resume that finds a non-empty `in_flight:` announces it — the step, the agent and the launch time —
and then decides per entry. Re-running blind is the wrong default:

| What the step's *Produces* artifact looks like | Do |
|---|---|
| Present and complete | This is the `already_done` row. Record it, `clear-in-flight` that entry, advance. **Do not re-run** |
| Absent | The step produced nothing. `clear-in-flight` that entry, `append history` with `result: INTERRUPTED` and `tokens: unavailable`, re-delegate. Safe, because every agent is a pure function of its parameters |
| Present but half-written | Do not guess. Manual mode asks; auto mode escalates with `status: escalated` naming the artifact |

Clear **that entry**, by `--agent` or `--step`, never the list — the sibling of a parallel pair may
still be running, and its entry is the only thing that will say so if this session dies too.

The cost of an interrupted agent is not reported in any of those cases. Its transcript stops where it
did, and a partial sum presented as the run's cost would be a different number wearing its clothes.
The run appears in the cost table as an `interrupted` row with a start time, a duration where the
harness measured one, and no tokens. That is the honest record; see `references/run-cost.md`.

## Step registry

Delegate one step at a time. Pass **artifact paths, not conversation history** — every agent re-reads from
disk, which is what keeps its context small and its result reproducible.

| Step | Agent / skill | Parameters passed | Receipt line to parse | Produces |
|---|---|---|---|---|
| 1.1 | `qa-requirements-collector` | `ticket_id`, `endpoint_hints`, `endpoint_hints_approver`, `api_surface_mode` | `QA_REQUIREMENTS_COLLECTOR_RESULT`, `FR_IDS`, `AC_IDS`, `API_SURFACE`, `SURFACE_PROVENANCE`, `MATCH_BASIS`, `MATCHED_OPERATIONS`, `SPEC_GAPS` | `requirements/<TICKET-ID>-requirements.md` incl. `# API Surface`, Jira -> In Progress |
| 1.2 | `qa-requirements-reviewer` — skipped when `review_requirements: false` | `ticket_id`, `requirements_path` | `QA_REQUIREMENTS_REVIEWER_RESULT`, `API_SURFACE_EVIDENCE`, `MISSING_INFORMATION` | five QA sections appended to the same file; the `# Missing Information` bullets are Checkpoint A1's input |
| 1.3 | `qa-scenario-generator` | `ticket_id`, `requirements_path`, `requirement_ids`, `review_findings`, `approved_values`, `confirm_ui` | `QA_SCENARIO_GENERATOR_RESULT`, `LINT`, `UNAPPROVED_UNKNOWNS`, `BLOCKED_SCENARIOS`, `APPROVED_ASSUMPTIONS`, `LEVELS`, `E2E_JOURNEYS`, `E2E_KEPT`, `E2E_DEMOTED`, `REQUIREMENT_GAPS` | `test-design/<TICKET-ID>-test-design.md`, classified — `Assigned Level:` + `Level Rationale:` (+ `Folds Into:`) per scenario |
| 1.5 | `qa-scenario-reviewer` | `ticket_id`, `test_design_path`, `requirements_path`, `previous_findings` | `Review Status:` | verdict + `[DESIGN-*]` findings |
| 2.1a | `aqa-api-test-creator` — skipped when `automation.api.status: not_applicable` | `ticket_id`, `test_design_path`, `requirements_path`, `iteration`, `review_findings`, `finding_ids`, `run_tests` | `API_SDET_RESULT` | `tests/api/**`, `.workflow/reports/<TICKET-ID>-api-implementation.md` |
| 2.1b | `aqa-ui-test-creator` — skipped when `automation.ui.status: not_applicable` | same, plus `explore_app` | `UI_SDET_RESULT` | `tests/ui/**`, `pages/**`, `.workflow/reports/<TICKET-ID>-ui-implementation.md` |
| 2.2a | `aqa-api-test-reviewer` — skipped when `automation.api.status: not_applicable` | `ticket_id`, `implementation_report_path`, `test_design_path`, `requirements_path`, `previous_findings` | `Review Status:` | verdict + `[API-*]` findings |
| 2.2b | `aqa-ui-test-reviewer` — skipped when `automation.ui.status: not_applicable` | same | `Review Status:` | verdict + `[UI-*]` findings |
| 3 | `qa-ship-tests` **skill** | `ticket_id`, `api_review`, `ui_review`, `branch_name`, `base_branch`, `dry_run`, `open_design_findings` | `QA_SHIP_TESTS_RESULT` | branch, commit, push, pull request |
| 4 | `qa-jira-transition` | `ticket_id`, `target_status` (**required**), `pr_url`, `branch_name`, `scenarios` | `QA_JIRA_TRANSITION_RESULT` | PR comment on the ticket, Jira -> `jira_target_status` |

`open_design_findings` is passed at step 3 only when `test_design.status` is
`approved_with_open_findings`: it is `test_design.open_questions` filtered to the `[DESIGN-*]` ids the
capped review left standing, one per line, copied rather than re-derived. On an `approved` design the
parameter is omitted and the pull-request body carries no such section.

Steps 2.1a/2.1b run **in parallel** — two Agent calls in one message. Same for 2.2a/2.2b. The two streams
write to disjoint paths by design, so concurrency here is a scheduling choice with no correctness cost.

**Every row of that table is delegated in the same three moves, and the first one comes before the
launch:**

1. `append <TICKET-ID> in_flight --json '{"step":"<step>","agent":"<agent>","at":"<UTC>"}'` — one
   `--json` per agent, so a parallel pair is one write and not two.
2. Launch the step.
3. On the receipt, `clear-in-flight <TICKET-ID> --agent <agent>`, then parse, then persist the rest.

Steps 1 and 3 are stated again at each phase below, because a rule that lives only in the state
section is one indirection away from the place it has to be obeyed. A step launched without its
`in_flight` entry is invisible to a resume: the session dies, and the next one cannot tell an
interrupted delegation from one that never started.

Every prompt carries `ticket_id` — it is the first parameter of every row above, and it is also what files
the run's cost under the right ticket. See `references/run-cost.md`.

**Every prompt also carries `run_mode:`, naming the mode you expect that step to resolve to** — one of
`first_run`, `EXISTS`, `revision`, `regenerate`, `full_review`, `re_review`,
`surface_revision`. It changes nothing about how the step behaves: each agent still resolves its own mode
from the parameters and the files on disk, and a disagreement between the two is a finding about the
delegation, not an instruction to the agent. It exists so the run's cost can be read per mode, because a
revision touching two scenarios and a first run producing forty are the same agent at wildly different
cost and the log could not tell them apart. Declare it rather than leaving it to be inferred from which
parameters are present: `previous_findings` usually means a revision, and *usually* is what makes an
inferred field worse than an absent one. A prompt without the line records as `undeclared`.

**And every prompt carries `step:`, the registry row it is delegating** — `step: 1.3`, `step: 2.1a`.
The hook cannot know that a reviewer run is step 1.5 rather than a re-review somebody asked for by
hand, and the cost table's `Step` column is only as honest as the line it was read from. A prompt
without it prints a dash there, never a guess.

## Reading a receipt

Two vocabularies exist on disk. Read each for what it is; do not judge an agent by prose.

* **Writing agents** end with `<NAME>_RESULT: OK | EXISTS | BLOCKED | ABORT` plus named fields.
* **Reviewers** write no `RESULT:` line. Their block opens `Review Status: Pass | Needs Revision | Blocked`.

Normalize both into one outcome:

| Receipt value | Outcome | Meaning |
|---|---|---|
| `OK`, `Pass` | `advance` | step done, go to the next one |
| `EXISTS` | `already_done` | the artifact was already there. Record it, advance, **do not re-run** |
| `Needs Revision` | `rework` | route the findings back |
| `PARTIAL` | `advance_with_gap` | the step did some of its work. Record what did not happen and what a human must finish, then advance — never re-run it blind |
| `BLOCKED`, `ABORT`, `Blocked` | `escalate` | stop and report the code |

`already_done` is the load-bearing row. A resumed run, a retried call after a timeout, or a re-entered phase
all land on it, and treating it as a failure would either loop or overwrite an artifact somebody is
mid-way through reading.

Record the abort code verbatim when escalating — `NO_TICKET_ID`, `NO_REQUIREMENTS_DOC`, `MALFORMED_DOCUMENT`,
`NO_TEST_DESIGN`, `LEVELS_NOT_ASSIGNED`, `TICKET_MISMATCH`, `AUT_UNREACHABLE`, `SELF_CHECK_FAILED`,
`NO_REPORT`, `SECRETS_DETECTED`, `NO_PR_URL`, `INVALID_PR_URL`, `NO_TRANSITION_PATH`, `TICKET_NOT_FOUND`,
`WRONG_PROJECT`, `REJECTED`. Each names a different fix, and a summary that says "blocked" without the
code makes a human re-derive it.

## Run cost — the metrics log

Every agent run costs tokens and wall time, and **no agent can report its own** — three hooks record
each launch and completion from outside, and the run's bill is summed from the transcript the harness
writes for every subagent. An `AGENT_RUN_METRICS:` line lands in the transcript right after each
receipt; treat it as the receipt's last field, echo `step`, `mode`, `duration`, `tokens`, `cost` and
`tool_uses` in the step summary, and copy them into `history` **together with `metrics_seq`**, the
line's `seq=` value — that pointer is what `WS-W20` checks. For a **background** agent the line lands at
the launch with `tokens=unavailable`; when the completion notification arrives, run
`node .claude/hooks/metrics-report.mjs <TICKET-ID> --last <agent>` and copy from that line instead.
Never copy the notification's own `<usage>` block: its `subagent_tokens` is the final turn's context,
not the run's bill.

**Read `references/run-cost.md` before the first delegation of a session**, and again before the terminal
return — it holds the hook table, the line's format, `metrics-report.mjs`, what the numbers actually
measure, and what an interrupted run does and does not report. Three rules from it stay here, because they
are the ones that cost something real when forgotten:

* **Never invent, estimate or extrapolate a cost number.** No `AGENT_RUN_METRICS` line means
  `metrics unavailable`; a dash on an interrupted row is the answer, not a gap to fill in.
* **`tokens` and `cost` are the run's bill, and `end_context` is not.** The bill is every API call
  summed from the transcript; `end_context` is the final message's context and is never reported as
  spend. `tool_uses` and `api_calls` are the true counts of how much work a run did.
* **Cost is a report, never a routing input.** Routing reads verdicts only.

## Routing a finding

Finding ids are stable across iterations and carry their stream in the prefix. Route by section, not by
severity:

| Finding source | Routed to | Additional parameters |
|---|---|---|
| `[DESIGN-*]` under `Missing Scenarios:`, `Duplications:`, `Technique Findings:`, `Risks:` | `qa-scenario-generator` | `review_findings` = the finding lines |
| `[DESIGN-*]` under `Incorrect Classifications:` | `qa-scenario-generator` | `review_findings` + `scenario_ids` = the named scenarios |
| `[REQ-*]`, or a design finding whose root cause is a missing requirement | **escalate** | — |
| `[API-*]` | `aqa-api-test-creator` | `review_findings`, `finding_ids`, `iteration` |
| `[UI-*]` | `aqa-ui-test-creator` | same |

**All four `[DESIGN-*]` buckets route to the same step**, because writing and classifying are one step.
A review with findings in several buckets is **one** delegation carrying all of them, and then one
re-run of the reviewer. That is one iteration — the counter tracks review rounds, not delegations.

Pass `scenario_ids` alongside `review_findings` when the findings name specific scenarios, so a
level finding re-runs the minimum-set pass for those scenarios rather than the whole document. The
ordering problem that used to live here — which of two steps to run first — is gone with the second
step.

Requirements gaps escalate rather than route. Only `qa-requirements-collector` holds Atlassian access, and a
gap in the ticket is answered by a person, not by a re-read of the same ticket. Re-running the collector is
worth doing only when the ticket itself has changed, and that is a human's call.

Minor findings (`[*-m*]`) attached to a `Pass` are recorded in `history` and never trigger a loop. A
reviewer that passes has already ruled that they do not block.

## Phase 1 — Test design

Sequence: 1.1 -> 1.2 (optional) -> **Checkpoint A (A1 approvals, A2 surface)** -> 1.3 -> **Checkpoint B** -> 1.5 -> design
decision.

Every delegation in this phase is preceded by its `in_flight` append and followed by its
`clear-in-flight`, exactly as the step registry says — 1.3 included, once per batch.

### After 1.1 — persist the test basis

The 1.1 receipt states the whole test basis on its `FR_IDS` and `AC_IDS` lines. Join them in document
order — every `FR_IDS` id, then every `AC_IDS` id — and write them once:

```bash
node scripts/workflow-state.mjs set-block <TICKET-ID> test_design.notes.requirement_ids --from-stdin
```

Nothing later in the run re-derives that list: the sizing decision below and every `requirement_ids`
batch read it from here, so a resume that never runs 1.1 again still knows how big the basis is.

### Before 1.3 — read `references/phase-1-design.md`

**Read it before the first 1.3 delegation of the run.** It holds the two things this phase decides that
are not in the step registry: how a test basis larger than `batch_threshold` is split into batches, and
what happens to a value the requirements never stated. Both are decisions no agent below may take —
the generating step is barred from choosing its own scope and from approving its own assumption — so
the rules live with the routing rather than with the work.

Two consequences that shape this phase's sequence, and are spelled out there: **batching is never a
review iteration**, and **1.5 runs once, over the whole document**, never over a partial design.

**Every 1.3 delegation classifies what the document holds when it finishes** — the first batch, every
later batch, and every revision. It is not "the last batch classifies": the step is barred from knowing
which batch is last, and it does not need to. Each run levels whatever is unlevelled and reruns the
minimum-set pass over the whole document, so the journey grouping is correct for the scenarios that
exist at that moment and correct again after the next batch arrives. A scenario kept as its own journey
after batch 1 may be folded after batch 2, which is the pass working rather than churn.

### Checkpoint A1 — the missing values, in both modes

Read the `# Missing Information` section of `requirements/<TICKET-ID>-requirements.md`. Every bullet
reads `- **[<id>] missing value: <short name>** — <what is missing>. Applies to <FR/AC ids>.`, and
that pair — the requirement and the short name — is what an approval is keyed on.

**Ask here rather than after 1.3.** A value approved now is written into the design on its first pass:
no `unknown:` marker, no coverage-gap entry, and no second 1.3 delegation spent absorbing an answer a
human had already given. `references/phase-1-design.md` holds the question, its four options, and the
one case auto mode stops on — read it before asking, and follow it from the file.

Pass whatever was approved to 1.3 as `approved_values`, one entry per line, and record them in
`test_design.approved_assumptions`. Nothing approved is a normal outcome and needs no note.

### The API surface — Checkpoint A2 and Checkpoint B

An E2E API scenario needs an operation to call. Step 1.1 maps one from the application's OpenAPI document
and records the outcome in `artifacts.api_surface`; a person can supply one instead, or decide the ticket
does not need one. The two checkpoints below are where that decision is taken, and they sit apart on
purpose: **A2 is cheap and early, B is binding.**

Escalating at A2 would stop every UI-only ticket, because nothing before 1.3 knows whether the design wants
API coverage at all. A design that assigns zero scenarios to `E2E API` on its own merits is a normal,
complete design, and SCRUM-132 shipped exactly that way.

**Checkpoint A2 — after 1.2, manual mode only.** Runs when `API_SURFACE_EVIDENCE` is `none` or `absent`. Print the reason the section gives, then
`AskUserQuestion`:

| Option | Effect |
|---|---|
| **Describe the endpoints** (recommended when you know the routes) | Collect the free text **and an approver handle**. Re-run 1.1 with `endpoint_hints` + `endpoint_hints_approver`; the collector resolves to `surface_revision` and rewrites only `# API Surface`. Then re-run 1.2 |
| **Retry the mapping** | Collect different match keys — the collector's `MATCH_BASIS` line names the tags that exist. Re-run 1.1 with them as `endpoint_hints` |
| **Ignore — no API information** | Re-run 1.1 with `api_surface_mode: ignore`. Record `decided_by` and `decided_at`. Print the consequence. The API stream will settle at `not_applicable` at Checkpoint B |
| **Escalate** | Stop, `status: escalated`, naming what a human must confirm |

Auto mode does not stop at **A2**. It already received `api_endpoints` and `api_surface` at the start of
the run if the user wanted them, and it cannot yet know whether API coverage is wanted. It does stop at
**A1**, for one case: a `[REQ-C*]` against an in-scope `AC-` id, which is the ticket's primary behaviour
having no stated outcome. An `AC-` id is main flow by definition, so that one needs no design to judge;
a `[REQ-C*]` against an `FR-` id waits for the design gate, where the manifest can say whether a
`Happy path` scenario cites it.

**Checkpoint B — after 1.3, both modes. This is the binding gate.** Take the counts from the design
manifest rather than by reading the document:

```bash
node scripts/test-design-lint.mjs test-design/<TICKET-ID>-test-design.md --emit-manifest
```

`scenarios_by_level["E2E API"]` and `scenarios_by_level["E2E UI"]` are the two lists this gate turns on,
and `classified` is the field that makes them safe to read. **A design nobody has classified reports zero
at every level**, which is a true statement about the document and the exact opposite of what this gate
would conclude from it — so `classified: false` is never a `not_applicable`, it is 1.3 not having finished.
Check it first; `counts.unassigned` says how many scenarios are waiting.

**A level count is not a test count.** `scenarios_by_level` is what this gate turns on, because the
question here is whether a stream has work at all. How many *tests* that work becomes is
`e2e_tests_implied`, which is the same list minus the scenarios carrying `folds_into` — a scenario the
design folded is executed inside another scenario's test rather than in one of its own. A stream with
scenarios is never `not_applicable`, however many of them fold: folding reduces tests, never coverage,
and a stream where every scenario folds into another is impossible, since something has to be folded
into. Pass neither figure down as a scope — the implementing step selects on the `Folds Into:` lines
itself, and a `scenario_ids` list built here from `scenarios_by_level` would hand it folded ids to
implement separately, undoing at the gate what the classification step decided.

Counting the levels by hand is what this replaces. It is arithmetic, the script already does it, and a
gate that settles a whole stream is the last place to re-derive a number from prose.

### The API stream

| E2E API scenarios | `artifacts.api_surface.status` | Outcome |
|---|---|---|
| 0 | any | `automation.api.status: not_applicable`, reason `the classified design assigns no scenarios to E2E API`. Skip 2.1a and 2.2a. **Not an escalation** |
| >= 1 | `mapped` or `partial` | Proceed. Spec gaps are already `unknown:` in the design and need nothing here |
| >= 1 | `ignored` | `not_applicable` in **both** modes, reason `the API surface was ignored by <decided_by> on <decided_at>`. Print the consequence. Do not re-ask and do not escalate — a person already decided this, and asking again spends their time to reach the answer they gave |
| >= 1 | `none` or `absent` | **manual**: the Checkpoint A2 options without *Retry*. **auto**: obey `on_missing_api_surface` — `escalate` stops with `status: escalated`, `final_decision: escalate`, `NEXT_ACTION` naming the feature-to-endpoint mapping a human must confirm; `ignore` sets `not_applicable` and prints the consequence |

### The UI stream

**Zero `E2E UI` scenarios settles the UI stream the same way**: `automation.ui.status: not_applicable`,
reason `the classified design assigns no scenarios to E2E UI`, skip 2.1b and 2.2b. Not an escalation, and
no surface question applies — the API surface has nothing to do with whether a UI test is wanted.

This half was missing. The state schema has always permitted `automation.ui.status: not_applicable`, but
nothing here ever set it, so a design assigning no UI work still launched both UI steps — and on the one
ticket anyone has measured those were the two most expensive steps in the run. A stream with nothing to
test is a stream with nothing to review.

Both streams `not_applicable` is a design with no automatable E2E work at all. That is not a failure
either, but it means there is nothing for phase 2 to do: record both reasons, skip to the terminal return
with `status: completed`, and say plainly in `NEXT_ACTION` that the design produced no E2E coverage and
why. Never open a pull request for it — there is nothing in it.

### Both streams

A `Requirement Gap` scenario is never an `E2E API` or `E2E UI` scenario, so it never counts towards this
gate — the manifest excludes it from both lists and from `counts.executable`. When a stream reaches zero
because its scenarios were classified as requirement gaps, the reason line says so — `the classified
design assigns no scenarios to E2E API; N scenarios are blocked on requirement gaps` — and the gap ids go
in `requirement_gaps`. Still `not_applicable`, still not an escalation, but a reason a reader can act on
rather than one that suggests the feature has no API surface.

Choosing *Describe the endpoints* at B re-runs 1.1, then **1.3** — a new surface changes
which values are assertable, so the design is regenerated rather than patched. Bump `iterations.design`; the
cap applies as it does to any other design loop.

**The consequence is printed, never implied.** Any `not_applicable` reached for a reason other than "the
design assigned zero API scenarios on its own merits" prints this at the pause, records it in
`test_design.open_questions`, and carries it into the PR body:

> No API surface was mapped for this feature. Scenarios cannot name a route, a status code or a response
> shape, so no E2E API coverage is produced for this ticket.

A skipped stream is always visible in the artifacts. A reader must never have to infer it from an absence.

The design decision is the gate between design and automation, and it is recorded in the state file:

* **Accept** — `Review Status: Pass`. Set `test_design.status: approved`, `review_status: passed`, move to
  Phase 2.
* **Request revision** — `Needs Revision`. Route per the finding table, bump `iterations.design`, re-run 1.5
  with `previous_findings`.
* **Escalate** — `Blocked`, an abort code, or an open question that no agent can answer. Stop, record it in
  `test_design.open_questions`, and say what a human must decide.

Do not enter Phase 2 on anything but Accept. Both SDETs abort `LEVELS_NOT_ASSIGNED` on an unclassified
design anyway, but arriving there is a wasted delegation.

**Then check the decision you just wrote, before the first Phase 2 delegation:**

```bash
node scripts/workflow-state.mjs check-streams <TICKET-ID>
```

Exit `0` means both stream statuses agree with the design the manifest was read from; exit `5` means they
do not, and the row says which. `CS-E02` is a stream settled `not_applicable` while the design assigns it
scenarios — **the one drift nothing downstream re-derives**: that work is never launched, and the ship
gate cannot tell a stream nobody needed from one nobody ran. `CS-E03` is the inverse, a stream carrying
work the design never assigned it. `CS-E01` is an unclassified design, which is 1.3 not having finished.

Fix the state file and re-run it; never route on an exit `5`. It rules on nothing else — not whether a
step ran, not whether a verdict was right — and it says nothing about a stream still `pending`, which is
every stream between this gate and its implementing step.

Run it again at the ship gate, before delegating step 3. `WS-E35` already refuses to let the phase reach
`ship` with a stream unsettled; this is the other half of the same question, and the two together are why
a forgotten stream cannot reach a pull request: one checks the statuses against the design, the other
checks them against the phase.

### Then preflight the environment, before the first Phase 2 delegation

Both implementing steps run the suite, and neither can produce a result without a running application;
the UI one also needs a browser binary on disk. Both discover that **after** reading the design, the
etalon, the surface and the whole existing suite, and both then return `BLOCKED` — the two most
expensive steps in the run, spent to learn something two commands answer here. Skip this only when both
streams settled `not_applicable`, where there is nothing to launch.

```bash
curl -s -o /dev/null -w "%{http_code}" <BASE_URL>/
npx playwright install --dry-run
```

`BASE_URL` comes from `.env`; `http://localhost:9000` is the documented local default, not a constant.

| What it says | What it means |
|---|---|
| a 2xx or 3xx | the application is up. Proceed |
| anything else, or no response | `AUT_UNREACHABLE` |
| `install --dry-run` prints an install location per browser | the versions Playwright expects are declared. Proceed |
| it exits non-zero, or prints nothing | `BROWSER_MISSING` |

**`--dry-run` reports what Playwright *would* install, not what is on disk.** It catches a broken
Playwright install and a version this project cannot resolve; it does not prove the binary is present.
Check the `Install location:` path it printed for the Chromium build if you want that, and say which of
the two you did — a preflight that claims more than it checked is worse than none.

Neither failure is skipped past:

* **Manual mode** — `AskUserQuestion` for both: start the application, or install the browsers, or
  stop. Re-run the failing command after the user says they have fixed it; do not take the answer as
  the evidence.
* **Auto mode** — stop with `status: escalated`, `final_decision: escalate`, and `AUT_UNREACHABLE` or
  `BROWSER_MISSING` in `NEXT_ACTION` naming the command that failed and its output. This is not a gate
  a setting relaxes: a suite that cannot run produces no verdict, and every downstream decision in this
  workflow reads one.

Record the outcome in `automation.notes.preflight`. A run that reached Phase 2 without it is a run
whose `BLOCKED` nobody can distinguish from a real one.

Step 1.3 returns `E2E_JOURNEYS`, `E2E_KEPT` and `E2E_DEMOTED` alongside its result line. Record them in
`test_design` and print them at the 1.3 pause: they are how many distinct journeys reached E2E, which
scenarios hold an E2E level, and which the classification step moved down to a level this repository does
not run. `E2E_DEMOTED` is the size of Phase 2 shrinking on purpose — a design whose E2E set collapsed to two
scenarios is the expected shape, not a gap to route back. The demoted scenarios reappear as follow-up work
below.

### Unapproved assumptions — the one decision no agent may make

Step 1.3 returns `UNAPPROVED_UNKNOWNS`, `BLOCKED_SCENARIOS` and `APPROVED_ASSUMPTIONS`. Record all three
in `test_design` and **handle a non-zero `UNAPPROVED_UNKNOWNS` at this gate, before Accept** — the
options per mode are in `references/phase-1-design.md`, which you have already read by this point.

The rule that does not move: an orchestrator that approves an agent's assumption on the user's behalf is
the same defect as an agent that approves its own. Never synthesise an approver name, never infer
approval from a general "yes, continue", and never carry an approval forward from another ticket.

**`on_blocked_alternative_flow` is a setting about stopping, not about approving.** Auto mode escalates
when an unapproved unknown leaves an in-scope requirement with no automatable coverage at all; `continue`
narrows that to **main-flow** requirements, leaving an alternative-flow one recorded and the run going.
The main-flow test, the mixed-set rule and what still gets printed are in the reference above. It
approves nothing, asserts nothing and changes no scenario — a requirement it lets past is exactly as
uncovered afterwards as it was before, and the difference is only whether a human is fetched now or
reads the open question later.

## Phase 2 — Test automation

Both launches below are preceded by one `in_flight` append carrying **both** entries — one `--json` per
stream, one write — and each receipt is followed by its own `clear-in-flight --agent <name>` before the
receipt is parsed. When only one stream is live, both commands name only that one.

1. Launch 2.1a and 2.1b in parallel. Record each stream's receipt fields — `IMPLEMENTED_SCENARIOS`,
   `CREATED_TESTS`, `EXECUTION`, `TYPECHECK`, `DEFECT_SUSPECTED`, `SHARED_CHANGE_REQUESTED` — into
   `automation.<stream>`.
2. Launch 2.2a and 2.2b in parallel, each with its stream's report path.

**A stream at `not_applicable` is not launched at all** — neither its creator nor its reviewer. Checkpoint B
set that status and wrote the reason; re-deriving it here would spend two delegations to be told what the
state file already says. Treat the stream as settled, carry `not_applicable` and its reason through to the
final decision and the PR body, and never let it hold up its sibling. `not_applicable` is a finished state,
not a pending one: it never blocks Accept, and it is never counted as a failure.

The parallelism is unchanged when only one stream is live. Launch the live one on its own. **Either
stream can be the settled one** — Checkpoint B sets `not_applicable` on the API stream when the design
assigns no `E2E API` scenarios and on the UI stream when it assigns no `E2E UI` scenarios, and nothing
here treats one as the default. With both settled there is no phase 2: skip to the terminal return
rather than opening a pull request with nothing in it.
3. Per-stream revision loop, with **independent counters**. A stream at `Pass` is finished and is not
   re-run because its sibling is looping.
4. Final decision when both streams have settled — Accept / Request Revision / Create Follow-Up Work /
   Block / Continue, recorded in `final_decision`.

**Stream independence is a requirement, not an optimisation.** A UI stream that exhausts its cap must not
discard the API stream's `Pass`. Keep both results in state, stop before ship, and name exactly which
stream needs a human.

Two receipt fields need action rather than filing:

* `SHARED_CHANGE_REQUESTED` — a stream needs a change on the other side of the ownership boundary, or in
  `playwright.config.ts` / `framework/`. That is an orchestrator- or human-level decision. Surface it; never
  make the edit here.
* `DEFECT_SUSPECTED` — a red test asserting the specification against a real application defect. That is
  **finished work**, not a failure. It ships, and `qa-ship-tests` puts it in the PR body under
  *Suspected Application Defects*. Never route it back as a bug to fix.

Non-E2E scenarios from the design's `Handed Off As Follow-Up Work` table are recorded in
`follow_up_tickets` as a list of what needs creating, and carried into the PR body. This skill creates no
Jira ticket.

Scenarios under the design's `## Blocked / Requirement Gaps` subsection — receipt line
`REQUIREMENT_GAPS` — are recorded **separately**, in `requirement_gaps`, and carried into the PR body under
that heading. They are not automation work at any level: each one says the requirements never stated an
outcome the scenario could assert, so what it needs is a specification, not a test at a lower level. Never
fold them into `follow_up_tickets`, never count them towards a stream's scenario counts, and never treat a
stream as short of coverage because of one. A ticket whose design is entirely requirement gaps still ships
whatever the other scenarios produced, and the gaps go in `NEXT_ACTION`.

## Manual mode — the default

After **every** step, before any further delegation:

1. Persist state.
2. Print a compact summary: the parsed receipt fields only — result, artifact path, counts, finding ids,
   and the step's cost as `<mode> / <duration> / <tool_uses> tool calls / <tokens> tokens / <cost>`
   off the `AGENT_RUN_METRICS` line — `unavailable` printed as such, never filled in.
   Never paste an agent's full output into the transcript. The agents keep their returns short on purpose;
   re-expanding them here throws that away.
3. Ask for the transition with `AskUserQuestion`. Build the options from the step registry and the receipt:

   | Option | Effect |
   |---|---|
   | **Continue -> `<next step>`** (first, recommended) | delegate the next registry row |
   | **Rework -> `<previous step>`** | re-run the previous agent, carrying this step's findings |
   | **Different agent** | any registry row, with the parameters that row needs |
   | **Pause** | persist `status: paused` and stop; `/qa-workflow <TICKET-ID>` resumes |
   | **Decline** (always last, always present) | persist `status: declined` and return — see *Declining* |

   For a reviewer returning `Needs Revision`, the options become **Send back to `<routing target>`**
   (recommended, named from the finding table), **Accept anyway** (records an override in `history` and
   advances), **Pause**, **Decline**.

No iteration cap applies in manual mode. Every loop is already a human decision, and capping a decision
somebody just made would be theatre.

## Declining — the option that must always be on the table

**Every `AskUserQuestion` this skill asks carries a Decline option, in both modes, without exception.**
List it last, after Pause. A question with no way out is not a question; it is a prompt to pick which
way to proceed, and a user who wants none of the offered paths is left with nothing to click. A decline
is not an error and not an escalation — it is a legitimate end state, and it reports *more* carefully
than a completed run, not less.

What to persist and what to return is in `references/terminal-return.md`, alongside the return block
itself. **Read that file when a run is about to end, in any way at all** — a decline, a pause, an
escalation, or the ordinary `OK`.

## Auto mode — `--auto`

No `AskUserQuestion` between agents. Route on the normalized outcome:

* `advance` -> next registry row.
* `already_done` -> record and advance without re-running.
* `rework` -> increment that stream's counter, route per the finding table, then re-run the reviewer with
  `previous_findings` set to its own previous block.
* A **code** counter (`iterations.api`, `iterations.ui`) **reaches** `max_review_iterations` (default
  `2`) with the verdict still `Needs Revision` -> **stop**. `status: escalated`,
  `final_decision: escalate`. Print the stream, the outstanding finding ids and what a human must
  decide. Never loop past the cap, and never lower the bar to clear it.
* **`iterations.design` reaches `max_design_iterations` (default `1`) and the design ships anyway.**
  This one does not stop the run. Set `test_design.status: approved_with_open_findings`, append every
  outstanding `[DESIGN-*]` id with its one-line text to `test_design.open_questions`, and continue into
  Phase 2. The reasoning is that a design review's Majors are, by the severity floor its reviewer now
  applies, things that change what a test asserts — and a second regeneration answers them by producing
  a document that invites new ones. Shipping the design with its open findings named, in the state file
  and in the pull-request body, puts them in front of a human who can rule on them, which is what
  escalating was for. The step that ships prints them under *Design findings not resolved*.

  It is a distinct status rather than `approved` on purpose: a reader who cannot tell the two apart
  cannot tell a design nobody criticised from one whose criticism nobody answered.
* `escalate` -> stop immediately with the code.

Two gates in this mode are settings rather than rules, and both default to stopping:
`on_missing_api_surface` at Checkpoint B, and `on_blocked_alternative_flow` at the design gate. Each
prints what it relaxed at the point it relaxes it, and the run-parameters banner has already named both
before the first delegation — an unattended run whose gate was widened has to say so twice, because the
one thing nobody can reconstruct afterwards is why it did *not* stop.

Confidence is read off the verdict, not guessed at. A reviewer that returns `Pass` has ruled that quality is
met; that is the signal to proceed, and there is no second opinion to form here. A `Pass` carrying Minor
findings still advances.

Still announce each step as it starts and each receipt as it lands, cost included — an unattended run that
prints nothing until it finishes is unauditable, and an unattended loop is exactly where a token count
climbing per iteration is worth seeing before the cap is reached.

## Steps 3 and 4 — ship, then hand back

**On reaching phase `ship`, read `references/ship-and-handback.md`** before delegating step 3. It holds
both steps end to end: the gate, what step 3 composes, which git confirmations survive auto mode,
`skip_ship` and `dry_run`, the `target_status` rule, the four hand-back outcomes and their state writes.

Four things belong here, next to the routing they constrain:

* **Two checks run before the delegation, and both are cheap.** `node scripts/workflow-state.mjs
  check-streams <TICKET-ID>` reads the stream statuses against the design once more — the same command
  Checkpoint B ran, asking whether the decision still matches the document that produced it — and the
  write that moved `phase` to `ship` has already been refused by `WS-E35` if either stream was left
  unsettled. A stream that was never launched fails one or the other; neither can be satisfied by a run
  that simply forgot it.
* **The run does not end at the pull request.** Record `pull_request` from the ship receipt's `PR_URL`,
  then run step 4 — the ticket still says `In Progress` until it does.
* **A failed hand-back does not fail the run.** The pull request is the deliverable; the Jira status is
  bookkeeping. Record the failure, put the manual step in `NEXT_ACTION`, and still return `OK`.
* **Never hand back on a pull request this run did not create** — a `dry_run`, a skipped ship phase, a
  `PR_URL` of `none`, or a URL carried over from another ticket.

## Return

Terminal returns have one shape, in `references/terminal-return.md`: the receipt block, then **Artifacts
produced**, then **Agent run cost** — on `OK`, `ESCALATED`, `BLOCKED`, `PAUSED` and `DECLINED` alike.
**Read that file when the run is ending**, before composing the return, and follow it exactly. A run that
stopped early still cost what it cost and still left files behind, which is precisely when the record
matters most.

## Must not

- Perform requirements analysis, scenario generation, classification, review or test implementation itself.
  Every step is a delegation; doing the work here is the failure this role exists to prevent.
- Write or edit anything under `requirements/`, `test-design/`, `tests/`, `pages/`, `services/`,
  `fixtures/`, or any implementation report. Exactly one file holds its state: `.workflow/<TICKET-ID>.yaml`.
  `.workflow/metrics/` is the hooks' directory — read it, never edit or delete anything in it, and let
  `metrics-report.mjs` do the reconciling. A `reset` renames files in two of those directories and is
  the one exception, but it is not an exception to *this*: the command moves them, never you. `mv`,
  `Move-Item`, `git mv` and a rename through any other tool stay forbidden.
- Reset a state file by hand — rename it, delete it, or `init` over it — or run `reset` on the
  strength of a `check-artifacts` exit `4`, a decline, a failed step or a cap being reached. The
  command is the only way, a human asks for it by name, and it runs only after a `--dry-run` they saw
  and a question they answered.
- Read a reset as a rollback. The archived files stay on disk under their new names, every
  `created_tests` file stays exactly where it was, and the metrics log is never touched.
- **Delegate anything in an invocation that carried `--reset`.** The reset is the whole request; the
  fresh document reading as a run with nothing to resume is not permission to start one. Nine
  unattended delegations is not what somebody asked for by typing one flag, and the fact that routing
  onward would need no special-casing is the reason to write the rule down rather than the reason to
  skip it.
- Report a token count, duration or cost that did not come from an `AGENT_RUN_METRICS` line or from
  `metrics-report.mjs`, write one into `history` without its `metrics_seq`, or let any of those numbers
  influence a routing, iteration or review decision. A dash on an interrupted row is the answer, not a
  gap to fill in.
- Describe `end_context`, or a task notification's `subagent_tokens`, as the run's token spend, or sum
  either into a figure called a cost. Both are the final message's context; the bill is the transcript
  sum the report prints under `Tokens`.
- Launch a step without `run_mode:` and `step:` in its prompt, or read an `undeclared` mode on a
  metrics row as `first_run`. An unrecorded mode must look unrecorded.
- Hand-write, hand-edit or `Edit` the state file. Every change goes through `scripts/workflow-state.mjs`;
  a file some other hand touched is repaired with `normalize`, not with another hand edit.
- Persist state without running `node scripts/workflow-state.mjs validate <TICKET-ID>` after it, or
  delegate the next step while that command still exits non-zero. Reach for `--force` without recording
  in `history` why the document had to be written in a state that does not validate.
- Write a key the schema does not define anywhere but under a `notes:` map, or write the same key twice
  in one section. The second value is the only one anybody reads.
- Launch any step without appending its `in_flight` entry first, or parse a receipt before clearing it.
  A delegation with no entry is invisible to the resume that has to decide whether it ran.
- Re-run a step found in `in_flight:` without first checking whether its artifact is already there.
- Resume a run without `check-artifacts`, or route on a recorded phase while a path the state file names
  is missing from disk and unannounced. The file is a record of what happened, not of what still exists.
- Read a `check-artifacts` exit `4` as a document to repair, or `--force` a state file over it. The
  document is fine; the disk is not, and the routing decision is this skill's, not the script's.
- Delegate the first step of a session without having read `references/run-cost.md`, or the first 1.3
  without having read `references/phase-1-design.md`.
- Delegate step 3 without having read `references/ship-and-handback.md` this session.
- Return a terminal result — `OK`, `ESCALATED`, `BLOCKED`, `PAUSED` or `DECLINED` — without having read
  `references/terminal-return.md` this session. A reference the orchestrator forgets to read does not
  make the run verbose; it makes the rule silently stop applying.
- Loop past `max_review_iterations` in auto mode, or raise the cap mid-run to clear a stuck loop.
- Count a 1.3 batch as a review iteration, run two batches in parallel, or start 1.5 while any batch is
  still outstanding. Batching splits one design across several delegations; it does not split the design.
- Run a git phase, or reach around `qa-ship-tests` to `git-workflow-orchestrator` or raw `git`, before both
  stream reviews are `Pass`.
- Re-run an agent that returned `EXISTS`, or pass a regenerate token to force a rewrite of an artifact a
  reviewer has already read.
- Discard one stream's passing result because the other stream failed.
- Route a `DEFECT_SUSPECTED` entry back as a defect to fix, or ask an implementer to weaken an assertion to
  turn a documented red test green.
- Touch Jira itself. Two agents hold Atlassian access — one at each end of the run — and every Jira change
  goes through one of them. Follow-up tickets are reported, never created.
- Hand a ticket back to `In Review` on a pull request that was not created this run: a `dry_run`, a skipped
  ship phase, a `PR_URL` of `none`, or a URL carried over from another ticket.
- Fail, reverse or re-run the ship phase because the Jira hand-back failed. The pull request is the
  deliverable; the status is bookkeeping.
- Ask an `AskUserQuestion` whose options are all ways of proceeding. Decline is always available, listed
  last, in both modes.
- Return a terminal result without the receipt block, the artifacts section and the cost section —
  `DECLINED` and `PAUSED` included. A run that stopped early is exactly when that record matters most.
- Treat a decline as a failure to recover from: no retry of the declined step, no rollback of an artifact
  already written, no reason invented on the user's behalf.
- Paste an agent's full output into the transcript instead of the parsed receipt fields.
- Add a routing hint, a `NEXT:` line, or a sibling agent's name to any file under `.claude/agents/`.
  Routing lives here.
