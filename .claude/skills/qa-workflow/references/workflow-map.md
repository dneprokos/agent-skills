# The workflow map — the run as one picture

Read this **when the shape of the run is the question**: explaining the workflow to a user, orienting
after a resume that landed somewhere unexpected, or checking that a routing change has somewhere to
go. **Do not read it before an ordinary delegation** — the step registry in `SKILL.md` carries every
parameter and receipt line, and this file carries none of them.

It is part of the skill: same rules, including the one that no file here names an agent. Every node
below is a **step id**, never the thing that runs it — `SKILL.md`'s registry stays the only place two
agent names appear together.

**This file is canonical for nothing.** It is a picture of the routing that `SKILL.md` defines. Where
the two disagree, `SKILL.md` is right and this file is out of date.

---

## 1 — The run, end to end

```mermaid
flowchart TD
    START(["/qa-workflow TICKET [--auto]"]) --> S0

    S0["Step 0 — resolve id · validate state · check-artifacts · print the banner"]
    S0 -->|"--reset"| RST(["reset written · run over<br/>the fresh run is a second command"])
    S0 --> A1

    subgraph P1["Phase 1 — test design"]
        direction TB
        A1["1.1 requirements collection<br/>writes requirements.md incl. # API Surface"]
        A2["1.2 requirements review<br/>skipped when review_requirements: false"]
        CKA(["Checkpoint A — A1 approvals · A2 surface<br/>size the test basis: &gt; batch_threshold → batch it"])
        A3["1.3 scenario generation + level assignment<br/>one delegation per batch; the last one classifies"]
        CKB(["Checkpoint B — count from the manifest<br/>settle each stream's scope"])
        A5["1.5 design review<br/>Pass / Needs Revision / Blocked"]
        GATE(["design gate<br/>unapproved unknown → coverage?"])
        A1 --> A2 --> CKA --> A3 --> CKB --> A5 --> GATE
    end

    A5 -.->|"missing scenarios · duplications · technique<br/>risks · incorrect classifications"| A3
    A5 -.->|"REQ-* · root cause is a missing requirement"| ESC
    CKB -.->|"design wants API coverage, no surface<br/>on_missing_api_surface: escalate"| ESC
    GATE -.->|"main flow has no automatable coverage<br/>or on_blocked_alternative_flow: escalate"| ESC

    subgraph P2["Phase 2 — test automation · the two streams run in parallel"]
        direction TB
        B1["2.1a API implementation<br/>tests/api/** + report"]
        B2["2.2a API review<br/>re-runs the suite + tsc itself"]
        C1["2.1b UI implementation<br/>tests/ui/** + pages/** + report"]
        C2["2.2b UI review<br/>re-runs the suite + tsc itself"]
        B1 --> B2
        C1 --> C2
    end

    GATE -->|"accept"| B1
    GATE -->|"accept"| C1
    CKB -.->|"zero E2E API scenarios<br/>or the surface was ignored"| NAAPI(["API stream not_applicable<br/>a finished state · needs a reason"])
    CKB -.->|"zero E2E UI scenarios"| NAUI(["UI stream not_applicable<br/>a finished state · needs a reason"])

    B2 -.->|"API-* findings"| B1
    C2 -.->|"UI-* findings"| C1

    subgraph P3["Ship and hand-back"]
        direction TB
        S3["3 ship — gate, branch, commit, push, pull request<br/>git confirmations survive auto mode"]
        S4["4 hand-back — comment the PR · move the ticket"]
        S3 --> S4
    end

    B2 -->|"Pass"| S3
    C2 -->|"Pass"| S3
    NAAPI --> S3
    NAUI --> S3
    NAAPI -.-> NOSHIP
    NAUI -.-> NOSHIP
    NOSHIP(["both streams not_applicable<br/>nothing to ship · no pull request"])
    S3 -.->|"dry_run · skip_ship · PR_URL none"| NOHB(["no hand-back —<br/>never hand back on a PR this run did not create"])
    S4 --> OK
    S4 -.->|"transition failed"| OK

    OK(["OK — PR linked · ticket In Review<br/>a failed hand-back does not fail the run"])
    ESC(["ESCALATED — a person decides"])

    STATE[(".workflow/TICKET.yaml<br/>written only by workflow-state.mjs")]
    S0 <--> STATE

    classDef gate fill:#fff3cd,stroke:#b8860b
    classDef term fill:#e6f4ea,stroke:#137333
    classDef bad fill:#fce8e6,stroke:#c5221f
    class CKA,CKB,GATE gate
    class OK term
    class ESC,NOSHIP,NOHB,RST bad
```

Solid edge = advance. Dashed edge = a review sending work back, a gate stopping the run, or a stream
settling without running. **Every edge on this diagram is drawn by the orchestrator**; no step knows
what follows it.

---

## 2 — The gates

Four places the run can stop or narrow. Two of them are settings, and both settings default to stopping.

| Gate | Where | What it decides | Auto-mode setting |
|---|---|---|---|
| Checkpoint A | before the first 1.3 | which missing values a human approves (A1) · the API surface (A2) · one delegation, or `batch_size` ids per delegation | A1 stops on a `[REQ-C*]` against an in-scope AC |
| Checkpoint B | after 1.3 | each stream's scope, from `--emit-manifest` counts — never by hand | `on_missing_api_surface` (default `escalate`) |
| design gate | after 1.5 | whether an unapproved unknown leaves an in-scope requirement with no automatable coverage | `on_blocked_alternative_flow` (default `escalate`) |
| ship gate | inside step 3 | both reviews passed / both reports exist, read off the files rather than off a caller's claim | — |

Three things about the two settings, because each is easy to read as more than it is:

- **A relaxed gate approves nothing.** The blocked scenarios still ship `Manual only`, the unknown stays
  unapproved, no `Expected:` gains a value. The only thing it decides is whether a human is fetched now or
  reads the open question later.
- **`continue` covers alternative flows only.** A **main flow** stops the run under either value, and a
  mixed set stops it naming every requirement in the gap rather than only the blocking half. The test is in
  `phase-1-design.md`.
- **A relaxed gate is printed twice** — at the banner and at the gate. Why a run did *not* stop is the one
  thing nobody can reconstruct afterwards.

`not_applicable` is not a gate failing. It is a stream finishing without running, and it needs a stated
reason — one with nothing behind it is indistinguishable from a stream that was forgotten.

---

## 3 — The review loop and the cap

Three loops exist, one per reviewing step, each with its own counter. Manual mode caps none of them: every
loop there is already a human decision, and capping a decision somebody just made would be theatre.

```mermaid
flowchart LR
    R{{"review step"}} -->|"Pass"| NEXT(["advance<br/>Minor findings recorded, never looped"])
    R -->|"Needs Revision"| ROUTE["route by finding section,<br/>not by severity"]
    ROUTE --> FIX["the step the findings name"]
    FIX --> RR["re-run the review with<br/>previous_findings set to its own last block"]
    RR --> R
    R -->|"Blocked"| ESC(["escalate"])
    RR -.->|"counter reaches max_review_iterations<br/>default 2, auto mode only"| CAP(["ESCALATED<br/>print the stream, the open finding ids,<br/>and what a human must decide"])

    classDef bad fill:#fce8e6,stroke:#c5221f
    class CAP,ESC bad
```

**The counter tracks review rounds, not delegations.** A design review with findings in *both* design
buckets routes the classifying step first, then the generating step, then re-runs the review once — that
is **one** iteration.

**Never loop past the cap, and never lower the bar to clear it.**

---

## 4 — Every step is delegated in the same three moves

The first move comes **before** the launch. A step launched without its `in_flight` entry is invisible to a
resume: the session dies, and the next one cannot tell an interrupted delegation from one that never
started.

```mermaid
flowchart LR
    W1["append TICKET in_flight --json …<br/>one --json per step, so a parallel pair is one write"] --> L["launch the step"]
    L --> W2["clear-in-flight TICKET --step …<br/>--agent also works · never clears the whole list"]
    W2 --> PARSE["parse the receipt"]
    PARSE --> W3["persist the rest · fold in AGENT_RUN_METRICS with its metrics_seq<br/>background agent: metrics-report --last first"]
    W3 --> Q{{"manual: ask for the transition<br/>auto: route on the normalized outcome"}}
```

Nothing else writes that file. `workflow-state.mjs` re-emits the whole document from the parsed model on
every write, which is what makes a duplicate key unreachable rather than merely reported.

---

## 5 — Terminal states

Every one of these is an ending the return block has to cover. `terminal-return.md` owns the shape; this
is the list.

| Status | Reached from | Deliverable |
|---|---|---|
| `OK` | step 4, or a failed hand-back after a real PR | the pull request; the Jira status is bookkeeping |
| `ESCALATED` | a cap reached, a `REQ-*` finding, a stopping gate, a `Blocked` verdict | the open decision, named |
| `BLOCKED` | a step that could not proceed at all | what blocked it |
| `PAUSED` | any manual-mode question | resume with `/qa-workflow TICKET` |
| `DECLINED` | any question, in either mode — **the option is always present, always last** | reports *more* carefully than a completed run, not less |

A run that stopped early still cost what it cost and still left files behind, which is precisely when the
record matters most: the receipt block, then **Artifacts produced**, then **Agent run cost**, on all five.
