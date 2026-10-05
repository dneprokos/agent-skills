# Run shape — the per-message state machine and the resume rules

**Read this before the first delegation of a session, and again on any resume.** It is part of the skill:
same rules, including the one that no file here names an agent.

---

## 1. The shape of a run

```
barrier 1   read the channel          1 delegation, whole window      -> intake.json
            plan + claim              script, all N rows at once      -> a lease per row
                                      --limit caps N at max_triage, oldest untracked first
barrier 2   claim marks               1 delegation, N x eyes, serial inside
barrier 3   draft                     1 delegation, N drafts, serial  -> drafts-index.json
barrier 4   duplicate search          1 delegation, N searches        -> verdicts.json
--- per message, strictly sequential -----------------------------------
            [manual] one question: Create / Mark duplicate / Skip / Decline
            file                      only on the create path
            journal record            state + jira_key  <- BEFORE any Slack write
            respond                   reply + terminal mark
            journal record            reply_ts + reactions_applied
```

Three read-only barriers, then a per-message tail. The reading steps each have one uniform failure mode —
an auth failure, a parser failure, a query failure — and produce data rather than side effects, so batching
them costs three subagent launches instead of 3N and loses nothing: a failure in any of them fails the
whole run regardless. The last two are per message because each acts irreversibly on an external system,
and the blast radius of a crash has to be one message.

Barrier 2 writes, and batches anyway. Its blast radius is already the smallest there is — a reaction is one
call, reversible, and carries no meaning the ledger does not already hold — while a whole subagent launch
per single API call is the most expensive thing in the run for the least work done. **Batching is not
parallelism**: the marks still go on one at a time inside that one delegation, because the endpoint takes
about one call a second and the responding step is required to stop after a single retry rather than loop.

**Nothing in the tail runs in parallel**, for three independent reasons, any one of which is sufficient:

1. The draft builder writes one fixed path, `.jira-bug/draft.json`, and overwrites it every invocation.
2. Slack's reaction and message endpoints are rate limited to roughly one call per second per channel.
3. Manual mode puts a human in the loop per message, so the human is the serialiser anyway.

## 2. Journal before Slack, always

The record of what happened to a message is written **after** Jira and **before** Slack.

A crash between the Jira create and the journal write would leave a ticket nobody knows about, and the next
run refiles it. A crash between the journal write and the Slack reply loses only the reply, and the resume
finishes it. One of those is recoverable and the other is not, so the ordering is not a preference.

The reply and the reactions are recorded as **separate fields**. A response that posted the reply and
failed the reaction must be finishable without posting a second reply, and a single `responded: true`
boolean makes the double-reply inevitable.

## 3. The per-message state machine

| From | On | To |
|---|---|---|
| (none) | claimed at the start of a run | `claimed` |
| `claimed` | verdict `new`, ticket created | `filed` **(terminal)** |
| `claimed` | verdict `duplicate` at high confidence | `duplicate` **(terminal)** |
| `claimed` | verdict `duplicate` at medium or low confidence | `escalated` |
| `claimed` | verdict `already_filed` | `filed`, with the key that was found |
| `claimed` | draft came back thin | `thin` |
| `claimed` | a human chose Skip or Decline | `skipped` / `declined` |
| `claimed` | anything errored | `failed` |
| `thin` | the message was edited, or a newer reply landed | back into scope, re-drafted |
| `failed` | the next run | back into scope |
| `escalated` | only when a run is asked for it by name | back into scope |

`filed` and `duplicate` are terminal and the journal script refuses to overwrite them with a different
outcome. Everything else is a waypoint.

An escalation is a **finished outcome**, not a failure. It leaves the claim mark on, posts nothing, and
files nothing.

## 4. The marks

| Mark | Means | Set when |
|---|---|---|
| eyes | claimed by a run | at barrier 2, before any drafting |
| white_check_mark | a ticket exists for this | after `filed` is journaled |
| bulb | pointed at an existing ticket | after `duplicate` is journaled |
| question | waiting on the reporter | after `thin` is journaled |

The question mark is removed when the report is finally filed; the claim mark is left in place, because it
is true and because removing it costs a call that can fail.

**The marks are decoration, not state.** They may be write-only — see §6 — so nothing routes on them.

## 5. What makes a message new

Decided by `node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-triage-journal.mjs" plan`, never by reading the table above and judging. The
script folds the ledger by `(channel, message_ts)`, takes the last record, and prints one row per message
with a reason. The reasons are `new`, `resume`, `lease_expired`, `retry_after_failure`, `thin_answered`,
`reacted_elsewhere`, `claimed_by_live_run`, `thin_unanswered`, `awaiting_human`, `previously_declined`,
`deferred_over_limit` and `terminal`.

Run it, read the rows, route on them. Counting them by hand is the one thing this script exists to stop.

`deferred_over_limit` is the only one of them that says nothing about the message. The other ten are
properties of the message and its history; this one is a property of **this run's budget**, and the same
message is `new` on the next run without anything about it having changed. It is reported rather than
dropped for that reason — a message left out by a cap and a message ruled out on its merits look identical
in a count and need opposite things from a reader.

## 6. Reactions may be unreadable, and the run says which

The channel-reading step reports `REACTIONS_READABLE: yes | no`, resolved from the response it actually
received on this run.

- `yes` — a message somebody marked by hand is excluded, as `reacted_elsewhere`.
- `no` — that exclusion cannot fire. A human who hand-marked a message will not be honoured, and a ticket
  may be filed for a bug somebody already handled.

There is no way around this on a server whose read tools omit reactions. The honest mitigation is that the
banner and the receipt both say `no` on every such run, and that the window is bounded. **Do not describe
the guarantee as holding when the receipt says it does not.**

Pass the value straight into `plan --reactions-readable <value>`. Never carry it over from a previous run,
a parameter or a document — a server that starts returning reactions makes the rule switch itself on, and
only a per-run answer can notice.

## 7. Resuming

A resume is the same command again. Step 0 folds the journal and the script partitions the channel; rows
already terminal drop out, rows this run claimed come back as `resume`, rows a dead run claimed come back
once their lease expires (default 30 minutes).

Three things make a resume safe, and all three are needed:

1. **The lease** — a run that died releases its messages by expiry, not by cleanup, because a write-only
   reaction cannot be taken back.
2. **The label search** — the filing step's first act is a Jira search on the message's idempotency label,
   so a ticket created just before a crash is found rather than duplicated. This survives a lost ledger.
3. **The separate reply and reaction fields** — so the half that landed is not repeated.

A resumed run re-appends its history rows; that is expected, and the ledger folds them.

## 8. What a partial receipt means

| Receipt | Meaning | What the run does |
|---|---|---|
| channel read `PARTIAL` | the window was not fully covered | record the oldest ts reached; do not treat the rest as handled |
| drafting `PARTIAL` | some messages failed to draft | those go to `failed`, and are retried next run |
| duplicate search `PARTIAL` | some messages have no verdict | a message with no verdict is **never** treated as `new` |
| filing `PARTIAL` | the create returned no key | the label search settles it; never invent a key |
| responding `PARTIAL` | reply or reaction landed, not both | record the halves separately, finish the other next run |

## 9. Caps, and why each one exists

| Cap | Default | Reason |
|---|---|---|
| window | 7 days | a first run over a long backlog would post hundreds of questions at once |
| messages read per run | 25 | the reaction burst at barrier 2 is one write per message against a per-second limit |
| messages triaged per run | 5 | a run should be short enough to watch, and repeating it should advance the backlog |
| tickets filed unattended | 5 | an unattended run that misreads a channel should cost five tickets, not fifty |
| candidates read per message | 10 | reading every search hit is most of the run's cost for the least of its value |
| lease | 30 minutes | long enough to outlive a slow run, short enough that a dead one is not stranded until tomorrow |

A window older than 30 days needs an explicit backfill flag. Nobody accidentally triages a year of chat.

The two message caps are not interchangeable, and only one of them can make a repeated run advance. The
read cap is applied by a step that holds no ledger tool, so it always returns the same oldest messages —
after one run they are all terminal and the run finds nothing to do while the backlog sits behind them
untouched. The triage cap is applied to the rows `plan` has already ruled in scope, so its budget is spent
only on messages nobody has handled: run one takes the oldest five, run two takes the next five. That is
the whole mechanism behind "run it again and nothing is missed", and it only works in that order.
