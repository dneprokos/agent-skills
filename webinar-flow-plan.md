# Webinar flow plan — building an exploratory testing agent from scratch

Goal: show live how an idea ("I want an exploratory testing agent") becomes a designed, built and reviewed skill/agent, using skills from this repo.

## Flow

| # | Stage | Skill | Input | Output | What the audience sees |
|---|---|---|---|---|---|
| 1 | Design | `brainstorming` | Vague idea | Approved design + written spec | Idea turned into a design step by step |
| 2 | Stress-test (optional, ~5 min) | `grilling` | Spec from stage 1 | Holes found, spec corrected | One skill builds, another attacks |
| 3 | Build | `skill-creator` | Corrected spec | Skill / agent files | Spec turned into a working artifact |
| 4 | Review | `agentic-workflow-review` | Built skill / agent | Scored report with Approve / Reject | Objective quality gate as the closer |

### 1. Design — `brainstorming`

- Opening prompt: "I want an exploratory testing agent."
- Expected classification: **architectural** (new thing, no existing flow in the repo), so the full path runs: clarifying questions → 2-3 approaches → sectioned design → written spec.
- Why this skill first: it starts from zero. `grilling` needs an existing plan to attack.

### 2. Stress-test — `grilling`

- Run against the spec produced in stage 1.
- Fold the answers back into the spec before building.
- Cut this stage first if time is short.

### 3. Build — `skill-creator`

- Feed it the approved spec.
- Decide during design whether the result is a single skill, an agent, or an orchestrator with sub-agents.
- If it is a skill, mirror to `.github/skills/` and `.cursor/skills/` after the webinar, not live.

### 4. Review — `agentic-workflow-review`

- Point it at the new skill / agent folder.
- Show the score, the weaknesses and the final decision.

## Risks and preparation

- [ ] **Pace.** `brainstorming` asks one question at a time, which is slow live. Prepare answers in advance, or front-load purpose, users and constraints in the first prompt so it moves to approaches faster.
- [ ] **`writing-plans` is not in this repo.** The architectural path ends by invoking it. Either install the superpowers plugin before the webinar, or stop at the approved spec and hand off to `skill-creator` manually.
- [ ] **Dry run.** The three-path classifier (spike / bounded / architectural) is new after the update to upstream v6.4.1. Confirm it picks architectural for the opening prompt.
- [ ] **Visual companion.** Decide whether to accept it if offered; on Windows the server runs in foreground mode and needs a background shell call.
- [ ] **Fallback.** Keep the spec and the built skill from the dry run on a branch in case the live run stalls.

## Open questions

- Target of the exploratory agent: web UI (via `playwright-cli`), API, or both?
- Output of the agent: session notes, bug reports (`bug-report-formatter` / `jira-bug-creator`), or a charter-based report?
- Time budget per stage.
