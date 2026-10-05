# Triage verdict — the duplicate-decision contract

**Read this when a run judges whether a reported bug already exists in Jira, and again when a run routes on
that judgement.** One file, two readers, for the usual reason: the rule a verdict is formed under and the
rule it is acted on under must be the same words.

It is part of `docs/automation/`: no file here names an agent, and nothing here may be worked from memory.

---

## 1. The verdict

Exactly one of two values, per message:

| Verdict | Meaning |
|---|---|
| `new` | no open or recent SCRUM bug describes this defect. A ticket should be filed |
| `duplicate` | an existing SCRUM bug describes **this same defect**, and the reporter should be pointed at it |

A `duplicate` verdict always carries three things and is incomplete without any of them:

- **`duplicate_of`** — the SCRUM key. One key. A verdict that names two candidates is not a verdict.
- **`confidence`** — `high`, `medium` or `low`, from the bands in §3. Never a number, never a percentage.
- **`justification`** — one line naming the *evidence*, not the impression: which fields matched and how.
  `same endpoint and the same 500 body as SCRUM-167` is a justification. `looks like the same thing` is not.

## 2. What a duplicate is

Same **defect**, not same **area**. Two bugs in the Owner Panel are not duplicates of each other; two
reports of the Owner Panel returning 500 on admin create are.

The test is whether fixing the existing ticket would close this report as well. If a reader could fix
`duplicate_of` completely and this reporter would still be able to reproduce what they described, the
verdict is `new`.

Specifically:

- A different endpoint, route or screen is **not** a duplicate, however similar the symptom.
- A different HTTP status on the same route is **not** a duplicate — a 500 and a 403 have different causes.
- The same defect reported against a different environment **is** a duplicate. Environment is a field on
  the ticket, not a second defect.
- A ticket already `Done` is a duplicate only when it is the same defect *and* the report predates the fix.
  A `Done` ticket plus a fresh report is a regression: verdict `new`, and the justification says so and
  names the closed key.

## 3. Confidence bands — evidence thresholds, not feelings

| Band | Earned by |
|---|---|
| `high` | the same route, screen or operation **and** a matching observable — the same status code, the same error string, or the same assertion text. Two independent fields agree |
| `medium` | the same route, screen or operation, and a symptom that is consistent but not verbatim; or a matching observable with the route unstated on one side |
| `low` | overlapping wording only. Similar nouns, no matched route and no matched observable |

A band is the **lowest** one the evidence satisfies. Two fields agreeing is what separates `high` from
`medium`, and "the summaries read alike" is never one of them — the search matched on summary text, so
summary similarity is how the candidate arrived, not evidence that it fits.

## 4. What the bands are allowed to do

Confidence exists because a duplicate verdict has no reviewer and no ground truth, and a wrong `high` buries
a real bug under an unrelated ticket where nobody looks again.

- An unattended run acts on `duplicate` at **`high`** only.
- `medium` and `low` are **escalated**: the message keeps its claim mark, no reply is posted, no ticket is
  filed, and a human decides. An escalation is a finished outcome, not a failure.
- An attended run shows every verdict, with its band and its justification, before anything happens.
- **A duplicate verdict never closes, edits, comments on or transitions the matched ticket.** It produces a
  threaded reply and a mark. That is what makes a wrong call cheap: recovery is removing an emoji.

## 5. The search, and what a zero result means

The query is generated from the draft, not composed freely. Two shapes are permitted and no others:

1. **The generated query** — the dedupe JQL the draft carries: the subject half of the summary, reduced to
   its content words, over SCRUM bugs from the last 180 days.
2. **One broadened fallback**, run only when the first returns nothing: fewer terms, and the description
   searched as well as the summary.

Authoring a third query is out of bounds. A search wide enough to find something will always find
something, and a verdict is only as good as the candidate set being honest.

**A zero result is not evidence of absence.** The generated query matches five content words against
summary text; a bug written up in different words returns nothing while sitting open in the backlog. A
message whose search returned nothing at either shape is reported as such — the verdict is `new`, and the
zero result is recorded, because a channel that keeps producing them is telling you the query is too narrow
and not that the backlog is empty.

## 6. Candidates

Read the candidates before ruling on them. A key returned by a search is a title and a status, and neither
is enough: the verdict turns on the route and the observable, which live in the description.

Cap the read at the ten most recent candidates. Where a match is not in those ten, the honest verdict is
`new` with the cap stated — not a `low`-confidence guess at the eleventh.

## 7. What a verdict may not assert

- That the matched ticket is open, assigned, being worked on, or will be fixed. A verdict reports a match.
- That the reporter's bug is invalid, already fixed, or working as intended. None of those is a duplicate,
  and none of them is this step's call.
- Anything about the application's behaviour that was not read from Jira or from the draft. The running app
  is not consulted here, and a route documented in `# API Surface` is not evidence that two reports describe
  the same defect.
