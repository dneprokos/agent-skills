# Slack bug intake — the message-to-draft contract

**Read this when a run turns Slack messages into bug drafts, and again when it writes the threaded reply
that asks for what a message did not carry.** Both steps read this one file, because the question a
reporter is asked must name the same field the draft demanded — a question about "reproduction details"
against a draft that wanted `steps` is a question nobody can answer correctly.

It is part of `docs/automation/`: no file here names an agent, and nothing here may be worked from memory.

---

## 1. The nine fields, and the only four a reporter owns

`.claude/skills/jira-bug-creator/scripts/lib.js` requires nine fields before it will build a Jira payload,
and it treats all nine identically. A human writing in Slack supplies four of them at best.

Left alone, that arithmetic produces one outcome: **every message is incomplete, every message gets a
question, and no bug is ever filed.** So the nine split in two, and only the first class can ever make a
report incomplete.

### Reporter-supplied — absence makes the report thin

| Field | What it is | Read from |
|---|---|---|
| `summary` | one line: what breaks, in product terms | the message; rewritten into a sentence, never pasted whole |
| `steps` | numbered, one action each | the message |
| `expected` | what should have happened | the message |
| `actual` | what happened instead, with the status or the message text observed | the message |

A message missing any of these four is **thin**. Nothing is filed, one threaded question is posted naming
exactly the missing fields by these names, and the message is marked with the question emoji.

### Run-level default — never makes a report thin

| Field | Default | Why it is defaulted rather than asked |
|---|---|---|
| `phase` | the run's detection-phase parameter; `Production` for this workflow | Jira's Defect Detection Phase is required and silently defaults to `Development`. A human hitting a defect in the running app is not a development-time find, and asking every reporter to classify it would make the field noise |
| `priority` | `Medium`, or a higher band when the message states severity in words | a reporter's own urgency is evidence, not authority; a triage pass sets the real one |
| `version` | the run's version parameter; else `unspecified — reported via Slack` | nobody in a chat channel knows the build they hit |
| `initialCondition` | taken from the message where it says one; else `As reported in Slack — see permalink` | the permalink is the honest answer, and it is better than an invented precondition |
| `affectedTests` | `none — reported manually via Slack` | this report came from a human, not a suite. Naming a suite here would be a guess about coverage |

Every defaulted value is added to the draft's `inferred` list, which the draft builder already carries, and
every default in force is printed in the run's parameter banner. **A run whose defaults nobody chose has to
say so** — a Jira board silently filling with `Development` bugs that were all found in production is the
failure this rule exists for.

---

## 2. What a message may and may not become

**The message is the only source of an asserted value.** A summary, a step, an expected result and an
actual result are all quotations of what a human reported, compressed into the house form. Nothing else in
the repository, the running app or Jira may supply one.

- Do **not** open the application to check whether the bug reproduces. A draft records the report; it does
  not adjudicate it. A report that turns out to be wrong is a Jira workflow's problem, not an intake one.
- Do **not** read a value out of the codebase to fill `expected`. "Expected" means what the reporter
  expected, and the two are different claims — the second one can only ever agree with the code.
- Do **not** merge two messages into one draft, even when they clearly describe the same defect. One
  message is one draft; sameness is the duplicate step's question, and it is asked against Jira, not
  against the channel.
- Do **not** infer `steps` from a screenshot, a stack trace or a log line pasted with no prose. Those go to
  `evidence`. A stack trace is not a reproduction.

## 3. Rewriting the summary

The summary is the one field that is composed rather than extracted, because it is what the duplicate
search runs on and what a human reads on a board.

- Product terms, not chat: `Owner Panel — creating an admin returns 500`, never `admin thing broken again`.
- Present tense, no reporter's name, no urgency words, no emoji.
- 255 characters is the hard cap the payload builder enforces; aim well under it.
- Do not carry a Slack thread's back-and-forth into the summary. The first message states the defect; a
  thread that corrects it makes the report thin, not the summary longer.

## 4. Evidence

`evidence` is optional and carries what the message attached: a pasted error body, a stack trace, a log
line, the permalink of a screenshot. Always include the message permalink there, because the ticket's
reader will want the conversation and the ledger stores it in only one other place.

Never put a Slack user's display name or e-mail in evidence — the user id is the identifier the workspace
already uses, and a ticket is a wider audience than a channel.

## 5. The threaded question

One reply per distinct missing set, ever. The reply names the missing fields **by the names in the table in
§1**, one bullet each, with the one-line prompt the draft builder itself prints for that field — not a
paraphrase. It says nothing about Jira, offers no guess at the answer, and does not ask for anything from
the run-level-default class.

A message whose missing set has not changed is not asked again. That is enforced by the ledger, not by
judgement: the same set hashes the same way and the message stays out of scope. **The failure this
prevents is a bot that pings a reporter every run until they mute the channel**, which is how an
automation stops being allowed near a real channel.

## 6. Reading `# API Surface`

This contract does not use it and neither does the intake step. An intake draft records what a human
reported; a documented route is not evidence about what they saw, and a route's response shape is not an
`expected` value. The endpoint mechanics matter to a test, not to a bug report.
