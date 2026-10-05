---
name: agentic-workflow-review
description: >-
  Critically reviews an agentic workflow — a skill, orchestrator, agent, directory or workflow
  node — as a Senior Software Architect and AI Workflow Critic, and writes a structured Markdown
  report with a score, maturity level, strengths, weaknesses with Keep/Remove/Merge/Split/Redesign
  verdicts, context-efficiency and shared-reference reuse analysis, prioritized recommendations and an
  Approve / Approve-with-changes / Reject decision. Works on any repository, not one particular
  workflow. Use when asked to "review the agentic workflow", "critique this orchestrator",
  "audit my agents", "is this workflow production ready", "review the multi-agent architecture",
  "challenge this agent design", or "/agentic-workflow-review <startPoint>".
argument-hint: "<startPoint> [--out docs/review.md] [--focus a,b] [--depth compact|standard|deep] [--context \"...\"]"
---

# Agentic Workflow Architecture Review

Reviews an agentic workflow from a configurable entry point and produces one Markdown report.

**This skill only reads and writes the report.** It never edits an agent, a skill, a prompt or a
config file it is reviewing, and never runs the workflow under review. Fixing findings is a separate,
explicitly requested job.

## Inputs

| Parameter | Required | Form | If absent |
|---|---|---|---|
| `startPoint` | yes | skill name, agent name, file path, directory, or workflow node | stop and ask — never guess from the repo layout or the newest file |
| `outputFile` | no | path | `docs/review.md` |
| `focusAreas` | no | list — e.g. `test design`, `orchestration`, `context efficiency`, `automation` | review all areas at equal weight |
| `reviewDepth` | no | `compact` \| `standard` \| `deep` | `standard` |
| `productionContext` | no | free text: intended usage, scale, users, repos, execution environment | assume a single team, single repo, human-supervised runs, and say so in the report |

Accept both `snake_case` and `camelCase` for every parameter. Flags map as
`--out` -> `outputFile`, `--focus` -> `focusAreas`, `--depth` -> `reviewDepth`,
`--context` -> `productionContext`. A bare first argument is `startPoint`.

## Step 1 — Resolve the entry point

Resolve `startPoint` to exactly one file before reading anything else. Try, in order:

1. Literal path — file or directory.
2. Skill — `**/skills/<startPoint>/SKILL.md`, then `.claude/skills/`, `.cursor/skills/`, `.github/skills/`.
3. Agent — `**/agents/<startPoint>.md`, plus any agent-definition directory the repo uses.
4. Config-declared node — a name defined in an SDK/workflow config (`agents:` blocks, graph definitions,
   pipeline YAML).
5. Directory — review every workflow definition it contains, with the directory as the root.

**Stop and report, do not guess**, when: nothing matches; more than one candidate matches and they are
not the same workflow; or the match is a document *about* a workflow rather than one that defines it
(say which file you think is the real entry point and ask). Output a one-line "cannot resolve" note to
the terminal — do not write a report file in that case.

Announce the resolved entry point and the traversal budget before reading further.

## Step 2 — Traverse

From the entry point, build the workflow graph:

1. **Nodes** — agents, skills, sub-workflows, scripts, tools, MCP servers invoked from it.
2. **Edges** — transitions, delegations, conditionals, loops, retries, and their trigger conditions.
3. **Artifacts** — every file the workflow writes or reads: paths, producers, consumers, lifetime.
4. **Shared references** — files more than one node reads: contracts, templates, etalons/examples,
   schemas, style guides, checklists. Record, per file, every node that reads it and whether any node
   writes it. These are the workflow's single sources of truth; a node that restates one inline instead
   of reading it is drift waiting to happen.
5. **Run modes** — what each writing node does when its output already exists: create, skip, revise
   against findings, or full rewrite. A node with no defined re-run behaviour is a finding.
6. **State** — where run state lives, who owns it, what happens on resume or crash.
7. **Boundaries** — human checkpoints, confirmations, side effects that leave the repo (git push, PR,
   ticket transition, network calls).

Rules:

- Follow downstream transitions and delegated operations transitively.
- Read a supporting file only when it changes a verdict. A framework file the workflow merely writes
  test code into is context, not subject.
- **Do not review unrelated repository content.** Application code, unrelated skills, dependencies and
  CI config are out of scope unless the workflow depends on them.
- Record, per node: its inputs, its outputs, and who consumes those outputs. An output with no consumer
  is a finding, not a detail.
- **Read a shared reference once**, then judge every node against it. Two nodes calibrating against
  different copies of the same rule — one reading the file, one carrying it inline — is a High finding:
  say which copy wins today and what breaks when only one is edited.
- A shared reference with exactly one reader is not shared. Either name the intended second reader or
  report it as indirection with no payoff.

Depth budget:

| `reviewDepth` | Files read | Report length | Per-node treatment |
|---|---|---|---|
| `compact` | entry point + directly named nodes | ~1 page | verdict + one-line reason |
| `standard` | full graph + every shared reference two or more nodes read, one hop past it for artifact shapes | 2–4 pages | verdict + evidence + recommendation |
| `deep` | full graph, plus prompt bodies, shared references, schemas, state files, sample artifacts | 5–10 pages | verdict + evidence + failure mode + redesign sketch |

At `compact`, still list shared references and their readers — the reuse map is cheap and it is the
fastest way to see duplicated responsibility.

## Step 3 — Your stance

Act as a **Senior Software Architect and AI Workflow Critic**.

**Assume the architecture should be rejected until its choices are justified.** Do not defend the
existing design or treat a decision as correct because it is documented.

- Challenge every agent, transition, artifact and design decision. Each must justify its existence.
- Name unnecessary complexity, duplicated responsibility, oversized context and over-engineering.
- Prefer the simpler solution unless the extra complexity buys clear, measurable value.
- Separate real architectural value from complexity that merely looks sophisticated.
- **Never recommend adding an agent when a rule, schema, validator, script or existing agent solves it
  more simply.** A deterministic step beats a probabilistic one at equal quality.
- Ground findings in software architecture, AI-agent design and modern QA practice — not in taste.

Evidence rules — a finding without these is not reportable:

- Cite `path:line` or `path` + section heading for every claim about the workflow.
- State the concrete failure: which input or state produces which wrong outcome.
- Never infer a behaviour from a file name, a description field or a README claim; read the body.
- Mark anything you could not verify as `Unverified` and say what would settle it.
- Do not praise ordinary correctness. "Has an inputs table" is not a strength.

## Step 4 — Review scope

Cover these in the report, in this order. Skip a section only when the workflow genuinely has no
surface for it, and say so in one line rather than dropping the heading.

**1. Overall assessment** — score 1–10, maturity (`Prototype` | `Experimental` | `Production Candidate` |
`Production Ready`), short justification, confidence (`High` | `Medium` | `Low`) with what limits it.

**2. Strengths** — meaningful ones only: separation of responsibility, modularity, maintainability,
scalability, extensibility, reliability, practical usability.

**3. Weaknesses** — unnecessary agents or skills; overlapping responsibility; unclear ownership;
redundant artifacts; rules restated inline that a shared reference already owns, and shared references
no node reads; excessive context generation; outputs nothing consumes; inefficient or ambiguous
transitions; bottlenecks; missing quality gates; undefined or destructive re-run behaviour; failure and
recovery risks; over- and under-engineering. Every affected component gets exactly one action:
**Keep / Remove / Merge / Split / Redesign**.

**4. Focus areas** — deepen wherever `focusAreas` points.

When `test design` is in scope, judge: whether the workflow generates more test information than
needed; whether scenarios, traceability, classifications, risks, requirements and review findings are
duplicated across artifacts; whether each artifact is consumed downstream; whether several agents run
substantially the same analysis; whether test-design activities are separated appropriately; whether
risk-based testing is applied effectively; whether test levels are chosen correctly; whether
requirements coverage is demonstrable; whether generated tests are readable, maintainable and
actionable; whether AI-generated design content is validated by anything; and which parts should be
deterministic instead of agent-driven. Measure against shift-left testing, risk-based testing, ISTQB
principles, requirements traceability, test-level selection, test maintainability, AI-assisted test
design, and human review gates.

**5. Context efficiency** — how context is created and passed between nodes. Find repeated
information, oversized handoffs, whole documents passed where a summary or a path would do,
information generated "just in case", context that goes stale mid-run, missing input/output schemas,
missing persistent artifacts, and places to pass a reference instead of a copy. State the **minimum
context** each important transition actually needs.

Include a **shared reference reuse map**: one row per file two or more nodes read, its readers, its
writer if any, and whether any reader duplicates it inline. Judge it — a reuse map is evidence, not a
conclusion:

- **Shared where it must be** — nodes that have to agree (a producer and the reviewer that judges it,
  two nodes writing the same artifact shape) read the *same* file. Where they do not, name the pair
  and the disagreement it allows.
- **Loaded when it is not needed** — a reference pulled into every node's context to serve one branch
  is per-run token cost. Say which node should stop reading it, or how to split the file.
- **Right granularity** — one oversized reference read for two paragraphs, or five files that always
  travel together, are the same defect in opposite directions.
- **Not a routing back door** — a reference readable by many nodes is the natural place for coupling
  the architecture forbids elsewhere. Check it carries no knowledge of who runs next when the design
  keeps routing in one place.

**6. Workflow optimization** — changes that cut agents, transitions, orchestration complexity, token
and wall-clock cost, and review loops, while making behaviour more deterministic, more observable and
more maintainable — at equal or better quality.

**7. Missing capabilities** — only where the value is clear: quality gates, input/output schemas,
validation, traceability, context management, observability, metrics, recovery strategies,
human-in-the-loop checkpoints, retry and termination rules, re-run and idempotency rules, stable
finding ids across iterations, artifact versioning.

**8. Recommendations** — prioritized. Each carries: priority (`High` | `Medium` | `Low`),
the change, the reason, expected impact, effort (`Small` | `Medium` | `Large`), affected files.

**9. Final verdict** — 5–10 bullets, then exactly one of ✅ Approve / ⚠️ Approve with changes /
❌ Reject, with a brief reason. Reject when a High-priority correctness, safety or data-loss finding is
open. Approve with changes when the design is sound but carries open Medium findings. Approve only when
nothing High or Medium is open.

Report shape and required tables: `references/report-template.md`. Follow it.

## Step 5 — Write the report

1. Write Markdown to `outputFile` (default `docs/review.md`). Create parent directories as needed.
2. If the file exists, say so and overwrite it — a review is a snapshot, not an append log. Preserve an
   earlier review only when the user asks.
3. Header carries: entry point (resolved path), depth, focus areas, production context (or the assumed
   default), date, graph size (nodes and shared references), and files read.
4. Concise, structured, critical, actionable. Important findings over exhaustive commentary. Cut any
   sentence that does not change a decision.
5. Print to the terminal only: resolved entry point, score, maturity, verdict, count of High findings,
   report path.

## Must not

- Edit, refactor or "quickly fix" anything under review.
- Run the workflow, spawn its agents, or trigger its side effects to see what happens.
- Report a finding without a file citation and a concrete failure scenario.
- Soften a verdict because the workflow is someone's work, or inflate one to look rigorous.
- Recommend a new agent where a schema, rule, script or validator suffices.
- Review repository content outside the workflow graph.
- Count a shared reference as a node — it is read, it does not run — or credit reuse as a strength
  without checking that every node that needs the rule reads the file.
