---
name: slack-bug-triage
description: >-
  Triages a Slack bug-reports channel into Jira. Reads the channel, claims each new message, drafts a
  bug from it, checks SCRUM for an existing ticket, then either files a new bug or points the reporter
  at the one that already exists — replying in thread and marking the message every time. Manual mode
  asks before each ticket; auto mode routes on the duplicate verdict under a hard cap. Use when asked to
  "triage the bug reports", "check the bug channel", "file the Slack bugs", "run the bug triage", or
  "/slack-bug-triage".
argument-hint: "[--channel <id>] [--auto] [--since <7d|iso>] [--max-messages N] [--max-files N] [--dry-run] [--resume]"
---

# Slack bug triage — the triage orchestrator

You run on the main thread, so you can ask the user questions and you can invoke skills. The agents you
delegate to can do neither.

**This is the only file in the repository that names one triage agent next to another.** Every one of them
is a pure function of its parameters and the files on disk; none knows the others exist, none emits a
`NEXT:` line, and none may be given a routing hint. Routing lives here.

You own three things and nothing else owns any of them: the ledger at `.slack-triage/journal.jsonl`, the
per-message routing decisions, and the caps. You never decide whether a message is a bug, whether it
duplicates a ticket, or what a reply should say — those belong to the steps below, and reading their output
is the whole of your job.

## Inputs

`snake_case` throughout.

| Parameter | Required | Form | If absent |
|---|---|---|---|
| `channel_id` | yes | a Slack channel id (`C…`), or a `#name` to resolve once | `$SLACK_TRIAGE_CHANNEL_ID`; if that is unset, stop and ask — never guess a channel |
| `mode` | no | `manual` \| `auto` (`--auto` sets `auto`) | `manual` |
| `since` | no | `7d`, `30d`, or an ISO date | `7d` |
| `max_messages` | no | integer >= 1; messages the channel read returns | `25` |
| `max_triage` | no | integer >= 1; messages this run actually triages | `5` |
| `max_files` | no | integer >= 0; tickets one run may create | `5` |
| `detection_phase` | no | `Development` \| `Production` | `Production` |
| `version_label` | no | free text | `unspecified — reported via Slack` |
| `default_priority` | no | `Highest` … `Lowest` | `Medium` |
| `lease_minutes` | no | integer >= 1 | `30` |
| `max_candidates` | no | integer >= 1 | `10` |
| `self_user_id` | no | Slack user id this workflow posts as | `$SLACK_TRIAGE_SELF_USER_ID`; if unset, stop — without it the run files tickets about its own replies |
| `dry_run` | no | `true` / `false` | `false` |
| `resume` | no | `true` / `false` | `false` |
| `include_escalated` | no | `true` / `false` | `false` |
| `include_skipped` | no | `true` / `false` | `false` |
| `allow_backfill` | no | `true` / `false` | `false` |

`since` older than 30 days without `allow_backfill` -> stop and say so. A first run over a year of chat
posts hundreds of questions at once, and nobody meant to do that.

**`max_messages` and `max_triage` are different caps and neither substitutes for the other.**
`max_messages` bounds what the channel read returns; the step that reads the channel holds no ledger tool
and cannot tell a handled message from an untouched one, so a cap applied there returns the *same* oldest
messages every run — all of them already terminal — and the backlog behind them is never reached.
`max_triage` is applied after the skip filter, on untracked work only, which is what makes running the
command again walk forward instead of re-offering the same batch. Lower `max_triage` for a shorter run;
`max_messages` stays where it is.

### The run-parameters banner

Printed after the ledger is read and **before the first delegation**, in both modes, on a fresh run and on
every resume. Three columns: parameter, resolved value, source.

| Source | Means |
|---|---|
| `request` | this invocation set it — a flag, or a named value in the prompt |
| `env` | read from the environment |
| `default` | nobody set it; the `If absent` column applies |

That is also the precedence order. Most values are defaults nobody chose, and on a resume the ones that
matter came out of an invocation nobody still has.

```
Slack bug triage — BUGTRIAGE-20260824-01

  channel_id                    C08ABCD1234               env
  mode                          manual                    default
  since                         7d                        default
  max_messages                  25                        default
  max_triage                    5                         default
  max_files                     5                         default
  detection_phase               Production                default
  version_label                 unspecified — reported via Slack   default
  default_priority              Medium                    default
  lease_minutes                 30                        default
  max_candidates                10                        default
  self_user_id                  U0BOT1234                 env
  dry_run                       no                        default
  resume                        no                        default

  Non-default settings this run:
  - None.
```

Every row appears even when unset — `—` is a value, a missing row is not. `Non-default settings this run:`
says what each non-default value **changes in behavioural terms**, and reads `- None.` when clean:

- `mode: auto` — **bugs are filed in SCRUM with no preview and no approval.** At most `max_files` of them.
- `max_files: 0` — nothing will be filed; duplicates and questions still post.
- `max_triage` above its default — more messages triaged in one pass, so more thread replies and, in auto
  mode, more tickets before a human next looks. It changes how much one run takes on, never what it decides.
- `include_escalated` / `include_skipped` — messages a human already set aside come back into scope.
- `dry_run: true` — nothing is written to Slack, Jira or the ledger.

Print it, do not store it.

## Step 0 — Resolve and load

1. Resolve the run id: `BUGTRIAGE-<YYYYMMDD>-<NN>`, `NN` starting at `01` and incrementing for a second run
   the same day. **It matches `[A-Z][A-Z0-9]+-\d+`, which is what makes the run's cost land under its own
   name rather than under whatever ticket happens to be open.**
2. `Read` `${CLAUDE_PLUGIN_ROOT}/skills/slack-bug-triage/references/run-shape.md` and `${CLAUDE_PLUGIN_ROOT}/skills/slack-bug-triage/references/slack-mcp.md`. Both, in full, once per session.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" validate` — a ledger that does not parse stops the run before it
   can write to it.
4. Create `.slack-triage/runs/<run_id>/`.
5. Print the banner.

## The ledger

`.slack-triage/journal.jsonl`, and `${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs` is the only thing that may write it.
Never hand-edit it, and never decide by eye what is still in scope.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" plan   --intake <p> --reactions-readable <yes|no> \
                                             --run-id <ID> --lease-minutes <n> --limit <max_triage> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" claim  --intake <p> --run-id <ID> --lease-minutes <n> \
                                             --limit <max_triage>
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" record --channel <C> --ts <ts> --state <s> [...]
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" get    --channel <C> --ts <ts> --json
```

`plan` returns one row per message with `in_scope` and a `reason`. **Route on those rows.** The reasons are
`new`, `resume`, `lease_expired`, `retry_after_failure`, `thin_answered`, `reacted_elsewhere`,
`claimed_by_live_run`, `thin_unanswered`, `awaiting_human`, `previously_declined`, `deferred_over_limit`
and `terminal`.

`--limit` is `max_triage`, and it goes to **both** commands or neither. It caps how many messages the run
works, keeping the oldest ones nobody has handled; rows beyond it come back as `deferred_over_limit`
rather than disappearing. Claiming more than the run will work would strand the surplus under a lease
nobody is holding on purpose, so the two calls take the same value.

`claim` exiting `4` means another run holds a live lease. That is not a failure to work around — stop, and
say which run holds it.

## Step registry

| Step | Agent | Parameters passed | Receipt line to parse | Produces |
|---|---|---|---|---|
| 1 | `slack-bug-triage:triage-slack-collector` | `run_id`, `channel_id`, `intake_path`, `self_user_id`, `since`, `max_messages` | `TRIAGE_SLACK_COLLECTOR_RESULT`, `REACTIONS_READABLE`, `INTAKE_PATH`, `PAGINATION` | `runs/<run_id>/intake.json` |
| 2 | `slack-bug-triage:triage-slack-responder` | `run_id`, `channel_id`, `messages` (every in-scope ts), `add_reactions: eyes` | `TRIAGE_SLACK_RESPONDER_RESULT`, `MARKED`, `NOT_ATTEMPTED`, `RESULTS` | the claim marks |
| 3 | `slack-bug-triage:triage-bug-drafter` | `run_id`, `intake_path`, `run_dir`, `detection_phase`, `version_label`, `default_priority` | `TRIAGE_BUG_DRAFTER_RESULT`, `READY`, `THIN`, `THIN_MESSAGES`, `DRAFTS_INDEX` | `runs/<run_id>/drafts-index.json` + per-message drafts |
| 4 | `slack-bug-triage:triage-duplicate-scout` | `run_id`, `drafts_index`, `verdicts_path`, `max_candidates` | `TRIAGE_DUPLICATE_SCOUT_RESULT`, `VERDICTS`, `JQL_ZERO_RESULT` | `runs/<run_id>/verdicts.json` |
| 5 | `slack-bug-triage:triage-bug-filer` | `run_id`, `draft_path`, `message_ts`, `channel_id`, `idempotency_label` | `TRIAGE_BUG_FILER_RESULT`, `BUG_KEY`, `BUG_URL`, `DETECTION_PHASE` | one SCRUM bug |
| 6 | `slack-bug-triage:triage-slack-responder` | `run_id`, `channel_id`, `message_ts`, `reply_text`, `add_reactions`, `remove_reactions` | `TRIAGE_SLACK_RESPONDER_RESULT`, `REPLY_TS`, `REACTIONS_ADDED` | the thread reply + terminal mark |

The names are namespaced because these five agents ship inside this plugin: `subagent_type` takes
`slack-bug-triage:triage-…`, not the bare slug. A project that also carries its own `triage-*` agent files
has two sets, and the bare slug reaches that project’s copy rather than this one.

Every delegation prompt carries, **as its first line**, `run_id: BUGTRIAGE-…`, then a `run_mode:` line.

The first-line rule is not style. Cost is filed against the first `[A-Z][A-Z0-9]+-\d+` in the prompt, and
steps 4, 5 and 6 all carry `SCRUM-` keys in their parameters. A key that appears before the run id files
the whole run's cost against somebody else's ticket, silently, and the receipt looks correct.

`run_mode:` takes only the existing vocabulary — `first_run`, `EXISTS`, `revision`. A `thin_answered` retry
is `revision`; a message whose ledger row is terminal is `EXISTS`.

Pass **artifact paths, never conversation history**. Every agent re-reads from disk.

## Reading a receipt

| Receipt value | Outcome | Meaning |
|---|---|---|
| `OK` | `advance` | step done |
| `EXISTS` | `already_done` | record it, advance, **do not re-run** |
| `PARTIAL` | `advance_with_gap` | record the gap, advance, never re-run blind |
| `ABORT`, `BLOCKED` | `escalate` | stop and report the code |

A `PARTIAL` from step 1 means the window was not covered: record the oldest ts reached and **never treat
the uncovered remainder as handled**. A `PARTIAL` from step 4 means some messages have no verdict, and a
message with no verdict is **never** routed as `new`.

## The run

### Barrier 1 — read the channel

Delegate step 1. Take `REACTIONS_READABLE` off the receipt and carry it into every `plan` call this run.
Never carry it over from a previous run or a document.

`COLLECTED: 0` -> there is nothing to do. Go to the return block.

### Barrier 1b — plan and claim

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" plan  --intake <p> --reactions-readable <v> --run-id <ID> \
                                            --limit <max_triage> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" claim --intake <p> --run-id <ID> --lease-minutes <n> \
                                            --limit <max_triage>
```

Pass `--limit` to both, always the same value. `plan` and `claim` compute the capped set the same way, so
the messages claimed are exactly the messages the run will work.

Print the partition — every message, in scope or not, with its reason. A run that silently drops messages
is indistinguishable from a run that had none, and a `deferred_over_limit` row is precisely a message this
run is choosing not to reach: say how many, and say that running the command again picks them up.

Nothing in scope -> the return block.

### Barrier 2 — claim marks

**One step-2 delegation for the whole in-scope set**, passing every claimed `message_ts` as `messages` and
adding `eyes`. One delegation, not one per message: marking a message is a single API call, and a whole
subagent launch per call costs more than every other read-only step in the run put together. The marks are
still applied one at a time inside that delegation — the channel's reaction endpoint takes roughly one call
a second, so this is batching, never fan-out.

A `SLACK_WRITE_FORBIDDEN` here **stops the whole run** — it means the token can read the channel and cannot
write to it, and discovering that after filing five tickets nobody can be told about is the worst available
outcome. The probe makes that failure arrive on the first call, with nothing marked.

Read `MARKED` and `NOT_ATTEMPTED` off the receipt. A `PARTIAL` here does not stop the run: a message whose
mark did not land is still claimed in the ledger, which is the state that matters, and the mark is
decoration. Carry every `NOT_ATTEMPTED` and `failed` ts into **Left for a human**.

Skip this barrier entirely on a `dry_run`.

### Barrier 3 — draft

Delegate step 3 for the in-scope messages. Record every `THIN_MESSAGES` entry:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" record --channel <C> --ts <ts> --state thin --missing <fields>
```

Thin messages leave the pipeline here. They are answered in barrier 5 with the question template, and they
are not searched, not filed and not counted against `max_files`.

### Barrier 4 — duplicate search

Delegate step 4 over the `ready` drafts. Nothing ready -> skip to barrier 5.

### Per message — decide, file, record, respond

Strictly sequential. Per message, in intake order:

1. **Decide** — manual mode asks; auto mode routes on the verdict (below).
2. **File**, on the create path only, and only while `filed_count < max_files`. At the cap, record
   `escalated` with the reason and stop filing for the rest of the run; keep responding to duplicates and
   thin reports.
3. **Record**, before any Slack write:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" record --channel <C> --ts <ts> --state filed --jira-key <KEY>
   ```
4. **Respond** — step 6, with the rendered template and the marks.
5. **Record again** — `--reply-ts <ts> --reaction <name>`, so a resume can finish whichever half failed.

Ordering is not a preference. A crash between the create and the record refiles the bug; a crash between
the record and the reply loses only a reply, which the next run posts.

Replies come from `${CLAUDE_PLUGIN_ROOT}/skills/slack-bug-triage/assets/`, rendered by substitution and posted verbatim: `filed-reply.template.md`,
`duplicate-reply.template.md`, `thin-report-reply.template.md`. Every one ends with `_(automated triage)_`,
which is how the next run's channel read knows not to file a ticket about it. **Never edit that line out,
and never compose a reply by hand.**

| Outcome | Ledger state | Reply | Marks added | Marks removed |
|---|---|---|---|---|
| filed | `filed` + key | filed template | `white_check_mark` | `question`, if it was there |
| duplicate at high confidence | `duplicate` + key + band | duplicate template | `bulb` | — |
| duplicate at medium or low | `escalated` | none | — | — |
| already filed | `filed` + the found key | filed template | `white_check_mark` | `question`, if it was there |
| thin | `thin` + missing fields | question template | `question` | — |
| skipped / declined | `skipped` / `declined` | none | — | — |
| step errored | `failed` + the error | none | — | — |

## Manual mode — the default

After barrier 4, one `AskUserQuestion` per message, showing the drafted summary, the priority, the
detection phase, the verdict with its band and its justification, and the reply that would be posted.

Options, in order: **Create** (recommended when the verdict is `new`) · **Mark duplicate** (recommended
when the verdict is `duplicate`, naming the key) · **Skip this one** · **Decline the rest of the run**.

Decline is present on every question, always last, no exception.

No cap applies in manual mode — a human approving each ticket is a better cap than a number.

## Auto mode — `--auto`

No questions between messages. Route on the verdict:

| Verdict | Route |
|---|---|
| `new` | file, while under `max_files` |
| `already_filed` | respond with the found key; does not count against `max_files` |
| `duplicate`, `high` | reply and mark `bulb` |
| `duplicate`, `medium` or `low` | **escalate** — no reply, no ticket, claim mark left on |
| no verdict | escalate |

A wrong `high` buries a real bug under an unrelated ticket where nobody looks again, so `medium` and `low`
are not close enough. Print the relaxed-gate line at the banner **and** again at the point it fires: why a
run did *not* stop is the one thing nobody can reconstruct afterwards.

## Declining

Every `AskUserQuestion` in both modes carries a Decline option, listed last. On Decline: record the
remaining in-scope messages as `declined`, leave every mark as it stands, and go to the return block. A
declined run is a finished run, not a failure.

## Dry run — `--dry-run`

Touches neither Slack nor Jira nor the real ledger.

- Step 1 is delegated only if `--intake-fixture` was not supplied; with a fixture, that file *is* the
  intake and the collector is skipped.
- `plan` runs for real against a **temp ledger** (`--journal <tmp>`).
- Step 3 is delegated for real — it holds no MCP grant, so it cannot reach anything it should not.
- Steps 2, 4, 5 and 6 are **not** delegated. Print, per message: the JQL that would have run, the
  `createPayload` that would have been sent, and every Slack write that would have been made — channel,
  `thread_ts`, emoji, and the rendered reply body.

That exercises the intake contract, the whole skip filter, the whole drafting path, both templates and
every routing decision. Only four MCP calls go untested.

## Return

```
SLACK_BUG_TRIAGE_RESULT: OK | PARTIAL | DECLINED | ABORT
RUN_ID: BUGTRIAGE-20260824-01
CHANNEL: C08ABCD1234
MODE: manual | auto | dry_run
REACTIONS_READABLE: yes | no
COLLECTED: 12
IN_SCOPE: 5
DEFERRED: 4 (over the max_triage cap of 5)
FILED: 2 (SCRUM-214, SCRUM-215)
DUPLICATES: 1 (SCRUM-167)
THIN: 1
ESCALATED: 1
SKIPPED: 0
FAILED: 0
LEDGER: .slack-triage/journal.jsonl
NEXT_ACTION: <one line, or "none">
```

Then two sections, always:

**Artifacts produced** — the intake file, the drafts index, the verdicts file, and every ticket created
with its URL.

**Left for a human** — every escalated message with its reason and permalink, every failure, every claim
mark reported `failed` or `not_attempted`, and — when `REACTIONS_READABLE` is `no` — one line saying that a
hand-marked message was not honoured on this run. That sentence is not optional. It is the only place the
missing guarantee is visible.

A `DEFERRED` count does **not** belong here. Those messages are waiting, not stuck, and the next run takes
them without anybody doing anything.

## Must not

- Add a routing hint, a `NEXT:` line, or another agent's name to any file under `${CLAUDE_PLUGIN_ROOT}/agents/`. Routing
  lives here.
- Hand-write, hand-edit or hand-repair `.slack-triage/journal.jsonl`. One script writes it.
- Decide by eye which messages are still in scope. `plan` answers that, and counting by hand is the one
  thing it exists to stop.
- Route on an emoji. Marks may be write-only; the ledger is the state.
- Carry `REACTIONS_READABLE` over from a previous run, a parameter or a document, or report `yes` when the
  receipt said `no`.
- Describe the hand-marked-message guarantee as holding on a run whose receipt says reactions are not
  readable, or leave that line out of the return block.
- Post a Slack write before the ledger record that explains it.
- Compose a reply by hand, edit a template's wording, or strip the `_(automated triage)_` line.
- Run the per-message tail in parallel, or delegate two drafting steps at once. The draft builder writes
  one fixed path and the second bug gets the first bug's steps.
- Delegate barrier 2 once per message. It is one delegation carrying every ts, and the marks go on one at
  a time inside it — batching, never fan-out. Marking messages concurrently earns a rate limit, and the
  responding step is required to stop after one retry rather than loop.
- Pass `--limit` to `plan` and not to `claim`, or a different value to each. The surplus is then leased by
  a run that will never work it, and stays leased until the lease expires.
- Present a `deferred_over_limit` message as handled, escalated or failed. It is untouched work the next
  run picks up, and nothing about it needs a human.
- Run `/jira-bug-creator` by hand while a triage run is in flight, for the same reason.
- File in auto mode past `max_files`, or raise the cap to get a backlog through.
- Act on a `medium` or `low` duplicate verdict in auto mode, or treat a message with no verdict as `new`.
- Treat a `PARTIAL` channel read as complete, or a thin report as a failure.
- Ask a reporter the same question twice. If the ledger says `thin_unanswered`, the message is out of
  scope and nothing is posted.
- Continue after `SLACK_WRITE_FORBIDDEN`. Tickets nobody can be told about are worse than no tickets.
- Continue after `claim` exits 4. Another run holds those messages.
- Omit `run_id:` from the first line of a delegation prompt, or let a `SCRUM-` key precede it.
- Write to Slack, Jira or the real ledger on a `dry_run`.
- Triage a second channel, widen `since` past 30 days without `allow_backfill`, or raise `max_messages`
  because the channel looked busy.
