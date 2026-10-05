# The terminal return, and declining

Read this **exactly once, when the run is about to end** — on `OK`, `ESCALATED`, `BLOCKED`, `PAUSED`
and `DECLINED` alike, and before offering any question that carries a Decline option. It is part of
the skill: same rules, including the one that no file here names an agent.

## Declining — the option that must always be on the table

**Every `AskUserQuestion` this skill asks carries a Decline option, in both modes, without
exception.** List it last, after Pause. A question with no way out is not a question; it is a prompt
to pick which way to proceed, and a user who wants none of the offered paths is left with nothing to
click.

A decline is not an error and not an escalation. It is the user saying *stop here, this is far
enough*, and it is a legitimate end state for a run.

On a decline:

1. Persist `status: declined`, `final_decision: decline`, and fill in `declined:` — the step you were
   standing on, the question you asked, and the user's reason **in their own words**, or the literal
   string `no reason given` when they gave none. Never invent a reason on their behalf.
2. Change nothing else. Do not roll back an artifact, do not delete a branch, do not revert a Jira
   transition, do not re-run the step to "leave things tidy". Everything produced before the decline
   stays exactly as it is — a declined run's artifacts are still work product, and the user may
   resume from them with `/qa-workflow <TICKET-ID>` at any time.
3. Return `QA_WORKFLOW_RESULT: DECLINED` with **the full receipt block and both trailing sections**,
   exactly as any other terminal return. `NEXT_ACTION` names what was left undone and how to resume.

That last point is the one that matters. A run that stopped early still spent the tokens, still took
the wall clock, and still left files on disk — so a decline reports *more* carefully, not less.
Silently returning "cancelled" throws away the entire record of what the run produced and what it
cost, which is precisely the information the user needs in order to decide whether to resume, restart
or abandon.

All three now have a mechanism. **Resume** is `/qa-workflow <TICKET-ID>`; **restart** is the same
with `--reset`, which archives every artifact by rename and starts again at step 0. Naming it is part
of the return, because a user who has just read a cost report is exactly the user deciding between
them. A reset is never a decline's remedy and never follows one automatically — it is a separate
request, made later, and the declined document is what it would archive.

**Auto mode declines too.** It asks no routing questions, but the ship phase's git confirmations reach
the user directly, and a user who declines a commit, a push or a pull request there has declined the
run's remaining work. Record it the same way, with `at_step: "3"`, and return `DECLINED` — never
treat a declined git confirmation as a phase failure, and never retry it in a loop hoping for a
different answer.

## The return block

```text
QA_WORKFLOW_RESULT: OK | ESCALATED | BLOCKED | PAUSED | DECLINED
TICKET: SCRUM-139
MODE: manual | auto
PHASE: test_design | test_automation | ship | done
STATE: .workflow/SCRUM-139.yaml
REQUIREMENTS: requirements/SCRUM-139-requirements.md
TEST_DESIGN: test-design/SCRUM-139-test-design.md
DESIGN_REVIEW: Pass | Needs Revision | Blocked | pending   ITERATIONS: 1/2
API: implemented=SCN-012,SCN-014 review=Pass iterations=1/2
UI: implemented=SCN-021 review=Pass iterations=0/2
PR_URL: <url or "none">
JIRA: In Progress -> In Review   COMMENT: added | already_present | skipped
FOLLOW_UP: <ids or "none">
OUTSTANDING_FINDINGS: <ids or "none">
NEXT_ACTION: <what a human must do, or "none">
NOTES: <one line, or "none">
AGENT_RUNS: 9   TOKENS: 412,908   AGENT_TIME: 731.4s   WALL_CLOCK: 512.0s
METRICS: .workflow/metrics/SCRUM-139.jsonl
```

On `ESCALATED` or `BLOCKED`, `NEXT_ACTION` is the point of the whole block — name the decision, not
the symptom. On `DECLINED`, add a `DECLINED_AT:` line naming the step and the question, and let
`NEXT_ACTION` say how to resume.

## The two sections after it

The receipt block is followed by two sections, in this order, on **every** terminal return. A run
that stopped early still cost what it cost and still left files behind; that is exactly when a human
needs to see both. **A declined or interrupted run reports its statistics just like a completed one**
— dropping them because the run did not finish destroys the only record of what was spent and
produced.

1. **Artifacts produced** — every path this run created or modified, grouped and each marked with the
   step that produced it and whether it was written this run or already existed: the requirements
   document, the test design, both implementation reports, every file listed in
   `automation.<stream>.created_tests`, the state file, the metrics log. Paths only, no summaries of
   their contents.
2. **Agent run cost** — the verbatim output of `node .claude/hooks/metrics-report.mjs <TICKET-ID>`,
   run from the project root. One row per run in log order, so the second and third pass of a review
   loop appear as their own rows against the same agent, then the `Σ` total, then the footnotes that
   say which rows contributed nothing to it and why. Print what the script returns; do not reformat,
   re-sum or trim it. `TOKENS:` in the receipt block above is that table's `Σ` tokens — the run's
   bill — and `AGENT_TIME:` its `Σ` duration; when the table prints a dash for either, the receipt
   says `unavailable`.

If the metrics log is missing, print `Agent run cost: metrics unavailable (hook not installed for
this run)` and nothing else under that heading. Never fill the gap with an estimate — see
`references/run-cost.md`.
