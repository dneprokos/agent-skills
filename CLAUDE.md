# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication style

Always use caveman mode (full level). Drop articles, filler words, pleasantries, and hedging. Fragments OK. Technical terms exact. Code blocks unchanged. Behave as if `/caveman` was invoked at session start.

## What this repository is

A collection of reusable agent skills for GitHub Copilot, Cursor, and Claude Code (repository: `dneprokos/agent-skills`). Each skill is a self-contained folder with a `SKILL.md` at its root. There is no build system, package manager, or test runner — skills are pure Markdown workflows with optional helper scripts.

## Skill locations

| Path | Purpose |
|---|---|
| `.github/skills/` | Canonical skill definitions (GitHub Copilot) |
| `.cursor/skills/` | Manual mirror of the same skills for Cursor Agent Skills |
| `.claude/skills/` | Manual mirror of the same skills for Claude Code |
| `.agents/skills/` | External skills pulled via `skills-lock.json` (do not edit manually) |
| `.github/agents/` | Orchestrator agents that coordinate multiple skills |
| `.claude/agents/` | Claude Code sub-agents (`ut-*`, `qa-*`, `aqa-*`, `git-change-analyst`) — not mirrored |
| `.claude/hooks/` | Claude Code hook scripts (Node, `.mjs`) — not mirrored |
| `plugins/`, `.claude-plugin/marketplace.json` | Claude Code plugins; this repo is a plugin marketplace named `agent-skills` |

**When you add or modify a skill, update all three mirrors: `.github/skills/`, `.cursor/skills/`, and `.claude/skills/`.** Use the `skill-copier` skill or run the script directly to sync:

```powershell
pwsh .github/skills/skill-copier/scripts/Copy-Skills.ps1 -Source .github -Destination .claude
pwsh .github/skills/skill-copier/scripts/Copy-Skills.ps1 -Source .github -Destination .cursor -Overwrite
# Use -DryRun to preview without making changes
```

Known gaps across mirrors:
- `brainstorming`, `unit-test-generator`, `qa-workflow`, `qa-ship-tests` — exist only in `.claude/skills/` (Claude Code specific, they spawn sub-agents)
- `hello-world`, `slack-markdown-generator-workspace` — exist only in `.cursor/skills/`
- `jira-story-reviewer` — `.claude/skills/` copy adds a `model:` frontmatter key and table formatting; do not overwrite it blindly

## SKILL.md format

Every skill starts with YAML frontmatter:

```yaml
---
name: skill-id
description: >-
  One-sentence summary. Trigger phrases that activate this skill.
argument-hint: "optional hint shown to the user"
tools: [read, search, edit]   # only if specific tools are required
---
```

The body contains the workflow: when to use it, step-by-step instructions, hard rules, and examples. Keep it markdown-only — no code execution, no MCP dependency (except the `jira-*` skills).

## Typical skill layout

```
.github/skills/{skill-name}/
├── SKILL.md          # required — agent instructions
├── README.md         # optional — human-facing summary and example prompts
├── references/       # optional — supporting .md guidance files
├── scripts/          # optional — PowerShell helper scripts
├── templates/        # optional — output templates
├── config/           # optional — configuration files
└── evals/            # optional — evaluation scenarios
```

## Unit test pipeline architecture

The `ut-analyst`, `ut-architect`, and `ut-coder` skills form a strict three-phase pipeline coordinated by `.github/agents/unit-test-generator.agent.md`:

- **Phase 1 — Analyst** (`ut-analyst`): classifies dependencies, detects non-determinism, enumerates test cases using EP/BVA/DT/ST, emits a JSON test plan
- **Phase 2 — Architect** (`ut-architect`): assigns mock/real strategy per dependency, resolves assertion style, specifies non-determinism abstractions
- **Phase 3 — Coder** (`ut-coder`): generates the complete compilable test file (AAA pattern, parameterized tests, null-guards, mocks, setup/teardown)

**Hard rule:** never combine responsibilities across phases. The Analyst never generates code; the Coder never classifies dependencies.

Supported languages: C#, Java, Python, TypeScript. Language-specific examples live in `.github/skills/ut-coder/references/examples-{lang}.md`.

Shared reference files (`project-patterns.md`, `analyst-test-plan-schema.md`) are duplicated across skill folders. Each copy includes a **Sync** callout — update all copies together when the canonical changes.

## Conference reference set (QA workflow, hooks, plugin)

Copied from `dneprokos/suvore-qa-confa-test-automation` as reference. Edit there first when the source is the owner; this repo holds a snapshot.

- **QA pipeline** — `.claude/skills/qa-workflow/` (orchestrator, canonical for routing and state) and `.claude/skills/qa-ship-tests/` drive the `qa-*` and `aqa-*` sub-agents. They read `docs/automation/` (etalons, contracts, references) and call `scripts/*.mjs`. Paths are kept identical to the source so cross-references resolve. The Playwright suite the agents write into (`tests/`, `pages/`, `fixtures/`) is **not** here, so the pipeline does not run end to end in this repo.
- **Rules inherited from the source:** no file under `docs/automation/` names an agent; a `qa-workflow` reference file never names a sibling agent — the registry in its `SKILL.md` is the only place two agent names appear together.
- **Hooks** — only `agent-metrics.mjs` is wired in `.claude/settings.json` (`PreToolUse` / `PostToolUse` / `PostToolUseFailure` on `Task|Agent`). It writes to `.workflow/metrics/` (gitignored). `prompted-by.mjs` and `codex-review.mjs` are unwired Stop-hook examples.
- **Plugin** — `plugins/slack-bug-triage/` is self-contained (skill, five `triage-*` agents, scripts, tests). Its paths use `${CLAUDE_PLUGIN_ROOT}`. Do not also copy its skill or agents into `.claude/`.
- **Jira config** — `jira-bug-creator`, `jira-metrics-bug-leakage`, and the plugin hardcode the demo Jira (`SCRUM`, site, `cloudId`, custom field ids) in `config.json`; their tests assert those values.

```bash
node --test "scripts/__tests__/*.test.mjs"                         # pipeline scripts + hooks (1 known fail: spec-lint lints the source repo's specs)
node --test .github/skills/jira-bug-creator/scripts/bug.test.js
node --test .github/skills/jira-metrics-bug-leakage/scripts/leakage.test.js
```

`scripts/__fixtures__/**` and `scripts/__tests__/**` are pinned to LF in `.gitattributes`; tests compare bytes.

## External skills (`skills-lock.json`)

`skills-lock.json` tracks remotely-sourced skills. Local skills (authored in this repo) are not listed there. External skills are stored under `.agents/skills/` after being pulled. Currently tracked: `documentation-writer` (from `github/awesome-copilot`) and `find-skills` (from `vercel-labs/skills`). The `hello-world` and `dneprokos-medium-article-reviewer` folders under `.agents/skills/` are present locally but not tracked in the lock file.

## Git workflow skills

The five git skills (`git-branch-creator`, `git-commit-creator`, `git-pr-creator`, `git-push-creator`, `git-workflow-orchestrator`) use PowerShell helper scripts under their `scripts/` folders. Scripts support `-PreviewOnly` / `-DryRun` flags. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) format.

These scripts are pre-approved in `.claude/settings.json` and run without a permission prompt in Claude Code. Any other `pwsh` invocations outside these paths will require user approval.

## Secrets and local config

Files that must never be committed:
- `github-pr.local.json` — GitHub API token for the pr-creator skill
- `**/skills/jira-issue-*/config/jira-defaults.local.json` — Jira site and project defaults (creator, searcher, updater skills, all mirrors)

Use the `.example.json` counterparts as templates.

## Token prediction demo

`token_prediction_example.py` is a standalone script that streams Claude's response token-by-token as a demonstration. It has no relation to skills — it's an independent educational example.

```bash
pip install anthropic python-dotenv
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
python token_prediction_example.py
```

Type any prompt at the REPL; type `quit` or Ctrl+C to exit.

## Contributing a new skill

1. Create `.github/skills/{skill-name}/SKILL.md` with correct YAML frontmatter.
2. Mirror the folder to `.cursor/skills/{skill-name}/` and `.claude/skills/{skill-name}/`.
3. Keep the skill focused on one workflow domain.
4. If the skill coordinates other skills, create an agent under `.github/agents/` instead.
