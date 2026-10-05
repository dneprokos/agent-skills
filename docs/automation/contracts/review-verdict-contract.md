# Review Verdict Contract

The process every test-code review in this repository follows: how a re-review narrows, how a previous
finding is ruled on, what the severities mean, which verdict follows from which findings, and the exact
shape of the report that comes out.

It is shared across streams on purpose. The workflow that routes these reviews keys off the verdict
string and the finding-id prefix, so two streams whose verdict semantics drift apart produce a workflow
that treats them asymmetrically for no reason anyone chose.

**What this document does not contain:** anything stream-specific. The review checklist, the severity
examples, the ownership boundary, the commands, the reference files — those live in the review's own
instructions, because they differ. Read both.

Throughout, `<STREAM>` is `API` or `UI` and `<stream>` is `api` or `ui`, matching the `stream:` field of
the implementation report under review.

## 1. Mode — full review or re-review

| `previous_findings` | Mode |
|---|---|
| absent | `full_review` — every check, over every changed file |
| present | `re_review` |

A re-review answers a narrower question than a first review: *did the implementer fix what I found, and
did fixing it break anything?* It is **not** a lighter review. Exactly one thing narrows.

### What still runs in full, every single iteration

- **The suite run and the type check.** This is what catches a fix in one file that broke another, and
  it is the reason a narrowed reading pass is safe at all.
- **The coverage pass.** Grep the test design for the level assigned to this stream and account for
  every id, exactly as on a first review. It is a grep over a document already in hand; narrowing it
  saves nothing and risks a silently dropped scenario reaching a pull request.
- **The report's structural checks** — sections present, `stream:` correct, every `Changed Files` path
  exists on disk.

### What narrows

The line-by-line style pass, and only it. Read in full: every file a previous finding names, and every
file whose content changed since the iteration under review. A file that is byte-identical to one
already passed does not need re-reading.

If what changed cannot be established — the report's `iteration:` did not move, or
`Review Findings Addressed` is missing — that is reason enough to run `full_review`, and it is said in
`NOTES`. **An uncertain delta is not a delta.**

## 2. Ruling on every previous finding

Read the report's `Review Findings Addressed` table. Every id raised last time gets exactly one ruling:

| The implementer said | Verify | Outcome |
|---|---|---|
| `fixed` | open the cited `file:line` and confirm the code does what the finding asked | **resolved**, or **still outstanding** when it does not. A finding claimed fixed that is not is Critical — a false claim about the code, the same class of defect as a scenario claimed but not covered |
| `disputed` | read the reasoning under `Known Limitations` and judge it | **accepted** — drop the finding, saying in one clause why the reasoning holds. Or **rejected** — it stays outstanding under its original id, and the report says why the reasoning does not hold |
| `not applicable` | confirm the file or scenario really is outside this stream | **accepted** or **rejected**, same as disputed |
| nothing — the id is absent from the table | — | **still outstanding**, and the omission is itself a Critical finding: a dropped finding is how a revision loop silently stops converging |

A previous finding may not be left unruled. "It seems addressed" is not a ruling; open the file.

## 3. Finding ids

Every finding opens with `[<STREAM>-<SEVERITY><N>]` — `[API-C1]`, `[UI-M2]`, `[API-m1]`. `C` is Critical,
`M` is Major, `m` is Minor, numbered per severity.

- **Ids are stable across iterations.** A finding still outstanding on iteration 3 keeps the number it
  was given on iteration 1.
- New findings continue from the highest number already used for that stream and severity, read out of
  `previous_findings`.
- **A resolved id is never reused** for a different defect. An id is cited in reports, pull-request
  threads and Jira comments, and reusing one makes every one of those citations wrong.
- A coverage finding carries the scenario id as its second token: `[API-C2] [SCN-014] …`.

The id is what makes a revision scopeable and a re-review verifiable. A finding without one cannot be
ruled on next iteration.

The prefix names a **stream, not an agent**. The stream is a partition of the work and stays the same
partition regardless of what implements it.

## 4. Severity

| Severity | What belongs here |
|---|---|
| **Critical** | the review's own subject matter is compromised: a scenario the design assigned to this stream neither implemented nor listed as skipped; a scenario claimed but not actually covered by its assertions; a credential or secret in the code; an assertion weakened, skipped or deleted to hide a real failure; a reported file that does not exist; execution counts that contradict the reviewer's own run in the report's favour; a write outside this stream's ownership boundary |
| **Major** | the code works but the test does not do its job, or breaks a stated convention with a behavioural effect |
| **Minor** | naming, ordering, duplication, a thin comment, a stylistic deviation with no behavioural effect |

**The floor between Major and Minor is what a finding changes.** Major is a defect that changes what a
test asserts, whether a scenario is covered, or whether the suite's result can be trusted. Everything
else is Minor: a name, an ordering, a duplicated block, a comment, a stylistic deviation with no
behavioural effect. A review loop is capped, so a Major is a request to spend one of its rounds —
grading up to look thorough spends a round and changes no test.

Two things upgrade to **Critical in a re-review**, because they break the loop rather than the code: a
finding the report claims `fixed` where the cited code does not do what the finding asked, and a finding
id the report does not account for at all.

**A new Major on a re-review may name only a file that changed since the iteration you reviewed, or one
a previous finding named.** A defect visible in a file nobody touched is one the previous round passed;
raising it as a Major now spends a round on work that round should have asked for. Report it as Minor
with `(untouched file)`. The files that *did* change are reviewed at full severity.

## 5. Verdict

Apply exactly:

- **`Blocked`** — the review could not be performed: report missing or malformed, wrong stream, test
  design missing, or the suite could not be run.
- **`Needs Revision`** — any Critical or any Major finding, **new or still outstanding**. A finding
  carried over from a previous iteration weighs exactly what a new one weighs; a loop that converges
  only because old findings stop being counted has not converged.
- **`Pass`** — no Critical and no Major, outstanding or new. Minor findings are listed and it is still
  `Pass`.

Never soften a verdict because the work is otherwise good, and never fail one on Minor findings alone.
When there is nothing to report, say so plainly — a review that manufactures a Major finding to look
thorough is as useless as one that misses a real gap.

A gap in the **test design itself** — a case that should have been designed and was not — is not a
finding here at any severity. The design review already ran and owns that question, and there is no
section in this block for an observation that is not a finding: leave it out.

## 6. The report

Emit exactly this block as the final message. No prose before or after it.

```
Review Status: Pass | Needs Revision | Blocked

Ticket: SCRUM-139
Stream: <stream>
Implementation Report: .workflow/reports/SCRUM-139-<stream>-implementation.md
Iteration Reviewed: 1
Mode: full_review | re_review
Previous Findings: API-C1, API-C2, API-M1 (3)
Findings Resolved: API-C1, API-M1
Findings Outstanding: API-C2 — still asserts only result.ok
Findings Disputed: API-M1 (accepted — the design really does leave the message open)
New Findings: API-C3, API-M2, API-M3, API-m1
E2E <STREAM> Scenarios in Test Design: SCN-012, SCN-014, SCN-016
Scenarios Claimed: SCN-012, SCN-014
Scenarios Verified: SCN-012, SCN-014
Scenarios Unverified: none
Scenarios Folded: SCN-018 -> SCN-012 (asserted in that test)
Scenarios Missing: SCN-016 (not implemented, not listed as skipped)

Critical Issues:
- [<STREAM>-C2] [SCN-014] <file>:<line> — <what is wrong, and what the scenario expected>

Major Issues:
- [<STREAM>-M2] <file>:<line> — <what is wrong>

Minor Issues:
- [<STREAM>-m1] <file>:<line> — <what is wrong>

Validation Results:
- <the suite command> — <counts> (report claimed <counts> — matches | discrepancy)
- npx tsc --noEmit — pass
- <suspected application defects confirmed as documented, or "- None.">
```

Rules for the report:

- The five `Findings` header lines appear in **every** report. On a `full_review` with no
  `previous_findings`, `Previous Findings` reads `none (0)`, `Findings Resolved` / `Outstanding` /
  `Disputed` read `- None.`, and `New Findings` lists every id raised.
- `Findings Outstanding` names the id and, in one clause, what is still wrong. `Findings Disputed` names
  the id, `accepted` or `rejected`, and why in one clause.
- `New Findings` is a **roll-up, not a separate list**: exactly the ids that appear in the sections below
  and not in `Previous Findings`. An id in one and not the other is a contradiction within one report.
- `Scenarios Folded` lists every scenario the test design marks `Folds Into: <id>`, each as `SCN-018 -> SCN-012` with a parenthetical saying whether the covering test actually asserts it. It reads `none` when the design folded nothing. Take the ids from the **design**, never from the report: a folded scenario has no test of its own, so an id the report forgot is invisible to `Scenarios Missing` — there is no missing test to notice. A folded id whose `Expected:` no test asserts belongs in the findings, not merely in a parenthetical here.
- Every finding cites `file:line`, and a coverage finding also names the scenario id. "Assertions could
  be stronger" is not a finding.
- A missing-scenario finding cites the scenario id and the test design instead of a `file:line`, since
  there is no line to point at.
- Quote the exact conflicting text when reporting an invented value, or a contradiction between the
  report and the code.
- A style finding names the convention **and where it is written** — `CLAUDE.md`, this stream's etalon
  document, or the line of the reference spec that shows the house form.
- Findings are actionable without re-reading the whole diff. Whoever fixes this has the report, the test
  design and the files, and nothing else.
- A section with no findings reads `- None.` Never delete the section.
- Keep the whole report under roughly 60 lines. With more than a dozen findings, report the twelve most
  severe and state how many were folded in.

## 7. Boundaries that hold in every stream

- **Edit, create or rewrite nothing.** A review holds no `Write` and no `Edit`, and must not ask its
  caller to apply a change for it mid-run. A review that can fix what it finds returns `Pass`, and the
  revision signal — the only thing the review exists to produce — disappears.
- **Do not write the fix into the report as replacement code.** Name the defect, its location and the
  convention it breaks; the fix belongs to whoever owns the code.
- **Do not review the sibling stream's files.** Duplicating a review that runs elsewhere produces
  contradictory findings.
- **Do not return `Pass`** with a Critical or Major finding listed, new or still outstanding, and do not
  return `Needs Revision` on Minor findings alone.
- **Do not return anything but `Blocked`** when the suite could not be run. A review of unrun code is a
  guess.
- **Do not return a `re_review`** that leaves a previous finding id unruled, or that accepts a `fixed`
  claim without opening the cited `file:line`. Taking the report's word for it is the one thing this
  review exists not to do.
- **Do not skip the suite run, the type check or the coverage pass** because this is a re-review. Only
  the line-by-line style pass narrows.
- **Do not trust** the report's execution counts, its coverage claims, or its file list without checking
  them.
- **Do not read `requirements/`**, or raise a finding phrased against a requirement. The requirements
  review already happened; repeating it re-opens a settled document and contradicts it.
  **One section is exempt: `# API Surface`.** The code you review was allowed to take its mechanics from
  it, so you need it to tell a documented route from a guessed one. Use it for exactly that. A finding
  phrased against it — a gap in the surface, an operation nobody mapped — belongs to the requirements
  review, not to yours, and **a value documented there but absent from the design's `Expected:` is an
  invented assertion**, which is a finding against the code and not against the document. How that
  section is read — and how far a stream whose subject is not the HTTP request may use it — is in
  `docs/automation/references/api-surface-reading.md`.
- **Do not judge the test design** — a scenario that would have been designed differently, a case
  thought missing, a level assignment disagreed with. The code is reviewed against the design, not the
  design against an opinion.
- **Do not open the application in a browser.** Exploring the app to check what it does reproduces the
  implementer's work instead of reviewing it, and what the app currently does is not the standard.
  What the implementing stream observed while working out how to reach an observable is reported to you
  instead — the locators it saw and the mechanics it read — and that report is the whole of your evidence
  about the running system. Rule on whether the code matches it and whether it accounts for every wait
  and locator committed; a gap there is a finding, and so is a value that reached an assertion from it.
- **Do not touch Jira.** No Atlassian tools are granted, deliberately.
- **Do not ask the user a clarifying question mid-run.** A question that makes the review undecidable
  is `Blocked` with the question as its reason; anything less than that, you rule on yourself.
- **Do not report a failing test as a defect in the code** when the report documents it as a suspected
  application defect with a scenario id, and do not accept a weakened assertion because the suite is
  green.
- **Do not invent a convention the repository does not state.** A preference that contradicts the stated
  standards, or that none of them expresses, is not a finding.
