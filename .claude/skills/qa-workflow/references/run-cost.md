# Run cost — the metrics log

Read this **once per session, before the first delegation**, and again before composing a terminal
return. It is part of the skill: same rules, including the one that no file here names an agent.

Every agent run costs tokens and wall time, and **no agent can report its own**. The numbers come from
outside the conversation: three hooks on the subagent tool record that a run was launched and how it
ended, and the run's bill is summed from the transcript the harness writes for every subagent under
`~/.claude/projects/<slug>/<session_id>/subagents/`. All of it is `.claude/hooks/agent-metrics.mjs`,
registered in `.claude/settings.json`, plus `.claude/hooks/metrics-report.mjs` which finishes what the
hooks could only start.

| Hook | Fires | Records |
|---|---|---|
| `PreToolUse --pre` | at launch | a measured start time, the ticket, the `run_mode:` and `step:` lines, in `.workflow/metrics/pending/` |
| `PostToolUse --post` | on completion — or, for a background agent, on the launch | the row in `.workflow/metrics/<TICKET-ID>.jsonl`. A completed agent's transcript is summed into the row's `billed` block on the spot; a background launch writes `status: background` with the `agent_id` the bill will later be found by |
| `PostToolUseFailure --failed` | on an interrupt, timeout or error | the event and its duration, with no token figures |

The ticket is taken from the prompt, which is why **every delegation must name the ticket id in its
prompt**. Miss it and the run lands in `unassigned.jsonl`. The **mode** and the **step** are taken from
the prompt for the same reason — see *What the numbers are* below.

## Where the bill comes from

Nothing the harness hands a hook describes a whole run: the tool response carries one message's usage
(the final turn's context), and a background launch carries no usage at all. What the harness does
write is the subagent's own transcript — one `usage` per API call, with the input / output / cache-read
/ cache-write split, the cache TTL, the speed and the model on each. Summed over the run that is the
bill. `lib/transcript-usage.mjs` does the sum; `metrics-report.mjs` applies it to every row that lacks
one, so a background run is priced the first time the report runs after it stopped, and a row written
before this measure existed is priced retroactively if its session directory is still on disk.

This is what replaced the `end_context` columns. That block — the final turn's context — is still
recorded under that name for a completed agent, and `--json` still carries it, but it is no longer in
the table and it is never priced as the run.

## The line the orchestrator reads

`--post` emits one `AGENT_RUN_METRICS:` line into the transcript immediately after the agent's own
output, and `metrics-report.mjs <TICKET-ID> --last <agent>` prints the same line for the latest run of
an agent after reconciling it:

```text
AGENT_RUN_METRICS: seq=3 ticket=SCRUM-139 agent=<the agent that just ran> step=1.3 mode=first_run
status=completed model=claude-opus-5 duration=109.0s tokens=247877 cost=$0.73 api_calls=5
tool_uses=8 prompt_chars=1256 log=.workflow/metrics/SCRUM-139.jsonl
```

(The `agent=` field carries a real name in the real line; it is elided here because a reference file
inherits the skill's rule against naming one.)

Treat that line as the last field of the receipt. Two cases:

* **A foreground agent** — the line lands with the receipt and already carries the bill. Echo `step`,
  `mode`, `duration`, `tokens`, `cost` and `tool_uses` in the step summary, and copy `duration_s`,
  `tokens`, `cost_usd`, `tool_uses` **and `metrics_seq` (the `seq=` value)** into the `history` entry
  you were writing anyway. `metrics_seq` is what `WS-W20` checks: a cost figure in `history` has to
  name the row it was copied from.
* **A background agent** — the line lands at the *launch* with `status=background` and
  `tokens=unavailable`, because nothing has been spent yet. When the completion notification arrives,
  run `node .claude/hooks/metrics-report.mjs <TICKET-ID> --last <agent>` and copy from *that* line.
  Do not copy the notification's own `<usage>` block into `history`: its `subagent_tokens` is the
  final turn's context, not the run's bill, and `WS-W20` will refuse it for want of a `metrics_seq`.

## What the numbers are

**`tokens` and `cost` are the run's bill.** Every API call the agent made, summed from its transcript,
at list rates dated in `lib/pricing.mjs`. The model, the cache-write TTL and the speed are read per
call, not assumed. `cost` is list price — no plan, batch or volume discount is applied — and a run on
a model the rate table lacks, or at a non-standard speed, prints `unavailable` with the reason rather
than a guess.

**`api_calls` and `tool_uses` are true counts over the run.** Two regimes show up in them: a step that
makes many cheap calls, and a step that makes few expensive ones. Cache reads dominate the bill — each
call re-reads the whole context — so a long-running, many-tool step costs far more than its output
size suggests, and `tool_uses` tracks the bill closely.

**`mode` and `step` are declared, not inferred.** They come from the `run_mode:` and `step:` lines
every delegation prompt carries. `undeclared` on a mode means the prompt omitted the line — it does
**not** mean the run was a first run, and it must never be read as one. A dash on a step means the
same. `prompt_chars` measures only what the delegation prompt itself weighed; everything a step reads
on its own is in the bill.

Do not aggregate by hand and do not re-print the per-run lines you already echoed — at the end of the
run, render the table with

```bash
node .claude/hooks/metrics-report.mjs <TICKET-ID>
```

which prints one row per run **in log order**, an `n/N` run counter per agent so a three-iteration
review loop reads as three rows, a `Σ` total, and the wall clock of the latest session. The wall clock
is shorter than the sum of durations whenever the parallel pairs of Phase 2 ran together; that gap is
the parallelism, not an error. `--detail` adds the in / out / cache-read / cache-write columns;
`--json` carries everything.

**The report is printed whole or not at all.** The column names are its first two lines, so piping it
through `tail`, `grep` or any other filter strips the header and leaves a table of unlabelled numbers
that reads as something it is not. Run the command bare and quote from what it printed. The footnotes
under the table are part of it: each names a class of row that contributed nothing to `Σ` and how many
there were.

## What is not priced, and is counted instead

Three kinds of row have no bill, each with its own footnote, and no row lands in two of them:

* **Interrupted.** The harness caught the interrupt (`--failed`) or a launch record was never
  completed and no transcript exists. Duration where one was measured; no tokens. A partial sum
  presented as the run's cost would be a different number wearing its clothes.
* **Unobserved.** A background run whose session directory is not on this machine. The cost existed
  and is not recoverable from here.
* **Legacy.** A row written before the transcript measure, with no session id to find a transcript by.
  It carries only its final-turn `end_context`, contributes duration and tool count to `Σ`, and is
  never priced into the `Cost` column.

An **incomplete** run — a background agent whose transcript ends mid-run — *is* priced, for what ran,
and its status says so. The tokens were billed; only the run did not finish.

## The two rules

* **Never invent, estimate or extrapolate a number, and never relabel one.** A missing
  `AGENT_RUN_METRICS` line means the hook is not installed or the run predates it — say
  `metrics unavailable`, never a plausible figure. If the run is in the log but the figure is a dash,
  the dash is the answer. And a final-turn context is reported as `end_context` if it is reported at
  all: calling it the run's cost, or summing it into a total described as one, is inventing a number
  out of a real one.
* **Cost is a report, never a routing input.** An expensive stream is not thereby a failing one, and
  no iteration is skipped, no review shortened and no cap lowered because the bill looked high.
  Routing reads verdicts only.

Both survive as one-line rules in `SKILL.md` as well. They are the two that cost something real when
forgotten, so they are stated in the place that is always loaded and again in the place that explains
them.
