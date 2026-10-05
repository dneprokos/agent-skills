# The test design document — shape

The body of `test-design/<TICKET-ID>-test-design.md`, below its YAML frontmatter, in the order the
sections appear. Read this when **writing the document from scratch or rewriting it whole**; a run that
appends scenarios to a document that already exists is editing a shape that is already on disk, and
re-reading the template to append one block is the cost this file was extracted to remove.

Nothing here is optional and nothing is shortened by its position. A scenario cites `EP-01` and the
reader turns to the back for it, exactly as they would in any test plan.

The four counted sections — `# Summary` and the three matrices — are written as placeholder headings
and filled in by `node scripts/test-design-lint.mjs <path> --requirements <path> --apply-summary`. The
arithmetic is not yours to do; see *Building the counted sections* below.

---

## The template

````markdown
# Test Design — SCRUM-139: List and create admin accounts

_Derived from requirements/SCRUM-139-requirements.md._

# Summary

Scenarios: 14  |  Automatable: 11  |  Manual only: 3
Levels: _pending classification._
Requirements: FR 6/6, AC 1/1 covered
Techniques: EP 8/8, BVA 8/9 (1 traced-only), DT 4/4, ST 5/6

Blocked by (top unknowns):
- duplicate-email status code, 400 vs 409 — not stated [REQ-C2]
- no stated maximum password length [REQ-M4]

# Scenarios

## SCN-001: ...

Requirement: ...
...
Notes: —

---

## SCN-002: ...

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-11.1 | SCN-003, SCN-007 |
| AC-1 | SCN-001, SCN-012 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-001, SCN-002 |
| Retry / timeout | _Not applicable — no external dependency is stated in the requirements._ |

# Technique Coverage Matrix

| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |
|---|---|---|---|---|---|
| Equivalence Partitioning | 8 | 8 | 0 | 100% | — |
| Boundary Value Analysis (3-value) | 9 | 8 | 1 | 89% | — |
| Decision Table Testing | 4 | 4 | 0 | 100% | — |
| State Transition Testing | 6 | 5 | 0 | 83% | ST-01/T6 |

# Coverage Gaps

- <a requirement with thin coverage, an uncovered coverage item, an unknown value that blocked a scenario, or a reviewer finding not turned into a scenario — and why>

# Approved Assumptions

| Value | Scenario | Basis | Approved by | Date |
|---|---|---|---|---|
| 409 on duplicate email | SCN-013 | matches existing POST behaviour | @dneprokos | 2026-08-06 |

# Test Basis Research

| Aspect | Findings | Feeds |
|---|---|---|
| Actors & roles | Owner, Admin, unauthenticated | DT-01, cat.6 |
| Entities & states | AdminUser: absent -> active | ST-01 |
| Inputs | email, password, confirmPassword | EP-01..05 |
| Limits | password >= 6 chars; no stated max | BV-01, gap |
| Oracles | 201 + body; GET list read-back | Expected: |
| Permissions | /api/admin/* owner-only | DT-01, cat.6 |
| Dependencies | JWT auth, Mongo normalizeEmail() | cat.8 |
| Data lifetime | email unique; list newest-first | cat.7 |
| Domain terms | "Owner" != "Admin" | naming |
| Unknowns | 400 vs 409 on duplicate | Coverage Gaps |

# Test Basis Analysis

_Black-box test techniques per ISTQB CTFL v4.0 §4.2. The coverage items below are cited by the `Coverage Item:` field of each scenario._

## Equivalence Partitions (§4.2.1)

| ID | Parameter | Partition | Valid / Invalid | Source |
|---|---|---|---|---|
| EP-01 | password | length >= 6 | Valid | FR-11.3 |
| EP-02 | password | length < 6 | Invalid | FR-11.3 |

Coverage criterion: Each Choice.

## Boundary Values (§4.2.2)

| ID | Boundary | Partitions | Version | Values | Source |
|---|---|---|---|---|---|
| BV-01 | password minimum length 6 | EP-02 / EP-01 | 3-value | 5, 6, 7 | FR-11.3 |

## Decision Tables (§4.2.3)

### DT-01: Create Admin

| Condition / Action | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| Caller is Owner | T | T | T | F |
| E-mail is unique | T | F | — | N/A |
| Password is valid | T | — | F | N/A |
| **201 Created** | X | | | |
| **409 duplicate e-mail** | | X | | |
| **400 validation error** | | | X | |
| **403 forbidden** | | | | X |

Infeasible columns removed: none. Merged columns: none. Rules: DT-01/R1 … DT-01/R4.

## State Transitions (§4.2.4)

### ST-01: Admin account

| State \ Event | create | delete | login |
|---|---|---|---|
| (does not exist) | Active (T1) | invalid (T4) | invalid (T5) |
| Active | invalid (T6) | (does not exist) (T2) | Active (T3) |

Target criterion: all transitions. Valid: T1, T2, T3. Invalid: T4, T5, T6.
````

---

## Building the counted sections

Write `# Summary` and the three matrices as placeholder headings. Once the scenario blocks and
`# Test Basis Analysis` are written, run

```bash
node scripts/test-design-lint.mjs <output_path> --requirements <requirements_path> --apply-summary
```

It recomputes `# Summary` and all three matrices from the blocks and writes them into the document in
place. Nothing else in the file is touched — every scenario block, every model row and every
`# Coverage Gaps` line is carried through byte-identical — and the `Levels:` line and the
`Blocked by (top unknowns):` list are carried through too, because neither is arithmetic. The run
prints one line per section it changed; a second run reports no change.

Counting nineteen scenarios across three matrices by re-reading your own output is the slowest and
least reliable thing this step does. Do not paste these sections by hand, and do not "check" the
script's output by recounting it — if you disagree with a number, the cause is in the blocks, and that
is what you fix. Use `--emit-summary` to look at the recount without writing it.

## Section rules

- **`# Summary` is the first thing anybody reads, so every number in it is counted, never asserted.**
  Six lines and a short list:
  - `Scenarios:` the number of `## SCN-` blocks. `Automatable:` and `Manual only:` split them on the
    `Automation Suitability:` field — `Manual only` on one side, everything else on the other. The two
    must add up to the first.
  - `Levels:` reads `_pending classification._` while the document is being written, and is replaced
    with the level counts once every scenario carries an `Assigned Level:` line. It is one of the four
    lines the script carries through rather than recomputes, so it is written from the level pass and
    from nothing else.
  - `Requirements:` the FR and AC counts from the traceability matrix — covered over total, where total
    is every id in the requirements document.
  - `Techniques:` exercised over total per technique, the same four numbers as
    `# Technique Coverage Matrix`. They are one recount, so they can never disagree; `n/a` for a
    technique with no items.
  - `Blocked by (top unknowns):` at most five bullets, one per distinct unknown that took an
    `Expected:` away, each naming the requirement id that would answer it. Omit the whole list when
    there are none — do not write "none".
  - A summary that disagrees with the matrices below it is worse than no summary, because it is the one
    section a reader trusts without checking. Build it last, from the finished document.
- **A UI scenario that leans on the backend states an API coverage decision in `Notes:`.** A scenario
  whose level is `E2E UI` and whose text turns on server behaviour — a sign-in, a request, a persisted
  record, a status code — is covering two things at once: what the screen does, and what the contract
  underneath it does. The design says which of those it means, in one of three forms:

  | Form | When |
  |---|---|
  | `API coverage: linked SCN-NNN — <what is asserted there>` | the backend behaviour has contract value of its own, and an `E2E API` scenario in this document asserts it |
  | `API coverage: not needed — <why>` | the backend is only support for the journey: sign-in, setup, cleanup, navigation mechanics. The reason is required — an exemption nobody can review is not an exemption |
  | `API coverage: not applicable — <why>` | no API surface is in play for this scenario at all |

  The linked id must be a scenario in this document carrying `E2E API`; a link to any other level is
  the same silence wearing an id, because a scenario at another level does not assert the contract.
  The decision is not required of a scenario that *is* an `E2E API` scenario — it carries its own
  contract, so asking it to name another would be circular. `scripts/test-design-lint.mjs` fails a
  missing or malformed decision as `TD-E22`; it rules on presence and shape, never on whether the
  decision was the right one.
- The document leads with `# Summary` and `# Scenarios` because that is what a reader came for; the
  matrices audit them, and `# Test Basis Research` and `# Test Basis Analysis` close the file as the
  appendix the models live in.
- `# Test Basis Research` carries all ten rows, in the fixed order, every time — `— none stated` where
  there was nothing to record. It stays directly above `# Test Basis Analysis`, because it is what the
  analysis was built from and a reader who wants to know whether a model is thin looks at the research
  first.
- `# Test Basis Analysis` carries a subsection per technique, in §4.2 order, every time. A technique
  with nothing to model still gets its heading and a one-line `_Not applicable — <reason>._` — an
  absent subsection is indistinguishable from a forgotten one.
- All three matrices are derived from the scenario blocks, not written from memory. Every id in a
  matrix must exist as a block, and every block must appear in the traceability and coverage matrices.
- The traceability matrix lists every FR and AC id from the requirements document, including any with
  no scenario — an empty cell there is exactly the signal an independent review is looking for, so
  never hide one.
- On a run scoped by `requirement_ids`, the matrix still lists **every** id in the document. An
  out-of-scope row reads `| FR-11.4 | _Out of scope for this run (requirement_ids)._ |`, and the
  out-of-scope ids get one `# Coverage Gaps` entry naming them. A scoped run that omits those rows
  would look like a finished design, which is the one thing this document must never do.
- The coverage matrix lists all twelve categories, in the coverage-category order, every time.
- `# Approved Assumptions` is present on every run, `_None._` when nothing has been approved. It is the
  audit trail for every value that reached an assertion without being in the requirements, so an absent
  section and an empty one are not the same claim.
- The technique coverage matrix is **counted**, never asserted, and it has six columns: `Technique`,
  `Coverage items`, `Exercised`, `Traced-only`, `Coverage`, `Uncovered`. `Coverage items` is the number
  of ids in that technique's subsection; `Exercised` is how many are cited by a scenario that actually
  asserts something; `Traced-only` is how many are cited **only** by scenarios that assert nothing;
  `Uncovered` is the ids no scenario cites at all. The percentage follows from `Exercised` over
  `Coverage items`. A matrix that claims 100% while an item is uncovered is a false coverage claim, and
  it is worse than reporting 83%.
- **A scenario an unknown blocked traces a requirement; it does not exercise a coverage item.** A block
  carrying an `unknown:` marker together with `Automation Suitability: Manual only` has had its outcome
  taken away — the coverage items it cites are `Traced-only`, and the script counts them that way
  whether or not you agree. Both an `Uncovered` id and a traced-only id need a `# Coverage Gaps` line
  naming them and saying why. A design cannot report full technique coverage on the strength of
  scenarios that assert nothing, and it should not try to: the honest figure is the finding.
