---
name: requirements-reviewer
description: >-
  Review software requirements against the 8 Key Characteristics of Good
  Requirements (Clear, Complete, Consistent, Verifiable, Feasible, Traceable,
  Atomic, Positive) and produce a structured report with issues, clarifying
  questions, a per-requirement grading table, aggregate scores, and top
  recommendations. Use this skill whenever the user asks to "review
  requirements", "check my requirements", "analyze user stories", "review
  acceptance criteria", "validate my specs", "grade my requirements",
  "give feedback on requirements", or pastes/attaches a list of requirements or
  user stories and asks for feedback — even if they just say "are these good?"
  or attach a requirements document.
argument-hint: "file path or paste requirements text"
---

# Requirements Reviewer

Review requirements against the 8 Key Characteristics of Good Requirements and produce a structured report with issues, clarifying questions, a per-requirement grading table, and aggregate scoring.

> **Scope note**: This review evaluates the _textual quality_ of requirements based on well-established characteristics. It cannot validate domain correctness or deep technical feasibility without additional project context — when those aspects matter, prompt the user for constraints.

## When to Use This Skill

Use for requests like:

- "review my requirements"
- "check if these requirements are well-written"
- "give feedback on my user stories / acceptance criteria"
- "grade my specs"
- "are my requirements clear and testable?"
- user pastes or attaches a requirements document and asks what you think

Do **not** use it for:

- generating requirements from scratch (the user has no existing requirements to review)
- writing test cases from requirements (use `api-test-scenario-rtm-generator` or `ut-analyst`)
- creating Jira issues from requirements (use `jira-issue-creator`)

---

## The 8 Key Characteristics Rubric

Evaluate every requirement against each characteristic below. These definitions are your grading rubric — keep them in mind throughout.

| #   | Characteristic | Definition                                                                                                                                                      |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Clear**      | Unambiguous — only one valid interpretation. No vague words (e.g., "fast", "user-friendly", "as needed", "appropriate").                                        |
| 2   | **Complete**   | Covers all necessary aspects of the described functionality. No missing pre/postconditions, actors, or edge cases that are obviously implied.                   |
| 3   | **Consistent** | Does not contradict other requirements. Uses consistent terminology; no synonym confusion between related requirements.                                         |
| 4   | **Verifiable** | Can be tested or confirmed via inspection, demonstration, analysis, or a pass/fail test. Avoids unmeasurable claims.                                            |
| 5   | **Feasible**   | Achievable within realistic project constraints (time, budget, technology). Flag when a constraint assumption is needed.                                        |
| 6   | **Traceable**  | Can be linked to a higher-level requirement, business goal, or stakeholder need. Standalone requirements with no stated justification should prompt a question. |
| 7   | **Atomic**     | Focuses on exactly one capability or constraint. Requirements that contain "and" connecting distinct behaviors are candidates for splitting.                    |
| 8   | **Positive**   | States what the system _shall_ do, not what it _shall not_ do. Negative phrasing is acceptable only for explicit exclusion/constraint requirements.             |

---

## Workflow

### Step 1: Locate the Requirements Input

Check for requirements in this order:

1. **Attached file** — if the user attached or referenced a file, read it now.
2. **Inline text** — if requirements were pasted directly into the conversation, use that text.
3. **Neither present** — respond with:

   > Please provide the requirements to review. You can either:
   >
   > - Attach or reference a requirements document
   > - Paste the requirements text directly into the chat

Do not proceed without a concrete requirements source.

### Supported Input Formats

| Format              | How to use               | Notes                                                                   |
| ------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Inline text         | Paste directly into chat | Quickest option — no file needed                                        |
| `.txt`              | Attach or reference file | Plain text; works perfectly                                             |
| `.md` / `.markdown` | Attach or reference file | Ideal for user stories, Gherkin, and spec docs                          |
| `.csv`              | Attach or reference file | Look for ID, title/description columns; one row per requirement         |
| `.json` / `.yaml`   | Attach or reference file | Extract requirement text from relevant fields                           |
| `.html`             | Attach or reference file | Best export format for Confluence pages; preserves tables and structure |
| `.docx`             | Attach or reference file | Works when Word file-reading support is available                       |
| `.pdf`              | Attach or reference file | Text-based PDFs only — scanned/image PDFs cannot be read                |

**Unsupported / unreliable**: scanned image PDFs (no OCR), `.xlsx` without spreadsheet tooling, screenshots.

#### Confluence Pages

If your requirements live in Confluence, use one of these approaches (in order of preference):

1. **Export as HTML (single page)** — best option. Go to the page → `···` menu → Export → HTML. Attach the `.html` file. Tables, headings, and formatting are fully preserved.
2. **Copy-paste content into chat** — quick and reliable for shorter pages. Select all text on the Confluence page (Ctrl+A), paste into the chat message.
3. **Export as PDF** — acceptable fallback, but multi-column tables may lose their structure during extraction.

### Step 2: Extract Individual Requirements

Parse the input and extract each distinct requirement as a numbered list. Apply these rules:

- A requirement is any statement describing what the system shall do, a constraint, or an acceptance criterion.
- If the input uses user-story format ("As a … I want … so that …"), treat each story as one requirement.
- If a single sentence contains multiple independent behaviors joined by "and" or ";", note this as a potential atomicity issue but treat it as one unit for grading.
- Strip bullets, identifiers (e.g., "REQ-001"), or story numbers — restate each requirement cleanly.

If fewer than 2 requirements are found, ask the user to confirm they have provided the full input.

### Step 3: Context Check (Optional but Recommended)

Before grading, determine whether any of the following would improve accuracy of Feasible and Traceable scores:

- **Project constraints** (timeline, tech stack, budget)
- **Business goals or higher-level objectives** the requirements trace to
- **A project glossary** for Consistent terminology checks

If the user did not provide this context and the requirement set has more than 5 items, ask in a single message:

> To give you the most accurate Feasible and Traceable scores, it would help to know:
>
> 1. Are there any known technical or budget constraints?
> 2. What business goal or objective do these requirements serve?
>
> You can skip this and I'll note where assumptions were made.

If the user skips or the set is small (≤ 5 items), proceed and note assumptions inline.

### Step 4: Grade Each Requirement

For each extracted requirement, score every characteristic as one of:

- **✅ Pass** — characteristic is clearly satisfied
- **⚠️ Partial** — characteristic is partially met; improvement possible
- **❌ Fail** — characteristic is present but clearly violated (evidence of defect, not merely unknown)
- **➖ N/A** — characteristic cannot be assessed without context that is absent (e.g., Traceable when no business goals were provided, Feasible when no technical constraints are known). **N/A entries are excluded from the aggregate denominator** so missing context does not artificially deflate the score.

Apply the rubric definitions strictly. When in doubt between Pass and Partial, choose Partial and note why. Do not use ❌ simply because information is unavailable — use ➖ N/A for unknowns.

### Step 5: Identify Issues and Questions

For every ⚠️ Partial or ❌ Fail grade, produce a concrete issue statement and/or a clarifying question. Be specific — quote the problematic phrase when relevant.

Good issue: _"'fast response time' is not measurable — specify a threshold (e.g., ≤ 200 ms under normal load)."_
Poor issue: _"This requirement is not clear."_

### Step 6: Compute Aggregate Scores

For each of the 8 characteristics, compute an aggregate score (0–10) across all requirements using this formula:

```
score = ((Pass × 1.0 + Partial × 0.5 + Fail × 0.0) / (total_requirements − N/A_count)) × 10
```

N/A grades are excluded from both the numerator and denominator. If **all** requirements are N/A for a characteristic (e.g., Traceable when zero business goals were provided), report the score as `—` and note the reason.

Round to one decimal place.

After computing individual characteristic scores, identify the **critical floor**: the lowest score among Clear, Complete, Verifiable, and Consistent. These four directly determine whether requirements can be built and tested. If the critical floor is below 6.0, flag it explicitly in the Aggregate Scores table regardless of the Overall average.

### Step 7: Produce the Report

Output the full report using the template in the **Output Format** section below.

---

## Worked Example

**Input requirement**: _"The system should quickly load user data and must not fail."_

| Characteristic | Grade | Reason |
|---|---|---|
| Clear | ❌ | "quickly" is unmeasurable; "fail" is undefined |
| Complete | ⚠️ | No error/timeout handling, no actor specified |
| Consistent | ✅ | No conflicts with other requirements |
| Verifiable | ❌ | "quickly" cannot produce a pass/fail test |
| Feasible | ➖ | No constraints provided — N/A |
| Traceable | ➖ | No business goal provided — N/A |
| Atomic | ❌ | Two behaviors joined: "load data" AND "must not fail" |
| Positive | ⚠️ | "must not fail" is negative; rewrite as "shall remain available" |

**Issues**:
- 🔴 **Clear/Verifiable**: "quickly" is vague — specify a threshold (e.g., ≤ 500 ms for 95th percentile).
- 🔴 **Atomic**: Split into two requirements: (1) performance SLA for loading, (2) reliability/availability constraint.
- ⚠️ **Positive**: Rewrite "must not fail" as a positive availability or reliability statement.
- ❓ **Question**: What user data is being loaded, and what constitutes a "failure" here?

---

## Output Format

Use this exact structure. Do not add extra top-level sections; you may add sub-bullets inside sections.

```markdown
# Requirements Review Report

> **Input**: [filename or "inline text"] · **Requirements found**: N · **Reviewed**: [date]

---

## 1. Extracted Requirements

| #   | Requirement             |
| --- | ----------------------- |
| 1   | [full requirement text] |
| 2   | [full requirement text] |
| …   | …                       |

---

## 2. Issues & Clarifying Questions

### Req 1 — [3–6 word label]

- 🔴 **[Characteristic]**: [Concrete issue statement. Quote the problem phrase if helpful.]
- ⚠️ **[Characteristic]**: [Improvement suggestion or clarifying question.]
- ❓ **Question**: [Specific question to ask the stakeholder.]

### Req 2 — [3–6 word label]

_(No issues — all characteristics pass.)_

… (one subsection per requirement; omit requirements with no issues only if at least 80% of requirements have zero issues — otherwise include a "No issues" note to confirm they were reviewed)

---

## 3. Characteristics Grading Table

| #   | Requirement (short) | Clear | Complete | Consistent | Verifiable | Feasible | Traceable | Atomic | Positive |
| --- | ------------------- | ----- | -------- | ---------- | ---------- | -------- | --------- | ------ | -------- |
| 1   | [short label]       | ✅    | ⚠️       | ✅         | ❌         | ✅       | ➖        | ✅     | ✅       |
| 2   | [short label]       | …     | …        | …          | …          | …        | …         | …      | …        |

> Grades: ✅ Pass · ⚠️ Partial · ❌ Fail · ➖ N/A (excluded from scoring)

---

## 4. Aggregate Scores

| Characteristic | Score (0–10) | Assessment                                                             |
| -------------- | :----------: | ---------------------------------------------------------------------- |
| Clear          |     8.0      | Most requirements are unambiguous; Req 3 needs a measurable threshold. |
| Complete       |     5.0      | Several requirements omit error/edge-case handling.                    |
| Consistent     |     9.0      | Terminology is consistent throughout.                                  |
| Verifiable     |     6.5      | Three requirements lack measurable acceptance criteria.                |
| Feasible       |     7.0      | Assumed standard web-app constraints; no major red flags.              |
| Traceable      |      —       | No business goals provided; all graded N/A.                            |
| Atomic         |     8.5      | One requirement should be split.                                       |
| Positive       |     10.0     | All requirements state intended behavior positively.                   |
| **Overall**    |   **7.7**    | **Average across assessed characteristics (N/A excluded).** |

> ⚠️ **Critical floor**: Complete = 5.0 — below 6.0 threshold. Requirements may be unbuildable without additional edge-case and error-state coverage, regardless of the Overall average.

---

## 5. Top Recommendations

1. **[Most impactful improvement]** — [1–2 sentence explanation and suggested fix.]
2. **[Second improvement]** — [explanation.]
3. **[Third improvement]** — [explanation.]

_(List up to 5 recommendations, ordered by impact.)_
```

---

## Grading Guidelines

### Clear

Flag: vague adjectives ("efficient", "seamless", "intuitive", "robust", "easy"), undefined acronyms, pronouns with ambiguous referents ("it", "they"), or passive voice that hides the actor ("shall be validated" — by whom?).

### Complete

Flag: requirements that describe a happy path only (no mention of error states, boundary conditions, or what happens when preconditions are not met), missing actor or system boundary, or unexplained inputs/outputs.

### Consistent

Compare terminology across the full requirement set. Flag: same concept named differently in different requirements (e.g., "user" vs "customer" vs "end user" used interchangeably), or contradictory constraints (e.g., Req 2 says response ≤ 100 ms, Req 7 says ≤ 500 ms for same operation).

### Verifiable

Flag: requirements that cannot produce a binary pass/fail test. Words like "should", "may", "could", "appropriately", "sufficiently", and "as required" are red flags. A good verifiable requirement names measurable values, quantities, or observable behaviors.

### Feasible

If no project context was given, note the assumption. Flag: requirements that reference technologies not commonly available, extremely tight performance requirements without justification, or contradictory constraints that cannot be simultaneously met. Do not fail a requirement on feasibility without evidence — use ⚠️ Partial to raise a question instead.

### Traceable

Flag: requirements with no stated business justification, no reference to a higher-level objective, and no indication of which stakeholder requested it. A user story "so that" clause satisfies this partially. Full traceability requires a link to a business goal, epic, or regulatory requirement.

### Atomic

Flag: compound requirements using "and" or ";" to join independent behaviors, requirements that embed multiple distinct constraints, or requirements that implicitly describe both functional and non-functional concerns in one statement.

### Positive

Flag: requirements using "shall not", "must not", "will not" as the primary statement rather than as a constraint on an otherwise positive behavior. Exception: security and exclusion requirements are legitimately negative ("the system shall not expose PII to unauthenticated users"). **Grade such legitimate negative requirements as ✅ Pass** — do not penalize intentional exclusion constraints.

---

## Tone and Style

- Be specific and constructive. Quote the problematic phrase rather than describing it vaguely.
- Avoid condescending language. The issues section should read like a peer review, not a rejection.
- When a requirement is genuinely well-written, say so briefly — don't invent problems.
- Keep the issues section focused: one issue per characteristic per requirement. Combine closely related points.
- If the overall quality is high (Overall Score ≥ 8.0), open the report with a brief positive note.
