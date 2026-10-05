# Workflow state schema

The field contract for `.workflow/<TICKET-ID>.yaml`.

**The `## Fields` table below is generated — do not hand-edit it.** It is the output of
`node scripts/workflow-state.mjs print-schema`, which reads the same schema object `validate` checks
against and `set` writes against. The rule a state file is written against and the rule it is
validated against have to be the same words, so there is one source and this is its rendering.
Regenerate by replacing the table under `## Fields` with:

```bash
node scripts/workflow-state.mjs print-schema
```

**A test guards the copy.** `scripts/__tests__/workflow-state.test.mjs` extracts this file's
`## Fields` section and compares it to that command's output, so the table cannot drift from the
schema quietly — which is the exact failure generating it was meant to prevent. Byte-equality of the
whole file is not the check, because the prose around the table is hand-written on purpose.

The state file is **never hand-written**. `init`, `set`, `set-block`, `append`, `clear-in-flight`,
`normalize` and `reset` are how it changes; the schema below is what they accept. `validate`, `get`,
`check-artifacts`, `check-streams` and `print-schema` only read.

`normalize` does two things, both of them repairs rather than routing. It collapses a duplicated key
to the last value — the one every YAML reader was already seeing — and it **back-fills the
`configuration.*` keys a document predates**, at the value `init` would have written, printing one
line per key. It never replaces a value already on disk and never touches anything outside
`configuration:`: an absent setting is reported by the banner as a `default` nobody chose, which is a
different problem from a run whose phase or counters need moving.

`reset` is the odd one and defines no field of its own: it archives the document by rename, writes
the `init` skeleton in its place, carries `mode` and the whole `configuration:` subtree forward, and
seeds one `history` entry. Two refusals belong to it alone and are **not** in the `## Checks` table
below, because `validate` never emits them: **`WS-E40`**, no free archive name left in a family
(exit `2`), and **`WS-E41`**, a rename that failed part-way (exit `1`). `WS-E41` rolls nothing back —
every move that did succeed put its file under a name nothing else uses, and re-running the command
skips each one as `absent`.

Keys the schema has no opinion on are a **warning**, not an error, and their designated home is a
`notes:` map — top level, or inside a section (`test_design.notes`, `automation.api.notes`). Nothing
under `notes.` is ever reported as unknown. A key that keeps coming back belongs in the schema
proper; `validate --json` lists them under `promote_candidates`.

## Fields

| Path | Type | Required | Notes |
|---|---|---|---|
| `ticket_id` | scalar | yes |  |
| `phase` | enum(test_design | test_automation | ship | done) | yes |  |
| `status` | enum(in_progress | paused | escalated | blocked | declined | completed) | yes |  |
| `mode` | enum(manual | auto) | yes |  |
| `current_step` | scalar | yes |  |
| `configuration` | map | yes |  |
| `configuration.review_requirements` | scalar | — |  |
| `configuration.non_e2e_coverage_strategy` | scalar | — |  |
| `configuration.max_review_iterations` | int | — |  |
| `configuration.max_design_iterations` | int | — | the design review's own cap, separate from the code reviews' because the two loops converge differently; on reaching it the design is approved_with_open_findings and the open ids travel to the pull request |
| `configuration.batch_threshold` | int | — |  |
| `configuration.batch_size` | int | — |  |
| `configuration.jira_target_status` | scalar | — |  |
| `configuration.on_blocked_alternative_flow` | enum(escalate | continue) | — | auto mode only — continue relaxes the no-coverage escalation for alternative-flow requirements, never for a main flow |
| `configuration.on_missing_api_surface` | enum(escalate | ignore) | — | auto mode only — what the automation gate does when the design wants API coverage and no surface was mapped; ignore settles the API stream as not_applicable instead of stopping the run |
| `configuration.notes` | free | — |  |
| `iterations` | map | yes | one counter per review loop, never shared |
| `iterations.design` | int | yes |  |
| `iterations.api` | int | yes |  |
| `iterations.ui` | int | yes |  |
| `artifacts` | map | yes |  |
| `artifacts.requirements` | scalar | — |  |
| `artifacts.test_design` | scalar | — |  |
| `artifacts.metrics` | scalar | — | written by the hook, not by the orchestrator |
| `artifacts.api_surface` | map | — |  |
| `artifacts.api_surface.status` | enum(mapped | partial | none | ignored | absent) | — |  |
| `artifacts.api_surface.provenance` | enum(openapi | user-supplied | mixed | none | ignored) | — |  |
| `artifacts.api_surface.match_basis` | scalar | — |  |
| `artifacts.api_surface.matched_operations` | int | — |  |
| `artifacts.api_surface.spec_gaps` | int | — |  |
| `artifacts.api_surface.decided_by` | scalar | — |  |
| `artifacts.api_surface.decided_at` | scalar | — |  |
| `artifacts.notes` | free | — |  |
| `test_design` | map | yes |  |
| `test_design.status` | enum(pending | generated | classified | approved | approved_with_open_findings) | yes |  |
| `test_design.review_status` | enum(pending | passed | needs_revision | blocked) | yes |  |
| `test_design.batches` | seq | — |  |
| `test_design.open_questions` | seq | — |  |
| `test_design.last_findings` | scalar | — | the reviewer's own previous block, fed back as previous_findings |
| `test_design.unapproved_unknowns` | seq | — |  |
| `test_design.blocked_scenarios` | seq | — |  |
| `test_design.approved_assumptions` | seq | — |  |
| `test_design.notes` | free | — |  |
| `automation` | map | yes |  |
| `automation.api` | map | yes | the API automation stream |
| `automation.api.status` | enum(pending | not_applicable | implemented | review_in_progress | passed | needs_revision | blocked) | yes |  |
| `automation.api.not_applicable_reason` | scalar | — | required whenever status is not_applicable — a settled stream with no stated reason is indistinguishable from a forgotten one |
| `automation.api.report` | scalar | — | path to the implementation report |
| `automation.api.implemented_scenarios` | seq | — |  |
| `automation.api.created_tests` | seq | — |  |
| `automation.api.review_status` | enum(pending | passed | needs_revision | blocked) | yes |  |
| `automation.api.last_findings` | scalar | — | the reviewer's own previous block, fed back as previous_findings |
| `automation.api.notes` | free | — |  |
| `automation.ui` | map | yes | the UI automation stream |
| `automation.ui.status` | enum(pending | not_applicable | implemented | review_in_progress | passed | needs_revision | blocked) | yes |  |
| `automation.ui.not_applicable_reason` | scalar | — | required whenever status is not_applicable — a settled stream with no stated reason is indistinguishable from a forgotten one |
| `automation.ui.report` | scalar | — | path to the implementation report |
| `automation.ui.implemented_scenarios` | seq | — |  |
| `automation.ui.created_tests` | seq | — |  |
| `automation.ui.review_status` | enum(pending | passed | needs_revision | blocked) | yes |  |
| `automation.ui.last_findings` | scalar | — | the reviewer's own previous block, fed back as previous_findings |
| `automation.ui.notes` | free | — |  |
| `automation.notes` | free | — |  |
| `in_flight` | seq | — | written immediately before a delegation, cleared on the receipt; a list, because two streams launch together |
| `pull_request` | scalar | — | the PR_URL off the ship receipt |
| `jira` | map | — |  |
| `jira.status` | scalar | — |  |
| `jira.handback_status` | enum(pending | done | skipped | partial | failed) | — |  |
| `jira.comment` | enum(pending | added | already_present | skipped) | — |  |
| `follow_up_tickets` | seq | — |  |
| `requirement_gaps` | seq | — |  |
| `final_decision` | enum(pending | accept | request_revision | escalate | block | decline | continue) | yes |  |
| `declined` | map | — |  |
| `declined.at_step` | scalar | — |  |
| `declined.question` | scalar | — |  |
| `declined.reason` | scalar | — | the user's own words — never a paraphrase |
| `history` | seq | yes |  |
| `notes` | free | — |  |

## Checks

`node scripts/workflow-state.mjs validate <TICKET-ID>` — exit `0` clean or warnings only, `1`
violations, `2` usage, `3` the file is missing or holds a construct the parser will not guess at.

| Code | Severity | Rule |
|---|---|---|
| `WS-E01` | error | duplicate key. YAML keeps the last value, so every earlier one is lost |
| `WS-E10` | error | a required key is missing |
| `WS-E20` | error | a scalar where a mapping or a sequence belongs, or a non-integer counter |
| `WS-E21` | error | a value outside the field's enum |
| `WS-E30` | error | `automation.<stream>.status: not_applicable` with no `not_applicable_reason` |
| `WS-E31` | error | `status: declined` with an unfilled `declined:` block |
| `WS-E32` | error | `phase: done` while `jira.handback_status` is still `pending` |
| `WS-E33` | error | a review counter past `configuration.max_review_iterations`. Reaching the cap is legal; passing it is not |
| `WS-E34` | error | a pull request recorded before the run reached `ship` |
| `WS-E35` | error | `phase: ship` or `done` with a stream that is neither `passed` nor `not_applicable` |
| `WS-E90` | error | a YAML construct outside the supported subset — reported rather than guessed at |
| `WS-W10` | warning | a key the schema does not know. `--strict` promotes it |
| `WS-W20` | warning | a `history` entry carrying a cost figure without a `metrics_seq` naming the metrics-log row it was copied from, or naming a row that does not exist or belongs to another agent |

`WS-E01` is the check this script exists for. `.workflow/SCRUM-132.yaml` carried
`test_design.last_findings` twice — an 1800-character routing block, then `null` — and every consumer
read `null`. A whole review round ran without the findings it was routing on, and nothing in the
transcript said so, because the document parsed.

`check-streams` asks the third question — not what the document says, and not what is on disk, but
whether the two stream decisions still match the design they were taken from. It reads its counts from
`test-design-lint.mjs --emit-manifest`, refuses an unclassified design rather than reading its zeros as
answers, and exits `5` on a disagreement:

| Code | Rule |
|---|---|
| `CS-E01` | the design is not classified, so no stream conclusion can be drawn from it |
| `CS-E02` | a stream settled `not_applicable` while the design assigns it scenarios |
| `CS-E03` | a stream carrying work while the design assigns it no scenario |

`CS-E02` is the one nothing downstream re-derives: the work is never launched, and the ship gate cannot
tell a stream nobody needed from one nobody ran. A stream still `pending` is not a violation — that is
every stream between the automation gate and its implementing step.

`WS-E35` is the early half of a check the ship step already makes. That step treats an unknown stream
verdict as *not passed* and stops, so a stream nobody settled has always been caught — but only after
the run was routed on a document that said it was shippable. Here it is caught while the document is
still the thing being read, before the ship delegation is made.

`WS-W20` is the honesty check. `SKILL.md` forbids inventing a cost figure, and a reader cannot tell a
correctly transcribed number from an invented one, so the check is on provenance rather than on value:
a `history` entry that carries `tokens`, `duration_s`, `tool_uses`, `api_calls` or `cost_usd` must
also carry `metrics_seq`, the `seq` of the metrics-log row it was copied from, and that row's `agent`
must match. The check used to count rows per agent name instead, which let a duration somebody typed
in from a task notification pass on the strength of a figureless background-launch row for the same
agent — a pointer cannot be satisfied by a tally.

## What this script does not decide

It never rules on whether a routing decision was right, whether a verdict was read correctly, whether
an iteration should have been spent, or whether the prose in `last_findings` says anything useful. It
checks that the file means what it appears to mean.
