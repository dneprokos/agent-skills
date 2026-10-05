# Run report — SCRUM-132

Real numbers off this repository's own workflow runs, for use in the talk. Nothing here is illustrative:
every figure is copied from `.workflow/metrics/SCRUM-132.jsonl`, from the `history:` block of
`.workflow/SCRUM-132.yaml.bak-2026-08-20-reset`, or from `node .claude/hooks/metrics-report.mjs SCRUM-132`.

The ticket: **SCRUM-132 — Build games management table for Admins**, a story under epic SCRUM-93.
4 functional requirements + 1 acceptance criterion.

---

## Provenance — three runs, two kinds of evidence

The log holds **three** runs of the same ticket, and they are not equally observable. Say this out loud
before showing any number, because it is the point of the metrics slide.

| Run | When | Launch style | What can be said about cost |
|---|---|---|---|
| **A** | 2026-08-09 → 08-10 | foreground | fully costed — 13 rows with tokens, model and price |
| **B** | 2026-08-17 → 08-18 | background | **`async_uncosted`** — the tool call returned at launch, so the hook saw no cost. Duration and tool calls survive, from the harness task notification, recorded into `history` |
| **C** | 2026-08-20 | background | 2 rows; a restart after the reset, abandoned early |

**A background launch is not a completion, and it is not an interrupt either.** Those 20 rows may have
finished perfectly. Calling them interrupts would be a false claim, so they carry their own status.

So the two tables below answer different questions and **must not be added together**:

- **Run B** answers *what did the workflow do* — every step, every verdict, every finding.
- **Run A** answers *what did a step cost* — tokens, model, list price.

---

## Table 1 — Run B, the complete run, step by step

Source: `history:` in the archived state file. 19 delegations, sequential except the two Phase 2 streams.

| Step | Agent | Verdict | Duration | Tools | What happened |
|---|---|---|---|---|---|
| 1.1 | `qa-requirements-collector` | OK | 84.8 s | 9 | 4 FR + 1 AC, 3 open questions. API surface **partial** — 6 operations matched, 2 spec gaps. Jira To Do → In Progress |
| 1.2 | `qa-requirements-reviewer` | OK | 266.5 s | 3 | 20 review notes, 6 missing-information items, 3 risks, 2 assumptions, 4 open questions, 1 **blocking** `[REQ-C1]` |
| 1.3 | `qa-scenario-generator` | OK | 710.4 s | 15 | 17 scenarios, all 5 requirements covered. Lint self-check **fixed 12 violations** before returning. 9 unapproved unknowns, 6 blocked scenarios |
| 1.4 | `qa-scenario-classifier` | OK | 366.1 s | 26 | 17 assigned: Component 7 · Integration 1 · E2E API 1 · E2E UI 2 · **Requirement Gap 6**. 15 of the generator's suggestions overridden |
| **B** | *checkpoint* | — | — | — | Counted off `--emit-manifest`: classified true, 0 violations. Both streams live |
| 1.5 | `qa-scenario-reviewer` | **Needs Revision** | 300.6 s | 7 | 8 findings — 1 Critical, 4 Major, 3 Minor |
| 1.3 | `qa-scenario-generator` | OK | 841.8 s | 20 | revision. All 8 addressed, **none disputed**. 17 → 20 scenarios; EP model 14 → 17 items |
| 1.4 | `qa-scenario-classifier` | OK | 432.3 s | 12 | reclassify, scope 4 scenarios — **the other 16 blocks byte-identical**. E2E share 27% → 43% |
| 1.5 | `qa-scenario-reviewer` | **Needs Revision** | 335.5 s | 7 | All 8 prior findings resolved; **7 new ones**. Cap reached at 1 of 1 → run stops, `escalated` |
| — | *human* | override | — | — | User ruled on all 7 findings individually, then chose apply-and-ship over raising the cap |
| 1.3 | `qa-scenario-generator` | OK | 234.3 s | 17 | revision 3. EP exercised 11 → 12 of 17; uncovered list now empty |
| 2.1a | `aqa-api-test-creator` | OK | 346.1 s | 38 | 1 of 2 E2E API scenarios; SCN-020 **not automatable** — no non-admin role obtainable. API suite 20 passed |
| 2.2a | `aqa-api-test-reviewer` | **Needs Revision** | 238.7 s | 22 | 5 findings — 1 Major, 4 Minor. Re-ran suite + typecheck itself |
| 2.1b | `aqa-ui-test-creator` | OK | 885.8 s | 58 | all 4 E2E UI scenarios. UI suite 8 passed **1 failed — pre-existing** (SCRUM-139) |
| 2.1a | `aqa-api-test-creator` | OK | 294.8 s | 29 | revision. All 5 fixed, none disputed |
| 2.2a | `aqa-api-test-reviewer` | **Pass** | 187 s | 19 | 2 Minors attached to the Pass — recorded, not routed |
| 2.2b | `aqa-ui-test-reviewer` | **Needs Revision** | 306.7 s | 26 | 6 findings — 4 Major, 2 Minor |
| 2.1b | `aqa-ui-test-creator` | **INTERRUPTED** | — | — | API error after the typecheck passed, before the self-check. **No receipt, no token figures, and none reconstructed** |
| 2.1b | `aqa-ui-test-creator` | OK | 151.5 s | 9 | resumed with its own context rather than re-delegated blind. Figures cover the resumed segment only |
| 2.2b | `aqa-ui-test-reviewer` | **Pass** | 233.3 s | 22 | all 6 resolved, no new findings |
| 3 | `qa-ship-tests` | **DECLINED** | — | — | Five-condition gate passed; branch created; **11 paths staged, 1076 insertions, 0 deletions**; user declined at the commit-message approval |

**Totals: 19 delegations · 6,216 s of agent time (1 h 43 m) · 339 tool calls.**

### Per-agent rollup, Run B

| Agent | Runs | Time | Tools |
|---|---|---|---|
| `qa-scenario-generator` | 3 | 1,786.5 s | 52 |
| `aqa-ui-test-creator` | 3 (+1 interrupted) | 1,037.3 s | 67 |
| `qa-scenario-classifier` | 2 | 798.4 s | 38 |
| `aqa-api-test-creator` | 2 | 640.9 s | 67 |
| `qa-scenario-reviewer` | 2 | 636.1 s | 14 |
| `aqa-ui-test-reviewer` | 2 | 540.0 s | 48 |
| `aqa-api-test-reviewer` | 2 | 425.7 s | 41 |
| `qa-requirements-reviewer` | 1 | 266.5 s | 3 |
| `qa-requirements-collector` | 1 | 84.8 s | 9 |

Two things to point at:

- **Every agent ran more than once except the two at the front.** The `EXISTS` / `revision` /
  `regenerate` mode machinery is not theoretical; it is most of the run.
- **The generator is the most expensive component in the workflow** — 3 runs, 29% of the wall time.
  That is the argument for batching, and for extracting `test-basis-modelling.md` out of its body.

---

## Table 2 — Run A, what a step cost

Source: `node .claude/hooks/metrics-report.mjs SCRUM-132`, rows 1–13.

| # | Agent | Model | Duration | Tools | End context | Out tokens | End ctx $ |
|---|---|---|---|---|---|---|---|
| 1 | `Explore` | opus-5 | 55.6 s | 10 | 27,062 | 1,535 | $0.0671 |
| 2 | `qa-requirements-collector` | sonnet-5 | 110.3 s | 8 | 53,285 | 874 | $0.0385 |
| 3 | `qa-requirements-reviewer` | sonnet-5 | 214.4 s | 4 | 51,970 | 294 | $0.0207 |
| 4 | `qa-scenario-generator` | sonnet-5 | 760.9 s | 22 | 166,232 | 1,042 | $0.0443 |
| 5 | `qa-scenario-classifier` | sonnet-5 | 482.0 s | 25 | 100,142 | 722 | $0.0274 |
| 6 | `qa-scenario-reviewer` | **opus-5** | 222.0 s | 6 | 72,164 | **5,318** | **$0.1819** |
| 7 | `qa-scenario-classifier` | sonnet-5 | 207.5 s | 13 | 76,217 | 957 | $0.0250 |
| 8 | `qa-scenario-generator` | sonnet-5 | 302.3 s | 13 | 99,657 | 1,050 | $0.0318 |
| 9 | `qa-scenario-reviewer` | **opus-5** | 210.8 s | 7 | 72,770 | 2,425 | $0.1432 |
| 10 | `aqa-ui-test-creator` | sonnet-5 | **1601.0 s** | **115** | 285,665 | 1,214 | $0.0726 |
| 11 | `aqa-ui-test-reviewer` | **opus-5** | 336.7 s | 27 | 115,971 | **7,617** | **$0.2476** |
| 12 | `aqa-ui-test-creator` | sonnet-5 | 846.9 s | 54 | 183,166 | 1,018 | $0.0469 |
| 13 | `aqa-ui-test-reviewer` | **opus-5** | 270.3 s | 23 | 98,442 | 2,195 | $0.1197 |
| **Σ** | **13 runs** | | **5,620.8 s** | **327** | **1,402,743** | **26,261** | **$1.0669** |

### The inversion worth a slide

**Row 10 against row 11.** The creator: 115 tool calls, 27 minutes, and a final message worth **7 cents**.
The reviewer next to it: 27 tool calls, 5½ minutes, and a final message worth **25 cents** — 3.4× the price
off a quarter of the tool calls.

Neither number is wrong and neither is the run's bill:

- **`tool_uses` is the honest measure of work.** A creator edits, runs the suite, reads the failure, edits
  again. That is what 115 looks like.
- **`End ctx $` prices the final message only.** A reviewer's last turn *is* its deliverable — 7,617 output
  tokens of findings — so its final message is genuinely expensive. A creator's last turn is a receipt.
- **Model tiering is visible in the log and nobody had to declare it**: every reviewer resolved to opus-5,
  every creator to sonnet-5.

**A row of 115 tool calls priced at seven cents is the proof that this column is not a bill, not a bargain.**

---

## Headline numbers for a slide

| | |
|---|---|
| Requirements in | 4 FR + 1 AC |
| Scenarios designed | 17 → **20** after review |
| Levels assigned | Component 7 · Integration 1 · E2E API 2 · E2E UI 4 · **Requirement Gap 6** |
| Executable coverage | 14 of 20 |
| Findings raised across the run | **26** — 15 design, 5 API, 6 UI |
| Findings disputed by a creator | **0** |
| Critical findings | 1 (design), 0 in either code stream |
| Review rounds that changed the artifact | 5 |
| Tests shipped | 11 paths, **1,076 insertions, 0 deletions** |
| Suite at the end | API 20 passed · UI 8 passed, **1 failed — pre-existing, another ticket** |
| Agent time | **1 h 43 m** across 19 delegations |
| Tool calls | 339 |
| Human decisions | 3 — one override on 7 findings, one staging choice, one decline |

---

## What the run did *not* do, and why that is the good part

Four honest failures in this data. Use them; a report with no failures in it reads as marketing.

1. **The design review hit its cap.** `max_review_iterations` was `1` for this run. Second verdict was still
   `Needs Revision`, so the run **stopped** — `status: escalated`. It did not lower the bar to clear itself.
2. **A human overrode the reviewer**, ruling on all 7 findings one at a time, and the override is recorded
   as an override: the `Needs Revision` verdict **stands unrewritten** in the state file.
3. **One scenario was not automatable** and was reported as such rather than faked — SCN-020 needed a
   non-admin role the environment cannot produce.
4. **The interrupted UI creator produced no token figures, and none were invented.** It was resumed with its
   own context instead of re-delegated blind, and the replacement row says its figures cover the resumed
   segment only.

And one process failure the log itself caught: three earlier rows are `no_result` diagnostics from the
period when the metrics hook was wired to the tool's old name and silently wrote nothing. The evidence that
a hook is broken looks exactly like the evidence that nothing ran.

---

## Reproducing these tables

```bash
node .claude/hooks/metrics-report.mjs SCRUM-132           # the cost table (Run A costed, Run B uncosted)
node .claude/hooks/metrics-report.mjs SCRUM-132 --json    # one record per run
sed -n '/^history:/,$p' .workflow/SCRUM-132.yaml.bak-2026-08-20-reset   # the step narrative, Run B
```

`workflow-state.mjs get` prints **one scalar** raw — it is what carries a multi-line `last_findings` into
the next delegation without retyping it, and it returns nothing for a list key like `history`.

The archived state file for run B is `.workflow/SCRUM-132.yaml.bak-2026-08-20-reset` — kept by `reset`,
which archives by rename and never deletes.
