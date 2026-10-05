# Steps 3 and 4 — ship, then hand back

Read this **on reaching phase `ship`**, before the step 3 delegation. It is part of the skill: same
rules, including the one that no file here names an agent — the step registry in `SKILL.md` names who
runs step 3 and step 4, and this file speaks only of the steps.

## Step 3 — Ship

The git workflow runs in both modes, and it is followed by step 4 whenever it produced a pull
request.

Delegate step 3 with `ticket_id`, `api_review`, `ui_review`, and any `branch_name`, `base_branch` or
`dry_run`. It runs its five-condition gate against the files on disk, composes the branch name, the
commit message and the PR body from the two implementation reports and the test design, and then
delegates all four git phases — branch, commit, push, pull request — to the git workflow
orchestration named in its own body (agent-driven path, section A).

That orchestration is what creates the branch, commits, pushes and opens the PR. Step 3 supplies the
gate and the naming. **Do not reach around step 3** to the git skills or to raw `git`: the gate reads
the reports rather than trusting a caller's claim that both reviews passed, and skipping it removes
the one check that a claimed review actually happened.

**Auto mode does not remove the human confirmations in the ship phase.** There are exactly two and
both now live **inside step 3, before any git command runs**: an explicit `OK` on the composed commit
message and the list of paths it will stage, and — only when `gh pr list` finds one — whether to open
a second pull request for this ticket. Auto mode automates agent-to-agent routing only; the
irreversible git actions keep their confirmation, so an auto run pauses at least once near the end, by
design.

They moved forward rather than away. The git phases used to ask mid-run, which meant the branch
already existed by the time anyone was asked about the commit. Asking first is what lets the four
phases then run as one non-interactive command — and it is also why the confirmations are not
optional there: the script is quiet because a person already answered, not because nobody asks.

`skip_ship` stops after the final decision. `dry_run` passes through, and step 3 stops after
composition having run no git command.

Record `pull_request` from the receipt's `PR_URL`, then go to step 4. The run is not done at the pull
request — the ticket still says `In Progress`.

## Step 4 — Hand back to Jira

A pull request that nobody linked to the ticket is invisible to everyone who works from the board.
The last step puts it back where the run started: delegate step 4 with `ticket_id`, the `pr_url` from
step 3, the `branch_name` and `scenarios` off the ship receipt, and `jira_target_status` as
`target_status`.

**`target_status` is required by that step and defaulted here.** It moves a ticket to whatever status
its caller names and refuses to pick one itself, so `In Review` is *this skill's* default (the
`jira_target_status` input, recorded in `configuration`), never the step's own. Always pass it
explicitly — an omitted `target_status` aborts `NO_TARGET_STATUS` and nothing happens.

Run it when **all** of these hold, and skip it silently otherwise:

* Step 3 returned `OK` with `pr=SUCCESS`, and
* `PR_URL` is a real URL — not `none`, not empty, and
* `dry_run` and `skip_jira_handback` are both unset.

Never synthesise the URL, never pass a URL from another ticket's run, and never hand back after a
`dry_run` — step 4 aborts `INVALID_PR_URL` on a placeholder anyway, but arriving there is a wasted
delegation and a confusing receipt.

Route the outcome:

| Receipt | State written | Then |
|---|---|---|
| `OK` | `jira.status` from the receipt's observed status, `handback_status: done`, `comment` from the receipt | `phase: done`, `status: completed` |
| `EXISTS` | `handback_status: done`, `comment: already_present` | same — the ticket was already linked and moved |
| `PARTIAL` | `handback_status: partial`, plus what did not happen | `phase: done`, `status: completed`, and `NEXT_ACTION` names the half a human must finish |
| `ABORT` | `handback_status: failed` with the code | `phase: done`, `status: completed` — see below |

**A failed hand-back does not fail the run.** The tests are written, reviewed and pushed; the pull
request exists. A Jira status is a bookkeeping fact about work that already shipped, so record the
failure, put the manual step in `NEXT_ACTION` — "move SCRUM-139 to In Review by hand; PR is `<url>`"
— and still return `OK` for the workflow. Do not retry the step in a loop, and do not roll back or
close the pull request.

**Both modes run step 4, and it needs no confirmation in either.** It is reversible in one click on
the board, unlike every git phase before it. Manual mode still prints the step and its receipt like
any other.

`skip_jira_handback` is for a re-run over a ticket already moved by hand, or a demo that must not
touch Jira. Say in the summary that it was skipped, so nobody reads a silent absence as a success.
